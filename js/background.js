importScripts("sdk-config.js");

console.log("Background js loaded..");

const CONFIG = {
  RECORD_TIMER: 1.5 * 1000,
};

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

/** Serialize storage writes so concurrent events cannot overwrite each other. */
let storageWriteQueue = Promise.resolve();

/** requestId -> pending event data captured in onBeforeRequest */
const pendingRequests = new Map();

function isEvergageEventRequest(url) {
  return url.indexOf("evergage.com/api2/event/") > -1;
}

function isDataCloudEventRequest(url) {
  return (
    url.indexOf("c360a.salesforce.com/web/events/") > -1 ||
    url.indexOf(".c360a.salesforce.com/web/events/") > -1
  );
}

function isTrackedEventRequest(request) {
  return (
    (request.method === "GET" || request.method === "POST") &&
    typeof request.url === "string" &&
    (isEvergageEventRequest(request.url) ||
      isDataCloudEventRequest(request.url))
  );
}

function decodeBase64Utf8(encodedString) {
  const binary = atob(encodedString);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function parseEventValue(eventValue) {
  if (eventValue == null) {
    throw new Error("Missing event value");
  }
  // Raw JSON
  try {
    return JSON.parse(eventValue);
  } catch (_) {
    // fall through
  }
  // Base64 JSON (Data Cloud / some Evergage POST bodies)
  try {
    return JSON.parse(decodeBase64Utf8(eventValue));
  } catch (_) {
    // fall through
  }
  // URL-encoded base64
  try {
    return JSON.parse(decodeBase64Utf8(decodeURIComponent(eventValue)));
  } catch (_) {
    throw new Error("Unable to parse event payload value");
  }
}

function extractPayload(request) {
  if (request.method === "GET") {
    const url = new URL(request.url);
    // searchParams.get already URL-decodes the value
    const encodedString = url.searchParams.get("event");
    if (!encodedString) {
      throw new Error("Missing event query parameter");
    }
    return parseEventValue(encodedString);
  }

  const formEvent = request.requestBody?.formData?.event?.[0];
  if (formEvent) {
    return parseEventValue(formEvent);
  }

  const rawBytes = request.requestBody?.raw?.[0]?.bytes;
  if (rawBytes) {
    const rawText = new TextDecoder().decode(new Uint8Array(rawBytes));
    try {
      return JSON.parse(rawText);
    } catch (_) {
      const params = new URLSearchParams(rawText);
      const eventValue = params.get("event");
      if (!eventValue) {
        throw new Error("Missing event field in POST body");
      }
      return parseEventValue(eventValue);
    }
  }

  throw new Error("Unable to extract event payload from request");
}

function getWebsiteName(request) {
  if (request.initiator) {
    try {
      return new URL(request.initiator).hostname;
    } catch (_) {
      // fall through
    }
  }
  if (request.documentUrl) {
    try {
      return new URL(request.documentUrl).hostname;
    } catch (_) {
      // fall through
    }
  }
  return "unknown";
}

function buildHostKey(request, websiteName) {
  const url = new URL(request.url);

  if (isDataCloudEventRequest(request.url)) {
    const pathParts = url.pathname.split("/").filter(Boolean);
    // /web/events/<app-id>
    const appId = pathParts[pathParts.length - 1] || "unknown";
    const shortId = appId.length > 12 ? appId.slice(0, 8) : appId;
    return websiteName + " | Data Cloud (app: " + shortId + ")";
  }

  const evergageHost = url.hostname.split(".")[0];
  const pathParts = url.pathname.split("/").filter(Boolean);
  const datasetName = pathParts[pathParts.length - 1] || "unknown";
  return websiteName + " | " + evergageHost + " (ds: " + datasetName + ")";
}

function extractEventTime(payload) {
  if (!payload || typeof payload !== "object") return null;

  const normalizeEpoch = (value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    // Seconds vs milliseconds heuristic
    if (value > 0 && value < 1e11) return value * 1000;
    return value;
  };

  if (Array.isArray(payload.events) && payload.events.length) {
    const times = payload.events
      .map((e) => {
        if (!e) return null;
        if (typeof e.dateTime === "string") {
          const parsed = Date.parse(e.dateTime);
          return Number.isFinite(parsed) ? parsed : null;
        }
        return normalizeEpoch(e.dateTime) || normalizeEpoch(e.time);
      })
      .filter((t) => Number.isFinite(t));
    if (times.length) return Math.max.apply(null, times);
  }

  const sourceTime = normalizeEpoch(payload.source && payload.source.time);
  if (sourceTime != null) return sourceTime;

  const topTime = normalizeEpoch(payload.time);
  if (topTime != null) return topTime;

  if (typeof payload.dateTime === "string") {
    const parsed = Date.parse(payload.dateTime);
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

function saveEvent(request, payload, statusCode) {
  const websiteName = getWebsiteName(request);
  const hostName = buildHostKey(request, websiteName);
  const capturedAt = Date.now();
  const eventTime = extractEventTime(payload) || capturedAt;
  const epocheDate = String(eventTime) + "-" + String(capturedAt);

  const isPayload = {};
  isPayload[epocheDate] = {
    url: request.url,
    payload: payload,
    datetime: capturedAt,
    eventTime: eventTime,
    website: websiteName,
    statusCode: statusCode,
    sdk: isDataCloudEventRequest(request.url) ? "data-cloud" : "evergage",
  };

  storageWriteQueue = storageWriteQueue
    .then(
      () =>
        new Promise((resolve) => {
          // Read and write only this site's list: rewriting all of storage on
          // every event got slower as the log (and saved SDK code) grew.
          chrome.storage.local.get(hostName, function (stored) {
            const list = Array.isArray(stored[hostName]) ? stored[hostName] : [];
            list.push(isPayload);
            chrome.storage.local.set({ [hostName]: list }, async function () {
              try {
                chrome.action.setIcon({
                  path: "../images/activeImg/cloud-48.png",
                });
                await delay(CONFIG.RECORD_TIMER);
                chrome.action.setIcon({ path: "../images/cloud/cloud-48.png" });
              } catch (e) {
                console.warn("Failed to update action icon", e);
              }
              resolve();
            });
          });
        })
    )
    .catch((e) => {
      console.error("Failed to persist event", e);
    });
}

function finalizeRequest(requestId, statusCode) {
  const pending = pendingRequests.get(requestId);
  if (!pending) {
    return;
  }
  pendingRequests.delete(requestId);
  saveEvent(pending.request, pending.payload, statusCode);
}

chrome.webRequest.onBeforeRequest.addListener(
  function (request) {
    if (!isTrackedEventRequest(request)) {
      return;
    }
    try {
      const payload = extractPayload(request);
      pendingRequests.set(request.requestId, {
        request: {
          url: request.url,
          method: request.method,
          initiator: request.initiator,
          documentUrl: request.documentUrl,
        },
        payload: payload,
      });
    } catch (e) {
      console.error("Failed to parse tracked event request", request.url, e);
    }
  },
  { urls: ["<all_urls>"] },
  ["requestBody"]
);

chrome.webRequest.onCompleted.addListener(
  function (request) {
    if (!isTrackedEventRequest(request)) {
      return;
    }
    finalizeRequest(request.requestId, request.statusCode);
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onErrorOccurred.addListener(
  function (request) {
    if (!isTrackedEventRequest(request)) {
      return;
    }
    // Still record the attempt; statusCode null marks transport failure in UI.
    finalizeRequest(request.requestId, null);
  },
  { urls: ["<all_urls>"] }
);

/* ---------------- SDK Force URL + Local Edit ---------------- */

async function injectLocalSdk(tabId, pageUrl) {
  const settings = await readMcpSettings();
  if (!settings.localEdit.enabled || !settings.localEdit.edited) {
    return { injected: false, reason: "disabled" };
  }
  let hostname = "";
  try {
    hostname = new URL(pageUrl || "").hostname;
  } catch (_) {}
  if (!siteMatches(settings.sites, hostname)) {
    return { injected: false, reason: "site-not-listed" };
  }

  const code = settings.localEdit.edited;
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (sdkCode, meta) => {
      try {
        if (window.__MCP_LOCAL_SDK_INJECTED__) {
          return;
        }
        window.__MCP_LOCAL_SDK_INJECTED__ = true;
        window.__MCP_LOCAL_SDK_META__ = meta;
        // executeScript MAIN-world code is not subject to page CSP.
        (0, eval)(sdkCode);
      } catch (err) {
        console.error("[MCP Logger] Local Edit SDK injection failed", err);
        window.__MCP_LOCAL_SDK_ERROR__ = String(err && err.message ? err.message : err);
      }
    },
    args: [
      code,
      {
        fileName: settings.localEdit.fileName || "local-edit.js",
        sourceUrl: settings.localEdit.sourceUrl || "",
        updatedAt: settings.localEdit.updatedAt || null,
      },
    ],
  });

  return { injected: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message && message.type;

  if (type === "MCP_GET_SETTINGS") {
    readMcpSettings().then((settings) => sendResponse({ ok: true, settings }));
    return true;
  }

  if (type === "MCP_SAVE_SETTINGS") {
    writeMcpSettings(message.settings)
      .then((settings) => syncSdkDnrRules(settings).then(() => settings))
      .then((settings) => sendResponse({ ok: true, settings }))
      .catch((err) =>
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) })
      );
    return true;
  }

  if (type === "MCP_FETCH_SDK") {
    const url = String(message.url || "").trim();
    fetch(url)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error("HTTP " + res.status + " fetching SDK");
        }
        const text = await res.text();
        let fileName = "sdk.js";
        try {
          const path = new URL(url).pathname;
          fileName = path.split("/").pop() || fileName;
        } catch (_) {}
        sendResponse({ ok: true, text, fileName, contentType: res.headers.get("content-type") });
      })
      .catch((err) =>
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) })
      );
    return true;
  }

  if (type === "MCP_INJECT_LOCAL_SDK") {
    const tabId = message.tabId || (sender.tab && sender.tab.id);
    if (!tabId) {
      sendResponse({ ok: false, error: "No tab id" });
      return false;
    }
    // From the content script, sender.url is the page being loaded.
    const pageUrl = message.url || sender.url || (sender.tab && sender.tab.url) || "";
    injectLocalSdk(tabId, pageUrl)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((err) =>
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) })
      );
    return true;
  }

  if (type === "MCP_CLEAR_EVENTS_KEEP_SETTINGS") {
    readMcpSettings().then((settings) => {
      chrome.storage.local.clear(() => {
        chrome.storage.local.set({ [MCP_SETTINGS_KEY]: settings }, () => {
          syncSdkDnrRules(settings).finally(() => sendResponse({ ok: true }));
        });
      });
    });
    return true;
  }

  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[MCP_SETTINGS_KEY]) return;
  const settings = mergeSettings(changes[MCP_SETTINGS_KEY].newValue);
  syncSdkDnrRules(settings).catch((e) => console.error(e));
});

readMcpSettings()
  .then((settings) => syncSdkDnrRules(settings))
  .catch((e) => console.error("Initial SDK DNR sync failed", e));
