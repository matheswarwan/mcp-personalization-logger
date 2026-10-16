/*
 * Export helpers for the Event Explorer: Markdown for AI agents, JSON and a
 * self-contained HTML report. Pure functions, no DOM or chrome.* access, so
 * they run in the extension page and in Node tests alike.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.McpExport = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  const MASK = "[masked]";

  // Keys whose values are personal data or credentials.
  const SENSITIVE_KEY =
    /(e-?mail|phone|mobile|first_?name|last_?name|full_?name|street|address|postal|zip_?code|birth|dob|password|passwd|secret|token|authorization|cookie|ssn)/i;

  // Emails, also URL-encoded (%40) as they appear in page URLs.
  const EMAIL = /[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

  const DEFAULT_AGENT_PAYLOAD_CHARS = 4000;

  function maskValue(value) {
    if (typeof value === "string") return value.replace(EMAIL, MASK);
    if (Array.isArray(value)) return value.map(maskValue);
    if (value && typeof value === "object") {
      const out = {};
      Object.keys(value).forEach((key) => {
        const v = value[key];
        out[key] =
          SENSITIVE_KEY.test(key) && v !== null && typeof v !== "object"
            ? MASK
            : maskValue(v);
      });
      return out;
    }
    return value;
  }

  // GET beacons carry the whole payload base64-encoded in ?event=. The decoded
  // payload is exported separately, so drop the blob from the URL.
  function shortenRequestUrl(url) {
    if (!url) return "";
    try {
      const parsed = new URL(url);
      if (parsed.searchParams.has("event")) {
        parsed.searchParams.set("event", "DECODED_BELOW");
      }
      return decodeURIComponent(parsed.toString());
    } catch (_) {
      return String(url);
    }
  }

  function statusLabel(statusCode) {
    return statusCode == null ? "transport error" : String(statusCode);
  }

  function isError(statusCode) {
    return statusCode == null || statusCode < 200 || statusCode >= 400;
  }

  function sdkLabel(sdk) {
    return sdk === "data-cloud" ? "Data Cloud Web SDK" : "Evergage (MCP) beacon";
  }

  function isoLocal(ts) {
    const d = new Date(ts);
    const pad = (n, w) => String(n).padStart(w || 2, "0");
    const offsetMin = -d.getTimezoneOffset();
    const sign = offsetMin >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMin);
    return (
      d.getFullYear() +
      "-" +
      pad(d.getMonth() + 1) +
      "-" +
      pad(d.getDate()) +
      " " +
      pad(d.getHours()) +
      ":" +
      pad(d.getMinutes()) +
      ":" +
      pad(d.getSeconds()) +
      "." +
      pad(d.getMilliseconds(), 3) +
      " " +
      sign +
      pad(Math.floor(abs / 60)) +
      ":" +
      pad(abs % 60)
    );
  }

  /**
   * events: normalized explorer events ({ ts, site, sdk, action, itemAction,
   * pageType, pageUrl, statusCode, url, payload }).
   * meta: { extensionVersion, scope, filters: { timeRange, search, status },
   * exportedAt, maskPersonalData }.
   */
  function buildExportModel(events, meta) {
    const options = meta || {};
    const mask = options.maskPersonalData !== false;
    const sorted = (events || []).slice().sort((a, b) => a.ts - b.ts);

    const rows = sorted.map((event, index) => {
      const payload = mask ? maskValue(event.payload || {}) : event.payload || {};
      // The explorer falls back to the beacon URL when a payload has no page
      // URL; that is not a page, so leave it out.
      const rawPage = event.pageUrl && event.pageUrl !== event.url ? event.pageUrl : "";
      const pageUrl = mask ? maskValue(rawPage) : rawPage;
      const requestUrl = shortenRequestUrl(event.url);
      return {
        n: index + 1,
        timestamp: event.ts,
        isoTime: new Date(event.ts).toISOString(),
        localTime: isoLocal(event.ts),
        site: event.site || "",
        sdk: event.sdk || "evergage",
        action: event.action || "Event",
        itemAction: event.itemAction || "",
        pageType: event.pageType || "",
        pageUrl,
        statusCode: event.statusCode == null ? null : event.statusCode,
        requestUrl: mask ? maskValue(requestUrl) : requestUrl,
        payload,
      };
    });

    const byAction = {};
    const pages = {};
    const sites = {};
    rows.forEach((row) => {
      const a = (byAction[row.action] = byAction[row.action] || {
        action: row.action,
        count: 0,
        errors: 0,
      });
      a.count += 1;
      if (isError(row.statusCode)) a.errors += 1;
      if (row.pageUrl) pages[row.pageUrl] = (pages[row.pageUrl] || 0) + 1;
      if (row.site) sites[row.site] = (sites[row.site] || 0) + 1;
    });

    const toSortedList = (obj, keyName) =>
      Object.keys(obj)
        .map((k) => ({ [keyName]: k, count: obj[k] }))
        .sort((x, y) => y.count - x.count);

    return {
      title: "Marketing Cloud Personalization events",
      exportedAt: options.exportedAt || new Date().toISOString(),
      extensionVersion: options.extensionVersion || "",
      scope: options.scope || "",
      filters: options.filters || {},
      personalDataMasked: mask,
      summary: {
        count: rows.length,
        errors: rows.filter((r) => isError(r.statusCode)).length,
        firstEvent: rows.length ? rows[0].isoTime : null,
        lastEvent: rows.length ? rows[rows.length - 1].isoTime : null,
        sites: toSortedList(sites, "site"),
        actions: Object.keys(byAction)
          .map((k) => byAction[k])
          .sort((x, y) => y.count - x.count),
        pages: toSortedList(pages, "url"),
      },
      events: rows,
    };
  }

  function describeFilters(filters) {
    const parts = [];
    if (filters.timeRange) parts.push("time range " + filters.timeRange);
    if (filters.search) parts.push('search "' + filters.search + '"');
    if (filters.status && filters.status !== "all") {
      parts.push("status " + filters.status);
    }
    return parts.length ? parts.join(", ") : "none";
  }

  function mdCell(value) {
    return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  }

  function fence(text) {
    // Use a fence longer than any backtick run inside the payload.
    const runs = String(text).match(/`+/g) || [];
    const longest = runs.reduce((m, r) => Math.max(m, r.length), 0);
    return "`".repeat(Math.max(3, longest + 1));
  }

  /**
   * options.maxPayloadChars: cut each payload's JSON at this length (0 or
   * missing means no limit). Copy for agent uses a limit so the text fits in a
   * prompt; Download Markdown does not.
   */
  function toMarkdown(model, options) {
    const maxChars = (options && options.maxPayloadChars) || 0;
    const s = model.summary;
    const lines = [];

    lines.push("# " + model.title, "");
    lines.push(
      "Captured in the browser by the Interaction Studio (MCP) Logger extension" +
        (model.extensionVersion ? " " + model.extensionVersion : "") +
        ". Each event is a request the page sent to Marketing Cloud Personalization (Evergage) or the Data Cloud Web SDK; the payload is the decoded request body.",
      ""
    );
    lines.push("- Exported: " + model.exportedAt);
    if (model.scope) lines.push("- Scope: " + model.scope);
    lines.push("- Filters: " + describeFilters(model.filters));
    lines.push(
      "- Events: " +
        s.count +
        (s.count ? " (" + s.firstEvent + " to " + s.lastEvent + ")" : "") +
        ", " +
        s.errors +
        " failed"
    );
    lines.push(
      "- Personal data: " +
        (model.personalDataMasked
          ? "masked (emails and fields such as email, phone, name, address, token show as " + MASK + ")"
          : "not masked")
    );
    lines.push("");

    if (!s.count) {
      lines.push("No events match the current filters.");
      return lines.join("\n") + "\n";
    }

    lines.push("## Summary", "");
    lines.push("| Action | Count | Failed |", "| --- | ---: | ---: |");
    s.actions.forEach((a) => {
      lines.push("| " + mdCell(a.action) + " | " + a.count + " | " + a.errors + " |");
    });
    lines.push("");

    if (s.sites.length > 1) {
      lines.push("Sites:", "");
      s.sites.forEach((x) => lines.push("- " + x.site + " (" + x.count + ")"));
      lines.push("");
    }

    if (s.pages.length) {
      lines.push("Pages:", "");
      s.pages.slice(0, 20).forEach((p) => lines.push("- " + p.url + " (" + p.count + ")"));
      if (s.pages.length > 20) lines.push("- ... " + (s.pages.length - 20) + " more");
      lines.push("");
    }

    const failed = model.events.filter((e) => isError(e.statusCode));
    if (failed.length) {
      lines.push("Failed requests:", "");
      failed.forEach((e) =>
        lines.push(
          "- #" + e.n + " " + e.action + " at " + e.localTime + ": " + statusLabel(e.statusCode)
        )
      );
      lines.push("");
    }

    lines.push("## Events (oldest first)", "");
    model.events.forEach((e) => {
      lines.push(
        "### " + e.n + ". " + e.action + " (" + e.localTime + ", " + statusLabel(e.statusCode) + ")",
        ""
      );
      if (e.itemAction) lines.push("- Item action: " + e.itemAction);
      if (e.pageType) lines.push("- Page type: " + e.pageType);
      if (e.pageUrl) lines.push("- Page: " + e.pageUrl);
      lines.push("- Site: " + e.site);
      lines.push("- SDK: " + sdkLabel(e.sdk));
      if (e.requestUrl) lines.push("- Request: " + e.requestUrl);
      lines.push("");

      let json = JSON.stringify(e.payload, null, 2);
      let cut = 0;
      if (maxChars && json.length > maxChars) {
        cut = json.length - maxChars;
        json = json.slice(0, maxChars);
      }
      const f = fence(json);
      lines.push(f + "json", json, f);
      if (cut) {
        lines.push(
          "",
          "(Payload cut short: " + cut + " more characters. Use Download Markdown or JSON for the full payload.)"
        );
      }
      lines.push("");
    });

    return lines.join("\n");
  }

  function toJson(model) {
    return JSON.stringify(model, null, 2);
  }

  function esc(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function toHtmlReport(model) {
    const s = model.summary;
    const actionRows = s.actions
      .map(
        (a) =>
          "<tr><td>" +
          esc(a.action) +
          '</td><td class="num">' +
          a.count +
          '</td><td class="num' +
          (a.errors ? " bad" : "") +
          '">' +
          a.errors +
          "</td></tr>"
      )
      .join("");

    const pageItems = s.pages
      .slice(0, 50)
      .map((p) => "<li>" + esc(p.url) + ' <span class="muted">(' + p.count + ")</span></li>")
      .join("");

    const events = model.events
      .map((e) => {
        const bad = isError(e.statusCode);
        const facts = [
          e.itemAction ? ["Item action", e.itemAction] : null,
          e.pageType ? ["Page type", e.pageType] : null,
          e.pageUrl ? ["Page", e.pageUrl] : null,
          ["Site", e.site],
          ["SDK", sdkLabel(e.sdk)],
          e.requestUrl ? ["Request", e.requestUrl] : null,
        ]
          .filter(Boolean)
          .map((f) => "<dt>" + esc(f[0]) + "</dt><dd>" + esc(f[1]) + "</dd>")
          .join("");
        return (
          '<details class="event' +
          (bad ? " failed" : "") +
          '"><summary><span class="n">' +
          e.n +
          '</span><span class="action">' +
          esc(e.action) +
          '</span><span class="status ' +
          (bad ? "bad" : "ok") +
          '">' +
          esc(statusLabel(e.statusCode)) +
          '</span><span class="time">' +
          esc(e.localTime) +
          "</span></summary><dl>" +
          facts +
          "</dl><pre>" +
          esc(JSON.stringify(e.payload, null, 2)) +
          "</pre></details>"
        );
      })
      .join("\n");

    const scopeLine = model.scope ? "<li>Scope: " + esc(model.scope) + "</li>" : "";

    return (
      "<!doctype html>\n" +
      '<html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      "<title>MCP Event Report</title><style>" +
      ":root{--bg:#f6f8fa;--surface:#fff;--ink:#1c2b36;--muted:#5f7383;--line:#d5e0e8;--ok:#1f8a5b;--bad:#c23b3b;--code:#f0f4f7}" +
      "@media (prefers-color-scheme:dark){:root{--bg:#11171c;--surface:#1a2228;--ink:#e3eaef;--muted:#93a4b1;--line:#2c3a44;--ok:#4cc38a;--bad:#ef6f6f;--code:#141b20}}" +
      "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif}" +
      "main{max-width:1000px;margin:0 auto;padding:24px 16px 48px}h1{font-size:1.4rem;margin:0 0 4px}h2{font-size:1.1rem;margin:28px 0 10px}" +
      ".muted{color:var(--muted)}ul.meta{padding-left:18px;color:var(--muted)}" +
      "table{border-collapse:collapse;width:100%;background:var(--surface);border:1px solid var(--line)}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line)}" +
      "td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}.bad{color:var(--bad)}" +
      "ol.pages{background:var(--surface);border:1px solid var(--line);padding:10px 10px 10px 34px;word-break:break-all;margin:0}" +
      "details.event{background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--ok);border-radius:6px;margin:0 0 8px}" +
      "details.event.failed{border-left-color:var(--bad)}" +
      "summary{cursor:pointer;display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline;padding:8px 12px}" +
      "summary .n{color:var(--muted);min-width:2.5em}summary .action{font-weight:600;flex:1 1 200px}" +
      "summary .status.ok{color:var(--ok)}summary .status.bad{color:var(--bad)}summary .time{color:var(--muted);font-variant-numeric:tabular-nums}" +
      "dl{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:0;padding:4px 12px 8px;font-size:.9rem}dt{color:var(--muted)}dd{margin:0;word-break:break-all}" +
      "pre{margin:0;padding:12px;background:var(--code);border-top:1px solid var(--line);overflow:auto;font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}" +
      "</style></head><body><main>" +
      "<h1>" +
      esc(model.title) +
      "</h1>" +
      '<p class="muted">Captured by the Interaction Studio (MCP) Logger extension' +
      (model.extensionVersion ? " " + esc(model.extensionVersion) : "") +
      ".</p>" +
      '<ul class="meta"><li>Exported: ' +
      esc(model.exportedAt) +
      "</li>" +
      scopeLine +
      "<li>Filters: " +
      esc(describeFilters(model.filters)) +
      "</li><li>Events: " +
      s.count +
      (s.count ? " (" + esc(s.firstEvent) + " to " + esc(s.lastEvent) + ")" : "") +
      ", " +
      s.errors +
      " failed</li><li>Personal data: " +
      (model.personalDataMasked ? "masked" : "not masked") +
      "</li></ul>" +
      (s.count
        ? "<h2>Summary</h2><table><thead><tr><th>Action</th><th class=\"num\">Count</th><th class=\"num\">Failed</th></tr></thead><tbody>" +
          actionRows +
          "</tbody></table>" +
          (pageItems ? "<h2>Pages</h2><ol class=\"pages\">" + pageItems + "</ol>" : "") +
          "<h2>Events (oldest first)</h2>" +
          events
        : "<p>No events match the current filters.</p>") +
      "</main></body></html>\n"
    );
  }

  function fileStamp(date) {
    const d = date || new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return (
      d.getFullYear() +
      pad(d.getMonth() + 1) +
      pad(d.getDate()) +
      "-" +
      pad(d.getHours()) +
      pad(d.getMinutes()) +
      pad(d.getSeconds())
    );
  }

  function slug(value, fallback) {
    const out = String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40);
    return out || fallback || "events";
  }

  return {
    MASK,
    DEFAULT_AGENT_PAYLOAD_CHARS,
    maskValue,
    shortenRequestUrl,
    buildExportModel,
    toMarkdown,
    toJson,
    toHtmlReport,
    fileStamp,
    slug,
  };
});
