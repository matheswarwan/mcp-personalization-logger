import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
globalThis.chrome = {};
require("../js/sdk-config.js");
const D = require("../js/decode.js");
const T = require("../js/page-tools.js");
const { SDK_SCRIPT_REGEXES, buildSdkDnrRules, buildTabBlockRules } = globalThis;

const payload = { action: "Home", user: { anonId: "1c3c70df55af5bcb" }, name: "Zoë" };
const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");

test("decodePayload reads base64, URL-encoded base64, base64url and JSON", () => {
  assert.deepEqual(D.decodePayload(b64).value, payload);
  assert.equal(D.decodePayload(b64).how, "base64");
  assert.deepEqual(D.decodePayload(encodeURIComponent(b64)).value, payload);
  const url64 = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.deepEqual(D.decodePayload(url64).value, payload);
  assert.deepEqual(D.decodePayload(JSON.stringify(payload)).value, payload);
  assert.equal(D.decodePayload("  " + b64 + "\n").ok, true);
});

test("decodePayload takes the event= value from a beacon URL or a form body", () => {
  const url = "https://x.evergage.com/api2/event/prod?event=" + encodeURIComponent(b64) + "&t=1";
  const r = D.decodePayload(url);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, payload);
  assert.match(r.how, /URL/);
  const form = D.decodePayload("a=1&event=" + encodeURIComponent(b64));
  assert.deepEqual(form.value, payload);
  assert.match(form.how, /form/);
});

test("decodePayload explains what it could not read", () => {
  assert.equal(D.decodePayload("").ok, false);
  assert.equal(D.decodePayload("hello world").ok, false);
  assert.equal(D.decodePayload(Buffer.from("not json").toString("base64")).ok, false);
  assert.match(D.decodePayload("%%%").error, /event payload/);
});

test("normalizePageUrl adds https and refuses other schemes", () => {
  assert.equal(T.normalizePageUrl("example.com/p?x=1"), "https://example.com/p?x=1");
  assert.equal(T.normalizePageUrl(" http://localhost:3000 "), "http://localhost:3000/");
  assert.throws(() => T.normalizePageUrl("javascript:alert(1)"), /http and https/);
  assert.throws(() => T.normalizePageUrl("chrome://extensions"), /http and https/);
  assert.throws(() => T.normalizePageUrl(""), /Enter/);
});

test("normalizeSdkUrl needs a full http(s) URL", () => {
  const src = "https://cdn.evgnet.com/beacon/acme/prod/scripts/evergage.min.js";
  assert.equal(T.normalizeSdkUrl(src), src);
  assert.throws(() => T.normalizeSdkUrl("cdn.evgnet.com/x.js"), /full URL/);
  assert.throws(() => T.normalizeSdkUrl("data:text/javascript,1"), /https/);
});

test("buildOpenSdkRules: per tab, only on the site it was opened on", () => {
  const src = "https://cdn.evgnet.com/beacon/acme/prod/scripts/evergage.min.js";
  const { addRules, removeRuleIds } = T.buildOpenSdkRules(
    [
      { tabId: 7, src, host: "www.Shop.com" },
      { tabId: 9, src: "https://localhost:8080/c360a.js", host: "localhost" },
      { tabId: 7, src, host: "dup.com" },
      { tabId: -1, src, host: "a.com" },
      { tabId: 3, host: "a.com" },
      { tabId: 4, src },
    ],
    SDK_SCRIPT_REGEXES
  );
  const of = (type) => addRules.filter((r) => r.action.type === type);
  const [blocks, allows, csp] = [of("block"), of("allow"), of("modifyHeaders")];
  const R = SDK_SCRIPT_REGEXES.length;
  assert.equal(blocks.length, 2 * R);
  assert.deepEqual(blocks.map((r) => r.condition.tabIds[0]), [...Array(R).fill(7), ...Array(R).fill(9)]);
  assert.deepEqual(blocks.map((r) => r.condition.regexFilter), [...SDK_SCRIPT_REGEXES, ...SDK_SCRIPT_REGEXES]);
  blocks.forEach((r, k) => assert.deepEqual(r.condition.initiatorDomains, [k < R ? "shop.com" : "localhost"]));
  assert.deepEqual(allows.map((r) => r.condition.initiatorDomains), [["shop.com"], ["localhost"]]);
  assert.deepEqual(csp.map((r) => [r.condition.tabIds, r.condition.requestDomains]), [[[7], ["shop.com"]], [[9], ["localhost"]]]);
  assert.equal(allows[0].condition.urlFilter, "|" + src + "|");
  assert.ok(allows[0].priority > blocks[0].priority);
  // Every rule added is also removed first, so rebuilding never collides.
  addRules.forEach((r) => assert.ok(removeRuleIds.includes(r.id), "rule " + r.id));
  assert.equal(new Set(addRules.map((r) => r.id)).size, addRules.length);
  assert.equal(new Set(removeRuleIds).size, removeRuleIds.length);
});

