// End-to-end check of the Tools page in a real Chrome with the extension loaded: Inject SDK &
// open page, SDK info, cookies, and the decoder. A local server plays the sites and the SDK
// CDN (host names map to 127.0.0.1), so no network is needed. Run: node tools-e2e.mjs
// Needs local port binding and a Chrome launch (run outside the Claude sandbox).
import puppeteer from "puppeteer";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, "..");

// A small stand-in for the SDK: records that it ran, keeps an anonymous id in _evga_ab12.
const sdk = (name) => `
window.__SDK_RUNS__=(window.__SDK_RUNS__||[]).concat(${JSON.stringify(name)});
(function(){
  var m=document.cookie.match(/(?:^|; )_evga_ab12=([^;]+)/);
  var id=m?m[1]:Math.random().toString(16).slice(2,18);
  if(!m) document.cookie="_evga_ab12="+id+"; path=/";
  window.__SENT__=0;
  window.SalesforceInteractions={
    init:function(){},
    getAnonymousId:function(){return id},
    getConsents:function(){return [{purpose:"Tracking",status:"Opt In"}]},
    isInitialized:function(){return true},
    sendEvent:function(){window.__SENT__++},
    getRecommendations:function(){window.__SENT__++},
    version:${JSON.stringify(name)}
  };
})();`;

