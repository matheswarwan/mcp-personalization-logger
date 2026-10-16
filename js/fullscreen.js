(function () {
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
    selectedPayload: null,
    eventsBySite: {},
  };

  const els = {
    tabs: document.getElementById("fsSiteTabs"),
    timeline: document.getElementById("fsTimeline"),
    detail: document.getElementById("fsDetailBody"),
    totalStat: document.getElementById("fsTotalStat"),
    filteredStat: document.getElementById("fsFilteredStat"),
    streamSubtitle: document.getElementById("fsStreamSubtitle"),
    search: document.getElementById("fsSearch"),
    customRange: document.getElementById("fsCustomRange"),
    from: document.getElementById("fsFrom"),
    to: document.getElementById("fsTo"),
  };

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function downloadJson(data, filename) {
    downloadText(JSON.stringify(data, null, 2), filename, "application/json");
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

  function flashButtonLabel(buttonId, label) {
    const btn = document.getElementById(buttonId);
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = label;
    setTimeout(() => {
      btn.textContent = original;
    }, 1200);
  }

  function getData() {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (items) => resolve(items || {}));
    });
  }

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

  function isFailed(event) {
    return (
      event.statusCode == null || event.statusCode < 200 || event.statusCode >= 400
    );
  }

  function getFilteredEvents() {
    if (!state.activeSite) return [];
    return filterEvents(state.eventsBySite[state.activeSite] || []);
  }

  function getAllSitesFilteredEvents() {
    return filterEvents(
      state.sites.reduce(
        (all, site) => all.concat(state.eventsBySite[site] || []),
        []
      )
    );
  }

  function filterEvents(events) {
    const { from, to } = getRangeBounds();
    const q = state.search.trim().toLowerCase();

    let filtered = events.filter((event) => {
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

  function renderTabs() {
    if (!state.sites.length) {
      els.tabs.innerHTML =
        '<div class="fs-empty" style="padding:18px 8px"><strong>No sites captured yet</strong>Browse a site with MCP Personalization to start logging.</div>';
      return;
    }

    els.tabs.innerHTML = state.sites
      .map((site) => {
        const count = (state.eventsBySite[site] || []).length;
        const shortLabel = site.split(" | ")[0] || site;
        const active = site === state.activeSite ? "active" : "";
        return `<button class="fs-tab ${active}" type="button" data-site="${escapeHtml(
          site
        )}" title="${escapeHtml(site)}">${escapeHtml(
          shortLabel
        )}<span class="count">${count}</span></button>`;
      })
      .join("");
  }

  function renderExportCounts(viewCount) {
    const view = document.getElementById("fsExportViewCount");
    const all = document.getElementById("fsExportAllCount");
    if (view) view.textContent = String(viewCount);
    if (all) all.textContent = String(getAllSitesFilteredEvents().length);
  }

  function describeTimeRange() {
    const chip = document.querySelector(
      '#fsTimeChips .fs-chip[data-range="' + state.timeRange + '"]'
    );
    const label = chip ? chip.textContent.trim() : state.timeRange;
    if (state.timeRange !== "custom") return label;
    return (
      label + " (" + (state.customFrom || "start") + " to " + (state.customTo || "now") + ")"
    );
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
    const menu = document.getElementById("fsExportMenu");
    const btn = document.getElementById("BtnFsExport");
    menu.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }

  async function runExport(kind, triggerBtn) {
    const scopeInput = document.querySelector('input[name="fsExportScope"]:checked');
    const allSites = scopeInput && scopeInput.value === "all-sites";
    const events = allSites ? getAllSitesFilteredEvents() : getFilteredEvents();
    if (!events.length) {
      flashElementLabel(triggerBtn, "No events to export");
      return;
    }
    const mask = document.getElementById("fsExportMask").checked;
    const scope = allSites ? "All sites" : state.activeSite;
    const model = buildModel(events, scope, mask);
    const base =
      "mcp-events-" +
      (allSites ? "all-sites" : McpExport.slug(String(state.activeSite).split("|")[0])) +
      "-" +
      McpExport.fileStamp();

    if (kind === "agent") {
      const text = McpExport.toMarkdown(model, {
        maxPayloadChars: McpExport.DEFAULT_AGENT_PAYLOAD_CHARS,
      });
      try {
        await navigator.clipboard.writeText(text);
        flashElementLabel(triggerBtn, "Copied " + events.length + " events");
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

  function flashElementLabel(btn, label) {
    if (!btn) return;
    if (!btn.dataset.label) btn.dataset.label = btn.textContent.trim();
    btn.textContent = label;
    clearTimeout(btn._flashTimer);
    btn._flashTimer = setTimeout(() => {
      btn.textContent = btn.dataset.label;
    }, 1400);
  }

  function renderTimeline() {
    const events = getFilteredEvents();
    renderExportCounts(events.length);
    els.filteredStat.textContent =
      "Showing " + events.length + " event" + (events.length === 1 ? "" : "s");
    els.streamSubtitle.textContent = state.activeSite
      ? state.activeSite
      : "Select a site tab to begin";

    if (!state.activeSite) {
      els.timeline.innerHTML =
        '<div class="fs-empty"><strong>Select a site</strong>Each captured site appears as a tab above.</div>';
      return;
    }

    if (!events.length) {
      els.timeline.innerHTML =
        '<div class="fs-empty"><strong>No events in this range</strong>Try widening the time filter or clearing the search.</div>';
      if (
        state.selectedEventId &&
        !events.some((e) => e.id === state.selectedEventId)
      ) {
        state.selectedEventId = null;
        state.selectedPayload = null;
        renderDetail(null);
      }
      return;
    }

    if (
      !state.selectedEventId ||
      !events.some((e) => e.id === state.selectedEventId)
    ) {
      state.selectedEventId = events[0].id;
      state.selectedPayload = events[0].payload;
      renderDetail(events[0]);
    }

    els.timeline.innerHTML = events
      .map((event, index) => {
        const ok =
          event.statusCode == null
            ? false
            : event.statusCode >= 200 && event.statusCode < 400;
        const statusClass =
          event.statusCode == null ? "error" : ok ? "success" : "error";
        const active = event.id === state.selectedEventId ? "active" : "";
        const statusLabel =
          event.statusCode == null ? "ERR" : String(event.statusCode);
        const statusBadgeClass = ok ? "status-ok" : "status-bad";

        return `
          <article class="fs-event ${statusClass} ${active}" data-event-id="${escapeHtml(
            event.id
          )}" style="animation-delay:${Math.min(index, 12) * 30}ms">
            <div class="fs-event-dot" aria-hidden="true"></div>
            <div class="fs-event-card">
              <div class="fs-event-top">
                <div>
                  <h3 class="fs-event-action">${escapeHtml(event.action)}</h3>
                  <div class="fs-event-meta">
                    ${
                      event.itemAction
                        ? `<span class="fs-badge item">${escapeHtml(
                            event.itemAction
                          )}</span>`
                        : ""
                    }
                    ${
                      event.pageType
                        ? `<span class="fs-badge">${escapeHtml(
                            event.pageType
                          )}</span>`
                        : ""
                    }
                    <span class="fs-badge ${statusBadgeClass}">${escapeHtml(
                      statusLabel
                    )}</span>
                  </div>
                </div>
                <div class="fs-event-time">
                  <strong>${escapeHtml(
                    moment(event.ts).format("HH:mm:ss.SSS")
                  )}</strong>
                  ${escapeHtml(moment(event.ts).format("MMM D, YYYY"))}<br/>
                  ${escapeHtml(moment(event.ts).fromNow())}
                </div>
              </div>
              ${
                event.pageUrl
                  ? `<div class="fs-event-url">${escapeHtml(
                      event.pageUrl
                    )}</div>`
                  : ""
              }
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renderDetail(event) {
    if (!event) {
      els.detail.innerHTML =
        '<div class="fs-empty"><strong>No event selected</strong>Click an event in the stream to inspect its payload.</div>';
      state.selectedPayload = null;
      return;
    }

    state.selectedPayload = event.payload;
    const ok =
      event.statusCode != null &&
      event.statusCode >= 200 &&
      event.statusCode < 400;

    els.detail.innerHTML = `
      <div class="fs-detail-grid">
        <div class="fs-kv"><label>Action</label><div>${escapeHtml(
          event.action
        )}</div></div>
        <div class="fs-kv"><label>Item action</label><div>${escapeHtml(
          event.itemAction || "—"
        )}</div></div>
        <div class="fs-kv"><label>Time</label><div>${escapeHtml(
          moment(event.ts).format("YYYY-MM-DD HH:mm:ss.SSS")
        )} (${escapeHtml(moment(event.ts).fromNow())})</div></div>
        <div class="fs-kv"><label>Status</label><div style="color:${
          ok ? "var(--ck-success)" : "var(--ck-danger)"
        }">${escapeHtml(
          event.statusCode == null ? "Transport error" : String(event.statusCode)
        )}</div></div>
        <div class="fs-kv" style="grid-column:1/-1"><label>Page URL</label><div>${escapeHtml(
          event.pageUrl || "—"
        )}</div></div>
        <div class="fs-kv" style="grid-column:1/-1"><label>Request URL</label><div>${escapeHtml(
          event.url || "—"
        )}</div></div>
      </div>
      <div class="fs-json" id="fsJsonMount"></div>
    `;

    const viewer = new JSONViewer();
    const mount = document.getElementById("fsJsonMount");
    mount.appendChild(viewer.getContainer());
    viewer.showJSON(event.payload || {});
  }

  function setActiveSite(site) {
    state.activeSite = site;
    state.selectedEventId = null;
    state.selectedPayload = null;
    renderTabs();
    renderTimeline();
  }

  async function loadAndRender() {
    state.raw = await getData();
    const normalized = normalizeEvents(state.raw);
    state.eventsBySite = normalized.bySite;
    state.sites = Object.keys(normalized.bySite).sort((a, b) =>
      a.localeCompare(b)
    );
    els.totalStat.textContent =
      normalized.total + " event" + (normalized.total === 1 ? "" : "s");

    if (!state.sites.length) {
      state.activeSite = null;
      renderTabs();
      els.timeline.innerHTML =
        '<div class="fs-empty"><strong>No events captured yet</strong>Open a site with Marketing Cloud Personalization to start logging.</div>';
      renderDetail(null);
      els.filteredStat.textContent = "Showing 0 events";
      els.streamSubtitle.textContent = "Waiting for events";
      return;
    }

    if (!state.activeSite || !state.sites.includes(state.activeSite)) {
      state.activeSite = state.sites[0];
    }

    renderTabs();
    renderTimeline();
  }

  function bindEvents() {
    document.getElementById("BtnFsRefresh").addEventListener("click", loadAndRender);
    document.getElementById("BtnFsClear").addEventListener("click", () => {
      chrome.runtime.sendMessage(
        { type: "MCP_CLEAR_EVENTS_KEEP_SETTINGS" },
        () => {
          state.selectedEventId = null;
          state.selectedPayload = null;
          loadAndRender();
        }
      );
    });

    const sdkToolsBtn = document.getElementById("BtnFsSdkTools");
    if (sdkToolsBtn) {
      sdkToolsBtn.addEventListener("click", () => {
        chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
      });
    }

    document.getElementById("BtnCopyJson").addEventListener("click", async () => {
      if (!state.selectedPayload) return;
      try {
        await navigator.clipboard.writeText(
          JSON.stringify(state.selectedPayload, null, 2)
        );
        const btn = document.getElementById("BtnCopyJson");
        const original = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => {
          btn.textContent = original;
        }, 1200);
      } catch (e) {
        console.error("Copy failed", e);
      }
    });

    document.getElementById("BtnDownloadJson").addEventListener("click", () => {
      if (!state.selectedPayload) return;
      const selected = (getFilteredEvents() || []).find(
        (e) => e.id === state.selectedEventId
      );
      const stamp = moment(selected?.ts || Date.now()).format("YYYYMMDD-HHmmss");
      const safeAction = String(selected?.action || "event")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40);
      downloadJson(
        state.selectedPayload,
        "mcp-event-" + safeAction + "-" + stamp + ".json"
      );
      flashButtonLabel("BtnDownloadJson", "Downloaded!");
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
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !exportMenu.hidden) {
        setExportMenuOpen(false);
        exportBtn.focus();
      }
    });

    document.getElementById("BtnCopyEventAgent").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      const selected = getFilteredEvents().find((ev) => ev.id === state.selectedEventId);
      if (!selected) return;
      const model = buildModel([selected], selected.site, true);
      try {
        await navigator.clipboard.writeText(
          McpExport.toMarkdown(model, {
            maxPayloadChars: McpExport.DEFAULT_AGENT_PAYLOAD_CHARS,
          })
        );
        flashElementLabel(btn, "Copied!");
      } catch (err) {
        console.error("Copy failed", err);
        flashElementLabel(btn, "Copy failed");
      }
    });

    document.getElementById("fsStatusChips").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-status]");
      if (!chip) return;
      state.status = chip.getAttribute("data-status");
      document
        .querySelectorAll("#fsStatusChips .fs-chip")
        .forEach((el) => el.classList.toggle("active", el === chip));
      renderTimeline();
    });

    els.tabs.addEventListener("click", (e) => {
      const tab = e.target.closest(".fs-tab");
      if (!tab) return;
      setActiveSite(tab.getAttribute("data-site"));
    });

    els.timeline.addEventListener("click", (e) => {
      const row = e.target.closest(".fs-event");
      if (!row) return;
      const id = row.getAttribute("data-event-id");
      const events = getFilteredEvents();
      const event = events.find((item) => item.id === id);
      if (!event) return;
      state.selectedEventId = id;
      renderTimeline();
      renderDetail(event);
    });

    document.getElementById("fsTimeChips").addEventListener("click", (e) => {
      const chip = e.target.closest(".fs-chip");
      if (!chip) return;
      state.timeRange = chip.getAttribute("data-range");
      document
        .querySelectorAll("#fsTimeChips .fs-chip")
        .forEach((el) => el.classList.toggle("active", el === chip));
      els.customRange.classList.toggle("visible", state.timeRange === "custom");
      renderTimeline();
    });

    document.querySelector(".fs-sort").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-sort]");
      if (!chip) return;
      state.sort = chip.getAttribute("data-sort");
      document
        .querySelectorAll(".fs-sort .fs-chip")
        .forEach((el) => el.classList.toggle("active", el === chip));
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

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local") {
        loadAndRender();
      }
    });
  }

  bindEvents();
  loadAndRender();
})();
