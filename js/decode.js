// Decodes an SDK event payload pasted by the user (feedback #1001). Accepts what people copy
// out of DevTools: a whole beacon URL, a form body (event=...), the event= value alone
// (base64, URL-encoded base64 or base64url), or plain JSON.
// Shared by the popup, the Tools page and Node tests.
(function (root) {
  function base64ToText(value) {
    let s = String(value).replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    const binary = atob(s);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  function tryJson(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (_) {
      return { ok: false };
    }
  }

  /** The event value inside a URL or a form body, or the text itself. */
  function eventValue(text) {
    if (/^https?:\/\//i.test(text)) {
      try {
        const v = new URL(text).searchParams.get("event");
        if (v) return { value: v, from: "url" };
      } catch (_) {}
    }
    if (/(^|&)event=/.test(text) && !/^[\[{]/.test(text)) {
      const v = new URLSearchParams(text).get("event");
      if (v) return { value: v, from: "form" };
    }
    return { value: text, from: "" };
  }

  /**
   * @returns {{ ok: true, value: any, how: string } | { ok: false, error: string }}
   */
  function decodePayload(input) {
    const text = String(input == null ? "" : input).trim();
    if (!text) return { ok: false, error: "Nothing to decode." };
    const { value, from } = eventValue(text);
    const where = from === "url" ? "event= in the URL, " : from === "form" ? "event= in the form body, " : "";

    const json = tryJson(value);
    if (json.ok) return { ok: true, value: json.value, how: where + "JSON" };

    const candidates = [[value, "base64"]];
    try {
      const unescaped = decodeURIComponent(value);
      if (unescaped !== value) candidates.push([unescaped, "URL-encoded base64"]);
    } catch (_) {}
    for (const [candidate, how] of candidates) {
      try {
        const decoded = tryJson(base64ToText(candidate));
        if (decoded.ok) return { ok: true, value: decoded.value, how: where + how };
      } catch (_) {}
    }
    return {
      ok: false,
      error: "Not an event payload: expected JSON, base64-encoded JSON, or a URL with an event= value.",
    };
  }

  const api = { decodePayload, base64ToText };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.McpDecode = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