test("buildOpenSdkRules id ranges do not overlap at the tab limit", () => {
  const src = "https://cdn.evgnet.com/beacon/acme/prod/scripts/evergage.min.js";
  const many = Array.from({ length: T.OPEN_SDK_MAX_TABS + 5 }, (_, i) => ({ tabId: i + 1, src, host: "s" + i + ".com" }));
  const { addRules, removeRuleIds } = T.buildOpenSdkRules(many, SDK_SCRIPT_REGEXES);
  assert.equal(addRules.length, T.OPEN_SDK_MAX_TABS * (2 + SDK_SCRIPT_REGEXES.length));
  assert.equal(new Set(addRules.map((r) => r.id)).size, addRules.length);
  assert.equal(addRules.filter((r) => r.condition.regexFilter).length <= 1000 - 50, true);
  addRules.forEach((r) => assert.ok(removeRuleIds.includes(r.id)));
});

test("buildOpenSdkRules outranks SDK Tools and does not share its rule ids", () => {
  const src = "https://cdn.evgnet.com/beacon/acme/prod/scripts/evergage.min.js";
  const ours = T.buildOpenSdkRules([{ tabId: 1, src, host: "shop.com" }], SDK_SCRIPT_REGEXES);
  const tools = buildSdkDnrRules({
    sites: ["*"],
    forceSdk: { enabled: true, url: "https://cdn.example.com/evergage.min.js" },
    localEdit: { enabled: false },
  });
  const tabBlock = buildTabBlockRules([1]);
  const theirIds = new Set([...tools.removeRuleIds, ...tabBlock.removeRuleIds]);
  ours.removeRuleIds.forEach((id) => assert.ok(!theirIds.has(id), "id " + id + " is shared"));
  const theirs = [...tools.addRules, ...tabBlock.addRules];
  const maxTheirs = Math.max(...theirs.map((r) => r.priority));
  // Our block beats their redirect and per-tab block; SDK Tools' own allow (for its
  // replacement URL) may still win, which is fine: our allow outranks everything.
  const theirRedirectOrBlock = Math.max(...theirs.filter((r) => r.action.type !== "allow").map((r) => r.priority));
  ours.addRules.filter((r) => r.action.type === "block").forEach((r) => assert.ok(r.priority > theirRedirectOrBlock));
  assert.ok(ours.addRules.find((r) => r.action.type === "allow").priority > maxTheirs);
});

test("buildOpenSdkRules with no tabs only removes", () => {
  const { addRules, removeRuleIds } = T.buildOpenSdkRules([], SDK_SCRIPT_REGEXES);
  assert.equal(addRules.length, 0);
  assert.ok(removeRuleIds.includes(T.OPEN_SDK_STRIP_CSP_BASE));
});

