// Runs at document_start. Requests local-edit SDK injection when enabled, and
// writes notes to the page's console while SDK Tools is on, so it is clear the
// session runs replaced SDK code (or why it does not). The same notes go to
// the background as a page report, which Feedback sends along.
(function () {
  const TAG = "%c MCP Logger %c ";
  const TAG_STYLE = "background:#0b6aa2;color:#fff;border-radius:3px;font-weight:bold";
  const SDK_SCRIPT = 'script[src*="cdn.evgnet.com"], script[src*="cdn.c360a.salesforce.com"]';
  const SDK_URL_RE = /^https?:\/\/(cdn\.evgnet\.com|cdn\.c360a\.salesforce\.com)[:/]/;

  const report = {
    reportId: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    url: location.href,
    startedAt: Date.now(),
    status: null,
    notes: [],
    sdkScripts: [],
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

  function sdkScripts() {
    return [...document.querySelectorAll(SDK_SCRIPT)].map((s) => s.src).slice(0, 5);
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
      if (el && el.tagName === "SCRIPT" && SDK_URL_RE.test(el.src || "")) onScriptError(e);
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
      if (!(SDK_URL_RE.test(uri) || uri.indexOf("data") === 0 || (target && uri.indexOf(target) === 0))) return;
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
      if (blocked) return;
      blocked = e;
      log(
        "error",
        status.mode === "redirect" && status.servedBy === "redirect"
          ? "The replacement SDK at " + status.url + " failed to load, so no SDK ran. Check that the server is running and, for https, that the browser trusts its certificate (open the URL in a tab)."
          : "The SDK script " + e.target.src + " failed to load, so nothing ran. Another extension (an ad or tracker blocker) may block cdn.evgnet.com, or the request failed. Try with other extensions turned off."
      );
    };
    early.splice(0).forEach(([kind, e]) => (kind === "csp" ? onViolation(e) : onScriptError(e)));

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
        if (!report.sdkScripts.length) {
          log("info", "This page has not loaded the SDK from cdn.evgnet.com or cdn.c360a.salesforce.com, so SDK Tools replaced nothing.");
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
