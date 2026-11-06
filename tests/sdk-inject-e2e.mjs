// End-to-end check of SDK Tools in a real Chrome with the extension loaded.
// A local server plays the site and the SDK CDN (host names are mapped to
// 127.0.0.1), so no network is needed. Run: node sdk-inject-e2e.mjs
import puppeteer from "puppeteer";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, "..");

const sdk = (name) =>
  `window.__SDK_RUNS__=(window.__SDK_RUNS__||[]).concat(${JSON.stringify(name)});` +
  `window.SalesforceInteractions={init:function(){}};`;

const pages = {
  // Loads the SDK from the CDN in a normal tag.
  "/with-sdk": (port) =>
    `<!doctype html><html><head><script src="http://cdn.evgnet.com:${port}/beacon/acct/ds/scripts/evergage.min.js"></script></head><body>with</body></html>`,
  // Loads the SDK through a tag manager style script, after load.
  "/late-sdk": (port) =>
    `<!doctype html><html><head></head><body>late<script>window.addEventListener("load",function(){setTimeout(function(){var s=document.createElement("script");s.src="http://cdn.evgnet.com:${port}/beacon/acct/ds/scripts/evergage.min.js";document.head.appendChild(s)},300)})</script></body></html>`,
  // Older install: cdn.evergage.com host.
  "/legacy-host": (port) =>
    `<!doctype html><html><head><script src="http://cdn.evergage.com:${port}/beacon/acct/ds/scripts/evergage.min.js"></script></head><body>legacy</body></html>`,
  // No SDK at all: the user wants to inject one.
  "/no-sdk": () => `<!doctype html><html><head></head><body>none</body></html>`,
  // Strict CSP header that allows only the page's own scripts.
  "/csp-no-sdk": () => `<!doctype html><html><head></head><body>csp</body></html>`,
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const host = (req.headers.host || "").split(":")[0];
      const url = new URL(req.url, "http://x");
      if (url.pathname.endsWith(".js")) {
        const name = host === "localhost" || host === "dev.sdk.test" ? "replacement" : "cdn:" + host;
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
    const t = (await browser.targets()).find(
      (x) => x.type() === "service_worker" && x.url().startsWith("chrome-extension://")
    );
    if (t) return t.url().split("/")[2];
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("no extension service worker");
}

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
      "--host-resolver-rules=MAP *.test 127.0.0.1,MAP *.sdk.test 127.0.0.1,MAP cdn.evgnet.com 127.0.0.1,MAP cdn.evergage.com 127.0.0.1",
      ...(process.env.CHROME_ARGS || "").split(/\s+/).filter(Boolean),
    ],
  });
  const results = [];
  try {
    const id = await extensionId(browser);
    const ext = await browser.newPage();
    await ext.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });

    const save = (settings) =>
      ext.evaluate(
        (s) => new Promise((r) => chrome.runtime.sendMessage({ type: "MCP_SAVE_SETTINGS", settings: s }, r)),
        settings
      );

    // One tab per scenario, so each page also checks that the previous
    // page's injection (and its per-tab SDK block) did not carry over.
    let page = null;
    let logs = [];
    const visit = async (pathname) => {
      logs = [];
      await page.goto(`http://www.site.test:${port}${pathname}`, { waitUntil: "load" });
      await new Promise((r) => setTimeout(r, 1200));
      const runs = await page.evaluate(() => window.__SDK_RUNS__ || []);
      return { runs, logs };
    };

    const redirect = (url, extra) => ({ sites: ["site.test"], forceSdk: { enabled: true, url }, localEdit: { enabled: false }, ...extra });
    const editedCode = sdk("edited");
    const scenarios = [
      ["redirect", redirect(`http://localhost:${port}/my-sdk.js`), "replacement"],
      // The replacement looks like an SDK URL itself: still loads, no loop.
      ["redirect-sdk-named", redirect(`http://localhost:${port}/beacon/x/scripts/evergage.min.js`), "replacement"],
      // http, not localhost: the extension fetches it and serves the code.
      ["redirect-fetched", redirect(`http://dev.sdk.test:${port}/my-sdk.js`), "replacement"],
      ["edit", { sites: ["site.test"], forceSdk: { enabled: false }, localEdit: { enabled: true, edited: editedCode, original: editedCode } }, "edited"],
      // Inject turned off: pages without the SDK stay without it.
      ["redirect-no-inject", redirect(`http://localhost:${port}/my-sdk.js`, { injectWhenMissing: false }), "replacement"],
    ];
    for (const [mode, settings, expected] of scenarios) {
      const res = await save(settings);
      if (!res || !res.ok) throw new Error("save failed: " + JSON.stringify(res));
      page = await browser.newPage();
      page.on("console", (m) => logs.push(m.text()));
      for (const pathname of ["/no-sdk", "/with-sdk", "/csp-no-sdk", "/late-sdk", "/legacy-host", "/no-sdk"]) {
        const { runs, logs } = await visit(pathname);
        const injectOff = settings.injectWhenMissing === false && /no-sdk/.test(pathname);
        const ok = injectOff ? runs.length === 0 : runs.length === 1 && runs[0] === expected;
        results.push({ ok, mode, pathname, runs });
        console.log(`${ok ? "PASS" : "FAIL"}  ${mode} ${pathname}: ran ${JSON.stringify(runs)}`);
        if (!ok) logs.filter((l) => /MCP Logger|SDK|Refused/i.test(l)).forEach((l) => console.log("      " + l));
      }
      await page.close();
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (results.some((r) => !r.ok)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