test("sameSite keeps subdomains and www, not look-alikes", () => {
  assert.equal(T.sameSite("www.shop.com", "https://shop.com/a"), true);
  assert.equal(T.sameSite("shop.com", "https://m.shop.com/a"), true);
  assert.equal(T.sameSite("shop.com", "https://badshop.com/"), false);
  assert.equal(T.sameSite("shop.com", "about:blank"), false);
  assert.equal(T.sameSite("WWW.Shop.com", "https://m.SHOP.com/"), true);
});

test("isSdkCookie and cookieRemoveUrl", () => {
  assert.equal(T.isSdkCookie("_evga_1a2b"), true);
  assert.equal(T.isSdkCookie("_sfid_5c1e"), true);
  assert.equal(T.isSdkCookie("_ga"), false);
  assert.equal(T.isSdkCookie("x_evga_"), false);
  assert.equal(T.cookieRemoveUrl({ domain: ".shop.com", path: "/", secure: true }), "https://shop.com/");
  assert.equal(T.cookieRemoveUrl({ domain: "shop.com", path: "/a", secure: false }), "http://shop.com/a");
});

test("collectSdkInfo calls safe getters, lists the rest, survives odd values", async () => {
  const calls = [];
  const circular = { a: 1 };
  circular.self = circular;
  class Base {
    getVersion() {
      calls.push("getVersion");
      return "1.2.3";
    }
  }
  const si = Object.assign(new Base(), {
    getAnonymousId: () => (calls.push("anon"), "abc123"),
    getConsents: async () => [{ purpose: "Tracking", status: "Opt In" }],
    isInitialized: () => true,
    getCircular: () => circular,
    getShared: () => {
      const one = { n: 1 };
      return { a: one, b: one };
    },
    getBroken: () => {
      throw new Error("boom");
    },
    getRecommendations: () => calls.push("recs"),
    getUserAttribute: (name) => calls.push("attr " + name),
    sendEvent: () => calls.push("send"),
    init: () => calls.push("init"),
    version: "9",
    config: { cookieDomain: "shop.com" },
  });
  globalThis.window = { SalesforceInteractions: si };
  globalThis.document = { querySelectorAll: () => [{ src: "https://cdn.evgnet.com/beacon/a/b/scripts/evergage.min.js" }, { src: "https://x/app.js" }] };
  globalThis.location = { href: "https://shop.com/" };
  try {
    const info = await T.collectSdkInfo(T.DOCUMENTED_GETTERS);
    const [sfi, ev] = info.sdks;
    assert.equal(ev.found, false);
    assert.equal(sfi.found, true);
    assert.deepEqual(sfi.getters.slice(0, 2).map((g) => g.name), ["getAnonymousId", "getConsents"]);
    assert.equal(sfi.getters[0].documented, true);
    const by = Object.fromEntries(sfi.getters.map((g) => [g.name, g]));
    assert.equal(by.getAnonymousId.value, "abc123");
    assert.deepEqual(by.getConsents.value, [{ purpose: "Tracking", status: "Opt In" }]);
    assert.equal(by.isInitialized.value, true);
    assert.equal(by.getVersion.value, "1.2.3");
    assert.equal(by.getCircular.value.self, "(circular)");
    // The same object twice, not inside itself: shown both times.
    assert.deepEqual(by.getShared.value, { a: { n: 1 }, b: { n: 1 } });
    assert.equal(by.getBroken.error, "boom");
    const others = sfi.others.map((o) => o.name);
    for (const n of ["getRecommendations", "getUserAttribute", "sendEvent", "init"]) assert.ok(others.includes(n), n);
    assert.ok(!calls.includes("recs") && !calls.includes("send") && !calls.includes("init"));
    assert.ok(!calls.some((c) => c.startsWith("attr")));
    assert.deepEqual(sfi.props.find((p) => p.name === "version"), { name: "version", value: "9" });
    assert.deepEqual(sfi.props.find((p) => p.name === "config").value, { cookieDomain: "shop.com" });
    assert.deepEqual(info.scripts, ["https://cdn.evgnet.com/beacon/a/b/scripts/evergage.min.js"]);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.location;
  }
});
