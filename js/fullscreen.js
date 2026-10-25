(function () {
  const ALL_SITES = "__all__";

  const state = {
    raw: {},
    sites: [],
    activeSite: null,
    timeRange: "24h",
    sort: "desc",
    search: "",
    status: "all",
    customFrom: null,
    customTo: null,
    selectedEventId: null,
    // Ticked events (ids), kept across filters and site changes.
    checked: new Set(),
    lastCheckedId: null,
    eventsBySite: {},
    total: 0,
    // Feedback #141: filters by field value, grouping and the chart.
    facets: { user: "", action: "", pageType: "", sdk: "" },
    groupBy: "",
    collapsed: new Set(),
    chartOn: readPref("mcpChartOn", "1") === "1",
    chartTable: false,
    rangeHistory: [],
    colorSlots: {},
  };

  const els = {
    tabs: document.getElementById("fsSiteTabs"),
    timeline: document.getElementById("fsTimeline"),
    detail: document.getElementById("fsDetailBody"),
    detailTitle: document.getElementById("fsDetailTitle"),
    totalStat: document.getElementById("fsTotalStat"),
    filteredStat: document.getElementById("fsFilteredStat"),
    search: document.getElementById("fsSearch"),
    customRange: document.getElementById("fsCustomRange"),
    from: document.getElementById("fsFrom"),
    to: document.getElementById("fsTo"),
    checkAll: document.getElementById("fsCheckAll"),
    selBar: document.getElementById("fsSelBar"),
    selCount: document.getElementById("fsSelCount"),
    selHidden: document.getElementById("fsSelHidden"),
    selMask: document.getElementById("fsSelMask"),
  };

  const { compareByTime, normalizeEvents, isFailed, siteLabel, siteDetail, groupOf, facetCounts, timeBuckets, GROUP_FIELDS } = McpEvents;

  const FACETS = ["user", "action", "pageType", "sdk"];
  const SERIES_SLOTS = 5;
  const OTHER_KEY = "__other__";

  function readPref(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : v;
    } catch (_) {
      return fallback;
    }
  }

  function writePref(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (_) {}
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function downloadText(text, filename, type) {
    const blob = new Blob([text], { type: type + ";charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function flashElementLabel(btn, label) {
    if (!btn) return;
    if (!btn.dataset.label) btn.dataset.label = btn.textContent.trim();
    btn.textContent = label;
    clearTimeout(btn._flashTimer);
    btn._flashTimer = setTimeout(() => {
      btn.textContent = btn.dataset.label;
    }, 1400);
  }

  function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
  }

  function getData() {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (items) => resolve(items || {}));
    });
  }

  function getRangeBounds() {
    const now = moment();
    switch (state.timeRange) {
      case "15m":
        return { from: now.clone().subtract(15, "minutes"), to: now };
      case "1h":
        return { from: now.clone().subtract(1, "hour"), to: now };
      case "24h":
        return { from: now.clone().subtract(24, "hours"), to: now };
      case "today":
        return { from: now.clone().startOf("day"), to: now.clone().endOf("day") };
      case "7d":
        return { from: now.clone().subtract(7, "days"), to: now };
      case "custom": {
        const from = state.customFrom ? moment(state.customFrom) : null;
        const to = state.customTo ? moment(state.customTo) : null;
        return {
          from: from && from.isValid() ? from : null,
          to: to && to.isValid() ? to : null,
        };
      }
      case "all":
      default:
        return { from: null, to: null };
    }
  }

  function allEvents() {
    return state.sites.reduce(
      (all, site) => all.concat(state.eventsBySite[site] || []),
      []
    );
  }

  function getFilteredEvents() {
    return filterEvents(siteEvents());
  }

  function getAllSitesFilteredEvents() {
    return filterEvents(allEvents());
  }

  /** Time, status and search only: the facet lists count within these. */
  function baseFilter(events) {
    const { from, to } = getRangeBounds();
    const q = state.search.trim().toLowerCase();

    return events.filter((event) => {
      const m = moment(event.ts);
      if (from && m.isBefore(from)) return false;
      if (to && m.isAfter(to)) return false;
      if (state.status === "failed" && !isFailed(event)) return false;
      if (state.status === "ok" && isFailed(event)) return false;
      if (!q) return true;
      const haystack = [
        event.action,
        event.itemAction,
        event.pageUrl,
        event.pageType,
        event.url,
        JSON.stringify(event.payload || {}),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }

  function matchesFacets(event) {
    return FACETS.every((f) => !state.facets[f] || groupOf(event, f).key === state.facets[f]);
  }

  function filterEvents(events) {
    const filtered = baseFilter(events).filter(matchesFacets);
    filtered.sort((a, b) => compareByTime(a, b, state.sort === "asc"));
    return filtered;
  }

  function siteEvents() {
    if (!state.activeSite) return [];
    return state.activeSite === ALL_SITES ? allEvents() : state.eventsBySite[state.activeSite] || [];
  }

  function hasExtraFilters() {
    return FACETS.some((f) => state.facets[f]);
  }

  function findSelected(events) {
    return (events || getFilteredEvents()).find((e) => e.id === state.selectedEventId) || null;
  }

  /* ---------- Export ---------- */

  function renderExportCounts(viewCount) {
    document.getElementById("fsExportViewCount").textContent = String(viewCount);
    const selected = checkedEvents().length;
    document.getElementById("fsExportSelCount").textContent = String(selected);
    const selRadio = document.querySelector('input[name="fsExportScope"][value="selected"]');
    selRadio.disabled = !selected;
    if (!selected && selRadio.checked) {
      document.querySelector('input[name="fsExportScope"][value="view"]').checked = true;
    }
    document.getElementById("fsExportAllCount").textContent = String(
      getAllSitesFilteredEvents().length
    );
  }

  function describeTimeRange() {
    const labels = {
      "15m": "Last 15 minutes",
      "1h": "Last hour",
      "24h": "Last 24 hours",
      today: "Today",
      "7d": "Last 7 days",
      all: "All",
      custom: "Custom",
    };
    const label = labels[state.timeRange] || state.timeRange;
    if (state.timeRange !== "custom") return label;
    return label + " (" + (state.customFrom || "start") + " to " + (state.customTo || "now") + ")";
  }

  function getExtensionVersion() {
    try {
      return chrome.runtime.getManifest().version;
    } catch (_) {
      return "";
    }
  }

  function buildModel(events, scope, maskPersonalData, noFilters) {
    return McpExport.buildExportModel(events, {
      extensionVersion: getExtensionVersion(),
      scope,
      maskPersonalData,
      // Ticked events are picked by hand, so the view's filters don't apply.
      filters: noFilters
        ? {}
        : {
            timeRange: describeTimeRange(),
            search: state.search.trim(),
            status: state.status,
            facets: FACETS.filter((f) => state.facets[f]).map((f) => ({
              field: GROUP_FIELDS[f].label,
              value: facetLabel(f, state.facets[f]),
            })),
          },
    });
  }

  function setExportMenuOpen(open) {
    document.getElementById("fsExportMenu").hidden = !open;
    document.getElementById("BtnFsExport").setAttribute("aria-expanded", open ? "true" : "false");
  }

  function viewScopeLabel() {
    return state.activeSite === ALL_SITES ? "All sites" : state.activeSite;
  }

  /** scope: "view", "all-sites" or "selected". */
  function exportSource(scope) {
    if (scope === "selected") {
      const events = checkedEvents();
      return { events, label: "Selected events", slug: "selected", noFilters: true };
    }
    const allSites = scope === "all-sites" || state.activeSite === ALL_SITES;
    return {
      events: allSites ? getAllSitesFilteredEvents() : getFilteredEvents(),
      label: allSites ? "All sites" : viewScopeLabel(),
      slug: allSites ? "all-sites" : McpExport.slug(siteLabel(state.activeSite)),
      noFilters: false,
    };
  }

  async function runExport(kind, triggerBtn, scope, mask) {
    if (!scope) {
      const scopeInput = document.querySelector('input[name="fsExportScope"]:checked');
      scope = scopeInput ? scopeInput.value : "view";
    }
    if (mask === undefined) mask = document.getElementById("fsExportMask").checked;
    const source = exportSource(scope);
    const events = source.events;
    if (!events.length) {
      flashElementLabel(triggerBtn, "No events to export");
      return;
    }
    const model = buildModel(events, source.label, mask, source.noFilters);
    const base = "mcp-events-" + source.slug + "-" + McpExport.fileStamp();

    if (kind === "agent") {
      const text = McpExport.toMarkdown(model, {
        maxPayloadChars: McpExport.DEFAULT_AGENT_PAYLOAD_CHARS,
      });
      try {
        await navigator.clipboard.writeText(text);
        flashElementLabel(triggerBtn, "Copied " + plural(events.length, "event"));
      } catch (e) {
        console.error("Copy failed", e);
        flashElementLabel(triggerBtn, "Copy failed");
      }
      return;
    }
    if (kind === "copy-json") {
      try {
        await navigator.clipboard.writeText(McpExport.toJson(model));
        flashElementLabel(triggerBtn, "Copied " + plural(events.length, "event"));
      } catch (e) {
        console.error("Copy failed", e);
        flashElementLabel(triggerBtn, "Copy failed");
      }
      return;
    }
    if (kind === "md") {
      downloadText(McpExport.toMarkdown(model), base + ".md", "text/markdown");
    } else if (kind === "json") {
      downloadText(McpExport.toJson(model), base + ".json", "application/json");
    } else if (kind === "html") {
      downloadText(McpExport.toHtmlReport(model), base + ".html", "text/html");
    }
    flashElementLabel(triggerBtn, "Downloaded");
  }

  /* ---------- Selection (ticked events) ---------- */

  function checkedEvents() {
    if (!state.checked.size) return [];
    return allEvents()
      .filter((e) => state.checked.has(e.id))
      .sort((a, b) => compareByTime(a, b, state.sort === "asc"));
  }

  function setChecked(ids, on) {
    ids.forEach((id) => (on ? state.checked.add(id) : state.checked.delete(id)));
    renderChecks();
  }

  /** Tick or untick one event; with shift, everything shown between it and the last one ticked. */
  function toggleCheck(id, range) {
    const anchor = state.lastCheckedId;
    state.lastCheckedId = id;
    if (range && anchor && anchor !== id) {
      const shown = getFilteredEvents().map((e) => e.id);
      const a = shown.indexOf(anchor);
      const b = shown.indexOf(id);
      if (a >= 0 && b >= 0) {
        // The range takes the anchor's state, as in Gmail.
        setChecked(shown.slice(Math.min(a, b), Math.max(a, b) + 1), state.checked.has(anchor));
        return;
      }
    }
    setChecked([id], !state.checked.has(id));
  }

  /** Update checkboxes, the header box and the selection bar without a full redraw. */
  function renderChecks() {
    els.timeline.querySelectorAll(".fs-event").forEach((row) => {
      const on = state.checked.has(row.getAttribute("data-event-id"));
      row.classList.toggle("checked", on);
      const box = row.querySelector(".ex-check");
      if (box) box.checked = on;
    });
    const shown = getFilteredEvents();
    const shownChecked = shown.filter((e) => state.checked.has(e.id)).length;
    els.checkAll.checked = !!shown.length && shownChecked === shown.length;
    els.checkAll.indeterminate = shownChecked > 0 && shownChecked < shown.length;
    els.checkAll.disabled = !shown.length;

    const total = checkedEvents().length;
    els.selBar.hidden = !total;
    els.selCount.textContent = plural(total, "event") + " selected";
    const hidden = total - shownChecked;
    els.selHidden.textContent = hidden > 0 ? "(" + hidden + " not in this view)" : "";
    renderExportCounts(shown.length);
  }

  /* ---------- Filters by field, grouping (feedback #141) ---------- */

  const facetSelects = {
    user: document.getElementById("fsFilterUser"),
    action: document.getElementById("fsFilterAction"),
    pageType: document.getElementById("fsFilterPageType"),
    sdk: document.getElementById("fsFilterSdk"),
  };
  // Labels of the chosen values, kept when a value drops out of the current range.
  const facetLabels = {};

  function facetLabel(field, key) {
    return facetLabels[field + "\u0000" + key] || key || "(none)";
  }

  function shortLabel(text, max) {
    const t = String(text);
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
  }

  function renderFacets() {
    const base = baseFilter(siteEvents());
    FACETS.forEach((field) => {
      const sel = facetSelects[field];
      const chosen = state.facets[field];
      const rows = facetCounts(base, field);
      rows.forEach((r) => (facetLabels[field + "\u0000" + r.key] = r.label));
      if (chosen && !rows.some((r) => r.key === chosen)) {
        rows.unshift({ key: chosen, label: facetLabel(field, chosen), count: 0 });
      }
      const any = field === "user" ? "Anyone" : "Any";
      const opts = ['<option value="">' + any + " (" + rows.length + ")</option>"];
      rows.slice(0, 500).forEach((r) => {
        opts.push(
          '<option value="' + escapeHtml(r.key) + '"' + (r.key === chosen ? " selected" : "") + ">" +
            escapeHtml(shortLabel(r.label, 60)) + " (" + r.count + ")</option>"
        );
      });
      sel.innerHTML = opts.join("");
      sel.value = chosen;
      sel.classList.toggle("on", !!chosen);
      sel.title = chosen ? facetLabel(field, chosen) : "";
    });
    document.getElementById("BtnFsClearFilters").hidden = !hasExtraFilters();
  }

  function setFacet(field, key, label) {
    if (!FACETS.includes(field)) return;
    if (label) facetLabels[field + "\u0000" + key] = label;
    state.facets[field] = key;
    renderTimeline();
  }

  /* ---------- Events over time chart ---------- */

  const chartEls = {
    box: document.getElementById("fsChart"),
    plot: document.getElementById("fsChartPlot"),
    legend: document.getElementById("fsChartLegend"),
    tip: document.getElementById("fsChartTip"),
    title: document.getElementById("fsChartTitle"),
    scale: document.getElementById("fsChartScale"),
    back: document.getElementById("BtnFsChartBack"),
    tableBtn: document.getElementById("BtnFsChartTable"),
  };
  let chartModel = null;

  function sizeLabel(ms) {
    if (ms < 60e3) return ms / 1e3 + " second" + (ms === 1e3 ? "" : "s");
    if (ms < 3600e3) return ms / 60e3 + " minute" + (ms === 60e3 ? "" : "s");
    if (ms < 86400e3) return ms / 3600e3 + " hour" + (ms === 3600e3 ? "" : "s");
    return ms / 86400e3 + " day" + (ms === 86400e3 ? "" : "s");
  }

  function bucketTime(start, size) {
    const fmt = size < 60e3 ? "HH:mm:ss" : size < 86400e3 ? "HH:mm" : "MMM D";
    const day = size < 86400e3 ? "MMM D " : "";
    return moment(start).format(day + fmt) + " to " + moment(start + size).format(fmt);
  }

  /**
   * Series for the chart: by status when nothing is grouped, else the five
   * biggest groups plus Other. A value keeps its color slot while it stays
   * in the top five, so filtering doesn't repaint the survivors.
   */
  function chartSeries(events) {
    if (!state.groupBy) {
      return {
        field: "",
        keyOf: (e) => (isFailed(e) ? "failed" : "ok"),
        series: [
          { key: "ok", label: "OK", color: "var(--series-1)" },
          { key: "failed", label: "Failed", color: "var(--series-failed)" },
        ],
      };
    }
    const field = state.groupBy;
    const top = facetCounts(events, field).slice(0, SERIES_SLOTS);
    const slots = state.colorSlots[field] || (state.colorSlots[field] = {});
    const topKeys = new Set(top.map((t) => t.key));
    Object.keys(slots).forEach((k) => topKeys.has(k) || delete slots[k]);
    const used = new Set(Object.values(slots));
    top.forEach((t) => {
      if (slots[t.key] != null) return;
      let i = 1;
      while (used.has(i)) i++;
      slots[t.key] = i;
      used.add(i);
    });
    const series = top.map((t) => ({ key: t.key, label: t.label, color: "var(--series-" + slots[t.key] + ")" }));
    const total = events.length;
    const shown = top.reduce((n, t) => n + t.count, 0);
    if (total > shown) series.push({ key: OTHER_KEY, label: "Other", color: "var(--series-other)" });
    return {
      field,
      keyOf: (e) => {
        const k = groupOf(e, field).key;
        return topKeys.has(k) ? k : OTHER_KEY;
      },
      series,
    };
  }

  function renderChart(events) {
    chartEls.box.hidden = !state.chartOn;
    chartEls.back.hidden = !state.rangeHistory.length;
    if (!state.chartOn) return;
    chartEls.title.textContent = state.groupBy
      ? "Events over time by " + GROUP_FIELDS[state.groupBy].label.toLowerCase()
      : "Events over time";
    if (!events.length) {
      chartModel = null;
      chartEls.scale.textContent = "";
      chartEls.plot.innerHTML = '<p class="ex-muted">No events in this range.</p>';
      chartEls.legend.innerHTML = "";
      return;
    }
    const { from, to } = getRangeBounds();
    const sized = timeBuckets(events, {
      from: from ? from.valueOf() : undefined,
      to: to ? Math.min(to.valueOf(), Date.now()) : undefined,
      maxBuckets: 60,
    });
    const spec = chartSeries(events);
    sized.buckets.forEach((b) => (b.stacks = {}));
    events.forEach((e) => {
      const b = sized.buckets[Math.floor((e.ts - sized.buckets[0].start) / sized.size)];
      if (b) b.stacks[spec.keyOf(e)] = (b.stacks[spec.keyOf(e)] || 0) + 1;
    });
    sized.buckets.forEach((b) => (b.count = Object.values(b.stacks).reduce((n, v) => n + v, 0)));
    chartModel = { ...sized, spec };
    chartEls.scale.textContent = "Each bar: " + sizeLabel(sized.size) + ". Click a bar to zoom in.";

    chartEls.legend.innerHTML = spec.series
      .map(
        (s) =>
          '<button type="button" data-key="' + escapeHtml(s.key) + '" title="Show only ' + escapeHtml(s.label) + '">' +
          '<span class="ex-swatch" style="background:' + s.color + '"></span><span>' + escapeHtml(shortLabel(s.label, 40)) + "</span></button>"
      )
      .join("");

    if (state.chartTable) {
      renderChartTable();
    } else {
      drawChart();
    }
  }

  function renderChartTable() {
    const { buckets, size, spec } = chartModel;
    const head =
      "<tr><th>Time</th><th class=\"num\">Events</th>" +
      spec.series.map((s) => '<th class="num">' + escapeHtml(shortLabel(s.label, 24)) + "</th>").join("") +
      "</tr>";
    const rows = buckets
      .filter((b) => b.count)
      .map(
        (b) =>
          "<tr><td>" + escapeHtml(bucketTime(b.start, size)) + '</td><td class="num">' + b.count + "</td>" +
          spec.series.map((s) => '<td class="num">' + (b.stacks[s.key] || 0) + "</td>").join("") +
          "</tr>"
      )
      .join("");
    chartEls.plot.innerHTML = '<div class="ex-chart-table"><table><thead>' + head + "</thead><tbody>" + rows + "</tbody></table></div>";
  }

  function drawChart() {
    const { buckets, size, spec } = chartModel;
    const width = Math.max(200, chartEls.plot.clientWidth || 600);
    const height = 96;
    const left = 30;
    const top = 4;
    const bottom = 18;
    const plotW = width - left;
    const plotH = height - top - bottom;
    const max = Math.max(1, ...buckets.map((b) => b.count));
    const step = plotW / buckets.length;
    const barW = Math.max(1, step - 2);
    const y = (v) => top + plotH - (v / max) * plotH;

    const parts = [];
    parts.push('<line class="grid" x1="' + left + '" x2="' + width + '" y1="' + (top + plotH + 0.5) + '" y2="' + (top + plotH + 0.5) + '"/>');
    parts.push('<line class="grid" x1="' + left + '" x2="' + width + '" y1="' + (top + 0.5) + '" y2="' + (top + 0.5) + '" stroke-dasharray="2 3"/>');
    parts.push('<text class="axis" x="' + (left - 6) + '" y="' + (top + 4) + '" text-anchor="end">' + max + "</text>");
    parts.push('<text class="axis" x="' + (left - 6) + '" y="' + (top + plotH) + '" text-anchor="end">0</text>');

    // Up to six time labels along the bottom.
    const every = Math.max(1, Math.ceil(buckets.length / 6));
    const fmt = size < 60e3 ? "HH:mm:ss" : size < 86400e3 ? "HH:mm" : "MMM D";
    buckets.forEach((b, i) => {
      if (i % every) return;
      parts.push('<text class="axis" x="' + (left + i * step + 1) + '" y="' + (height - 4) + '">' + escapeHtml(moment(b.start).format(fmt)) + "</text>");
    });

    buckets.forEach((b, i) => {
      const x = left + i * step + 1;
      let base = top + plotH;
      spec.series.forEach((s) => {
        const v = b.stacks[s.key] || 0;
        if (!v) return;
        const h = (v / max) * plotH;
        // 1px surface gap between stacked segments.
        const segH = Math.max(1, h - (base < top + plotH ? 1 : 0));
        parts.push('<rect x="' + x.toFixed(1) + '" y="' + (base - h).toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + segH.toFixed(1) + '" rx="' + Math.min(2, barW / 2).toFixed(1) + '" fill="' + s.color + '"/>');
        base -= h;
      });
      parts.push('<rect class="hit" data-i="' + i + '" x="' + (left + i * step).toFixed(1) + '" y="' + top + '" width="' + step.toFixed(1) + '" height="' + plotH + '"/>');
    });
    void y;
    chartEls.plot.innerHTML =
      '<svg width="' + width + '" height="' + height + '" role="img" aria-label="Events over time, ' + buckets.length + " bars of " + sizeLabel(size) + '">' +
      parts.join("") +
      "</svg>";
  }

  function showChartTip(i, clientX) {
    if (!chartModel) return;
    const b = chartModel.buckets[i];
    if (!b) return;
    const rows = chartModel.spec.series
      .filter((s) => b.stacks[s.key])
      .map(
        (s) =>
          '<div class="tip-row"><span class="ex-swatch" style="background:' + s.color + '"></span><span>' +
          escapeHtml(shortLabel(s.label, 40)) + '</span><span class="mono">' + b.stacks[s.key] + "</span></div>"
      )
      .join("");
    chartEls.tip.innerHTML =
      '<div class="tip-time">' + escapeHtml(bucketTime(b.start, chartModel.size)) + "</div>" +
      (rows || '<div class="ex-muted">No events</div>') +
      (b.count ? '<div class="tip-hint">' + plural(b.count, "event") + ". Click to zoom in.</div>" : "");
    chartEls.tip.hidden = false;
    const box = chartEls.box.getBoundingClientRect();
    const tipW = chartEls.tip.offsetWidth;
    const x = Math.min(Math.max(8, clientX - box.left + 12), box.width - tipW - 8);
    chartEls.tip.style.left = x + "px";
    chartEls.tip.style.top = "34px";
  }

  function rangeSnapshot() {
    return { timeRange: state.timeRange, customFrom: state.customFrom, customTo: state.customTo };
  }

  function applyRange(r) {
    state.timeRange = r.timeRange;
    state.customFrom = r.customFrom;
    state.customTo = r.customTo;
    els.from.value = r.customFrom || "";
    els.to.value = r.customTo || "";
    els.customRange.hidden = state.timeRange !== "custom";
    const group = document.getElementById("fsTimeChips");
    setSegActive(group, group.querySelector('[data-range="' + state.timeRange + '"]'));
    renderTimeline();
  }

  function zoomToBucket(i) {
    const b = chartModel && chartModel.buckets[i];
    if (!b || !b.count) return;
    state.rangeHistory.push(rangeSnapshot());
    const fmt = "YYYY-MM-DDTHH:mm:ss";
    applyRange({
      timeRange: "custom",
      customFrom: moment(b.start).format(fmt),
      customTo: moment(b.end - 1).format(fmt),
    });
  }

  /* ---------- Rendering ---------- */

  function renderTabs() {
    if (!state.sites.length) {
      els.tabs.innerHTML =
        '<div class="empty"><strong>No sites yet</strong>Open a site that uses Marketing Cloud Personalization.</div>';
      return;
    }
    const allActive = state.activeSite === ALL_SITES ? " active" : "";
    const rows = [
      '<div class="field-label ex-sites-title">Sites</div>',
      `<button class="fs-tab fs-tab-all${allActive}" type="button" data-site="${ALL_SITES}"><span class="name">All sites</span><span class="count">${state.total}</span></button>`,
    ];
    state.sites.forEach((site) => {
      const count = (state.eventsBySite[site] || []).length;
      const active = site === state.activeSite ? " active" : "";
      rows.push(
        `<button class="fs-tab${active}" type="button" data-site="${escapeHtml(site)}" title="${escapeHtml(site)}">` +
          `<span class="name">${escapeHtml(siteLabel(site))}</span>` +
          `<span class="count">${count}</span>` +
          `<span class="detail">${escapeHtml(siteDetail(site))}</span>` +
          "</button>"
      );
    });
    els.tabs.innerHTML = rows.join("");
  }

  function statusBadge(statusCode) {
    if (statusCode == null) return '<span class="badge badge-err">ERR</span>';
    const ok = statusCode >= 200 && statusCode < 400;
    return `<span class="badge ${ok ? "badge-ok" : "badge-err"}">${escapeHtml(statusCode)}</span>`;
  }

  function pagePath(url) {
    try {
      const u = new URL(url);
      return u.host + u.pathname + u.search;
    } catch (_) {
      return url || "";
    }
  }

  function eventRow(event) {
    const failed = isFailed(event);
    const active = event.id === state.selectedEventId;
    const sub = [event.itemAction, event.pageType].filter(Boolean).join(" · ");
    const checked = state.checked.has(event.id);
    return (
      `<div class="fs-event${failed ? " error" : ""}${active ? " active" : ""}${checked ? " checked" : ""}" role="option" aria-selected="${active}" data-event-id="${escapeHtml(event.id)}">` +
      `<span class="ex-col-check"><input type="checkbox" class="ex-check" tabindex="-1" aria-label="Select this event"${checked ? " checked" : ""} /></span>` +
      `<span class="fs-event-time" title="${escapeHtml(moment(event.ts).format("YYYY-MM-DD HH:mm:ss.SSS"))}">${escapeHtml(moment(event.ts).format("HH:mm:ss.SSS"))}</span>` +
      `<span class="ex-col-status">${statusBadge(event.statusCode)}</span>` +
      `<span class="ex-col-action"><span class="fs-event-action">${escapeHtml(event.action)}</span>${sub ? `<span class="fs-event-sub">${escapeHtml(sub)}</span>` : ""}</span>` +
      `<span class="ex-col-page fs-event-url" title="${escapeHtml(event.pageUrl || "")}">${escapeHtml(pagePath(event.pageUrl))}</span>` +
      "</div>"
    );
  }

  /** Groups in the order their first event appears, so they follow the sort. */
  function groupEvents(events, field) {
    const groups = new Map();
    events.forEach((e) => {
      const g = groupOf(e, field);
      let row = groups.get(g.key);
      if (!row) {
        row = { key: g.key, label: g.label, events: [], failed: 0 };
        groups.set(g.key, row);
      }
      row.events.push(e);
      if (isFailed(e)) row.failed += 1;
    });
    return [...groups.values()];
  }

  function groupHeader(group, field) {
    const open = !state.collapsed.has(field + "\u0000" + group.key);
    const times = group.events.map((e) => e.ts);
    const first = Math.min(...times);
    const last = Math.max(...times);
    const span =
      moment(first).format("MMM D HH:mm:ss") +
      (last - first >= 1000 ? " to " + moment(last).format(moment(first).isSame(last, "day") ? "HH:mm:ss" : "MMM D HH:mm:ss") : "");
    const canFilter = FACETS.includes(field) && state.facets[field] !== group.key;
    return (
      `<div class="ex-group" role="button" tabindex="0" aria-expanded="${open}" data-group="${escapeHtml(group.key)}" title="${escapeHtml(group.label)}">` +
      `<span class="chev" aria-hidden="true">${open ? "▾" : "▸"}</span>` +
      `<span class="name">${escapeHtml(group.label)}</span>` +
      (canFilter ? `<button type="button" class="ex-group-only" data-only="${escapeHtml(group.key)}">Only this</button>` : "") +
      `<span class="meta">${plural(group.events.length, "event")}` +
      (group.failed ? `, <span class="failed">${group.failed} failed</span>` : "") +
      ` · ${escapeHtml(span)}</span>` +
      "</div>"
    );
  }

  function renderTimeline() {
    const events = getFilteredEvents();
    renderFacets();
    renderExportCounts(events.length);
    els.filteredStat.textContent = events.length + " shown";

    if (!state.activeSite) {
      els.timeline.innerHTML =
        '<div class="empty"><strong>No events captured yet</strong>Open a site with Marketing Cloud Personalization to start logging.</div>';
      renderChart([]);
      renderDetail(null);
      return;
    }

    renderChart(events);

    if (!events.length) {
      els.timeline.innerHTML =
        '<div class="empty"><strong>No events match</strong>Widen the time range or clear the filters.</div>';
      state.selectedEventId = null;
      renderChecks();
      renderDetail(null);
      return;
    }

    if (!findSelected(events)) {
      state.selectedEventId = events[0].id;
    }

    const html = [];
    if (state.groupBy) {
      groupEvents(events, state.groupBy).forEach((group) => {
        html.push(groupHeader(group, state.groupBy));
        if (state.collapsed.has(state.groupBy + "\u0000" + group.key)) return;
        group.events.forEach((event) => html.push(eventRow(event)));
      });
    } else {
      let lastDay = "";
      events.forEach((event) => {
        const day = moment(event.ts).format("ddd, MMM D, YYYY");
        if (day !== lastDay) {
          html.push(`<div class="ex-day">${escapeHtml(day)}</div>`);
          lastDay = day;
        }
        html.push(eventRow(event));
      });
    }
    els.timeline.innerHTML = html.join("");
    renderChecks();
    renderDetail(findSelected(events));
  }

  function renderDetail(event) {
    if (!event) {
      els.detailTitle.textContent = "Event details";
      els.detail.innerHTML =
        '<div class="empty"><strong>No event selected</strong>Pick an event to see its payload.</div>';
      return;
    }

    els.detailTitle.textContent = event.action;
    const rows = [
      ["Action", event.action],
      ["Item action", event.itemAction || "-"],
      ["Time", moment(event.ts).format("YYYY-MM-DD HH:mm:ss.SSS") + " (" + moment(event.ts).fromNow() + ")"],
      ["Status", event.statusCode == null ? "Transport error" : String(event.statusCode)],
      ["User", event.userLabel || "-"],
      ["Site", event.site],
      ["SDK", event.sdk === "data-cloud" ? "Data Cloud Web SDK" : "Evergage beacon"],
      ["Page type", event.pageType || "-"],
      ["Page URL", event.pageUrl || "-"],
      ["Request URL", McpExport.shortenRequestUrl(event.url) || "-"],
    ];
    els.detail.innerHTML =
      '<dl class="kv">' +
      rows
        .map((r) => {
          let extra = "";
          if (r[0] === "User" && event.userKey && state.facets.user !== event.userKey) {
            extra = '<button type="button" class="ex-link" data-only-user>Only this user</button>';
          }
          return `<dt>${escapeHtml(r[0])}</dt><dd>${escapeHtml(r[1])}${extra}</dd>`;
        })
        .join("") +
      '</dl><div class="fs-json" id="fsJsonMount"></div>';

    const viewer = new JSONViewer();
    document.getElementById("fsJsonMount").appendChild(viewer.getContainer());
    viewer.showJSON(event.payload || {});
  }

  function selectEvent(id, scroll) {
    state.selectedEventId = id;
    els.timeline.querySelectorAll(".fs-event").forEach((row) => {
      const on = row.getAttribute("data-event-id") === id;
      row.classList.toggle("active", on);
      row.setAttribute("aria-selected", String(on));
      if (on && scroll) row.scrollIntoView({ block: "nearest" });
    });
    renderDetail(findSelected());
  }

  function moveSelection(step) {
    // Rows on screen, so collapsed groups are skipped.
    const ids = [...els.timeline.querySelectorAll(".fs-event")].map((r) => r.getAttribute("data-event-id"));
    if (!ids.length) return;
    const i = ids.indexOf(state.selectedEventId);
    selectEvent(ids[Math.min(ids.length - 1, Math.max(0, (i < 0 ? 0 : i) + step))], true);
  }

  function toggleGroup(key) {
    const id = state.groupBy + "\u0000" + key;
    if (state.collapsed.has(id)) state.collapsed.delete(id);
    else state.collapsed.add(id);
    renderTimeline();
  }

  function setActiveSite(site) {
    state.activeSite = site;
    state.selectedEventId = null;
    renderTabs();
    renderTimeline();
  }

  function readHash() {
    const params = new URLSearchParams(location.hash.slice(1));
    return { site: params.get("site"), event: params.get("event") };
  }

  async function loadAndRender() {
    state.raw = await getData();
    const normalized = normalizeEvents(state.raw);
    state.eventsBySite = normalized.bySite;
    state.total = normalized.total;
    state.sites = Object.keys(normalized.bySite)
      .filter((site) => normalized.bySite[site].length)
      .sort((a, b) => a.localeCompare(b));
    els.totalStat.textContent = plural(normalized.total, "event");
    if (state.checked.size) {
      const ids = new Set(allEvents().map((e) => e.id));
      state.checked.forEach((id) => ids.has(id) || state.checked.delete(id));
    }

    if (!state.sites.length) {
      state.activeSite = null;
    } else if (state.activeSite !== ALL_SITES && !state.sites.includes(state.activeSite)) {
      state.activeSite = state.sites.length > 1 ? ALL_SITES : state.sites[0];
    }

    renderTabs();
    renderTimeline();
  }

  function setSegActive(group, button) {
    group.querySelectorAll("button").forEach((el) => el.classList.toggle("active", el === button));
  }

  function bindEvents() {
    document.getElementById("BtnFsRefresh").addEventListener("click", loadAndRender);
    document.getElementById("BtnFsClear").addEventListener("click", () => {
      if (!window.confirm("Delete every captured event? SDK Tools settings are kept.")) return;
      chrome.runtime.sendMessage({ type: "MCP_CLEAR_EVENTS_KEEP_SETTINGS" }, () => {
        state.selectedEventId = null;
        loadAndRender();
      });
    });

    document.getElementById("BtnCopyJson").addEventListener("click", async (e) => {
      const selected = findSelected();
      if (!selected) return;
      try {
        await navigator.clipboard.writeText(JSON.stringify(selected.payload, null, 2));
        flashElementLabel(e.currentTarget, "Copied");
      } catch (err) {
        console.error("Copy failed", err);
      }
    });

    document.getElementById("BtnDownloadJson").addEventListener("click", (e) => {
      const selected = findSelected();
      if (!selected) return;
      const stamp = moment(selected.ts).format("YYYYMMDD-HHmmss");
      downloadText(
        JSON.stringify(selected.payload, null, 2),
        "mcp-event-" + McpExport.slug(selected.action, "event") + "-" + stamp + ".json",
        "application/json"
      );
      flashElementLabel(e.currentTarget, "Saved");
    });

    document.getElementById("BtnCopyEventAgent").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const selected = findSelected();
      if (!selected) return;
      const model = buildModel([selected], selected.site, true);
      try {
        await navigator.clipboard.writeText(
          McpExport.toMarkdown(model, { maxPayloadChars: McpExport.DEFAULT_AGENT_PAYLOAD_CHARS })
        );
        flashElementLabel(btn, "Copied");
      } catch (err) {
        console.error("Copy failed", err);
        flashElementLabel(btn, "Copy failed");
      }
    });

    const exportBtn = document.getElementById("BtnFsExport");
    const exportMenu = document.getElementById("fsExportMenu");
    exportBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      renderExportCounts(getFilteredEvents().length);
      if (exportMenu.hidden && state.checked.size) {
        document.querySelector('input[name="fsExportScope"][value="selected"]').checked = true;
      }
      setExportMenuOpen(exportMenu.hidden);
    });
    exportMenu.addEventListener("click", (e) => {
      e.stopPropagation();
      const btn = e.target.closest("[data-export]");
      if (btn) runExport(btn.getAttribute("data-export"), btn);
    });
    document.addEventListener("click", () => setExportMenuOpen(false));

    els.tabs.addEventListener("click", (e) => {
      const tab = e.target.closest(".fs-tab");
      if (tab) setActiveSite(tab.getAttribute("data-site"));
    });

    els.timeline.addEventListener("click", (e) => {
      const only = e.target.closest("[data-only]");
      if (only) {
        const header = only.closest(".ex-group");
        setFacet(state.groupBy, only.getAttribute("data-only"), header && header.getAttribute("title"));
        return;
      }
      const header = e.target.closest(".ex-group");
      if (header) {
        toggleGroup(header.getAttribute("data-group"));
        return;
      }
      const row = e.target.closest(".fs-event");
      if (!row) return;
      const id = row.getAttribute("data-event-id");
      // Checkbox, Ctrl/Cmd+click or Shift+click tick events; a plain click shows one.
      if (e.target.classList.contains("ex-check") || e.metaKey || e.ctrlKey || e.shiftKey) {
        if (!e.target.classList.contains("ex-check")) e.preventDefault();
        toggleCheck(id, e.shiftKey);
        return;
      }
      selectEvent(id, false);
    });
    // Stop Shift+click from selecting page text.
    els.timeline.addEventListener("mousedown", (e) => {
      if (e.shiftKey && e.target.closest(".fs-event")) e.preventDefault();
    });

    els.timeline.addEventListener("keydown", (e) => {
      const header = e.target.closest && e.target.closest(".ex-group");
      if (header && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        e.stopPropagation();
        toggleGroup(header.getAttribute("data-group"));
      }
    });

    FACETS.forEach((field) => {
      facetSelects[field].addEventListener("change", (e) => {
        const opt = e.target.selectedOptions[0];
        setFacet(field, e.target.value, opt ? opt.textContent.replace(/ \(\d+\)$/, "") : "");
      });
    });
    document.getElementById("BtnFsClearFilters").addEventListener("click", () => {
      FACETS.forEach((f) => (state.facets[f] = ""));
      renderTimeline();
    });
    document.getElementById("fsGroupBy").addEventListener("change", (e) => {
      state.groupBy = e.target.value;
      writePref("mcpGroupBy", state.groupBy);
      renderTimeline();
    });
    const chartBtn = document.getElementById("BtnFsChart");
    chartBtn.setAttribute("aria-pressed", String(state.chartOn));
    chartBtn.addEventListener("click", () => {
      state.chartOn = !state.chartOn;
      writePref("mcpChartOn", state.chartOn ? "1" : "0");
      chartBtn.setAttribute("aria-pressed", String(state.chartOn));
      renderChart(getFilteredEvents());
    });
    chartEls.tableBtn.addEventListener("click", () => {
      state.chartTable = !state.chartTable;
      chartEls.tableBtn.setAttribute("aria-pressed", String(state.chartTable));
      chartEls.tip.hidden = true;
      renderChart(getFilteredEvents());
    });
    chartEls.back.addEventListener("click", () => {
      const prev = state.rangeHistory.pop();
      if (prev) applyRange(prev);
    });
    chartEls.legend.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-key]");
      if (!btn || !chartModel) return;
      const key = btn.getAttribute("data-key");
      if (key === OTHER_KEY) return;
      const field = chartModel.spec.field;
      if (!field) {
        const group = document.getElementById("fsStatusChips");
        state.status = key === "failed" ? "failed" : "ok";
        setSegActive(group, group.querySelector('[data-status="' + state.status + '"]'));
        renderTimeline();
      } else if (FACETS.includes(field)) {
        setFacet(field, key, btn.textContent);
      } else {
        // Page and other non-facet fields filter through the search box.
        els.search.value = key;
        state.search = key;
        renderTimeline();
      }
    });
    chartEls.plot.addEventListener("mousemove", (e) => {
      const hit = e.target.closest(".hit");
      if (!hit) {
        chartEls.tip.hidden = true;
        return;
      }
      showChartTip(Number(hit.getAttribute("data-i")), e.clientX);
    });
    chartEls.plot.addEventListener("mouseleave", () => (chartEls.tip.hidden = true));
    chartEls.plot.addEventListener("click", (e) => {
      const hit = e.target.closest(".hit");
      if (!hit) return;
      chartEls.tip.hidden = true;
      zoomToBucket(Number(hit.getAttribute("data-i")));
    });
    if (window.ResizeObserver) {
      let lastW = 0;
      new ResizeObserver(() => {
        const w = chartEls.plot.clientWidth;
        if (Math.abs(w - lastW) < 4) return;
        lastW = w;
        if (state.chartOn && !state.chartTable && chartModel) drawChart();
      }).observe(chartEls.plot);
    }
    els.detail.addEventListener("click", (e) => {
      if (!e.target.closest("[data-only-user]")) return;
      const ev = findSelected();
      if (ev) setFacet("user", ev.userKey, ev.userLabel);
    });

    els.checkAll.addEventListener("change", () => {
      setChecked(getFilteredEvents().map((ev) => ev.id), els.checkAll.checked);
    });
    els.selBar.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-sel]");
      if (!btn) return;
      const kind = btn.getAttribute("data-sel");
      if (kind === "clear") {
        state.checked.clear();
        state.lastCheckedId = null;
        renderChecks();
        return;
      }
      runExport(kind, btn, "selected", els.selMask.checked);
    });

    const timeGroup = document.getElementById("fsTimeChips");
    timeGroup.addEventListener("click", (e) => {
      const chip = e.target.closest("button[data-range]");
      if (!chip) return;
      state.timeRange = chip.getAttribute("data-range");
      setSegActive(timeGroup, chip);
      els.customRange.hidden = state.timeRange !== "custom";
      renderTimeline();
    });

    const statusGroup = document.getElementById("fsStatusChips");
    statusGroup.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-status]");
      if (!chip) return;
      state.status = chip.getAttribute("data-status");
      setSegActive(statusGroup, chip);
      renderTimeline();
    });

    const sortGroup = document.querySelector(".ex-sort");
    sortGroup.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-sort]");
      if (!chip) return;
      state.sort = chip.getAttribute("data-sort");
      setSegActive(sortGroup, chip);
      renderTimeline();
    });

    els.search.addEventListener("input", () => {
      state.search = els.search.value || "";
      renderTimeline();
    });

    els.from.addEventListener("change", () => {
      state.customFrom = els.from.value || null;
      if (state.timeRange === "custom") renderTimeline();
    });
    els.to.addEventListener("change", () => {
      state.customTo = els.to.value || null;
      if (state.timeRange === "custom") renderTimeline();
    });

    // Keyboard: "/" to search, j/k or arrows to move, x to tick the shown
    // event, Escape to close menus (or clear the ticks).
    document.addEventListener("keydown", (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.key === "Escape") {
        if (!exportMenu.hidden) {
          setExportMenuOpen(false);
          exportBtn.focus();
        } else if (typing) {
          e.target.blur();
        } else if (state.checked.size) {
          state.checked.clear();
          state.lastCheckedId = null;
          renderChecks();
        }
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        els.search.focus();
      } else if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        moveSelection(1);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        moveSelection(-1);
      } else if (e.key === "x" && state.selectedEventId) {
        e.preventDefault();
        toggleCheck(state.selectedEventId, false);
      }
    });

    let reloadTimer = null;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      // Settings and page diagnostics (__mcp_*) don't change the event list.
      if (Object.keys(changes).every((k) => k.indexOf("__mcp_") === 0)) return;
      // New events arrive in bursts; redraw at most every 300 ms.
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(loadAndRender, 300);
    });
  }

  async function start() {
    state.groupBy = GROUP_FIELDS[readPref("mcpGroupBy", "")] ? readPref("mcpGroupBy", "") : "";
    document.getElementById("fsGroupBy").value = state.groupBy;
    bindEvents();
    const link = readHash();
    if (link.site) {
      state.activeSite = link.site;
      state.timeRange = "all";
      setSegActive(
        document.getElementById("fsTimeChips"),
        document.querySelector('#fsTimeChips [data-range="all"]')
      );
    }
    if (link.event) state.selectedEventId = link.event;
    await loadAndRender();
    if (link.event) selectEvent(link.event, true);
  }

  start();
})();
