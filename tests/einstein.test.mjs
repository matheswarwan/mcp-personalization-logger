import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const W = require("../js/einstein.js");
const E = require("../js/events.js");
const X = require("../js/exporters.js");

// What collect.js builds: https://<host>/c2/<org>/<endpoint>?payload=<encodeURIComponent(JSON)>
function collectUrl(host, org, endpoint, payload) {
  return "https://" + host + "/c2/" + org + "/" + endpoint + "?payload=" + encodeURIComponent(JSON.stringify(payload));
}

const PAGE_VIEW = {
  item: "SKU-1",
  title: "Shampoo",
  url: "https://www.example.ca/shampoo.html?j=123&sfmc_sub=456",
  referrer: "",
  et_email: { job_id: "123", list_id: "9", landing_url_id: "7", job_batch_id: "1", subscriber_id: "456", mid: "546002015" },
  user_info: { email: "jane@example.com" },
};

test("collectInfo recognises igodigital collect hosts and first-party collect paths", () => {
  assert.deepEqual(W.collectInfo(collectUrl("nova.collect.igodigital.com", "546002015", "track_page_view", {})), {
    orgId: "546002015",
    endpoint: "track_page_view",
  });
  assert.equal(W.collectInfo(collectUrl("546002015.collect.igodigital.com", "546002015", "track_cart", {})).endpoint, "track_cart");
  // first party: only known endpoints with a payload parameter
  assert.equal(W.collectInfo(collectUrl("collect.example.ca", "1", "track_conversion", {})).endpoint, "track_conversion");
  assert.equal(W.collectInfo("https://www.example.ca/c2/1/something_else?payload=x"), null);
  assert.equal(W.collectInfo("https://www.example.ca/c2/1/track_cart"), null);
  // collect.js itself is not an event
  assert.equal(W.collectInfo("https://546002015.collect.igodigital.com/collect.js"), null);
  assert.equal(W.collectInfo("https://evil-igodigital.com/c2/1/track_x"), null);
  assert.equal(W.collectInfo("not a url"), null);
});

test("recsInfo recognises recommendation requests", () => {
  assert.deepEqual(W.recsInfo("https://546002015.recs.igodigital.com/a/v2/546002015/home/recommend.json?item=SKU-1"), {
    orgId: "546002015",
    page: "home",
    format: "json",
  });
  assert.equal(W.recsInfo("https://546002015.recs.igodigital.com/a/v2/546002015/product/recommend.js").format, "js");
  assert.equal(W.recsInfo("https://546002015.collect.igodigital.com/a/v2/1/home/recommend.json"), null);
  assert.ok(W.isEinsteinRequest("https://546002015.recs.igodigital.com/a/v2/546002015/home/recommend.json"));
  assert.ok(!W.isEinsteinRequest("https://cdn.evgnet.com/beacon/x/engage/scripts/evergage.min.js"));
});

test("extractPayload decodes the payload JSON and recommendation parameters", () => {
  assert.deepEqual(W.extractPayload(collectUrl("nova.collect.igodigital.com", "1", "track_page_view", PAGE_VIEW)), PAGE_VIEW);
  assert.deepEqual(W.extractPayload("https://nova.collect.igodigital.com/c2/1/track_page_view?payload=%7Bbroken"), { _unparsed: "{broken" });
  assert.deepEqual(W.extractPayload("https://1.recs.igodigital.com/a/v2/1/home/recommend.json?item=A&item=B&email=x"), {
    item: ["A", "B"],
    email: "x",
  });
});

test("action names, summaries and site key detail", () => {
  const pv = collectUrl("nova.collect.igodigital.com", "546002015", "track_page_view", PAGE_VIEW);
  assert.equal(W.actionName(pv), "Page View");
  assert.equal(W.itemSummary(pv, PAGE_VIEW), "item SKU-1");
  const cart = { cart: [{ item: "A", quantity: 1 }, { item: "B", quantity: 2 }] };
  assert.equal(W.itemSummary(collectUrl("nova.collect.igodigital.com", "1", "track_cart", cart), cart), "2 items");
  assert.equal(W.itemSummary(collectUrl("nova.collect.igodigital.com", "1", "track_cart", { clear_cart: true }), { clear_cart: true }), "clear cart");
  assert.equal(W.actionName("https://1.recs.igodigital.com/a/v2/1/home/recommend.json"), "Recommendations: home");
  assert.equal(W.hostKeyDetail(pv), "Einstein Recs (org: 546002015)");
});

