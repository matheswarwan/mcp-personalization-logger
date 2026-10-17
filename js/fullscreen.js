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
    eventsBySite: {},
    total: 0,
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
  };

  const { compareByTime, normalizeEvents, isFailed, siteLabel, siteDetail } = McpEvents;

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
    if (!state.activeSite) return [];
    if (state.activeSite === ALL_SITES) return filterEvents(allEvents());
    return filterEvents(state.eventsBySite[state.activeSite] || []);
  }

  function getAllSitesFilteredEvents() {
    return filterEvents(allEvents());
  }

  function filterEvents(events) {
    const { from, to } = getRangeBounds();
    const q = state.search.trim().toLowerCase();

    const filtered = events.filter((event) => {
      const m = moment(event.ts);
      if (from && m.isBefore(from)) return false;
      if (to && m.isAfter(to)) return false;
      if (state.status === "failed" && !isFailed(event)) return false;
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

    filtered.sort((a, b) => compareByTime(a, b, state.sort === "asc"));
    return filtered;
  }

  function findSelected(events) {
    return (events || getFilteredEvents()).find((e) => e.id === state.selectedEventId) || null;
  }

  /* ---------- Export ---------- */

  function renderExportCounts(viewCount) {
    document.getElementById("fsExportViewCount").textContent = String(viewCount);
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

  function buildModel(events, scope, maskPersonalData) {
    return McpExport.buildExportModel(events, {
      extensionVersion: getExtensionVersion(),
      scope,
      maskPersonalData,
      filters: {
        timeRange: describeTimeRange(),
        search: state.search.trim(),
        status: state.status,
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

  async function runExport(kind, triggerBtn) {
    const scopeInput = document.querySelector('input[name="fsExportScope"]:checked');
    const allSites = (scopeInput && scopeInput.value === "all-sites") || state.activeSite === ALL_SITES;
    const events = allSites ? getAllSitesFilteredEvents() : getFilteredEvents();
    if (!events.length) {
      flashElementLabel(triggerBtn, "No events to export");
      return;
    }
    const mask = document.getElementById("fsExportMask").checked;
    const model = buildModel(events, allSites ? "All sites" : viewScopeLabel(), mask);
    const base =
      "mcp-events-" +
      (allSites ? "all-sites" : McpExport.slug(siteLabel(state.activeSite))) +
      "-" +
      McpExport.fileStamp();

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
    if (kind === "md") {
      downloadText(McpExport.toMarkdown(model), base + ".md", "text/markdown");
    } else if (kind === "json") {
      downloadText(McpExport.toJson(model), base + ".json", "application/json");
    } else if (kind === "html") {
      downloadText(McpExport.toHtmlReport(model), base + ".html", "text/html");
    }
    flashElementLabel(triggerBtn, "Downloaded");
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

  function renderTimeline() {
    const events = getFilteredEvents();
    renderExportCounts(events.length);
    els.filteredStat.textContent = events.length + " shown";

    if (!state.activeSite) {
      els.timeline.innerHTML =
        '<div class="empty"><strong>No events captured yet</strong>Open a site with Marketing Cloud Personalization to start logging.</div>';
      renderDetail(null);
      return;
    }

    if (!events.length) {
      els.timeline.innerHTML =
        '<div class="empty"><strong>No events match</strong>Widen the time range or clear the filters.</div>';
      state.selectedEventId = null;
      renderDetail(null);
      return;
    }

    if (!findSelected(events)) {
      state.selectedEventId = events[0].id;
    }

    let lastDay = "";
    const html = [];
    events.forEach((event) => {
      const day = moment(event.ts).format("ddd, MMM D, YYYY");
      if (day !== lastDay) {
        html.push(`<div class="ex-day">${escapeHtml(day)}</div>`);
        lastDay = day;
      }
      const failed = isFailed(event);
      const active = event.id === state.selectedEventId;
      const sub = [event.itemAction, event.pageType].filter(Boolean).join(" · ");
      html.push(
        `<div class="fs-event${failed ? " error" : ""}${active ? " active" : ""}" role="option" aria-selected="${active}" data-event-id="${escapeHtml(event.id)}">` +
          `<span class="fs-event-time" title="${escapeHtml(moment(event.ts).format("YYYY-MM-DD HH:mm:ss.SSS"))}">${escapeHtml(moment(event.ts).format("HH:mm:ss.SSS"))}</span>` +
          `<span class="ex-col-status">${statusBadge(event.statusCode)}</span>` +
          `<span class="ex-col-action"><span class="fs-event-action">${escapeHtml(event.action)}</span>${sub ? `<span class="fs-event-sub">${escapeHtml(sub)}</span>` : ""}</span>` +
          `<span class="ex-col-page fs-event-url" title="${escapeHtml(event.pageUrl || "")}">${escapeHtml(pagePath(event.pageUrl))}</span>` +
          "</div>"
      );
    });
    els.timeline.innerHTML = html.join("");
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
      ["Site", event.site],
      ["SDK", event.sdk === "data-cloud" ? "Data Cloud Web SDK" : "Evergage beacon"],
      ["Page type", event.pageType || "-"],
      ["Page URL", event.pageUrl || "-"],
      ["Request URL", McpExport.shortenRequestUrl(event.url) || "-"],
    ];
    els.detail.innerHTML =
      '<dl class="kv">' +
      rows.map((r) => `<dt>${escapeHtml(r[0])}</dt><dd>${escapeHtml(r[1])}</dd>`).join("") +
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
    const events = getFilteredEvents();
    if (!events.length) return;
    const i = events.findIndex((e) => e.id === state.selectedEventId);
    const next = events[Math.min(events.length - 1, Math.max(0, (i < 0 ? 0 : i) + step))];
    selectEvent(next.id, true);
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
      const row = e.target.closest(".fs-event");
      if (row) selectEvent(row.getAttribute("data-event-id"), false);
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

    // Keyboard: "/" to search, j/k or arrows to move, Escape to close menus.
    document.addEventListener("keydown", (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.key === "Escape") {
        if (!exportMenu.hidden) {
          setExportMenuOpen(false);
          exportBtn.focus();
        } else if (typing) {
          e.target.blur();
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
      }
    });

    let reloadTimer = null;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      // New events arrive in bursts; redraw at most every 300 ms.
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(loadAndRender, 300);
    });
  }

  async function start() {
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
