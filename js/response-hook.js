// Page MAIN world, document_start (feedback #1003): copies the response body of
// Personalization (Evergage) and Data Cloud event requests made with XHR or fetch
// and posts it to the content script. Requests sent with sendBeacon or as images
// have no readable response. Never changes a request or its response.
(function () {
  if (window.__mcpLoggerResponseHook) return;
  window.__mcpLoggerResponseHook = true;
  const TAG = "mcp-logger-response";
  const MAX = 256 * 1024;
  const tracked = (u) => typeof u === "string" && (u.indexOf("evergage.com/api2/event/") > -1 || u.indexOf("c360a.salesforce.com/web/events/") > -1);
  const abs = (u) => { try { return new URL(String(u), location.href).href; } catch (_) { return String(u || ""); } };
  const post = (url, status, body, via) => {
    try {
      const text = body == null ? null : String(body);
      window.postMessage({ source: TAG, url, status, body: text && text.length > MAX ? text.slice(0, MAX + 1) : text, via }, "*");
    } catch (_) { /* never break the page */ }
  };

  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      try { this.__mcpUrl = abs(url); } catch (_) { /* ignore */ }
      return open.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      try {
        if (tracked(this.__mcpUrl)) {
          this.addEventListener("loadend", () => {
            try {
              let body = null;
              if (this.responseType === "" || this.responseType === "text") body = this.responseText;
              else if (this.responseType === "json") body = JSON.stringify(this.response);
              post(this.responseURL || this.__mcpUrl, this.status, body, "xhr");
            } catch (_) { /* ignore */ }
          });
        }
      } catch (_) { /* ignore */ }
      return send.apply(this, arguments);
    };
  }

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (input) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = abs(input && typeof input === "object" && "url" in input ? input.url : input);
        if (tracked(url)) {
          p.then((res) => {
            try { res.clone().text().then((t) => post(res.url || url, res.status, t, "fetch"), () => {}); } catch (_) { /* ignore */ }
          }, () => {});
        }
      } catch (_) { /* ignore */ }
      return p;
    };
  }
})();
