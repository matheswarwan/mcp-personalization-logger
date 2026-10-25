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

  /**
   * Who sent the event. Evergage beacons carry user.id once identified and
   * user.anonId (or user.encryptedId) before that; Data Cloud Web SDK events
   * carry deviceId, plus an individualId or email on identity events.
   * Returns { key, label, known } or null when the payload names nobody.
   */
  function getUser(payload) {
    if (!payload || typeof payload !== "object") return null;
    const pick = (v) => (typeof v === "string" || typeof v === "number") && String(v).trim() ? String(v).trim() : "";

    const u = payload.user && typeof payload.user === "object" ? payload.user : null;
    if (u) {
      const id = pick(u.id) || pick(u.identities && u.identities.emailAddress);
      if (id) return { key: "id:" + id, label: id, known: true };
      const anon = pick(u.anonId) || pick(u.anonymousId);
      if (anon) return { key: "anon:" + anon, label: "Anonymous " + anon, known: false };
      const enc = pick(u.encryptedId);
      if (enc) return { key: "enc:" + enc, label: "Encrypted " + enc.slice(0, 12) + "...", known: false };
    }
    const topId = pick(payload.userId);
    if (topId) return { key: "id:" + topId, label: topId, known: true };

    if (Array.isArray(payload.events) && payload.events.length) {
      for (const e of payload.events) {
        if (!e) continue;
        const known = pick(e.individualId) || pick(e.partyIdentificationNumber) || pick(e.email);
        if (known) return { key: "id:" + known, label: known, known: true };
      }
      for (const e of payload.events) {
        const device = e && pick(e.deviceId);
        if (device) return { key: "device:" + device, label: "Device " + device, known: false };
      }
    }
    return null;
  }

  const GROUP_FIELDS = {
    user: { label: "User", value: (e) => (e.userLabel ? { key: e.userKey, label: e.userLabel } : null) },
    action: { label: "Action", value: (e) => ({ key: e.action, label: e.action }) },
    pageType: { label: "Page type", value: (e) => (e.pageType ? { key: e.pageType, label: e.pageType } : null) },
    page: { label: "Page", value: (e) => { const p = pagePathOf(e.pageUrl); return p ? { key: p, label: p } : null; } },
    sdk: { label: "SDK", value: (e) => (e.sdk === "data-cloud" ? { key: "data-cloud", label: "Data Cloud Web SDK" } : { key: "evergage", label: "Evergage beacon" }) },
    site: { label: "Site", value: (e) => ({ key: e.site, label: siteLabel(e.site) }) },
  };

  function pagePathOf(url) {
    if (!url) return "";
    try {
      const u = new URL(url);
      return u.host + u.pathname;
    } catch (_) {
      return String(url);
    }
  }

  /** { key, label } of an event for a group field; events without a value get "(none)". */
  function groupOf(event, field) {
    const def = GROUP_FIELDS[field];
    const v = def ? def.value(event) : null;
    return v && v.key ? v : { key: "", label: "(none)" };
  }

  /** Distinct values of a field with counts, most frequent first. */
  function facetCounts(events, field) {
    const map = new Map();
    events.forEach((e) => {
      const g = groupOf(e, field);
      const row = map.get(g.key) || { key: g.key, label: g.label, count: 0, failed: 0, first: e.ts, last: e.ts };
      row.count += 1;
      if (isFailed(e)) row.failed += 1;
      row.first = Math.min(row.first, e.ts);
      row.last = Math.max(row.last, e.ts);
      map.set(g.key, row);
    });
    return [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }

  const BUCKET_SIZES = [
    1e3, 5e3, 15e3, 30e3, 60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3,
    3600e3, 3 * 3600e3, 6 * 3600e3, 12 * 3600e3, 86400e3, 7 * 86400e3,
  ];

  /**
   * Splits events into time buckets for the chart: the smallest standard size
   * that keeps the count at maxBuckets or fewer. from/to default to the events'
   * own span. Each bucket has start, end, count, failed and counts per stack key.
   */
  function timeBuckets(events, opts) {
    const o = opts || {};
    const maxBuckets = o.maxBuckets || 60;
    const times = events.map((e) => e.ts);
    let from = Number.isFinite(o.from) ? o.from : Math.min.apply(null, times);
    let to = Number.isFinite(o.to) ? o.to : Math.max.apply(null, times);
    if (!events.length && !(Number.isFinite(o.from) && Number.isFinite(o.to))) return { size: 0, buckets: [] };
    if (to <= from) to = from + 1000;
    const span = to - from;
    const size = BUCKET_SIZES.find((s) => span / s <= maxBuckets) || Math.ceil(span / maxBuckets);
    const start = Math.floor(from / size) * size;
    const count = Math.max(1, Math.ceil((to - start) / size));
    const buckets = [];
    for (let i = 0; i < count; i++) {
      buckets.push({ start: start + i * size, end: start + (i + 1) * size, count: 0, failed: 0, stacks: {} });
    }
    events.forEach((e) => {
      const i = Math.floor((e.ts - start) / size);
      const b = buckets[i];
      if (!b) return;
      b.count += 1;
      if (isFailed(e)) b.failed += 1;
      if (o.stackBy) {
        const k = groupOf(e, o.stackBy).key;
        b.stacks[k] = (b.stacks[k] || 0) + 1;
      }
    });
    return { size, buckets };
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
            // A batch's nested events lose the batch's top level, so fall back to it.
            ...userFields(getUser(nestedPayload) || getUser(payload)),
          });
          total += 1;
        });
      });

      bySite[site].sort((a, b) => compareByTime(a, b, false));
    });

    return { bySite, total };
  }

  function userFields(user) {
    return { userKey: user ? user.key : "", userLabel: user ? user.label : "", userKnown: !!(user && user.known) };
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
    getUser,
    GROUP_FIELDS,
    groupOf,
    facetCounts,
    timeBuckets,
    pagePathOf,
  };
});
