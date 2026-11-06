// Runs at document_start, after sdk-config.js (isSdkScriptUrl). Requests
// local-edit SDK injection when enabled, injects the SDK into listed pages
// that never load it (injectWhenMissing), and writes notes to the page's console while SDK Tools is on, so it is clear the
// session runs replaced SDK code (or why it does not). The same notes go to
// the background as a page report, which Feedback sends along.
(function () {
  const TAG = "%c MCP Logger %c ";
  const TAG_STYLE = "background:#0b6aa2;color:#fff;border-radius:3px;font-weight:bold";
  const isSdkUrl = (url) => isSdkScriptUrl(url);

  const report = {
    reportId: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    url: location.href,
    startedAt: Date.now(),
    status: null,
    notes: [],
    sdkScripts: [],
    injected: null,
    ranId: null,
    checkedAt: null,
  };

  function sendReport() {
    try {
      chrome.runtime.sendMessage({ type: "MCP_PAGE_DIAG", report }, () => void chrome.runtime.lastError);
    } catch (_) {
      // Extension reloaded or context gone.
    }
  }

  function log(level, text) {
    console[level](TAG + text, TAG_STYLE, "");
    report.notes.push({ level, text, at: Date.now() });
    sendReport();
  }

  /** SDK script tags on the page, not counting the one SDK Tools injected. */
  function sdkScripts() {
    return [...document.querySelectorAll("script[src]")]
      .filter((s) => !s.hasAttribute("data-mcp-sdk-tools-injected") && isSdkUrl(s.src))
      .map((s) => s.src)
      .slice(0, 5);
  }

  /** The page has asked for the SDK: a tag, or a request a tag manager made and removed. */
  function pageLoadsSdk() {
    if (sdkScripts().length) return true;
    try {
      return performance
        .getEntriesByType("resource")
        .some((e) => e.initiatorType === "script" && isSdkUrl(e.name));
    } catch (_) {
      return false;
    }
  }

  function describe(status) {
    if (status.mode === "edit") {
      const saved = status.savedAt ? ", saved " + new Date(status.savedAt).toLocaleString() : "";
      return (
        "SDK Tools: Edit SDK is on for this site (id " + status.id + saved + "). " +
        (status.servedBy === "inject"
          ? "The CDN SDK is blocked and your edited copy is injected."
          : "The SDK request gets your edited copy.")
      );
    }
    if (status.fetchError) {
      return "SDK Tools: Redirect SDK is on for this site, but fetching " + status.url +
        " failed (" + status.fetchError + "), so the real SDK loads.";
    }
    return "SDK Tools: Redirect SDK is on for this site. SDK requests go to " + status.url + ".";
  }

  // Listen from the start: the SDK tag can be blocked or fail before the
  // status arrives.
  const early = [];
  let onViolation = (e) => early.push(["csp", e]);
  let onScriptError = (e) => early.push(["error", e]);
  document.addEventListener("securitypolicyviolation", (e) => onViolation(e));
  // Script load errors don't bubble; catch them on the way down.
  document.addEventListener(
    "error",
    (e) => {
      const el = e.target;
      if (el && el.tagName === "SCRIPT" && el.src) onScriptError(e);
    },
    true
  );

  function watch(status) {
    let blocked = null;
    onViolation = (e) => {
      // Chrome reports a redirected script under its original SDK URL, so a
      // block there means the replacement was blocked.
      const uri = String(e.blockedURI || "");
      let target = "";
      try {
        target = status.mode === "redirect" ? new URL(status.url).origin : "";
      } catch (_) {}
      const injectedEval = report.injected && uri === "eval";
      if (!(isSdkUrl(uri) || injectedEval || uri.indexOf("data") === 0 || (target && uri.indexOf(target) === 0))) return;
      if (blocked) return;
      blocked = e;
      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy" i]');
      log(
        "error",
        "The page's Content Security Policy blocked the " +
          (status.mode === "edit" ? "edited" : "replacement") + " SDK (" + e.effectiveDirective + "). " +
          (meta
            ? "The policy is set in a <meta> tag on the page, which the extension cannot remove."
            : "The extension removes the CSP header on listed sites; if this persists, reload the extension in chrome://extensions and check that this site is listed.")
      );
    };
    onScriptError = (e) => {
      const el = e.target;
      const ours = el.hasAttribute("data-mcp-sdk-tools-injected");
      if (!ours && !isSdkUrl(el.src)) return;
      if (!ours && report.injected) {
        // The per-tab block: the page added its own SDK after the injection.
        log("info", "The page then requested the SDK itself (" + el.src + "). SDK Tools blocked it, so only the injected SDK runs.");
        return;
      }
      if (blocked) return;
      blocked = e;
      log(
        "error",
        ours || (status.mode === "redirect" && status.servedBy === "redirect")
          ? "The replacement SDK at " + status.url + " failed to load, so no SDK ran. Check that the server is running and, for https, that the browser trusts its certificate (open the URL in a tab)."
          : "The SDK script " + e.target.src + " failed to load, so nothing ran. Another extension (an ad or tracker blocker) may block cdn.evgnet.com, or the request failed. Try with other extensions turned off."
      );
    };
    early.splice(0).forEach(([kind, e]) => (kind === "csp" ? onViolation(e) : onScriptError(e)));

    if (status.injectWhenMissing && status.servedBy !== "inject" && !status.fetchError) {
      onDomReady(() => {
        if (pageLoadsSdk()) return;
        chrome.runtime.sendMessage({ type: "MCP_INJECT_MISSING_SDK" }, (res) => {
          void chrome.runtime.lastError;
          if (!res || !res.ok || res.skipped) {
            if (res && !res.ok) log("error", "SDK Tools could not inject the SDK: " + res.error);
            return;
          }
          if (!res.injected) {
            if (res.error) log("error", "SDK Tools injected the SDK, but it failed to run: " + res.error);
            return;
          }
          report.injected = { src: res.src || "", at: Date.now() };
          log(
            "info",
            "This page does not load the SDK, so SDK Tools injected " +
              (status.mode === "edit" ? "your edited copy" : res.src ? res.src : "the replacement SDK") + "."
          );
        });
      });
    }

    window.addEventListener("load", () => {
      // Give tag managers a moment to add the SDK tag.
      setTimeout(() => {
        report.sdkScripts = sdkScripts();
        report.ranId = document.documentElement.getAttribute("data-mcp-sdk-tools");
        report.checkedAt = Date.now();
        // A direct redirect serves the developer's file as is: no banner to check.
        if (blocked || (status.mode === "redirect" && status.servedBy === "redirect") || report.ranId) {
          sendReport();
          return;
        }
        if (report.injected) {
          // Injected code that ran sets ranId; a missing one means it threw.
          log("warn", "SDK Tools injected the SDK, but it did not finish running. Look above for an error.");
          sendReport();
          return;
        }
        if (!report.sdkScripts.length) {
          log(
            "info",
            status.injectWhenMissing
              ? "This page has not loaded the SDK, and SDK Tools did not inject it. Look above for an error."
              : "This page has not loaded the SDK, so SDK Tools replaced nothing. Turn on \"Inject the SDK into pages that don't load it\" in SDK Tools to add it."
          );
          return;
        }
        log(
          "warn",
          "The page loads the SDK, but the " + (status.mode === "edit" ? "edited" : "replacement") +
            " SDK did not run. Look above for a syntax error or a blocked script. Reload with the cache off (DevTools open, Disable cache) and, if you updated the extension, reload it in chrome://extensions."
        );
      }, 3000);
    });
  }

  function onDomReady(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn, { once: true });
    else fn();
  }

  /** SDK Tools is on, but this site is not in Sites: say so if the page loads the SDK. */
  function watchUnlisted(mode) {
    window.addEventListener("load", () => {
      setTimeout(() => {
        const scripts = sdkScripts();
        if (!scripts.length) return;
        report.sdkScripts = scripts;
        report.checkedAt = Date.now();
        log(
          "info",
          "SDK Tools " + (mode === "edit" ? "Edit" : "Redirect") + " SDK is on, but " + location.hostname +
            " is not in Sites, so this page loads the real SDK. Add the site in SDK Tools."
        );
      }, 3000);
    });
  }

  try {
    chrome.runtime.sendMessage({ type: "MCP_INJECT_LOCAL_SDK" }, function (res) {
      void chrome.runtime.lastError;
      const status = res && res.status;
      if (!status) return;
      report.status = status;
      if (status.mode === "off") {
        if (status.unlisted) watchUnlisted(status.unlisted);
        return;
      }
      log("info", describe(status));
      watch(status);
    });
  } catch (_) {
    // Extension context may be unavailable during navigation edge cases.
  }
})();
