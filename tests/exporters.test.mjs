import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const X = require("../js/exporters.js");

const base = Date.UTC(2026, 9, 16, 14, 0, 0);

function sampleEvents() {
  return [
    {
      ts: base + 2000,
      site: "shop.example.com | usf (ds: prod)",
      sdk: "evergage",
      action: "Add To Cart",
      itemAction: "AddToCart",
      pageType: "product",
      pageUrl: "https://shop.example.com/p/123?u=jane%40example.com",
      statusCode: 500,
      url: "https://usf.evergage.com/api2/event/prod?event=eyJhIjoxfQ%3D%3D&x=1",
      payload: {
        action: "Add To Cart",
        user: {
          id: "jane@example.com",
          attributes: { emailAddress: "jane@example.com", firstName: "Jane", tier: "gold" },
        },
        cart: { lineItems: [{ sku: "123", price: 9.5 }] },
      },
    },
    {
      ts: base + 1000,
      site: "shop.example.com | usf (ds: prod)",
      sdk: "evergage",
      action: "Page View",
      itemAction: "",
      pageType: "product",
      pageUrl: "https://shop.example.com/p/123",
      statusCode: 200,
      url: "https://usf.evergage.com/api2/event/prod",
      payload: { action: "Page View", note: "has ``` backticks" },
    },
  ];
}

test("maskValue hides sensitive keys and emails, keeps the rest", () => {
  const out = X.maskValue(sampleEvents()[0].payload);
  assert.equal(out.user.id, X.MASK);
  assert.equal(out.user.attributes.emailAddress, X.MASK);
  assert.equal(out.user.attributes.firstName, X.MASK);
  assert.equal(out.user.attributes.tier, "gold");
  assert.deepEqual(out.cart, { lineItems: [{ sku: "123", price: 9.5 }] });
});

test("maskValue does not change the input", () => {
  const payload = sampleEvents()[0].payload;
  X.maskValue(payload);
  assert.equal(payload.user.attributes.firstName, "Jane");
});

test("shortenRequestUrl drops the base64 event blob", () => {
  const out = X.shortenRequestUrl(sampleEvents()[0].url);
  assert.ok(!out.includes("eyJhIjoxfQ"));
  assert.ok(out.includes("event=DECODED_BELOW"));
  assert.ok(out.includes("x=1"));
  assert.equal(X.shortenRequestUrl("not a url"), "not a url");
});

test("buildExportModel sorts oldest first and summarizes", () => {
  const model = X.buildExportModel(sampleEvents(), {
    extensionVersion: "0.0.6",
    scope: "shop.example.com | usf (ds: prod)",
    filters: { timeRange: "Last 24 hours", search: "", status: "all" },
    exportedAt: "2026-10-16T15:00:00.000Z",
  });
  assert.equal(model.personalDataMasked, true);
  assert.deepEqual(model.events.map((e) => e.action), ["Page View", "Add To Cart"]);
  assert.deepEqual(model.events.map((e) => e.n), [1, 2]);
  assert.equal(model.summary.count, 2);
  assert.equal(model.summary.errors, 1);
  assert.equal(model.summary.firstEvent, new Date(base + 1000).toISOString());
  assert.equal(model.events[1].pageUrl, "https://shop.example.com/p/123?u=" + X.MASK);
  assert.equal(model.events[1].payload.user.id, X.MASK);
  assert.equal(model.summary.pages.length, 2);
});

test("buildExportModel can keep personal data", () => {
  const model = X.buildExportModel(sampleEvents(), { maskPersonalData: false });
  assert.equal(model.personalDataMasked, false);
  assert.equal(model.events[1].payload.user.id, "jane@example.com");
});

test("toMarkdown has summary, failures and fenced payloads", () => {
  const md = X.toMarkdown(X.buildExportModel(sampleEvents(), { extensionVersion: "0.0.6" }));
  assert.match(md, /^# Marketing Cloud Personalization events/);
  assert.match(md, /\| Add To Cart \| 1 \| 1 \|/);
  assert.match(md, /Failed requests:\n\n- #2 Add To Cart at .*: 500/);
  assert.match(md, /### 1\. Page View \(/);
  // Payload containing ``` gets a longer fence.
  assert.match(md, /````json\n[\s\S]*has ``` backticks[\s\S]*\n````/);
  assert.ok(!md.includes("jane@example.com"));
});

test("toMarkdown cuts long payloads when asked", () => {
  const events = sampleEvents();
  events[1].payload = { blob: "x".repeat(10000) };
  const model = X.buildExportModel(events, {});
  const cut = X.toMarkdown(model, { maxPayloadChars: 500 });
  assert.match(cut, /Payload cut short: \d+ more characters/);
  assert.ok(cut.length < 3000);
  const full = X.toMarkdown(model);
  assert.ok(!full.includes("cut short"));
  assert.ok(full.includes("x".repeat(10000)));
});

test("toMarkdown handles no events", () => {
  const md = X.toMarkdown(X.buildExportModel([], {}));
  assert.match(md, /No events match the current filters\./);
});

test("a page URL that is just the beacon URL is dropped", () => {
  const events = sampleEvents();
  events[1].pageUrl = events[1].url;
  const model = X.buildExportModel(events, {});
  assert.equal(model.events[0].pageUrl, "");
  assert.equal(model.summary.pages.length, 1);
});

test("toJson round-trips the model", () => {
  const model = X.buildExportModel(sampleEvents(), {});
  assert.deepEqual(JSON.parse(X.toJson(model)), model);
});

test("toHtmlReport escapes content and needs no scripts", () => {
  const events = sampleEvents();
  events[1].action = '<img src=x onerror="alert(1)">';
  const html = X.toHtmlReport(X.buildExportModel(events, {}));
  assert.match(html, /^<!doctype html>/);
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
  assert.ok(!/<script/i.test(html));
  assert.ok(!/https?:\/\/[^"']*\.(css|js)/.test(html));
  assert.equal((html.match(/<details class="event/g) || []).length, 2);
  assert.ok(html.includes('class="event failed"'));
});

test("slug and fileStamp", () => {
  assert.equal(X.slug("Shop.Example.com "), "shop-example-com");
  assert.equal(X.slug(""), "events");
  assert.match(X.fileStamp(new Date(2026, 0, 2, 3, 4, 5)), /^20260102-030405$/);
});
