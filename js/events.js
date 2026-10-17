/*
 * Turns what background.js stores (site key -> [{ "<eventTime>-<capturedAt>": entry }])
 * into flat, sortable events. Shared by the popup and the Event Explorer.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.McpEvents = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  function getStatusCode(entry) {
    if (entry.statusCode !== undefined) return entry.statusCode;
    if (entry["statusCode;"] !== undefined) return entry["statusCode;"];
    return null;
  }

  function getActionName(payload) {
    if (!payload || typeof payload !== "object") return "Unknown event";

    // Data Cloud Web SDK batches: { events: [ { eventType, interactionName, pageName } ] }
    if (Array.isArray(payload.events) && payload.events.length) {
      const preferred =
        payload.events.find(
          (e) =>
            e &&
            (e.eventType === "pageView" ||
              e.interactionName ||
              e.pageName)
        ) || payload.events[0];
      return (
        preferred.interactionName ||
        preferred.pageName ||
        preferred.eventType ||
        "Data Cloud Event"
      );
    }

    return (
      payload.action ||
      payload.itemAction ||
      payload.interaction?.name ||
      payload.name ||
      (payload.flags?.pageView ? "Page View" : null) ||
      "Event"
    );
  }

  function getPageUrl(payload, fallbackUrl) {
    if (Array.isArray(payload?.events) && payload.events.length) {
      const withUrl = payload.events.find((e) => e?.pageUrl || e?.sourceUrl);
      if (withUrl) {
        return withUrl.pageUrl || withUrl.sourceUrl;
      }
    }
    return (
      payload?.source?.url ||
      payload?.url ||
      fallbackUrl ||
      ""
    );
  }

  function getPageType(payload) {
    if (Array.isArray(payload?.events) && payload.events.length) {
      const withType = payload.events.find(
        (e) => e?.sourcePageType || e?.eventType
      );
      if (withType) {
        return withType.sourcePageType || withType.eventType || "";
      }
    }
    return payload?.source?.pageType || payload?.pageType || "";
  }

  function getItemAction(payload) {
    if (Array.isArray(payload?.events) && payload.events.length) {
      const types = payload.events
        .map((e) => e?.eventType)
        .filter(Boolean);
      if (types.length) {
        return types.slice(0, 3).join(", ");
      }
    }
    return payload?.itemAction || payload?.interaction?.name || "";
  }

  function getEventTimestamp(payload, fallbackTs) {
    // Prefer the SDK/event timestamp (ms precision) over extension receive time.
    const normalizeEpoch = (value) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      // Seconds vs milliseconds heuristic
      if (value > 0 && value < 1e11) return value * 1000;
      return value;
    };

    if (payload && typeof payload === "object") {
      if (Array.isArray(payload.events) && payload.events.length) {
        const times = payload.events
          .map((e) => {
            if (!e) return null;
            if (typeof e.dateTime === "string" || e.dateTime instanceof Date) {
              const parsed = Date.parse(e.dateTime);
              return Number.isFinite(parsed) ? parsed : null;
            }
            return normalizeEpoch(e.dateTime) || normalizeEpoch(e.time);
          })
          .filter((t) => Number.isFinite(t));
        if (times.length) {
          // Use the newest nested event time for the batch card.
          return Math.max.apply(null, times);
        }
      }

      const sourceTime = normalizeEpoch(payload.source && payload.source.time);
      if (sourceTime != null) return sourceTime;

      const topTime = normalizeEpoch(payload.time);
      if (topTime != null) return topTime;

      if (typeof payload.dateTime === "string") {
        const parsed = Date.parse(payload.dateTime);
        if (Number.isFinite(parsed)) return parsed;
      }
    }

    const fallback = Number(fallbackTs);
    return Number.isFinite(fallback) ? fallback : Date.now();
  }

  function compareByTime(a, b, ascending) {
    const diff = a.ts - b.ts;
    if (diff !== 0) {
      return ascending ? diff : -diff;
    }
    // Stable tie-breaker when timestamps collide.
    if (a.index !== b.index) {
      return ascending ? a.index - b.index : b.index - a.index;
    }
    return String(a.id).localeCompare(String(b.id));
  }

  function normalizeEvents(raw) {
    const bySite = {};
    let total = 0;

    Object.keys(raw).forEach((site) => {
      if (String(site).indexOf("__mcp_") === 0) {
        return;
      }
      const rows = Array.isArray(raw[site]) ? raw[site] : [];
      bySite[site] = [];

      rows.forEach((row, index) => {
        const key = Object.keys(row || {})[0];
        if (!key) return;
        const entry = row[key] || {};
        const payload = entry.payload || {};
        const capturedAt = Number(entry.eventTime || entry.datetime || key);
        const statusCode = getStatusCode(entry);
        const requestUrl = entry.url || "";
        const sdk =
          entry.sdk ||
          (requestUrl.indexOf("c360a.salesforce.com") > -1 ? "data-cloud" : "evergage");

        // Expand Data Cloud batches so each nested event sorts on its own ms timestamp.
        const nestedEvents =
          Array.isArray(payload.events) && payload.events.length > 1
            ? payload.events
            : null;

        const units = nestedEvents
          ? nestedEvents.map((nested, nestedIndex) => ({
              nestedPayload: { events: [nested] },
              nestedIndex,
            }))
          : [{ nestedPayload: payload, nestedIndex: 0 }];

        units.forEach(({ nestedPayload, nestedIndex }) => {
          const ts = getEventTimestamp(
            nestedPayload,
            Number.isFinite(capturedAt) ? capturedAt : Date.now()
          );
          if (!Number.isFinite(ts)) return;

          bySite[site].push({
            id: site + "::" + key + "::" + index + "::" + nestedIndex,
            site,
            index: index * 1000 + nestedIndex,
            ts,
            capturedAt: Number.isFinite(capturedAt) ? capturedAt : ts,
            statusCode,
            payload: nestedPayload,
            url: requestUrl,
            sdk,
            action: getActionName(nestedPayload),
            itemAction: getItemAction(nestedPayload),
            pageUrl: getPageUrl(nestedPayload, requestUrl),
            pageType: getPageType(nestedPayload),
          });
          total += 1;
        });
      });

      bySite[site].sort((a, b) => compareByTime(a, b, false));
    });

    return { bySite, total };
  }

  function isFailed(event) {
    return (
      event.statusCode == null || event.statusCode < 200 || event.statusCode >= 400
    );
  }

  function siteLabel(site) {
    return String(site || "").split(" | ")[0] || String(site || "");
  }

  function siteDetail(site) {
    return String(site || "").split(" | ").slice(1).join(" | ");
  }

  return {
    getStatusCode,
    getActionName,
    getPageUrl,
    getPageType,
    getItemAction,
    getEventTimestamp,
    compareByTime,
    normalizeEvents,
    isFailed,
    siteLabel,
    siteDetail,
  };
});
