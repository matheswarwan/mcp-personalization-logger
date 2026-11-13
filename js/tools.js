// Tools page (feedback #1001 and user, 2026-11-13): decode a payload, open a page with an SDK
// injected, read the SDK on a tab, and clear a site's cookies. The work that needs the tabs,
// scripting and cookies APIs runs in the service worker (MCP_OPEN_WITH_SDK, MCP_SDK_INFO,
// MCP_LIST_COOKIES, MCP_CLEAR_SITE_DATA).
(function () {
  const $ = (id) => document.getElementById(id);
  const LAST_OPEN = "mcp-tools-open";

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function send(message) {
    return new Promise((resolve) =>
      chrome.runtime.sendMessage(message, (res) => {
        const err = chrome.runtime.lastError;
        resolve(res || { ok: false, error: err ? err.message : "No answer from the extension." });
      })
    );
  }

  function flash(btn, label) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent.trim();
    btn.textContent = label;
    clearTimeout(btn._t);
    btn._t = setTimeout(() => (btn.textContent = btn.dataset.label), 1200);
  }

  function showJson(mount, data) {
    const viewer = new JSONViewer();
    mount.innerHTML = "";
    mount.appendChild(viewer.getContainer());
    viewer.showJSON(data);
  }

  function setStatus(el, text, isError) {
    el.textContent = text || "";
    el.classList.toggle("err", !!isError);
  }

  function readStored(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch (_) {
      return null;
    }
  }

  function store(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {}
  }

  /* ---------- Decode ---------- */

  let decoded = null;
  function decode() {
    const result = McpDecode.decodePayload($("decodeInput").value);
    const empty = !$("decodeInput").value.trim();
    $("decodeOut").hidden = empty;
    $("decodeHow").hidden = empty || !result.ok;
    $("decodeActions").hidden = !result.ok;
    decoded = result.ok ? result.value : null;
    if (empty) return;
    if (result.ok) {
      $("decodeHow").textContent = "Read as " + result.how + ".";
      showJson($("decodeOut"), result.value);
    } else {
      $("decodeOut").innerHTML = '<p class="hint err">' + escapeHtml(result.error) + "</p>";
    }
  }
  $("decodeInput").addEventListener("input", decode);
  $("BtnDecodeCopy").addEventListener("click", async (e) => {
    if (decoded == null) return;
    await navigator.clipboard.writeText(JSON.stringify(decoded, null, 2));
    flash(e.currentTarget, "Copied");
  });
  $("BtnDecodeDownload").addEventListener("click", (e) => {
    if (decoded == null) return;
    const blob = new Blob([JSON.stringify(decoded, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "mcp-event-" + moment().format("YYYYMMDD-HHmmss") + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    flash(e.currentTarget, "Saved");
  });

  /* ---------- Open a page with the SDK ---------- */

  async function prefillOpen() {
    const last = readStored(LAST_OPEN) || {};
    if (last.url) $("openPageUrl").value = last.url;
    if (last.sdkUrl) {
      $("openSdkUrl").value = last.sdkUrl;
      return;
    }
    // Otherwise the SDK Tools replacement URL, when one is set.
    const res = await send({ type: "MCP_GET_SETTINGS" });
    const url = res && res.settings && res.settings.forceSdk && res.settings.forceSdk.url;
    if (url) $("openSdkUrl").value = url;
  }

  $("BtnOpenWithSdk").addEventListener("click", async () => {
    const url = $("openPageUrl").value;
    const sdkUrl = $("openSdkUrl").value;
    setStatus($("openStatus"), "Opening…");
    const res = await send({ type: "MCP_OPEN_WITH_SDK", url, sdkUrl });
    if (!res.ok) {
      setStatus($("openStatus"), res.error, true);
      return;
    }
    store(LAST_OPEN, { url: res.url, sdkUrl: res.src });
    setStatus($("openStatus"), "Opened in a new tab. Its console says whether the SDK loaded.");
    await loadTabs(res.tabId);
  });

  /* ---------- Tab ---------- */

  async function loadTabs(preferId) {
    const tabs = (await chrome.tabs.query({})).filter((t) => /^https?:/.test(t.url || ""));
    const select = $("tabSelect");
    const current = preferId || Number(select.value) || Number(new URLSearchParams(location.search).get("tab")) || 0;
    if (!tabs.length) {
      select.innerHTML = '<option value="">No web pages are open</option>';
      return;
    }
    const chosen = tabs.find((t) => t.id === current) || tabs.find((t) => t.active) || tabs[0];
    select.innerHTML = tabs
      .map((t) => {
        let host = "";
        try {
          host = new URL(t.url).hostname;
        } catch (_) {}
        const label = host + " · " + (t.title || t.url);
        return `<option value="${t.id}"${t.id === chosen.id ? " selected" : ""}>${escapeHtml(label.length > 110 ? label.slice(0, 109) + "…" : label)}</option>`;
      })
      .join("");
  }

  function tabId() {
    const id = Number($("tabSelect").value);
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  $("BtnTabsRefresh").addEventListener("click", () => loadTabs());
  $("tabSelect").addEventListener("change", () => {
    $("sdkOut").innerHTML = "";
    $("cookieOut").innerHTML = "";
    $("BtnSdkInfoCopy").hidden = true;
    setStatus($("sdkStatus"), "");
    setStatus($("cookieStatus"), "");
  });

  /* ---------- SDK info ---------- */

  let lastInfo = null;

  function valueCell(item) {
    if (item.error) return `<span class="err">${escapeHtml(item.error)}</span>`;
    const v = item.value;
    if (v !== null && typeof v === "object") return '<div class="tl-json" data-json></div>';
    return `<span class="mono">${escapeHtml(v === null ? "null" : typeof v === "string" ? JSON.stringify(v) : String(v))}</span>`;
  }

  function renderSdk(info) {
    const out = $("sdkOut");
    const found = info.sdks.filter((s) => s.found);
    const parts = [];
    parts.push(
      `<p class="hint">${escapeHtml(info.url)} · read ${escapeHtml(moment(info.at).format("HH:mm:ss"))}` +
        (info.scripts.length ? ` · SDK script: ${info.scripts.map(escapeHtml).join(", ")}` : " · no SDK script tag on the page") +
        (info.injected ? " · injected by MCP Logger" : "") +
        "</p>"
    );
    if (!found.length) {
      parts.push(
        '<div class="empty"><strong>No SDK on this page</strong>Neither <code>SalesforceInteractions</code> nor <code>Evergage</code> exists. Use "Open a page with the SDK" above to add one.</div>'
      );
    }
    const objects = [];
    for (const sdk of found) {
      parts.push(`<h3 class="tl-h">${escapeHtml(sdk.name)}</h3>`);
      const rows = [];
      for (const g of sdk.getters) {
        objects.push(g);
        rows.push(
          `<tr><td class="mono">${escapeHtml(g.name)}()${g.documented ? ' <span class="badge badge-accent" title="Documented by Salesforce">doc</span>' : ""}</td><td>${valueCell(g)}</td></tr>`
        );
      }
      parts.push(
        rows.length
          ? `<table class="tl-table"><thead><tr><th>Function</th><th>Returns</th></tr></thead><tbody>${rows.join("")}</tbody></table>`
          : '<p class="hint">No get, is or has functions to call.</p>'
      );
      // Properties (constants, helper objects) are many and less often needed: folded.
      if (sdk.props.length) {
        const propRows = sdk.props.map((p) => {
          objects.push(p);
          return `<tr><td class="mono">${escapeHtml(p.name)}</td><td>${valueCell(p)}</td></tr>`;
        });
        parts.push(
          `<details class="tl-others"><summary>${sdk.props.length} propert${sdk.props.length === 1 ? "y" : "ies"} (constants, settings, helper objects)</summary>` +
            `<table class="tl-table"><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody>${propRows.join("")}</tbody></table></details>`
        );
      }
      if (sdk.others.length) {
        parts.push(
          `<details class="tl-others"><summary>${sdk.others.length} other function${sdk.others.length === 1 ? "" : "s"} (not called)</summary><p class="mono tl-names">` +
            sdk.others.map((o) => escapeHtml(o.name) + "(" + (o.params ? o.params + " arg" + (o.params === 1 ? "" : "s") : "") + ")").join(", ") +
            "</p></details>"
        );
      }
    }
    out.innerHTML = parts.join("");
    // Objects open in the JSON viewer, in the order the rows were written.
    const mounts = out.querySelectorAll("[data-json]");
    objects.filter((o) => !o.error && o.value !== null && typeof o.value === "object").forEach((o, i) => mounts[i] && showJson(mounts[i], o.value));
  }

  $("BtnSdkInfo").addEventListener("click", async () => {
    const id = tabId();
    if (!id) return setStatus($("sdkStatus"), "Choose a tab.", true);
    setStatus($("sdkStatus"), "Reading…");
    const res = await send({ type: "MCP_SDK_INFO", tabId: id });
    if (!res.ok || !res.info) {
      setStatus($("sdkStatus"), (res && res.error) || "Could not read the page.", true);
      return;
    }
    lastInfo = res.info;
    setStatus($("sdkStatus"), "");
    $("BtnSdkInfoCopy").hidden = false;
    renderSdk(res.info);
  });
  $("BtnSdkInfoCopy").addEventListener("click", async (e) => {
    if (!lastInfo) return;
    await navigator.clipboard.writeText(JSON.stringify(lastInfo, null, 2));
    flash(e.currentTarget, "Copied");
  });

  /* ---------- Cookies ---------- */

  function renderCookies(data) {
    if (!data.cookies.length) {
      $("cookieOut").innerHTML = '<p class="hint">No cookies for ' + escapeHtml(data.origin) + ".</p>";
      return;
    }
    const rows = data.cookies.map(
      (c) =>
        `<tr${c.sdk ? ' class="tl-sdk"' : ""}><td class="mono">${escapeHtml(c.name)}${c.sdk ? ' <span class="badge badge-accent">SDK</span>' : ""}</td>` +
        `<td class="mono tl-val" title="${escapeHtml(c.value)}">${escapeHtml(c.value.length > 80 ? c.value.slice(0, 79) + "…" : c.value)}</td>` +
        `<td class="mono">${escapeHtml(c.domain)}</td>` +
        `<td>${c.expires ? escapeHtml(moment(c.expires).format("YYYY-MM-DD")) : "session"}</td></tr>`
    );
    $("cookieOut").innerHTML =
      `<p class="hint">${data.cookies.length} cookie${data.cookies.length === 1 ? "" : "s"} for ${escapeHtml(data.origin)}, ${data.cookies.filter((c) => c.sdk).length} from the SDK.</p>` +
      `<table class="tl-table"><thead><tr><th>Name</th><th>Value</th><th>Domain</th><th>Expires</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
  }

  async function showCookies() {
    const id = tabId();
    if (!id) return setStatus($("cookieStatus"), "Choose a tab.", true);
    const res = await send({ type: "MCP_LIST_COOKIES", tabId: id });
    if (!res.ok) return setStatus($("cookieStatus"), res.error, true);
    renderCookies(res);
  }

  async function clear(scope) {
    const id = tabId();
    if (!id) return setStatus($("cookieStatus"), "Choose a tab.", true);
    if (scope === "all" && !window.confirm("Remove every cookie this page gets, and its localStorage and sessionStorage? You may be signed out of the site.")) return;
    const reload = $("reloadAfter").checked;
    setStatus($("cookieStatus"), "Clearing…");
    const res = await send({ type: "MCP_CLEAR_SITE_DATA", tabId: id, scope, reload });
    if (!res.ok) return setStatus($("cookieStatus"), res.error, true);
    const what =
      scope === "all"
        ? `Removed ${res.removed} cookie${res.removed === 1 ? "" : "s"}` + (res.storage != null ? ` and ${res.storage} storage item${res.storage === 1 ? "" : "s"}` : "")
        : res.found
          ? `Removed ${res.removed} SDK cookie${res.removed === 1 ? "" : "s"}`
          : "No SDK cookies to remove";
    setStatus($("cookieStatus"), what + (reload ? ". The tab is reloading." : "."));
    // After a reload the SDK sets a new id; give it a moment before listing again.
    setTimeout(showCookies, reload ? 2500 : 0);
  }

  $("BtnCookies").addEventListener("click", showCookies);
  $("BtnClearSdkCookies").addEventListener("click", () => clear("sdk"));
  $("BtnClearAll").addEventListener("click", () => clear("all"));

  prefillOpen();
  loadTabs();
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
})();
