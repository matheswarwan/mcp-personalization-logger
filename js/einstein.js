/*
 * Einstein Web Recommendations (Marketing Cloud Engagement, the igodigital collect code).
 * Shared by the service worker (importScripts), the extension pages and the Node tests.
 *
 * collect.js turns each _etmc.push([...]) into an image request:
 *   https://<host>/c2/<org id>/<endpoint>?payload=<URL-encoded JSON>
 * where host is nova.collect.igodigital.com, <org id>.collect.igodigital.com, or the
 * site's own first-party host (setFirstParty). Endpoints: track_page_view, track_cart,
 * track_conversion, track_wishlist, track_rating, update_item.
 * Recommendations are read from <org id>.recs.igodigital.com/a/v2/<org id>/<page>/recommend.(js|json).
 */
(function (root) {
  "use strict";

  const COLLECT_ENDPOINTS = {
    track_page_view: "Page View",
    track_cart: "Cart",
    track_conversion: "Conversion",
    track_wishlist: "Wishlist",
    track_rating: "Rating",
    update_item: "Update item",
  };

  const COLLECT_PATH = /^\/c2\/([^/]+)\/([a-z_]+)\/?$/;
  const RECS_PATH = /^\/a\/v2\/([^/]+)\/([^/]+)\/recommend\.(js|json)$/i;

  function parse(url) {
    try {
      return new URL(url);
    } catch (_) {
      return null;
    }
  }

  function isIgodigitalHost(host, part) {
    return host === part + ".igodigital.com" || host.endsWith("." + part + ".igodigital.com");
  }

  /**
   * { orgId, endpoint } for a collect request, else null. On igodigital's collect hosts any
   * /c2/<org>/<endpoint> counts; on other (first-party) hosts only the known endpoints with a
   * payload parameter, so unrelated /c2/ paths are not picked up.
   */
  function collectInfo(url) {
    const u = typeof url === "string" ? parse(url) : null;
    if (!u || !/^https?:$/.test(u.protocol)) return null;
    const m = COLLECT_PATH.exec(u.pathname);
    if (!m) return null;
    const own = isIgodigitalHost(u.hostname, "collect");
    if (!own && !(COLLECT_ENDPOINTS[m[2]] && u.searchParams.has("payload"))) return null;
    return { orgId: decodeURIComponent(m[1]), endpoint: m[2] };
  }

  /** { orgId, page, format } for a recommendations request, else null. */
  function recsInfo(url) {
    const u = typeof url === "string" ? parse(url) : null;
    if (!u || !/^https?:$/.test(u.protocol) || !isIgodigitalHost(u.hostname, "recs")) return null;
    const m = RECS_PATH.exec(u.pathname);
    if (!m) return null;
    return { orgId: decodeURIComponent(m[1]), page: decodeURIComponent(m[2]), format: m[3].toLowerCase() };
  }

  function isEinsteinRequest(url) {
    return !!(collectInfo(url) || recsInfo(url));
  }

  /**
   * The event payload stored for a request. Collect: the JSON in ?payload= (raw text kept
   * under _unparsed when it is not JSON). Recommendations: the query parameters.
   */
  function extractPayload(url) {
    const u = parse(url);
    if (!u) throw new Error("Bad URL");
    if (collectInfo(url)) {
      const raw = u.searchParams.get("payload");
      if (raw == null) return {};
      try {
        return JSON.parse(raw);
      } catch (_) {
        return { _unparsed: raw };
      }
    }
    const params = {};
    u.searchParams.forEach((v, k) => {
      if (k in params) params[k] = [].concat(params[k], v);
      else params[k] = v;
    });
    return params;
  }

  /** Site key suffix for the Explorer's site list, e.g. "Einstein Recs (org: 546002015)". */
  function hostKeyDetail(url) {
    const info = collectInfo(url) || recsInfo(url);
    return "Einstein Recs (org: " + (info ? info.orgId : "unknown") + ")";
  }

  /** Action name for an Einstein request URL. */
  function actionName(url) {
    const c = collectInfo(url);
    if (c) return COLLECT_ENDPOINTS[c.endpoint] || c.endpoint;
    const r = recsInfo(url);
    if (r) return "Recommendations: " + r.page;
    return "Einstein request";
  }

  /** Short summary for the event row: items, cart size, rating. */
  function itemSummary(url, payload) {
    const p = payload && typeof payload === "object" ? payload : {};
    const c = collectInfo(url);
    if (!c) {
      const r = recsInfo(url);
      if (!r) return "";
      const item = p.item || p.items || p.search || p.category;
      return item ? String(item) : "";
    }
    const cart = Array.isArray(p.cart) ? p.cart : Array.isArray(p) ? p : null;
    if (c.endpoint === "track_cart" && p.clear_cart) return "clear cart";
    if (cart) return cart.length + " item" + (cart.length === 1 ? "" : "s");
    if (c.endpoint === "track_rating" && p.rating != null) return "rating " + p.rating + (p.item ? " for " + p.item : "");
    const bits = [];
    if (p.item) bits.push("item " + p.item);
    if (p.category) bits.push("category " + p.category);
    if (p.search) bits.push("search " + p.search);
    return bits.join(", ");
  }

  /**
   * Email click-through fields collect.js keeps on _etmc (from the landing page URL:
   * j/sfmc_j, s/sfmc_s/sfmc_sub, l/sfmc_l, u/sfmc_u, jb/sfmc_jb, mid/sfmc_mid, e/sfmc_e)
   * and, on a page view sent from such a link, in the payload's et_email.
   * Returns [label, value] pairs with a value.
   */
  function emailFields(payload, etmc) {
    const e = (etmc && etmc.value && typeof etmc.value === "object" && !Array.isArray(etmc.value) ? etmc.value : {}) || {};
    const et = (payload && payload.et_email) || {};
    const userInfo = (payload && payload.user_info) || e.user_info || {};
    const rows = [
      ["Org ID", Array.isArray(e.org_id) ? e.org_id.join(", ") : e.org_id],
      ["Email address", userInfo.email || e.email],
      ["Job ID", et.job_id || e.email_job_id],
      ["Subscriber ID", et.subscriber_id || e.email_subscriber_id],
      ["List ID", et.list_id || e.email_list_id],
      ["Job batch ID", et.job_batch_id || e.email_job_batch_id],
      ["Landing URL ID", et.landing_url_id || e.email_landing_url_id],
      ["MID", et.mid || e.mid],
      ["First-party host", e.first_party],
      ["Tracking disabled", e.tracking_disabled ? "yes (doNotTrack)" : ""],
    ];
    return rows.filter((r) => r[1] != null && String(r[1]) !== "").map((r) => [r[0], String(r[1])]);
  }

  /**
   * Runs in the page (MAIN world) through chrome.scripting.executeScript, so it must stay
   * self-contained. Returns a JSON-safe copy of window._etmc: the collect object's data
   * (functions left out), or the queued pushes when collect.js has not loaded yet.
   */
  function snapshotEtmc() {
    function plain(value, depth) {
      if (value === null || value === undefined) return value === null ? null : undefined;
      const t = typeof value;
      if (t === "string" || t === "number" || t === "boolean") return value;
      if (t === "function" || t === "symbol" || t === "bigint") return undefined;
      if (depth > 6) return "(nested too deep)";
      if (typeof Element !== "undefined" && value instanceof Element) return "(element)";
      if (Array.isArray(value)) return value.slice(0, 100).map((v) => plain(v, depth + 1));
      const out = {};
      Object.keys(value).slice(0, 100).forEach((k) => {
        try {
          const v = plain(value[k], depth + 1);
          if (v !== undefined) out[k] = v;
        } catch (_) {}
      });
      return out;
    }
    let etmc;
    try {
      etmc = window._etmc;
    } catch (_) {}
    if (etmc === undefined) return { found: false, page: location.href };
    const loaded = !Array.isArray(etmc) && typeof (etmc && etmc.push) === "function";
    let value = plain(etmc, 0);
    const text = JSON.stringify(value === undefined ? null : value);
    if (text && text.length > 20000) value = { truncated: true, preview: text.slice(0, 20000) };
    return { found: true, loaded, page: location.href, at: Date.now(), value };
  }

  const SDK_LABELS = {
    evergage: "Interaction Studio (Personalization)",
    "data-cloud": "Data Cloud Web SDK",
    einstein: "Einstein Web Recommendations",
  };
  const SDK_SHORT = { evergage: "IS", "data-cloud": "DC", einstein: "EWR" };

  function sdkLabel(sdk) {
    return SDK_LABELS[sdk] || SDK_LABELS.evergage;
  }

  function sdkShort(sdk) {
    return SDK_SHORT[sdk] || SDK_SHORT.evergage;
  }

  const api = {
    COLLECT_ENDPOINTS,
    collectInfo,
    recsInfo,
    isEinsteinRequest,
    extractPayload,
    hostKeyDetail,
    actionName,
    itemSummary,
    emailFields,
    snapshotEtmc,
    SDK_LABELS,
    sdkLabel,
    sdkShort,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.McpEinstein = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
