// Tools page helpers (user, 2026-11-13): open a page with an SDK injected, clear a site's
// cookies, and read what the SDK on a page knows (anonymous id, consents and other getters).
// Shared by the service worker (importScripts, after sdk-config.js), tools.js and Node tests.
(function (root) {
  /* ---------- Open a page with the SDK ---------- */

  // Session DNR rules for tabs opened with "Inject SDK & open page": per tab, one allow, one
  // CSP strip and one block per SDK regex. Separate from SDK Tools' rules (91001-91049) so
  // changing SDK Tools settings does not touch these tabs.
  const OPEN_SDK_MAX_TABS = 100;
  const OPEN_SDK_ALLOW_BASE = 91100; // + tab index
  const OPEN_SDK_STRIP_CSP_BASE = 91200; // + tab index
  const OPEN_SDK_BLOCK_BASE = 91300; // + tab index * number of regexes + regex index
  // Above SDK Tools' redirect (50) and per-tab block (55), and above the block below.
  const OPEN_SDK_BLOCK_PRIORITY = 65;
  const OPEN_SDK_ALLOW_PRIORITY = 70;

  /** A page address as typed: "example.com/x" becomes https://example.com/x. Only http(s). */
  function normalizePageUrl(input) {
    let text = String(input == null ? "" : input).trim();
    if (!text) throw new Error("Enter the page address.");
    if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = "https://" + text;
    let url;
    try {
      url = new URL(text);
    } catch (_) {
      throw new Error("That is not a web address.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only http and https pages can be opened.");
    return url.toString();
  }

  /** The SDK script address. It must be http(s); any file name is allowed (self-hosted copies). */
  function normalizeSdkUrl(input) {
    const text = String(input == null ? "" : input).trim();
    if (!text) throw new Error("Enter the SDK script address.");
    let url;
    try {
      url = new URL(text);
    } catch (_) {
      throw new Error("The SDK address must be a full URL, starting with https://.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("The SDK address must start with https:// or http://.");
    return url.toString();
  }

  /** The site a tab was opened on: its host without www. Subdomains count as the same site. */
  function siteOf(host) {
    return String(host || "")
      .toLowerCase()
      .replace(/^www\./, "");
  }

  /**
   * Rules for every tab opened with an injected SDK. entries: [{ tabId, src, host }].
   * Per tab, and only for the site it was opened on (so another site loaded in the tab is
   * left alone even before the tab is forgotten, which happens asynchronously):
   * - block the page's own SDK, so only the chosen SDK runs;
   * - let the chosen SDK through (it is usually an SDK URL itself, and SDK Tools may
   *   redirect SDK URLs);
   * - remove the page's CSP header, so the injected script is not refused.
   */
  function buildOpenSdkRules(entries, regexes) {
    const seen = new Set();
    const list = (entries || [])
      .filter((e) => e && Number.isInteger(e.tabId) && e.tabId >= 0 && e.src && siteOf(e.host))
      .filter((e) => !seen.has(e.tabId) && seen.add(e.tabId))
      .slice(0, OPEN_SDK_MAX_TABS);
    const removeRuleIds = [];
    for (let i = 0; i < OPEN_SDK_MAX_TABS; i++) {
      removeRuleIds.push(OPEN_SDK_ALLOW_BASE + i, OPEN_SDK_STRIP_CSP_BASE + i);
      regexes.forEach((_, j) => removeRuleIds.push(OPEN_SDK_BLOCK_BASE + i * regexes.length + j));
    }
    // One block rule per SDK regex (a single joined regex is over Chrome's 2 KB compiled
    // limit): up to 100 tabs x 2 regexes, within the 1000 regex rules Chrome allows.
    const addRules = [];
    list.forEach((e, i) => {
      const site = [siteOf(e.host)];
      regexes.forEach((regexFilter, j) =>
        addRules.push({
          id: OPEN_SDK_BLOCK_BASE + i * regexes.length + j,
          priority: OPEN_SDK_BLOCK_PRIORITY,
          action: { type: "block" },
          condition: { regexFilter, resourceTypes: ["script"], tabIds: [e.tabId], initiatorDomains: site },
        })
      );
      addRules.push(
        {
          id: OPEN_SDK_ALLOW_BASE + i,
          priority: OPEN_SDK_ALLOW_PRIORITY,
          action: { type: "allow" },
          condition: { urlFilter: "|" + e.src + "|", resourceTypes: ["script"], tabIds: [e.tabId], initiatorDomains: site },
        },
        {
          id: OPEN_SDK_STRIP_CSP_BASE + i,
          priority: OPEN_SDK_ALLOW_PRIORITY,
          action: {
            type: "modifyHeaders",
            responseHeaders: [
              { header: "content-security-policy", operation: "remove" },
              { header: "content-security-policy-report-only", operation: "remove" },
            ],
          },
          condition: { resourceTypes: ["main_frame"], tabIds: [e.tabId], requestDomains: site },
        }
      );
    });
    return { addRules, removeRuleIds };
  }

  /** Keep the injection while the tab stays on the same site (subdomains included). */
  function sameSite(openedHost, nextUrl) {
    let host = "";
    try {
      host = new URL(nextUrl).hostname.toLowerCase();
    } catch (_) {
      return false;
    }
    const base = siteOf(openedHost);
    return !!base && (host === base || host.endsWith("." + base));
  }

  /* ---------- Cookies ---------- */

  // Personalization (Evergage) keeps its anonymous id in _evga_<suffix>; the Data Cloud Web
  // SDK in _sfid_<suffix>. Both are first-party cookies set by the SDK.
  const SDK_COOKIE_PATTERNS = [/^_evga_/, /^_sfid_/];

  function isSdkCookie(name) {
    return SDK_COOKIE_PATTERNS.some((p) => p.test(String(name || "")));
  }

  /** The URL chrome.cookies.remove needs for a cookie from chrome.cookies.getAll. */
  function cookieRemoveUrl(cookie) {
    const host = String(cookie.domain || "").replace(/^\./, "");
    return (cookie.secure ? "https://" : "http://") + host + (cookie.path || "/");
  }

  /* ---------- SDK info ---------- */

  // Documented in Salesforce's Web SDK guides: getAnonymousId (Identity Management) and
  // getConsents (Personalization Web Integration). Shown first; everything else is found on
  // the page's SDK objects at run time, since the functions differ by SDK and version.
  const DOCUMENTED_GETTERS = ["getAnonymousId", "getConsents"];

  /**
   * Runs in the page (MAIN world) through chrome.scripting.executeScript, so it must not use
   * anything from outside its own body. Reads window.SalesforceInteractions and
   * window.Evergage: lists their functions and properties, and calls the zero-argument
   * get / is / has functions. Functions whose names suggest a request or a change are listed
   * but not called.
   */
  async function collectSdkInfo(documented) {
    const MAX_TEXT = 20000;
    // After the get/is/has prefix: names that read from the server or start work.
    const NOT_CALLED = /^(Recommend|Campaign|Fetch|Load|Request|Send|Track|Remote|Server)/;
    function plain(value, depth, seen) {
      if (value === null || value === undefined) return value === null ? null : "(undefined)";
      const t = typeof value;
      if (t === "string" || t === "number" || t === "boolean") return value;
      if (t === "bigint" || t === "symbol") return String(value);
      if (t === "function") return "(function " + (value.name || "anonymous") + ")";
      if (value instanceof Date) return value.toISOString();
      if (typeof Element !== "undefined" && value instanceof Element) return "(element <" + value.tagName.toLowerCase() + ">)";
      if (value === window || value === document) return "(" + (value === window ? "window" : "document") + ")";
      // seen holds the objects on the current path only: an object reached twice by
      // different paths (getState() repeats the sitemap) is shown both times.
      if (seen.has(value)) return "(circular)";
      if (depth > 5) return "(nested too deep)";
      seen.add(value);
      try {
        return plainObject(value, depth, seen);
      } finally {
        seen.delete(value);
      }
    }
    function plainObject(value, depth, seen) {
      if (Array.isArray(value)) return value.slice(0, 200).map((v) => plain(v, depth + 1, seen));
      const out = {};
      let n = 0;
      for (const k of Object.keys(value)) {
        if (n++ >= 200) {
          out["…"] = "more keys not shown";
          break;
        }
        try {
          out[k] = plain(value[k], depth + 1, seen);
        } catch (e) {
          out[k] = "(could not read: " + (e && e.message) + ")";
        }
      }
      return out;
    }
    function shown(value) {
      const v = plain(value, 0, new WeakSet());
      const text = JSON.stringify(v);
      if (text && text.length > MAX_TEXT) return { truncated: true, preview: text.slice(0, MAX_TEXT) };
      return v;
    }
    function withTimeout(p, ms) {
      return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("no answer in " + ms / 1000 + " s")), ms))]);
    }
    function names(obj) {
      const set = new Set();
      let o = obj;
      for (let i = 0; o && o !== Object.prototype && o !== Function.prototype && i < 4; i++) {
        Object.getOwnPropertyNames(o).forEach((k) => k !== "constructor" && set.add(k));
        o = Object.getPrototypeOf(o);
      }
      return [...set];
    }
    async function read(globalName) {
      let obj;
      try {
        obj = window[globalName];
      } catch (_) {}
      if (!obj || (typeof obj !== "object" && typeof obj !== "function")) return { name: globalName, found: false };
      const getters = [];
      const others = [];
      const props = [];
      const list = names(obj).sort((a, b) => {
        const da = documented.indexOf(a);
        const db = documented.indexOf(b);
        if (da !== db) return (da < 0 ? 99 : da) - (db < 0 ? 99 : db);
        return a.localeCompare(b);
      });
      for (const key of list) {
        let v;
        try {
          v = obj[key];
        } catch (e) {
          props.push({ name: key, error: String(e && e.message) });
          continue;
        }
        if (typeof v !== "function") {
          if (v === null || ["string", "number", "boolean", "undefined"].includes(typeof v)) props.push({ name: key, value: shown(v) });
          else props.push({ name: key, value: shown(v), object: true });
          continue;
        }
        const getterName = /^(get|is|has)[A-Z_]/.test(key);
        if (!getterName || v.length > 0 || NOT_CALLED.test(key.replace(/^(get|is|has)/, ""))) {
          others.push({ name: key, params: v.length });
          continue;
        }
        try {
          const value = await withTimeout(Promise.resolve(v.call(obj)), 2000);
          getters.push({ name: key, documented: documented.includes(key), value: shown(value) });
        } catch (e) {
          getters.push({ name: key, documented: documented.includes(key), error: String((e && e.message) || e) });
        }
      }
      return { name: globalName, found: true, getters, others, props };
    }
    const scripts = [...document.querySelectorAll("script[src]")]
      .map((s) => s.src)
      .filter((src) => /\/(evergage[A-Za-z]*|c360a)(\.min)?\.js([?#]|$)/.test(src));
    return {
      url: location.href,
      at: Date.now(),
      scripts,
      injected: !!(window.__MCP_SDK_TOOLS_INJECTED__ || window.__MCP_LOCAL_SDK_INJECTED__),
      sdks: [await read("SalesforceInteractions"), await read("Evergage")],
    };
  }

  const api = {
    OPEN_SDK_ALLOW_BASE,
    OPEN_SDK_BLOCK_BASE,
    OPEN_SDK_STRIP_CSP_BASE,
    OPEN_SDK_MAX_TABS,
    siteOf,
    normalizePageUrl,
    normalizeSdkUrl,
    buildOpenSdkRules,
    sameSite,
    SDK_COOKIE_PATTERNS,
    isSdkCookie,
    cookieRemoveUrl,
    DOCUMENTED_GETTERS,
    collectSdkInfo,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.McpPageTools = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
