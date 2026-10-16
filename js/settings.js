(function () {
  const els = {
    forceEnabled: document.getElementById("forceEnabled"),
    forceUrl: document.getElementById("forceUrl"),
    localEnabled: document.getElementById("localEnabled"),
    sdkSourceUrl: document.getElementById("sdkSourceUrl"),
    sdkEditor: document.getElementById("sdkEditor"),
    statusLine: document.getElementById("statusLine"),
    metaFile: document.getElementById("metaFile"),
    metaChars: document.getElementById("metaChars"),
    metaUpdated: document.getElementById("metaUpdated"),
    metaDirtyEdit: document.getElementById("metaDirtyEdit"),
    diffPanel: document.getElementById("diffPanel"),
    diffBody: document.getElementById("diffBody"),
    diffStats: document.getElementById("diffStats"),
    fileInput: document.getElementById("fileInput"),
    dirtyBadge: document.getElementById("dirtyBadge"),
    redirectEmpty: document.getElementById("redirectEmpty"),
    editEmpty: document.getElementById("editEmpty"),
    panelRedirect: document.getElementById("PanelRedirect"),
    panelEdit: document.getElementById("PanelEdit"),
    tabRedirect: document.getElementById("TabRedirect"),
    tabEdit: document.getElementById("TabEdit"),
    stepEdit: document.getElementById("StepEdit"),
    stepUse: document.getElementById("StepUse"),
    sitesInput: document.getElementById("sitesInput"),
    openUrl: document.getElementById("openUrl"),
    openTabHosts: document.getElementById("openTabHosts"),
    openTabHostList: document.getElementById("openTabHostList"),
    forceFetchRow: document.getElementById("forceFetchRow"),
    forceFetchStatus: document.getElementById("forceFetchStatus"),
  };

  let originalText = "";
  let loadedFileName = "";
  let loadedSourceUrl = "";
  let updatedAt = null;
  let savedSnapshot = "";
  let activeMode = "redirect";
  let lastFetched = null;

  function setStatus(message, kind) {
    els.statusLine.textContent = message || "Ready.";
    els.statusLine.className =
      "st-footer-status" + (kind ? " " + kind : "");
  }

  function sendMessage(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response || {});
      });
    });
  }

  function collectSettings() {
    return {
      sites: parseSiteList(els.sitesInput.value),
      forceSdk: {
        enabled: !!els.forceEnabled.checked,
        url: els.forceUrl.value.trim(),
      },
      localEdit: {
        enabled: !!els.localEnabled.checked,
        sourceUrl: loadedSourceUrl || els.sdkSourceUrl.value.trim(),
        fileName: loadedFileName || "",
        original: originalText || "",
        edited: els.sdkEditor.value || "",
        updatedAt: updatedAt,
        openUrl: els.openUrl.value.trim(),
      },
    };
  }

  function snapshotOf(settings) {
    return JSON.stringify({
      sites: settings.sites,
      forceSdk: settings.forceSdk,
      localEdit: {
        enabled: settings.localEdit.enabled,
        sourceUrl: settings.localEdit.sourceUrl,
        fileName: settings.localEdit.fileName,
        // Persist editor contents with settings so reload restores draft
        original: settings.localEdit.original,
        edited: settings.localEdit.edited,
        updatedAt: settings.localEdit.updatedAt,
        openUrl: settings.localEdit.openUrl,
      },
    });
  }

  function hasSdkLoaded() {
    return !!(originalText || els.sdkEditor.value);
  }

  function updateDirtyBadge() {
    const dirty = snapshotOf(collectSettings()) !== savedSnapshot;
    els.dirtyBadge.classList.toggle("visible", dirty);
  }

  function updateRedirectEmpty() {
    els.redirectEmpty.style.display = els.forceEnabled.checked
      ? "none"
      : "block";
    els.redirectEmpty.textContent = els.forceEnabled.checked
      ? ""
      : "Redirect is off. SDK requests will load normally.";
  }

  function updateEditChrome() {
    const loaded = hasSdkLoaded();
    els.editEmpty.style.display = loaded ? "none" : "block";
    els.stepEdit.style.opacity = loaded ? "1" : "0.55";
    els.stepUse.style.opacity = loaded ? "1" : "0.55";

    [
      "BtnInjectOpen",
      "BtnCompare",
      "BtnDownloadEdited",
      "BtnResetEdited",
    ].forEach((id) => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = !loaded;
    });

    els.metaFile.innerHTML = loadedFileName
      ? "<strong>Source:</strong> " + escapeHtml(loadedFileName)
      : "<strong>Source:</strong> None";

    const len = els.sdkEditor.value.length;
    const originalLen = originalText.length;
    els.metaChars.textContent = loaded
      ? "Original size: " +
        originalLen.toLocaleString() +
        " · Edited size: " +
        len.toLocaleString()
      : "";

    els.metaUpdated.textContent = updatedAt
      ? "Last loaded: " + new Date(updatedAt).toLocaleString()
      : "";

    if (!loaded) {
      els.metaDirtyEdit.textContent = "";
    } else if (!originalText) {
      els.metaDirtyEdit.textContent = "Edited SDK has changes";
    } else if (els.sdkEditor.value === originalText) {
      els.metaDirtyEdit.textContent = "No edits";
    } else {
      els.metaDirtyEdit.textContent = "Edited SDK has changes";
    }

    updateDirtyBadge();
  }

  function setMode(mode) {
    activeMode = mode === "edit" ? "edit" : "redirect";
    const isEdit = activeMode === "edit";

    els.tabRedirect.classList.toggle("active", !isEdit);
    els.tabEdit.classList.toggle("active", isEdit);
    els.tabRedirect.setAttribute("aria-selected", String(!isEdit));
    els.tabEdit.setAttribute("aria-selected", String(isEdit));

    els.panelRedirect.classList.toggle("active", !isEdit);
    els.panelEdit.classList.toggle("active", isEdit);
    els.panelRedirect.hidden = isEdit;
    els.panelEdit.hidden = !isEdit;
  }

  function applySettings(settings) {
    const s = mergeSettings(settings);
    lastFetched = s.forceSdk.fetched || null;
    els.sitesInput.value = s.sites.join(", ");
    els.openUrl.value = s.localEdit.openUrl || els.openUrl.value || "";
    els.forceEnabled.checked = !!s.forceSdk.enabled;
    els.forceUrl.value = s.forceSdk.url || "";
    els.localEnabled.checked = !!s.localEdit.enabled;
    els.sdkSourceUrl.value = s.localEdit.sourceUrl || "";
    originalText = s.localEdit.original || "";
    els.sdkEditor.value = s.localEdit.edited || s.localEdit.original || "";
    loadedFileName = s.localEdit.fileName || "";
    loadedSourceUrl = s.localEdit.sourceUrl || "";
    updatedAt = s.localEdit.updatedAt || null;
    savedSnapshot = snapshotOf(collectSettings());
    updateForceUrlWarning();
    updateRedirectEmpty();
    updateEditChrome();
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  async function saveSettings() {
    const settings = collectSettings();

    if ((settings.forceSdk.enabled || settings.localEdit.enabled) && !settings.sites.length) {
      setStatus("Add at least one site under Sites (or * for every site).", "err");
      els.sitesInput.focus();
      return;
    }

    if (settings.forceSdk.enabled && !parseHttpUrl(settings.forceSdk.url)) {
      setStatus("Enter a full http or https URL for the replacement SDK.", "err");
      setMode("redirect");
      return;
    }

    if (settings.localEdit.enabled && !settings.localEdit.edited) {
      setStatus(
        "Enable edited SDK injection only after an SDK is loaded.",
        "err"
      );
      setMode("edit");
      return;
    }

    if (settings.forceSdk.enabled && settings.localEdit.enabled) {
      // Older saved settings could have both on; Redirect is the one shown first.
      settings.localEdit.enabled = false;
    }

    updatedAt = updatedAt || Date.now();
    settings.localEdit.updatedAt = updatedAt;

    const res = await sendMessage({ type: "MCP_SAVE_SETTINGS", settings });
    if (!res.ok) {
      setStatus(res.error || "Failed to save settings", "err");
      return;
    }

    applySettings(res.settings);

    const where = describeSites(res.settings.sites);
    const f = res.settings.forceSdk.fetched;
    if (res.settings.forceSdk.enabled && f && f.error) {
      setStatus("Settings saved, but fetching the replacement failed: " + f.error, "err");
      return;
    }
    if (res.settings.forceSdk.enabled) {
      setStatus("Settings saved. Redirect is on for " + where + ". Reload those pages.", "ok");
    } else if (res.settings.localEdit.enabled) {
      setStatus(
        "Settings saved. The edited SDK runs on " + where + " on page load.",
        "ok"
      );
    } else {
      setStatus(
        "Settings saved. Redirect is off. SDK requests will load normally.",
        "ok"
      );
    }
  }

  async function loadFromUrl() {
    const url = els.sdkSourceUrl.value.trim();
    if (!parseHttpUrl(url)) {
      setStatus("Enter a full http or https URL.", "err");
      return;
    }
    setStatus("Loading SDK...");
    const res = await sendMessage({ type: "MCP_FETCH_SDK", url });
    if (!res.ok) {
      setStatus(res.error || "Failed to fetch SDK", "err");
      return;
    }
    originalText = res.text || "";
    els.sdkEditor.value = originalText;
    loadedFileName = res.fileName || "sdk.js";
    loadedSourceUrl = url;
    updatedAt = Date.now();
    els.diffPanel.classList.remove("visible");
    updateEditChrome();
    updateDirtyBadge();
    setStatus("Loaded SDK from URL.", "ok");
  }

  function loadFromFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      originalText = String(reader.result || "");
      els.sdkEditor.value = originalText;
      loadedFileName = file.name || "sdk.js";
      loadedSourceUrl = "";
      updatedAt = Date.now();
      els.diffPanel.classList.remove("visible");
      updateEditChrome();
      updateDirtyBadge();
      setStatus("Loaded SDK from file.", "ok");
    };
    reader.onerror = () => setStatus("Failed to read file", "err");
    reader.readAsText(file);
  }

  function downloadEdited() {
    const text = els.sdkEditor.value;
    if (!text) {
      setStatus("Load an SDK before downloading.", "err");
      return;
    }
    const name =
      (loadedFileName || "sdk").replace(/\.js$/i, "") + "-edited.js";
    const blob = new Blob([text], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus("Downloaded edited SDK.", "ok");
  }

  function buildLineDiff(aText, bText) {
    const a = aText.split("\n");
    const b = bText.split("\n");
    const n = a.length;
    const m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
        else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const lines = [];
    let i = 0;
    let j = 0;
    let adds = 0;
    let dels = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        lines.push({ type: "same", text: a[i], line: j + 1 });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        lines.push({ type: "del", text: a[i], line: i + 1 });
        dels++;
        i++;
      } else {
        lines.push({ type: "add", text: b[j], line: j + 1 });
        adds++;
        j++;
      }
    }
    while (i < n) {
      lines.push({ type: "del", text: a[i], line: i + 1 });
      dels++;
      i++;
    }
    while (j < m) {
      lines.push({ type: "add", text: b[j], line: j + 1 });
      adds++;
      j++;
    }
    return { lines, adds, dels };
  }

  function compareWithOriginal() {
    if (!originalText) {
      setStatus("Load an original SDK first to compare.", "err");
      return;
    }
    const edited = els.sdkEditor.value;
    if (edited === originalText) {
      els.diffPanel.classList.add("visible");
      els.diffBody.innerHTML =
        '<div class="st-diff-line same"><span class="ln"></span><span>No changes detected.</span></div>';
      els.diffStats.textContent = "0 added, 0 removed";
      setStatus("No changes detected.", "ok");
      return;
    }

    const { lines, adds, dels } = buildLineDiff(originalText, edited);
    els.diffBody.innerHTML = lines
      .map((row) => {
        const prefix =
          row.type === "add" ? "+" : row.type === "del" ? "-" : " ";
        return `<div class="st-diff-line ${row.type}"><span class="ln">${
          row.line || ""
        }</span><span>${prefix} ${escapeHtml(row.text)}</span></div>`;
      })
      .join("");
    els.diffStats.textContent = adds + " added, " + dels + " removed";
    els.diffPanel.classList.add("visible");
    setStatus("Comparison updated.", "ok");
  }

  function resetToOriginal() {
    if (!originalText) {
      setStatus("No original loaded.", "err");
      return;
    }
    if (els.sdkEditor.value !== originalText) {
      const ok = window.confirm(
        "Reset editor to the original SDK? Your current edits will be lost."
      );
      if (!ok) return;
    }
    els.sdkEditor.value = originalText;
    updatedAt = Date.now();
    els.diffPanel.classList.remove("visible");
    updateEditChrome();
    setStatus("Editor reset to original SDK.", "ok");
  }

  function parseHttpUrl(value) {
    try {
      const parsed = new URL(String(value || "").trim());
      return parsed.protocol === "http:" || parsed.protocol === "https:"
        ? parsed
        : null;
    } catch (_) {
      return null;
    }
  }

  function describeSites(sites) {
    if (!sites || !sites.length) return "no sites";
    if (sites.includes("*")) return "every site";
    return sites.join(", ");
  }

  function updateForceUrlWarning() {
    const url = els.forceUrl.value.trim();
    const show = needsFetchedSdk(url);
    els.forceFetchRow.hidden = !show;
    if (!show) return;
    const parsed = parseHttpUrl(url);
    const f = lastFetched;
    let text;
    let isErr = false;
    if (!f || f.url !== parsed.toString()) {
      text = "The extension will fetch this http file when you save.";
    } else if (f.error) {
      text = "Fetch failed: " + f.error + " The SDK loads normally until a fetch works.";
      isErr = true;
    } else {
      text =
        "Fetched " +
        (f.bytes < 1024 ? f.bytes + " bytes" : (f.bytes / 1024).toFixed(1) + " KB") +
        " at " +
        new Date(f.at).toLocaleTimeString() +
        ". After changing the file, click Fetch again.";
    }
    els.forceFetchStatus.textContent = text;
    els.forceFetchStatus.classList.toggle("err", isErr);
    document.getElementById("BtnRefetch").disabled =
      !(f && f.url === parsed.toString() && els.forceEnabled.checked);
  }

  function addSite(hostname) {
    const sites = parseSiteList(els.sitesInput.value);
    if (siteMatches(sites, hostname)) return false;
    sites.push(hostname.replace(/^www\./, ""));
    els.sitesInput.value = parseSiteList(sites).join(", ");
    updateDirtyBadge();
    renderOpenTabHosts();
    return true;
  }

  async function getWebTabs() {
    try {
      const tabs = await chrome.tabs.query({});
      return tabs
        .filter((t) => /^https?:/i.test(t.url || ""))
        .sort((x, y) => (y.lastAccessed || 0) - (x.lastAccessed || 0));
    } catch (_) {
      return [];
    }
  }

  async function renderOpenTabHosts() {
    const listed = parseSiteList(els.sitesInput.value);
    const hosts = [];
    (await getWebTabs()).forEach((t) => {
      const host = new URL(t.url).hostname;
      if (!hosts.includes(host) && !siteMatches(listed, host)) hosts.push(host);
    });
    els.openTabHosts.hidden = !hosts.length;
    els.openTabHostList.innerHTML = hosts
      .slice(0, 12)
      .map(
        (h) =>
          '<button type="button" class="st-host-chip" data-host="' +
          escapeHtml(h) +
          '">' +
          escapeHtml(h) +
          "</button>"
      )
      .join("");
  }

  async function prefillOpenUrl() {
    if (els.openUrl.value.trim()) return;
    const tabs = await getWebTabs();
    if (tabs.length) els.openUrl.value = tabs[0].url;
  }

  async function injectAndOpen() {
    if (!els.sdkEditor.value) {
      setStatus("Load an SDK before injecting.", "err");
      return;
    }
    const target = parseHttpUrl(els.openUrl.value);
    if (!target) {
      setStatus("Enter the full http or https URL of the page to open.", "err");
      els.openUrl.focus();
      return;
    }

    const added = addSite(target.hostname);
    updatedAt = Date.now();
    els.localEnabled.checked = true;
    els.forceEnabled.checked = false;
    updateRedirectEmpty();
    const settings = collectSettings();
    settings.localEdit.updatedAt = updatedAt;

    const saved = await sendMessage({ type: "MCP_SAVE_SETTINGS", settings });
    if (!saved.ok) {
      setStatus(saved.error || "Failed to save before inject", "err");
      return;
    }
    applySettings(saved.settings);

    // The content script asks for the edited SDK at document_start, so a
    // fresh tab gets it before the page's own scripts run.
    await chrome.tabs.create({ url: target.toString() });
    setStatus(
      "Opened " +
        target.hostname +
        " with the edited SDK." +
        (added ? " Added " + target.hostname.replace(/^www\./, "") + " to Sites." : ""),
      "ok"
    );
  }

  async function init() {
    els.tabRedirect.addEventListener("click", () => setMode("redirect"));
    els.tabEdit.addEventListener("click", () => setMode("edit"));

    document.getElementById("BtnSaveAll").addEventListener("click", () => {
      saveSettings().catch((e) => setStatus(String(e.message || e), "err"));
    });
    document.getElementById("BtnLoadSdk").addEventListener("click", () => {
      loadFromUrl().catch((e) => setStatus(String(e.message || e), "err"));
    });
    document.getElementById("BtnLoadFile").addEventListener("click", () => {
      els.fileInput.click();
    });
    els.fileInput.addEventListener("change", () => {
      const file = els.fileInput.files && els.fileInput.files[0];
      loadFromFile(file);
      els.fileInput.value = "";
    });
    document
      .getElementById("BtnResetEdited")
      .addEventListener("click", resetToOriginal);
    document
      .getElementById("BtnDownloadEdited")
      .addEventListener("click", downloadEdited);
    document
      .getElementById("BtnCompare")
      .addEventListener("click", compareWithOriginal);
    document.getElementById("BtnHideDiff").addEventListener("click", () => {
      els.diffPanel.classList.remove("visible");
    });
    document.getElementById("BtnRefetch").addEventListener("click", async () => {
      setStatus("Fetching...");
      try {
        const res = await sendMessage({ type: "MCP_REFETCH_SDK" });
        if (!res.ok) throw new Error(res.error || "Fetch failed");
        applySettings(res.settings);
        const f = res.settings.forceSdk.fetched;
        if (f && f.error) setStatus("Fetch failed: " + f.error, "err");
        else setStatus("Fetched the replacement again. Reload the site with the cache off.", "ok");
      } catch (e) {
        setStatus(String(e.message || e), "err");
      }
    });
    document.getElementById("BtnInjectOpen").addEventListener("click", () => {
      injectAndOpen().catch((e) => setStatus(String(e.message || e), "err"));
    });
    els.openTabHostList.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-host]");
      if (chip) addSite(chip.getAttribute("data-host"));
    });
    els.sitesInput.addEventListener("input", () => {
      updateDirtyBadge();
      renderOpenTabHosts();
    });
    els.openUrl.addEventListener("input", updateDirtyBadge);
    els.forceUrl.addEventListener("input", updateForceUrlWarning);
    // Redirect and Edit are exclusive: Edit blocks the SDK that Redirect
    // would replace, so both on meant Redirect silently did nothing.
    els.forceEnabled.addEventListener("change", () => {
      if (els.forceEnabled.checked && els.localEnabled.checked) {
        els.localEnabled.checked = false;
        setStatus("Edit SDK turned off: only one of Redirect and Edit can be on.", "warn");
      }
      updateForceUrlWarning();
      updateDirtyBadge();
    });
    els.localEnabled.addEventListener("change", () => {
      if (els.localEnabled.checked && els.forceEnabled.checked) {
        els.forceEnabled.checked = false;
        updateRedirectEmpty();
        setStatus("Redirect turned off: only one of Redirect and Edit can be on.", "warn");
      }
      updateDirtyBadge();
    });
    document.getElementById("BtnOpenExplorer").addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("fullscreen.html") });
    });

    ["change", "input"].forEach((evt) => {
      els.forceEnabled.addEventListener(evt, () => {
        updateRedirectEmpty();
        updateDirtyBadge();
      });
      els.forceUrl.addEventListener(evt, updateDirtyBadge);
      els.localEnabled.addEventListener(evt, updateDirtyBadge);
      els.sdkSourceUrl.addEventListener(evt, updateDirtyBadge);
    });

    els.sdkEditor.addEventListener("input", () => {
      updateEditChrome();
    });

    try {
      const res = await sendMessage({ type: "MCP_GET_SETTINGS" });
      if (res.ok) applySettings(res.settings);
      setMode(res.ok && res.settings.localEdit.enabled && !res.settings.forceSdk.enabled ? "edit" : "redirect");
      renderOpenTabHosts();
      prefillOpenUrl();
      if (res.settings?.localEdit?.edited) {
        setStatus("Draft restored from saved settings.", "ok");
      } else {
        setStatus("Ready.", "ok");
      }
    } catch (e) {
      setStatus(String(e.message || e), "err");
    }
  }

  init();
})();