const pages = {
  "/with-sdk": (port) =>
    `<!doctype html><html><head><script src="http://cdn.evgnet.com:${port}/beacon/acct/ds/scripts/evergage.min.js"></script></head><body>with</body></html>`,
  "/no-sdk": () => `<!doctype html><html><head></head><body>none</body></html>`,
  "/csp-no-sdk": () => `<!doctype html><html><head></head><body>csp</body></html>`,
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const host = (req.headers.host || "").split(":")[0];
      const url = new URL(req.url, "http://x");
      if (url.pathname.endsWith(".js")) {
        const name = host === "localhost" ? "chosen" : "cdn:" + host;
        res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
        return res.end(sdk(name));
      }
      const page = pages[url.pathname];
      if (!page) {
        res.writeHead(404);
        return res.end();
      }
      const headers = { "content-type": "text/html", "cache-control": "no-store" };
      if (url.pathname === "/csp-no-sdk") headers["content-security-policy"] = "script-src 'self'";
      res.writeHead(200, headers);
      res.end(page(server.address().port));
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function extensionId(browser) {
  for (let i = 0; i < 80; i++) {
    const t = (await browser.targets()).find((x) => x.type() === "service_worker" && x.url().startsWith("chrome-extension://"));
    if (t) return t.url().split("/")[2];
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("no extension service worker");
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = await startServer();
  const port = server.address().port;
  const browser = await puppeteer.launch({
    headless: process.env.HEADLESS !== "0",
    executablePath: process.env.CHROME_PATH || undefined,
    pipe: true,
    enableExtensions: [EXTENSION_PATH],
    args: [
      "--no-first-run",
      "--host-resolver-rules=MAP *.test 127.0.0.1,MAP cdn.evgnet.com 127.0.0.1",
      ...(process.env.CHROME_ARGS || "").split(/\s+/).filter(Boolean),
    ],
  });
  const results = [];
  const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ": " + detail : ""}`);
  };
  try {
    const id = await extensionId(browser);
    const tools = await browser.newPage();
    await tools.goto(`chrome-extension://${id}/tools.html`, { waitUntil: "domcontentloaded" });
    const ask = (message) => tools.evaluate((m) => new Promise((r) => chrome.runtime.sendMessage(m, r)), message);
    const chosen = `http://localhost:${port}/beacon/x/scripts/evergage.min.js`;

    // Opens a page with the chosen SDK and returns the puppeteer page of the new tab.
    const openWith = async (pathname) => {
      const url = `http://www.site.test:${port}${pathname}`;
      const target = browser.waitForTarget((t) => t.url() === url);
      const res = await ask({ type: "MCP_OPEN_WITH_SDK", url, sdkUrl: chosen });
      if (!res.ok) throw new Error("open failed: " + res.error);
      const page = await (await target).page();
      await page.waitForFunction(() => document.readyState === "complete");
      await wait(800);
      return { page, tabId: res.tabId };
    };
    const runs = (page) => page.evaluate(() => window.__SDK_RUNS__ || []);

    // 1. Open with SDK: page without an SDK, page with its own SDK, page with a strict CSP.
    for (const pathname of ["/no-sdk", "/with-sdk", "/csp-no-sdk"]) {
      const { page } = await openWith(pathname);
      const r = await runs(page);
      check("open with SDK " + pathname, r.length === 1 && r[0] === "chosen", JSON.stringify(r));
      await page.close();
    }

    // 2. Same tab, same site: still the chosen SDK. Another site: the page's own SDK again.
    const { page, tabId } = await openWith("/no-sdk");
    await page.goto(`http://shop.site.test:${port}/with-sdk`, { waitUntil: "load" });
    await wait(800);
    let r = await runs(page);
    check("same site keeps the chosen SDK", r.length === 1 && r[0] === "chosen", JSON.stringify(r));
    await page.goto(`http://www.other.test:${port}/with-sdk`, { waitUntil: "load" });
    await wait(800);
    r = await runs(page);
    check("another site loads its own SDK", r.length === 1 && r[0] === "cdn:cdn.evgnet.com", JSON.stringify(r));
    await page.goto(`http://www.site.test:${port}/with-sdk`, { waitUntil: "load" });
    await wait(800);
    r = await runs(page);
    check("coming back does not re-inject", r.length === 1 && r[0] === "cdn:cdn.evgnet.com", JSON.stringify(r));

    // 3. SDK info on that tab.
    const anon = await page.evaluate(() => window.SalesforceInteractions.getAnonymousId());
    const info = await ask({ type: "MCP_SDK_INFO", tabId });
    const sfi = info.ok && info.info.sdks[0];
    const by = sfi ? Object.fromEntries(sfi.getters.map((g) => [g.name, g])) : {};
    check("SDK info reads getAnonymousId", by.getAnonymousId && by.getAnonymousId.value === anon, anon);
    check("SDK info reads getConsents", by.getConsents && Array.isArray(by.getConsents.value));
    check("SDK info lists, but does not call, sendEvent and getRecommendations",
      sfi && ["sendEvent", "getRecommendations"].every((n) => sfi.others.some((o) => o.name === n)) &&
        (await page.evaluate(() => window.__SENT__)) === 0);
    check("SDK info sees the script tag", info.ok && info.info.scripts.length === 1, JSON.stringify(info.info && info.info.scripts));

    // 4. Cookies: list, clear the SDK ones, then everything.
    await page.evaluate(() => {
      document.cookie = "keep=1; path=/";
      localStorage.setItem("k", "v");
    });
    let list = await ask({ type: "MCP_LIST_COOKIES", tabId });
    const names = () => list.cookies.map((c) => c.name).sort().join(",");
    check("cookies listed with the SDK one marked", list.ok && names() === "_evga_ab12,keep" && list.cookies.find((c) => c.name === "_evga_ab12").sdk, names());
    let clear = await ask({ type: "MCP_CLEAR_SITE_DATA", tabId, scope: "sdk", reload: false });
    list = await ask({ type: "MCP_LIST_COOKIES", tabId });
    check("Clear SDK cookies keeps the others", clear.ok && clear.removed === 1 && names() === "keep", names());
    await page.reload({ waitUntil: "load" });
    await wait(500);
    const anon2 = await page.evaluate(() => window.SalesforceInteractions.getAnonymousId());
    check("after clearing, the SDK starts a new anonymous id", anon2 && anon2 !== anon, anon + " -> " + anon2);
    clear = await ask({ type: "MCP_CLEAR_SITE_DATA", tabId, scope: "all", reload: false });
    list = await ask({ type: "MCP_LIST_COOKIES", tabId });
    const storage = await page.evaluate(() => localStorage.length);
    check("Clear all removes cookies and storage", clear.ok && list.cookies.length === 0 && storage === 0, `${names()} / storage ${storage}`);
    await page.close();

    // 5. A tab id that is not a web page is refused.
    const noTab = await ask({ type: "MCP_LIST_COOKIES", tabId: 0 });
    check("Tools messages refuse a tab that does not exist", !noTab.ok, noTab.error);

    // 6. The decoder on the Tools page.
    const payload = { action: "Home", user: { anonId: "a1" } };
    const b64 = Buffer.from(JSON.stringify(payload)).toString("base64");
    await tools.click("#decodeInput");
    await tools.type("#decodeInput", `https://x.evergage.com/api2/event/ds?event=${encodeURIComponent(b64)}`);
    await wait(200);
    const shown = await tools.evaluate(() => ({
      how: document.getElementById("decodeHow").textContent,
      text: document.getElementById("decodeOut").textContent,
    }));
    check("Tools decoder reads a beacon URL", /URL/.test(shown.how) && shown.text.includes("anonId"), shown.how);
  } finally {
    await browser.close();
    server.close();
  }
  if (results.some((ok) => !ok)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
