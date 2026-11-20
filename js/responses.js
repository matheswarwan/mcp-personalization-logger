// Responses to tracked event requests (feedback #1003). webRequest cannot read a
// response body, so js/response-hook.js (page MAIN world) copies the body of
// tracked XHR/fetch requests and the content script forwards it here. The body is
// matched to the saved event by URL: whichever of the two arrives first waits up
// to RESPONSE_TTL_MS for the other.
(function (root) {
  const MAX_BODY = 256 * 1024;
  const RESPONSE_TTL_MS = 60 * 1000;

  function isTrackedResponseUrl(url) {
    const u = String(url || "");
    return u.indexOf("evergage.com/api2/event/") > -1 || u.indexOf("c360a.salesforce.com/web/events/") > -1;
  }

  /** JSON when it parses, else the text; long bodies cut to MAX_BODY characters. */
  function parseResponseBody(text) {
    if (text == null) return null;
    let s = String(text);
    const truncated = s.length > MAX_BODY;
    if (truncated) s = s.slice(0, MAX_BODY);
    if (!truncated) {
      try {
        return { body: JSON.parse(s), truncated: false, size: s.length };
      } catch (_) { /* not JSON */ }
    }
    return { body: s, truncated, size: String(text).length };
  }

  function createMatcher(ttl) {
    const life = ttl || RESPONSE_TTL_MS;
    const responses = new Map(); // url -> [{ response, at }]
    const saved = new Map(); // url -> [{ hostName, key, at }]
    const prune = (map, now) => {
      for (const [k, list] of map) {
        const kept = list.filter((x) => now - x.at < life);
        if (kept.length) map.set(k, kept); else map.delete(k);
      }
    };
    return {
      /** A response that arrived before its event was saved, or null. */
      takeResponse(url, now) {
        const t = now || Date.now();
        prune(responses, t);
        const list = responses.get(url);
        if (!list || !list.length) return null;
        const first = list.shift();
        if (!list.length) responses.delete(url);
        return first.response;
      },
      /** An event saved without a response: the response may still come. */
      rememberSaved(url, hostName, key, now) {
        const t = now || Date.now();
        prune(saved, t);
        const list = saved.get(url) || [];
        list.push({ hostName, key, at: t });
        saved.set(url, list);
      },
      /** A response arrived: where to attach it, or null when it was kept for later. */
      onResponse(url, response, now) {
        const t = now || Date.now();
        prune(saved, t);
        const list = saved.get(url);
        if (list && list.length) {
          const target = list.shift();
          if (!list.length) saved.delete(url);
          return { hostName: target.hostName, key: target.key };
        }
        prune(responses, t);
        const waiting = responses.get(url) || [];
        waiting.push({ response, at: t });
        responses.set(url, waiting);
        return null;
      },
    };
  }

  /**
   * The campaigns a Personalization (Evergage) response served, for the detail pane:
   * [{ campaign, experience, userGroup, id }]. Empty when the body has none.
   */
  function campaignsServed(body) {
    const list = body && typeof body === "object" && Array.isArray(body.campaignResponses) ? body.campaignResponses : [];
    return list
      .filter((c) => c && typeof c === "object")
      .map((c) => ({
        campaign: c.campaignName || c.campaign || c.campaignId || "",
        experience: c.experienceName || c.experience || c.experienceId || "",
        userGroup: c.userGroup || "",
        id: c.campaignId || c.id || "",
      }));
  }

  const api = { MAX_BODY, RESPONSE_TTL_MS, isTrackedResponseUrl, parseResponseBody, createMatcher, campaignsServed };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.McpResponses = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
