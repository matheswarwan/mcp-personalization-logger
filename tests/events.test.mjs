import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const E = require("../js/events.js");

test("getUser reads Evergage ids, anonymous ids and Data Cloud ids", () => {
  assert.deepEqual(E.getUser({ user: { id: "jane@example.com", anonId: "a1" } }), {
    key: "id:jane@example.com",
    label: "jane@example.com",
    known: true,
  });
  assert.equal(E.getUser({ user: { anonId: "1c3c70df55af5bcb", attributes: {} } }).key, "anon:1c3c70df55af5bcb");
  assert.equal(E.getUser({ user: { encryptedId: "gCmT8nwiQVXURw2IM8b6" } }).key, "enc:gCmT8nwiQVXURw2IM8b6");
  assert.equal(E.getUser({ events: [{ deviceId: "d-1" }, { individualId: "ind-9" }] }).key, "id:ind-9");
  assert.equal(E.getUser({ events: [{ deviceId: "d-1", eventType: "pageView" }] }).label, "Device d-1");
  assert.equal(E.getUser({ action: "x" }), null);
  assert.equal(E.getUser(null), null);
});

test("normalizeEvents adds user fields, falling back to the batch for nested events", () => {
  const raw = {
    "shop.example.com": [
      { "1000-1000": { statusCode: 200, url: "https://x.evergage.com/api2/event/p", payload: { action: "A", user: { anonId: "u1" } } } },
      {
        "2000-2000": {
          statusCode: 200,
          url: "https://c360a.salesforce.com/web/events/x",
          payload: { events: [{ eventType: "pageView", deviceId: "dev" }, { eventType: "cart", deviceId: "dev" }] },
        },
      },
    ],
  };
  const { bySite } = E.normalizeEvents(raw);
  const events = bySite["shop.example.com"];
  assert.equal(events.length, 3);
  assert.deepEqual(new Set(events.map((e) => e.userKey)), new Set(["anon:u1", "device:dev"]));
});

test("facetCounts counts values most frequent first, with (none) for missing", () => {
  const events = [
    { ts: 1, action: "View", pageType: "home", statusCode: 200 },
    { ts: 2, action: "View", pageType: "", statusCode: 500 },
    { ts: 3, action: "Buy", pageType: "cart", statusCode: 200 },
  ];
  const rows = E.facetCounts(events, "action");
  assert.deepEqual(rows.map((r) => [r.key, r.count, r.failed]), [["View", 2, 1], ["Buy", 1, 0]]);
  assert.equal(E.facetCounts(events, "pageType").find((r) => r.key === "").label, "(none)");
});

test("timeBuckets picks a standard size and fills buckets", () => {
  const t0 = Date.UTC(2026, 9, 25, 10, 0, 0);
  const events = [
    { ts: t0 + 10e3, statusCode: 200, action: "A" },
    { ts: t0 + 20e3, statusCode: 500, action: "B" },
    { ts: t0 + 50 * 60e3, statusCode: 200, action: "A" },
  ];
  const { size, buckets } = E.timeBuckets(events, { from: t0, to: t0 + 3600e3, maxBuckets: 60, stackBy: "action" });
  assert.equal(size, 60e3);
  assert.equal(buckets.length, 60);
  assert.equal(buckets[0].count, 2);
  assert.equal(buckets[0].failed, 1);
  assert.deepEqual(buckets[0].stacks, { A: 1, B: 1 });
  assert.equal(buckets.reduce((n, b) => n + b.count, 0), 3);
  assert.deepEqual(E.timeBuckets([], {}), { size: 0, buckets: [] });
});
