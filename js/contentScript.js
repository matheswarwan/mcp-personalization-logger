// Runs at document_start. Requests local-edit SDK injection when enabled, and
// writes notes to the page's console while SDK Tools is on for this site, so
// it is clear the session runs replaced SDK code (or why it does not).
(function () {
  const TAG = "%c MCP Logger %c ";
  const TAG_STYLE = "background:#0b6aa2;color:#fff;border-radius:3px;font-weight:bold";
  const SDK_SCRIPT = 'script[src*="cdn.evgnet.com"], script[src*="cdn.c360a.salesforce.com"]';
  const log = (level, text) => console[level](TAG + text, TAG_STYLE, "");

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

  // Listen from the start: the SDK tag can be blocked before the status arrives.
  const violations = [];
  let onViolation = (e) => violations.push(e);
  document.addEventListener("securitypolicyviolation", (e) => onViolation(e));

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
      const sdkHost = /^https?:\/\/(cdn\.evgnet\.com|cdn\.c360a\.salesforce\.com)[:/]/.test(uri);
      if (!(sdkHost || uri.indexOf("data") === 0 || (target && uri.indexOf(target) === 0))) return;
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
    violations.splice(0).forEach(onViolation);

    window.addEventListener("load", () => {
      // Give tag managers a moment to add the SDK tag.
      setTimeout(() => {
        // A direct redirect serves the developer's file as is: no banner to check.
        if (blocked || (status.mode === "redirect" && status.servedBy === "redirect")) return;
        const ran = document.documentElement.getAttribute("data-mcp-sdk-tools");
        if (ran) return;
        if (!document.querySelector(SDK_SCRIPT)) {
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

  try {
    chrome.runtime.sendMessage({ type: "MCP_INJECT_LOCAL_SDK" }, function (res) {
      void chrome.runtime.lastError;
      const status = res && res.status;
      if (!status || status.mode === "off") return;
      log("info", describe(status));
      watch(status);
    });
  } catch (_) {
    // Extension context may be unavailable during navigation edge cases.
  }
})();
