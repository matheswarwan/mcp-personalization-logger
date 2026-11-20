// End to end for feedback #1003: the extension saves the response of a
// Personalization (XHR) and a Data Cloud (fetch) event and shows it in the explorer.
// Fake servers through --host-resolver-rules. Run: HEADLESS=1 CHROME_PATH=... node response-e2e.mjs
import puppeteer from "puppeteer";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, "..");
const BODY = { campaignResponses: [{ campaignId: "c1", campaignName: "Hero banner", experienceName: "Spring", userGroup: "Test" }] };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

const server = http.createServer((req, res) => {
  const host = (req.headers.host || "").split(":")[0];
  const cors = { "access-control-allow-origin": req.headers.origin || "*", "access-control-allow-credentials": "true", "access-control-allow-headers": "content-type" };
  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
  if (host.endsWith("evergage.com")) { res.writeHead(200, { ...cors, "content-type": "application/json" }); return res.end(JSON.stringify(BODY)); }
  if (host.endsWith("c360a.salesforce.com")) { req.resume(); res.writeHead(202, { ...cors, "content-type": "text/plain" }); return res.end("accepted"); }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><body>shop<script>
    const x = new XMLHttpRequest();
    x.open("GET", "http://acme.us-5.evergage.com/api2/event/prod?event=" + encodeURIComponent("${b64({ action: "Home Page", source: { url: "http://www.site.test/" }, user: { anonId: "a1" } })}"));
    x.withCredentials = true; x.send();
    setTimeout(() => fetch("http://abc.c360a.salesforce.com/web/events/app1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ events: [{ eventType: "pageView", deviceId: "d1", dateTime: new Date().toISOString() }] }) }), 300);
  </script></body></html>`);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await puppeteer.launch({
  headless: process.env.HEADLESS !== "0",
  executablePath: process.env.CHROME_PATH || undefined,
  pipe: true,
  enableExtensions: [EXTENSION_PATH],
  args: ["--no-first-run", `--proxy-server=http://127.0.0.1:${port}`, ...(process.env.CHROME_ARGS || "").split(/\s+/).filter(Boolean)],
});
let failed = 0;
const check = (name, ok, extra) => { console.log((ok ? "ok   " : "FAIL ") + name + (extra ? " " + extra : "")); if (!ok) failed++; };
try {
  let id;
  for (let i = 0; i < 80 && !id; i++) {
    const t = (await browser.targets()).find((x) => x.type() === "service_worker" && x.url().startsWith("chrome-extension://"));
    if (t) id = t.url().split("/")[2]; else await new Promise((r) => setTimeout(r, 250));
  }
  const page = await browser.newPage();
  const pageLog = []; page.on("console", (m) => pageLog.push(m.text())); await page.evaluateOnNewDocument(() => window.addEventListener("message", (e) => { if (e.data && e.data.source === "mcp-logger-response") console.log("posted", e.data.via, e.data.url, e.data.status); }));
  await page.goto(`http://www.site.test/`, { waitUntil: "load" });
  await new Promise((r) => setTimeout(r, 2500));
  const ext = await browser.newPage();
  await ext.goto(`chrome-extension://${id}/fullscreen.html`, { waitUntil: "domcontentloaded" });
  const all = await ext.evaluate(() => new Promise((r) => chrome.storage.local.get(null, r)));
  const entries = Object.entries(all).filter(([k, v]) => Array.isArray(v)).flatMap(([, list]) => list.flatMap((o) => Object.values(o)));
  const ev = entries.find((e) => e.sdk !== "datacloud" && String(e.url).includes("evergage.com"));
  const dc = entries.find((e) => String(e.url).includes("c360a"));

  if (process.env.DEBUG) console.log(JSON.stringify(dc), "\nPAGE LOG", JSON.stringify(pageLog));
  check("Personalization event saved", !!ev);
  check("its response saved (XHR)", ev && ev.response && ev.response.status === 200 && ev.response.body.campaignResponses[0].campaignName === "Hero banner", String(JSON.stringify(ev && ev.response)).slice(0, 120));
  check("Data Cloud event saved", !!dc);
  check("its response saved (fetch)", dc && dc.response && dc.response.status === 202 && dc.response.body === "accepted", String(JSON.stringify(dc && dc.response)).slice(0, 120));
  check("page still got its response", (await page.evaluate(() => document.body.textContent)).includes("shop"));
  await ext.reload({ waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 1500));
  const rows = await ext.$$(".fs-event");
  let shown = false;
  for (const row of rows) {
    await row.click();
    await new Promise((r) => setTimeout(r, 200));
    const text = await ext.$eval("#fsDetailBody", (n) => n.textContent).catch(() => "");
    if (text.includes("Hero banner") && text.includes("Response")) { shown = true; break; }
  }
  check("explorer shows the response and campaign", shown);
  if (process.env.SHOT) await ext.screenshot({ path: process.env.SHOT });
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
