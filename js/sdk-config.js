/** Shared SDK tooling config for Force SDK URL + Local Edit */

const MCP_SETTINGS_KEY = "__mcp_settings__";

const DEFAULT_MCP_SETTINGS = {
  // Sites (domains) where Redirect and Edit apply; subdomains included.
  // "*" means every site. Empty means the tools do nothing.
  sites: [],
  forceSdk: {
    enabled: false,
    url: "",
    // For http URLs not on localhost: the extension fetches the file and
    // serves it as a data: URL, because Chrome blocks http scripts on https
    // pages. { url, code, bytes, at, error }
    fetched: null,
  },
  localEdit: {
    enabled: false,
    sourceUrl: "",
    fileName: "",
    original: "",
    edited: "",
    updatedAt: null,
    openUrl: "",
  },
};

// http or https, optional port, evergage.js or evergage.min.js (same for c360a).
const SDK_SCRIPT_REGEXES = [
  "^https?://cdn\\.evgnet\\.com(:[0-9]+)?/[^?#]*evergage(\\.min)?\\.js([?#].*)?$",
  "^https?://cdn\\.c360a\\.salesforce\\.com(:[0-9]+)?/[^?#]*c360a(\\.min)?\\.js([?#].*)?$",
];

const DNR_RULE_ID_ALLOW_TARGET = 91020;

// Chrome caps URLs at 2 MB; base64 adds a third, so stay well below.
const MAX_FETCHED_SDK_CHARS = 1400000;

/** True when the replacement URL must be fetched by the extension. */
function needsFetchedSdk(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    return parsed.protocol === "http:" && !isLocalHost(parsed.hostname);
  } catch (_) {
    return false;
  }
}

/**
 * Edit mode serves the edited SDK through a data: redirect (so it runs where
 * the SDK tag is) when it fits in a URL; larger files fall back to blocking
 * the CDN SDK and injecting the code from the content script.
 */
function editServedByRedirect(settings) {
  const local = settings && settings.localEdit;
  return !!(
    local &&
    local.enabled &&
    local.edited &&
    local.edited.length <= MAX_FETCHED_SDK_CHARS
  );
}

function toBase64Utf8(text) {
  const bytes = new TextEncoder().encode(String(text));
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Turn free text ("https://www.example.com/path, shop.example.ca") into a
 * list of lowercase hostnames. "*" is kept as the all-sites marker.
 */
function parseSiteList(input) {
  const parts = Array.isArray(input)
    ? input
    : String(input || "").split(/[\s,;]+/);
  const out = [];
  parts.forEach((raw) => {
    let value = String(raw || "").trim().toLowerCase();
    if (!value) return;
    if (value === "*") {
      out.push("*");
      return;
    }
    value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
    value = value.split(/[/?#]/)[0];
    value = value.replace(/:\d+$/, "").replace(/^\*\./, "").replace(/\.$/, "");
    if (/^[a-z0-9.-]+$/.test(value) || /^\[[0-9a-f:]+\]$/.test(value)) {
      out.push(value);
    }
  });
  return [...new Set(out)];
}

function siteMatches(sites, hostname) {
  const list = parseSiteList(sites);
  const host = String(hostname || "").toLowerCase();
  if (!host) return false;
  return list.some(
    (d) => d === "*" || host === d || host.endsWith("." + d)
  );
}

function isLocalHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127\./.test(host)
  );
}

const DNR_RULE_ID_FORCE = 91001;
const DNR_RULE_ID_BLOCK_BASE = 91010;

function isSettingsKey(key) {
  return key === MCP_SETTINGS_KEY || String(key).indexOf("__mcp_") === 0;
}

function mergeSettings(raw) {
  const incoming = raw && typeof raw === "object" ? raw : {};
  return {
    sites: parseSiteList(incoming.sites),
    forceSdk: {
      ...DEFAULT_MCP_SETTINGS.forceSdk,
      ...(incoming.forceSdk || {}),
    },
    localEdit: {
      ...DEFAULT_MCP_SETTINGS.localEdit,
      ...(incoming.localEdit || {}),
    },
  };
}

async function readMcpSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get([MCP_SETTINGS_KEY], (items) => {
      resolve(mergeSettings(items[MCP_SETTINGS_KEY]));
    });
  });
}

async function writeMcpSettings(next) {
  const settings = mergeSettings(next);
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [MCP_SETTINGS_KEY]: settings }, () => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError);
      } else {
        resolve(settings);
      }
    });
  });
}

