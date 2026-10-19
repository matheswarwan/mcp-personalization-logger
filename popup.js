(function () {
  const MAX_ROWS = 50;
  const ALL = "__all__";

  const state = { events: [], sites: [], site: ALL, open: null, decoded: null };

  const els = {
    list: document.getElementById("eventList"),
    summary: document.getElementById("summaryText"),
    sites: document.getElementById("siteChips"),
    sdk: document.getElementById("sdkStatus"),
    sdkBar: document.getElementById("sdkBar"),
    atob: document.getElementById("atob"),
    decodeOut: document.getElementById("json"),
    decodeActions: document.getElementById("bd-clipboard"),
  };

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function openPage(path) {
    const url = chrome.runtime.getURL(path);
    if (chrome.tabs && chrome.tabs.create) chrome.tabs.create({ url });
    else window.open(url, "_blank");
  }

  function flash(btn, label) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent.trim();
    btn.textContent = label;
    clearTimeout(btn._t);
    btn._t = setTimeout(() => (btn.textContent = btn.dataset.label), 1200);
  }

  function downloadJson(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function showJson(mount, data) {
    const viewer = new JSONViewer();
    mount.innerHTML = "";
    mount.appendChild(viewer.getContainer());
    viewer.showJSON(data);
  }

  function getData() {
    return new Promise((resolve) => chrome.storage.local.get(null, (items) => resolve(items || {})));
  }

  async function renderSdkStatus() {
    const s = await readMcpSettings();
    const where = !s.sites.length ? "no sites" : s.sites.includes("*") ? "every site" : s.sites.join(", ");
    let text = "";
    if (s.localEdit.enabled && s.localEdit.edited) text = "Edit SDK is on for " + where;
    else if (s.forceSdk.enabled && s.forceSdk.url) text = "Redirect SDK is on for " + where + " to " + s.forceSdk.url;
    els.sdkBar.hidden = !text;
    els.sdk.textContent = text;
    els.sdk.title = text ? text + ". Click to change." : "";
  }

  function visibleEvents() {
    const list = state.site === ALL ? state.events : state.events.filter((e) => e.site === state.site);
    return list.slice(0, MAX_ROWS);
  }

  function renderSites() {
    if (state.sites.length < 2) {
      els.sites.innerHTML = "";
      return;
    }
    const chip = (key, label, n) =>
      `<button type="button" class="pp-site${state.site === key ? " active" : ""}" data-site="${escapeHtml(key)}" title="${escapeHtml(key === ALL ? "All sites" : key)}">${escapeHtml(label)}<span class="n">${n}</span></button>`;
    els.sites.innerHTML =
      chip(ALL, "All", state.events.length) +
      state.sites
        .map((s) => chip(s, McpEvents.siteLabel(s), state.events.filter((e) => e.site === s).length))
        .join("");
  }

  function renderList() {
    const events = visibleEvents();
    if (!state.events.length) {
      els.list.innerHTML =
        '<div class="empty"><strong>No events yet</strong>Open a site that uses Marketing Cloud Personalization. The icon changes color when an event is captured.</div>';
      return;
    }
    const rows = events.map((e) => {
      const failed = McpEvents.isFailed(e);
      const ok = !failed;
      const badge =
        e.statusCode == null
          ? '<span class="badge badge-err">ERR</span>'
          : `<span class="badge ${ok ? "badge-ok" : "badge-err"}">${escapeHtml(e.statusCode)}</span>`;
      const open = state.open === e.id;
      const sub = [McpEvents.siteLabel(e.site), e.itemAction, e.pageType].filter(Boolean).join(" · ");
      return (
        `<button type="button" class="pp-row${failed ? " error" : ""}" role="listitem" aria-expanded="${open}" data-id="${escapeHtml(e.id)}" title="${escapeHtml(moment(e.ts).format("YYYY-MM-DD HH:mm:ss.SSS"))}">` +
        `<span class="pp-time">${escapeHtml(moment(e.ts).format("HH:mm:ss"))}</span>${badge}` +
        `<span class="pp-main"><span class="pp-action">${escapeHtml(e.action)}</span><span class="pp-sub">${escapeHtml(sub)}</span></span>` +
        "</button>" +
        (open
          ? `<div class="pp-expand"><div class="pp-expand-actions"><button type="button" class="btn btn-sm" data-act="explorer">Open in Explorer</button><button type="button" class="btn btn-sm" data-act="copy">Copy JSON</button></div><div class="pp-json"></div></div>`
          : "")
      );
    });
    const total = state.site === ALL ? state.events.length : state.events.filter((e) => e.site === state.site).length;
    if (total > events.length) {
      rows.push(`<div class="pp-more">Showing the latest ${events.length} of ${total}. Open Explorer for the rest.</div>`);
    }
    els.list.innerHTML = rows.join("");
    const openEvent = events.find((e) => e.id === state.open);
    const mount = els.list.querySelector(".pp-json");
    if (openEvent && mount) showJson(mount, openEvent.payload || {});
  }

  async function init() {
    const raw = await getData();
    const { bySite, total } = McpEvents.normalizeEvents(raw);
    state.sites = Object.keys(bySite).filter((s) => bySite[s].length).sort();
    state.events = state.sites
      .reduce((all, s) => all.concat(bySite[s]), [])
      .sort((a, b) => McpEvents.compareByTime(a, b, false));
    if (state.site !== ALL && !state.sites.includes(state.site)) state.site = ALL;
    els.summary.textContent =
      total + " event" + (total === 1 ? "" : "s") + " on " + state.sites.length + " site" + (state.sites.length === 1 ? "" : "s");
    renderSites();
    renderList();
    renderSdkStatus();
  }

  function decode() {
    const encoded = els.atob.value.trim();
    if (!encoded) {
      els.decodeOut.hidden = true;
      els.decodeActions.hidden = true;
      state.decoded = null;
      return;
    }
    els.decodeOut.hidden = false;
    try {
      let value = encoded;
      try {
        value = decodeURIComponent(value);
      } catch (_) {}
      const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
      state.decoded = JSON.parse(new TextDecoder().decode(bytes));
      showJson(els.decodeOut, state.decoded);
      els.decodeActions.hidden = false;
    } catch (_) {
      state.decoded = null;
      els.decodeOut.innerHTML = '<p class="hint err">Not valid base64-encoded JSON.</p>';
      els.decodeActions.hidden = true;
    }
  }

  document.getElementById("BtnFullScreen").addEventListener("click", () => openPage("fullscreen.html"));
  document.getElementById("BtnSdkTools").addEventListener("click", () => openPage("settings.html"));
  els.sdk.addEventListener("click", () => openPage("settings.html"));
  document.getElementById("BtnSdkStop").addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "MCP_STOP_SDK_TOOLS", reload: true }, () => renderSdkStatus());
  });
  document.getElementById("BtnRefresh").addEventListener("click", init);
  document.getElementById("BtnClear").addEventListener("click", () => {
    if (!window.confirm("Delete every captured event? SDK Tools settings are kept.")) return;
    chrome.runtime.sendMessage({ type: "MCP_CLEAR_EVENTS_KEEP_SETTINGS" }, () => {
      state.open = null;
      init();
    });
  });

  els.sites.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-site]");
    if (!chip) return;
    state.site = chip.getAttribute("data-site");
    state.open = null;
    renderSites();
    renderList();
  });

  els.list.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]");
    if (act) {
      const event = state.events.find((x) => x.id === state.open);
      if (!event) return;
      if (act.dataset.act === "explorer") {
        const hash = new URLSearchParams({ site: event.site, event: event.id }).toString();
        openPage("fullscreen.html#" + hash);
      } else if (act.dataset.act === "copy") {
        await navigator.clipboard.writeText(JSON.stringify(event.payload, null, 2));
        flash(act, "Copied");
      }
      return;
    }
    const row = e.target.closest(".pp-row");
    if (!row) return;
    const id = row.getAttribute("data-id");
    state.open = state.open === id ? null : id;
    renderList();
  });

  els.atob.addEventListener("input", decode);
  document.getElementById("BtnCopyJson").addEventListener("click", async (e) => {
    if (!state.decoded) return;
    await navigator.clipboard.writeText(JSON.stringify(state.decoded, null, 2));
    flash(e.currentTarget, "Copied");
  });
  document.getElementById("BtnDownloadJson").addEventListener("click", (e) => {
    if (!state.decoded) return;
    downloadJson(state.decoded, "mcp-event-" + moment().format("YYYYMMDD-HHmmss") + ".json");
    flash(e.currentTarget, "Saved");
  });

  init();
})();
