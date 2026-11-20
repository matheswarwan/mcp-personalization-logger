import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const R = require("../js/responses.js");
const E = require("../js/events.js");
const X = require("../js/exporters.js");

const URL1 = "https://acme.us-5.evergage.com/api2/event/prod?event=eyJhIjoxfQ%3D%3D";
const BODY = { campaignResponses: [{ campaignId: "c1", campaignName: "Hero banner", experienceName: "Spring", userGroup: "Test" }], persistedUser: { id: "jane@example.com" } };

test("tracked URLs are Personalization and Data Cloud event endpoints only", () => {
  assert.equal(R.isTrackedResponseUrl(URL1), true);
  assert.equal(R.isTrackedResponseUrl("https://abc.c360a.salesforce.com/web/events/xyz"), true);
  assert.equal(R.isTrackedResponseUrl("https://example.com/api2/event/"), false);
});

test("bodies parse as JSON, else stay text; long ones are cut", () => {
  assert.deepEqual(R.parseResponseBody('{"a":1}'), { body: { a: 1 }, truncated: false, size: 7 });
  assert.equal(R.parseResponseBody("ok").body, "ok");
  const long = R.parseResponseBody("x".repeat(R.MAX_BODY + 10));
  assert.equal(long.truncated, true);
  assert.equal(long.body.length, R.MAX_BODY);
  assert.equal(R.parseResponseBody(null), null);
});

test("matcher pairs a response with its event whichever comes first", () => {
  const m = R.createMatcher(1000);
  // response first, then the event is saved
  assert.equal(m.onResponse(URL1, { body: 1 }, 100), null);
  assert.deepEqual(m.takeResponse(URL1, 200), { body: 1 });
  assert.equal(m.takeResponse(URL1, 200), null);
  // event first, then the response: attach to the saved entry
  m.rememberSaved(URL1, "site", "k1", 300);
  assert.deepEqual(m.onResponse(URL1, { body: 2 }, 400), { hostName: "site", key: "k1" });
  // expired entries are dropped
  m.rememberSaved(URL1, "site", "k2", 500);
  assert.equal(m.onResponse(URL1, { body: 3 }, 2000), null);
  assert.equal(m.takeResponse(URL1, 3500), null);
});

test("campaigns served are listed from campaignResponses", () => {
  assert.deepEqual(R.campaignsServed(BODY), [{ campaign: "Hero banner", experience: "Spring", userGroup: "Test", id: "c1" }]);
  assert.deepEqual(R.campaignsServed({}), []);
  assert.deepEqual(R.campaignsServed("text"), []);
});

test("events carry the saved response; exports include it, masked", () => {
  const raw = { "shop | acme (ds: prod)": [{ "1-1": { url: URL1, payload: { action: "Home", user: { id: "u1" } }, datetime: 1, statusCode: 200, response: { status: 200, body: BODY, truncated: false, size: 10 } } }] };
  const ev = E.normalizeEvents(raw).bySite["shop | acme (ds: prod)"][0];
  assert.equal(ev.response.body.campaignResponses[0].campaignName, "Hero banner");
  const masked = X.buildExportModel([ev], { maskPersonalData: true });
  assert.equal(masked.events[0].response.body.campaignResponses[0].campaignName, "Hero banner");
  assert.ok(!JSON.stringify(masked.events[0].response).includes("jane@example.com"));
  const md = X.toMarkdown(X.buildExportModel([ev], { maskPersonalData: false }), {});
  assert.match(md, /Response \(HTTP 200\)/);
  assert.match(md, /Hero banner/);
  assert.match(X.toHtmlReport(X.buildExportModel([ev], {})), /Response \(HTTP 200\)/);
});

test("page hook copies tracked XHR and fetch responses and leaves others alone", async () => {
  const posted = [];
  class FakeXHR {
    constructor() { this.listeners = {}; this.responseType = ""; }
    open(m, u) { this.url = u; }
    send() { this.status = 200; this.responseText = JSON.stringify(BODY); this.responseURL = this.url; setTimeout(() => (this.listeners.loadend || []).forEach((f) => f()), 0); }
    addEventListener(n, f) { (this.listeners[n] = this.listeners[n] || []).push(f); }
  }
  const fetchCalls = [];
  const window = {
    location: { href: "https://shop.example.com/" },
    postMessage: (d) => posted.push(d),
    XMLHttpRequest: FakeXHR,
    fetch: async (u) => { fetchCalls.push(u); return { url: String(u), status: 202, clone: () => ({ text: async () => '{"ok":true}' }) }; },
  };
  const ctx = vm.createContext({ window, location: window.location, URL, setTimeout, String, JSON, Number });
  vm.runInContext(fs.readFileSync(new URL("../js/response-hook.js", import.meta.url), "utf8"), ctx);
  const x = new window.XMLHttpRequest();
  x.open("GET", URL1);
  x.send();
  const other = new window.XMLHttpRequest();
  other.open("GET", "/api/cart");
  other.send();
  const res = await window.fetch("https://abc.c360a.salesforce.com/web/events/xyz", { method: "POST" });
  await window.fetch("https://shop.example.com/other");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(res.status, 202); // the page still gets its response
  assert.equal(fetchCalls.length, 2);
  assert.equal(posted.length, 2);
  assert.deepEqual(posted.map((p) => p.source + " " + p.via + " " + p.status).sort(), ["mcp-logger-response fetch 202", "mcp-logger-response xhr 200"]);
  assert.equal(JSON.parse(posted.find((p) => p.via === "xhr").body).campaignResponses[0].campaignName, "Hero banner");
});