test("emailFields reads et_email, user_info and the _etmc snapshot", () => {
  const etmc = {
    found: true,
    loaded: true,
    value: { org_id: ["546002015"], email_job_id: "123", email_subscriber_id: "456", mid: "546002015", user_info: { email: "jane@example.com" } },
  };
  const rows = Object.fromEntries(W.emailFields({ item: "SKU-1" }, etmc));
  assert.equal(rows["Org ID"], "546002015");
  assert.equal(rows["Job ID"], "123");
  assert.equal(rows["Subscriber ID"], "456");
  assert.equal(rows["Email address"], "jane@example.com");
  const fromPayload = Object.fromEntries(W.emailFields(PAGE_VIEW, null));
  assert.equal(fromPayload["List ID"], "9");
  assert.equal(fromPayload["Job batch ID"], "1");
  assert.deepEqual(W.emailFields({}, null), []);
});

test("snapshotEtmc copies data and leaves out functions", () => {
  const saved = globalThis.window;
  const savedLoc = globalThis.location;
  try {
    globalThis.location = { href: "https://www.example.ca/" };
    globalThis.window = { _etmc: { debug: false, org_id: ["1"], user_info: { email: "a@b.co" }, push() {}, setOrgId() {} } };
    let snap = W.snapshotEtmc();
    assert.equal(snap.found, true);
    assert.equal(snap.loaded, true);
    assert.deepEqual(snap.value, { debug: false, org_id: ["1"], user_info: { email: "a@b.co" } });
    globalThis.window = { _etmc: [["setOrgId", "1"]] };
    snap = W.snapshotEtmc();
    assert.equal(snap.loaded, false);
    assert.deepEqual(snap.value, [["setOrgId", "1"]]);
    globalThis.window = {};
    assert.equal(W.snapshotEtmc().found, false);
  } finally {
    globalThis.window = saved;
    globalThis.location = savedLoc;
  }
});

test("normalizeEvents labels Einstein events and keeps the _etmc snapshot", () => {
  const url = collectUrl("nova.collect.igodigital.com", "546002015", "track_page_view", PAGE_VIEW);
  const etmc = { found: true, loaded: true, page: PAGE_VIEW.url, value: { org_id: ["546002015"], email_job_id: "123" } };
  const raw = {
    "www.example.ca | Einstein Recs (org: 546002015)": [
      { "1000-1000": { url, payload: PAGE_VIEW, datetime: 1000, eventTime: 1000, statusCode: 200, sdk: "einstein", etmc } },
    ],
    "www.example.ca | Data Cloud (app: abc)": [
      { "2000-2000": { url: "https://x.c360a.salesforce.com/web/events/abc", payload: { events: [{ eventType: "pageView", dateTime: 2000 }] }, datetime: 2000, statusCode: 200 } },
    ],
  };
  const { bySite } = E.normalizeEvents(raw);
  const ev = bySite["www.example.ca | Einstein Recs (org: 546002015)"][0];
  assert.equal(ev.sdk, "einstein");
  assert.equal(ev.action, "Page View");
  assert.equal(ev.itemAction, "item SKU-1");
  assert.equal(ev.pageType, "collect: track_page_view");
  assert.equal(ev.pageUrl, PAGE_VIEW.url);
  assert.equal(ev.userLabel, "jane@example.com");
  assert.equal(ev.etmc.value.email_job_id, "123");
  assert.equal(E.groupOf(ev, "sdk").label, "Einstein Web Recommendations");
  assert.equal(E.groupOf(bySite["www.example.ca | Data Cloud (app: abc)"][0], "sdk").label, "Data Cloud Web SDK");
  // old rows without sdk are still told apart by their URL
  const old = E.normalizeEvents({ s: [{ "1-1": { url, payload: {}, datetime: 1, statusCode: 200 } }] }).bySite.s[0];
  assert.equal(old.sdk, "einstein");
});

test("exports name Einstein, shorten its payload URL and mask the _etmc email but keep job ids", () => {
  const url = collectUrl("nova.collect.igodigital.com", "546002015", "track_page_view", PAGE_VIEW);
  const etmc = { found: true, loaded: true, value: { email_job_id: "123", user_info: { email: "jane@example.com" } } };
  const model = X.buildExportModel(
    [{ ts: 1000, site: "s", sdk: "einstein", action: "Page View", url, payload: PAGE_VIEW, statusCode: 200, etmc }],
    { maskPersonalData: true }
  );
  const row = model.events[0];
  assert.match(row.requestUrl, /payload=DECODED_BELOW/);
  assert.equal(row.etmc.value.email_job_id, "123");
  assert.equal(row.etmc.value.user_info.email, "[masked]");
  assert.equal(row.payload.user_info.email, "[masked]");
  const md = X.toMarkdown(model);
  if (md) {
    assert.match(md, /Einstein Web Recommendations/);
    assert.match(md, /window\._etmc on the page/);
    assert.doesNotMatch(md, /jane@example\.com/);
  }
});