function buildSdkDnrRules(settings) {
  const addRules = [];
  const removeRuleIds = [DNR_RULE_ID_ALLOW_TARGET];
  for (let i = 0; i < SDK_SCRIPT_REGEXES.length; i++) {
    removeRuleIds.push(DNR_RULE_ID_FORCE + i);
    removeRuleIds.push(DNR_RULE_ID_BLOCK_BASE + i);
  }

  const sites = parseSiteList(settings.sites);
  if (!sites.length) {
    // No sites chosen: the tools stay off everywhere.
    return { addRules, removeRuleIds };
  }
  // initiatorDomains covers subdomains too. "*" means no restriction.
  const scope = sites.includes("*")
    ? {}
    : { initiatorDomains: sites.map((d) => d.replace(/^\[|\]$/g, "")) };

  const localOn = !!(settings.localEdit && settings.localEdit.enabled && settings.localEdit.edited);
  const forceOn = !!(settings.forceSdk && settings.forceSdk.enabled && settings.forceSdk.url);

  if (localOn && editServedByRedirect(settings)) {
    const dataUrl = "data:text/javascript;base64," + toBase64Utf8(settings.localEdit.edited);
    SDK_SCRIPT_REGEXES.forEach((regexFilter, i) => {
      addRules.push({
        id: DNR_RULE_ID_FORCE + i,
        priority: 50,
        action: { type: "redirect", redirect: { url: dataUrl } },
        condition: {
          regexFilter,
          resourceTypes: ["script"],
          ...scope,
        },
      });
    });
  } else if (localOn) {
    // Too large for a data: URL: block the CDN SDK and inject instead.
    SDK_SCRIPT_REGEXES.forEach((regexFilter, i) => {
      addRules.push({
        id: DNR_RULE_ID_BLOCK_BASE + i,
        priority: 100,
        action: { type: "block" },
        condition: {
          regexFilter,
          resourceTypes: ["script"],
          ...scope,
        },
      });
    });
  } else if (forceOn) {
    let redirectUrl = String(settings.forceSdk.url || "").trim();
    try {
      const parsed = new URL(redirectUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error("not http(s)");
      }
      redirectUrl = parsed.toString();
    } catch (_) {
      return { addRules: [], removeRuleIds };
    }

    if (needsFetchedSdk(redirectUrl)) {
      const fetched = settings.forceSdk.fetched;
      if (!fetched || fetched.url !== redirectUrl || !fetched.code) {
        // Not fetched yet (or it failed): leave the SDK alone.
        return { addRules: [], removeRuleIds };
      }
      redirectUrl = "data:text/javascript;base64," + toBase64Utf8(fetched.code);
    }

    SDK_SCRIPT_REGEXES.forEach((regexFilter, i) => {
      addRules.push({
        id: DNR_RULE_ID_FORCE + i,
        priority: 50,
        action: {
          type: "redirect",
          redirect: { url: redirectUrl },
        },
        condition: {
          regexFilter,
          resourceTypes: ["script"],
          ...scope,
        },
      });
    });

    // If the replacement itself looks like an SDK URL, let it through so the
    // redirect does not loop.
    if (redirectUrl.indexOf("data:") !== 0) addRules.push({
      id: DNR_RULE_ID_ALLOW_TARGET,
      priority: 60,
      action: { type: "allow" },
      condition: {
        urlFilter: "|" + redirectUrl + "|",
        resourceTypes: ["script"],
      },
    });
  }

  return { addRules, removeRuleIds: [...new Set(removeRuleIds)] };
}

async function syncSdkDnrRules(settings) {
  if (!chrome.declarativeNetRequest) {
    console.warn("declarativeNetRequest API unavailable");
    return;
  }
  const { addRules, removeRuleIds } = buildSdkDnrRules(settings);
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds,
      addRules,
    });
  } catch (e) {
    console.error("Failed to update SDK DNR rules", e);
    throw e;
  }
}

// Export for both service worker (importScripts) and window contexts.
if (typeof globalThis !== "undefined") {
  globalThis.MCP_SETTINGS_KEY = MCP_SETTINGS_KEY;
  globalThis.DEFAULT_MCP_SETTINGS = DEFAULT_MCP_SETTINGS;
  globalThis.SDK_SCRIPT_REGEXES = SDK_SCRIPT_REGEXES;
  globalThis.isSettingsKey = isSettingsKey;
  globalThis.parseSiteList = parseSiteList;
  globalThis.siteMatches = siteMatches;
  globalThis.isLocalHost = isLocalHost;
  globalThis.needsFetchedSdk = needsFetchedSdk;
  globalThis.editServedByRedirect = editServedByRedirect;
  globalThis.toBase64Utf8 = toBase64Utf8;
  globalThis.MAX_FETCHED_SDK_CHARS = MAX_FETCHED_SDK_CHARS;
  globalThis.mergeSettings = mergeSettings;
  globalThis.readMcpSettings = readMcpSettings;
  globalThis.writeMcpSettings = writeMcpSettings;
  globalThis.buildSdkDnrRules = buildSdkDnrRules;
  globalThis.syncSdkDnrRules = syncSdkDnrRules;
}
