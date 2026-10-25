/**
 * Feedback page. Posts to the feedback Worker shared with SFMC Toolkit
 * (D1 sfmc-query-saver-feedback, rows tagged app = "mcp-logger"), with
 * technical details the developer can read and copy before sending.
 */
(function () {
  const FEEDBACK_URL = "https://query-saver-feedback.mathes-btech.workers.dev/feedback";
  const DIAG_KEY = "__mcp_diag__";
  // The Worker rejects metadata over 20,000 characters.
  const MAX_META_CHARS = 19000;

  const els = {
    form: document.getElementById("fbForm"),
    kind: document.getElementById("fbKind"),
    message: document.getElementById("fbMessage"),
    details: document.getElementById("fbDetails"),
    email: document.getElementById("fbEmail"),
    includeMeta: document.getElementById("fbIncludeMeta"),
    meta: document.getElementById("fbMeta"),
    status: document.getElementById("fbStatus"),
    send: document.getElementById("fbSend"),
  };

  let kind = "problem";
  let metadata = null;

  function setStatus(text, cls) {
    els.status.textContent = text;
    els.status.className = "st-footer-status" + (cls ? " " + cls : "");
  }

  /** Origin and path only: query strings can carry tokens or personal data. */
  function pageAddress(url) {
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch (_) {
      return "";
    }
  }

  function describeRule(rule) {
    const action = rule.action || {};
    const out = { id: rule.id, type: action.type, priority: rule.priority };
    if (action.redirect) {
      const url = action.redirect.url || "";
      out.redirect = url.indexOf("data:") === 0 ? "data: URL (" + url.length + " chars)" : url;
    }
    if (action.responseHeaders) out.responseHeaders = action.responseHeaders;
    const c = rule.condition || {};
    out.condition = {
      regexFilter: c.regexFilter,
      urlFilter: c.urlFilter,
      initiatorDomains: c.initiatorDomains,
      requestDomains: c.requestDomains,
      resourceTypes: c.resourceTypes,
    };
    return out;
  }

  function describeReport(r) {
    return {
      at: new Date(r.startedAt || r.receivedAt || 0).toISOString(),
      page: pageAddress(r.url),
      status: r.status,
      sdkScripts: r.sdkScripts || [],
      ranId: r.ranId || null,
      checked: !!r.checkedAt,
      notes: (r.notes || []).map((n) => n.level + ": " + String(n.text).slice(0, 400)),
    };
  }

  async function collectMetadata() {
    const items = await chrome.storage.local.get(null);
    const settings = mergeSettings(items[MCP_SETTINGS_KEY]);
    const local = settings.localEdit;
    const force = settings.forceSdk;
    const mode = local.enabled && local.edited ? "edit" : force.enabled && force.url ? "redirect" : "off";
    let self = null;
    try {
      self = await chrome.management.getSelf();
    } catch (_) {}
    let rules = [];
    try {
      rules = (await chrome.declarativeNetRequest.getSessionRules()).map(describeRule);
    } catch (e) {
      rules = [{ error: String(e && e.message ? e.message : e) }];
    }
    const events = McpEvents.normalizeEvents(items);

    const meta = {
      app: "mcp-logger",
      extension: {
        version: chrome.runtime.getManifest().version,
        id: chrome.runtime.id,
        installType: self ? self.installType : "unknown",
      },
      browser: {
        userAgent: navigator.userAgent,
        platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform,
        language: navigator.language,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      sdkTools: {
        mode,
        sites: settings.sites,
        redirect: {
          enabled: !!force.enabled,
          url: force.url || "",
          fetched: force.fetched
            ? { url: force.fetched.url, bytes: force.fetched.bytes, error: force.fetched.error || "", at: force.fetched.at }
            : null,
        },
        edit: {
          enabled: !!local.enabled,
          fileName: local.fileName || "",
          sourceUrl: local.sourceUrl || "",
          originalChars: (local.original || "").length,
          editedChars: (local.edited || "").length,
          id: local.edited ? sdkFingerprint(local.edited) : "",
          changed: !!local.edited && local.edited !== local.original,
          savedAt: local.savedAt ? new Date(local.savedAt).toISOString() : null,
          servedBy: local.edited ? (editServedByRedirect(settings) ? "redirect" : "inject") : "",
        },
      },
      rules,
      pageReports: (Array.isArray(items[DIAG_KEY]) ? items[DIAG_KEY] : []).map(describeReport),
      events: { total: events.total, sites: Object.keys(events.bySite).length },
      collectedAt: new Date().toISOString(),
    };

    // Keep under the Worker's limit: drop the oldest page reports first.
    while (JSON.stringify(meta).length > MAX_META_CHARS && meta.pageReports.length) {
      meta.pageReports.pop();
      meta.pageReportsTrimmed = true;
    }
    return meta;
  }

  async function refreshMeta() {
    try {
      metadata = await collectMetadata();
      els.meta.textContent = JSON.stringify(metadata, null, 2);
    } catch (e) {
      metadata = null;
      els.meta.textContent = "Could not collect technical details: " + (e && e.message ? e.message : e);
    }
  }

  function setKind(next) {
    kind = next;
    els.kind.querySelectorAll("[data-kind]").forEach((b) =>
      b.setAttribute("aria-checked", String(b.dataset.kind === kind))
    );
  }

  function fromPage() {
    const from = new URLSearchParams(location.search).get("from");
    return /^[a-z-]{1,30}$/.test(from || "") ? from : "feedback";
  }

  async function send() {
    const message = els.message.value.trim();
    if (!message) {
      setStatus("Write a short summary first.", "err");
      els.message.focus();
      return;
    }
    if (els.includeMeta.checked) await refreshMeta();
    const body = {
      app: "mcp-logger",
      kind,
      message,
      details: els.details.value.trim() || undefined,
      email: els.email.value.trim() || undefined,
      screen: "mcp-logger/" + fromPage(),
      version: chrome.runtime.getManifest().version,
      metadata: els.includeMeta.checked && metadata ? metadata : undefined,
    };
    els.send.disabled = true;
    setStatus("Sending...");
    try {
      const res = await fetch(FEEDBACK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "HTTP " + res.status);
      setStatus("Sent. Thank you" + (data.id != null ? " (feedback #" + data.id + ")." : "."), "ok");
      showThanks(data.id);
      els.message.value = "";
      els.details.value = "";
      try {
        localStorage.setItem("mcpFeedbackEmail", body.email || "");
      } catch (_) {}
    } catch (e) {
      setStatus("Could not send: " + (e && e.message ? e.message : e) + ". Use Copy technical details and send them another way.", "err");
    } finally {
      els.send.disabled = false;
    }
  }

  // Feedback #142: a clear thank-you in place of the form once it is sent.
  function showThanks(id) {
    const thanks = document.getElementById("fbThanks");
    document.getElementById("fbThanksText").textContent =
      "Your feedback was sent" + (id != null ? " as #" + id : "") + ".";
    els.form.hidden = true;
    document.getElementById("fbFooter").hidden = true;
    thanks.hidden = false;
    thanks.focus();
    window.scrollTo(0, 0);
  }

  document.getElementById("fbAgain").addEventListener("click", () => {
    document.getElementById("fbThanks").hidden = true;
    els.form.hidden = false;
    document.getElementById("fbFooter").hidden = false;
    setStatus("Ready.");
    els.message.focus();
  });

  els.kind.addEventListener("click", (e) => {
    const b = e.target.closest("[data-kind]");
    if (b) setKind(b.dataset.kind);
  });
  document.getElementById("fbRefreshMeta").addEventListener("click", refreshMeta);
  document.getElementById("fbCopyMeta").addEventListener("click", async (e) => {
    await refreshMeta();
    try {
      await navigator.clipboard.writeText(JSON.stringify(metadata, null, 2));
      setStatus("Technical details copied.", "ok");
    } catch (err) {
      setStatus("Copy failed: " + (err && err.message ? err.message : err), "err");
    }
  });
  els.includeMeta.addEventListener("change", () => {
    els.meta.hidden = !els.includeMeta.checked;
  });
  els.send.addEventListener("click", send);
  els.form.addEventListener("submit", (e) => e.preventDefault());

  try {
    els.email.value = localStorage.getItem("mcpFeedbackEmail") || "";
  } catch (_) {}
  refreshMeta();
})();
