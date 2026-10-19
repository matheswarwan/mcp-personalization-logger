import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
globalThis.chrome = {};
require("../js/sdk-config.js");
const { parseSiteList, siteMatches, isLocalHost, mergeSettings, buildSdkDnrRules, SDK_SCRIPT_REGEXES } = globalThis;

test("parseSiteList cleans URLs, ports, wildcards and junk", () => {
  assert.deepEqual(
    parseSiteList("https://www.Example.com/path?x=1, *.shop.ca\nlocalhost:3000; bad!! *"),
    ["www.example.com", "shop.ca", "localhost", "*"]
  );
  assert.deepEqual(parseSiteList(["a.com", "a.com", ""]), ["a.com"]);
  assert.deepEqual(parseSiteList(undefined), []);
});

test("siteMatches covers subdomains only", () => {
  assert.equal(siteMatches(["example.com"], "example.com"), true);
  assert.equal(siteMatches(["example.com"], "www.example.com"), true);
  assert.equal(siteMatches(["example.com"], "badexample.com"), false);
  assert.equal(siteMatches(["*"], "anything.org"), true);
  assert.equal(siteMatches([], "example.com"), false);
});

test("isLocalHost", () => {
  assert.equal(isLocalHost("localhost"), true);
  assert.equal(isLocalHost("127.0.0.1"), true);
  assert.equal(isLocalHost("app.localhost"), true);
  assert.equal(isLocalHost("example.com"), false);
});

test("SDK regexes match http and https, ports and non-min builds", () => {
  const [evg, c360] = SDK_SCRIPT_REGEXES.map((r) => new RegExp(r));
  assert.ok(evg.test("https://cdn.evgnet.com/beacon/a/b/scripts/evergage.min.js"));
  assert.ok(evg.test("http://cdn.evgnet.com/beacon/a/b/scripts/evergage.js?v=2"));
  assert.ok(evg.test("https://cdn.evgnet.com:8443/beacon/a/evergage.min.js"));
  assert.ok(!evg.test("https://cdn.evgnet.com/beacon/a/evergage.min.json"));
  assert.ok(!evg.test("https://evil.com/cdn.evgnet.com/evergage.min.js"));
  assert.ok(c360.test("https://cdn.c360a.salesforce.com/beacon/c360a/x/scripts/c360a.min.js"));
});

test("no sites means no rules", () => {
  const r = buildSdkDnrRules(
    mergeSettings({ forceSdk: { enabled: true, url: "https://x.com/sdk.js" } })
  );
  assert.equal(r.addRules.length, 0);
  assert.ok(r.removeRuleIds.includes(91001));
});

test("redirect rules are scoped to the sites and guard against loops", () => {
  const r = buildSdkDnrRules(
    mergeSettings({
      sites: ["shop.example.com"],
      forceSdk: { enabled: true, url: "http://localhost:8080/evergage.min.js" },
    })
  );
  const redirects = r.addRules.filter((x) => x.action.type === "redirect");
  assert.equal(redirects.length, 2);
  redirects.forEach((x) => {
    assert.deepEqual(x.condition.initiatorDomains, ["shop.example.com"]);
    assert.equal(x.action.redirect.url, "http://localhost:8080/evergage.min.js");
  });
  const allow = r.addRules.find((x) => x.action.type === "allow");
  assert.equal(allow.condition.urlFilter, "|http://localhost:8080/evergage.min.js|");
  assert.ok(allow.priority > redirects[0].priority);
});

test("* drops the site restriction", () => {
  const r = buildSdkDnrRules(
    mergeSettings({ sites: ["*"], forceSdk: { enabled: true, url: "https://x.com/sdk.js" } })
  );
  assert.equal(r.addRules[0].condition.initiatorDomains, undefined);
});

test("invalid or non-http redirect URL adds nothing", () => {
  ["not a url", "ftp://x.com/sdk.js", "javascript:alert(1)"].forEach((url) => {
    const r = buildSdkDnrRules(mergeSettings({ sites: ["a.com"], forceSdk: { enabled: true, url } }));
    assert.equal(r.addRules.length, 0, url);
  });
});

test("edit mode serves the edited SDK as a data: URL on the sites only", () => {
  const r = buildSdkDnrRules(
    mergeSettings({
      sites: ["a.com", "b.org"],
      forceSdk: { enabled: true, url: "https://x.com/sdk.js" },
      localEdit: { enabled: true, edited: 'window.x="é";' },
    })
  );
  const redirects = r.addRules.filter((x) => x.action.type === "redirect");
  assert.equal(redirects.length, 2);
  redirects.forEach((x) => {
    assert.deepEqual(x.condition.initiatorDomains, ["a.com", "b.org"]);
    const u = x.action.redirect.url;
    assert.ok(u.startsWith("data:text/javascript;base64,"));
    assert.equal(Buffer.from(u.split(",")[1], "base64").toString("utf8"), 'window.x="é";');
  });
  assert.equal(globalThis.editServedByRedirect(mergeSettings({ localEdit: { enabled: true, edited: "x" } })), true);
});

test("edit mode falls back to block and inject when the file is too large", () => {
  const big = "x".repeat(globalThis.MAX_FETCHED_SDK_CHARS + 1);
  const settings = mergeSettings({ sites: ["a.com"], localEdit: { enabled: true, edited: big } });
  assert.equal(globalThis.editServedByRedirect(settings), false);
  const r = buildSdkDnrRules(settings);
  assert.ok(r.addRules.length > 0);
  assert.ok(r.addRules.filter((x) => x.action.type !== "modifyHeaders").every((x) => x.action.type === "block"));
});

test("needsFetchedSdk: only http URLs that are not on localhost", () => {
  const { needsFetchedSdk } = globalThis;
  assert.equal(needsFetchedSdk("http://dev.example.com/sdk.js"), true);
  assert.equal(needsFetchedSdk("http://192.168.1.20:8080/sdk.js"), true);
  assert.equal(needsFetchedSdk("http://localhost:8080/sdk.js"), false);
  assert.equal(needsFetchedSdk("http://127.0.0.1/sdk.js"), false);
  assert.equal(needsFetchedSdk("https://dev.example.com/sdk.js"), false);
  assert.equal(needsFetchedSdk("nonsense"), false);
});

test("toBase64Utf8 handles non-ASCII and large input", () => {
  const { toBase64Utf8 } = globalThis;
  assert.equal(Buffer.from(toBase64Utf8("é ✓ x"), "base64").toString("utf8"), "é ✓ x");
  const big = "a".repeat(200000) + "ü";
  assert.equal(Buffer.from(toBase64Utf8(big), "base64").toString("utf8"), big);
});

test("non-local http redirect serves the fetched code as a data: URL", () => {
  const url = "http://dev.example.com/sdk.js";
  const base = { sites: ["a.com"], forceSdk: { enabled: true, url } };
  // Not fetched yet: nothing.
  assert.equal(buildSdkDnrRules(mergeSettings(base)).addRules.length, 0);
  // Fetched for a different URL or failed: nothing.
  for (const fetched of [
    { url: "http://other.example.com/sdk.js", code: "x" },
    { url, code: "", error: "HTTP 404" },
  ]) {
    const r = buildSdkDnrRules(mergeSettings({ ...base, forceSdk: { ...base.forceSdk, fetched } }));
    assert.equal(r.addRules.length, 0);
  }
  const r = buildSdkDnrRules(
    mergeSettings({ ...base, forceSdk: { ...base.forceSdk, fetched: { url, code: 'window.x="ü";' } } })
  );
  const redirects = r.addRules.filter((x) => x.action.type === "redirect");
  assert.equal(redirects.length, 2);
  redirects.forEach((x) => {
    const u = x.action.redirect.url;
    assert.ok(u.startsWith("data:text/javascript;base64,"));
    assert.equal(Buffer.from(u.split(",")[1], "base64").toString("utf8"), 'window.x="ü";');
  });
});

test("page CSP header is removed on the listed sites only while a tool is on", () => {
  const strip = (settings) =>
    buildSdkDnrRules(mergeSettings(settings)).addRules.find((x) => x.action.type === "modifyHeaders");
  const edit = { localEdit: { enabled: true, edited: "x" } };
  assert.equal(strip({ sites: ["a.com"] }), undefined);
  assert.equal(strip({ ...edit }), undefined);
  const rule = strip({ sites: ["a.com"], ...edit });
  assert.deepEqual(rule.action.responseHeaders, [{ header: "content-security-policy", operation: "remove" }]);
  assert.deepEqual(rule.condition.requestDomains, ["a.com"]);
  assert.deepEqual(rule.condition.resourceTypes, ["main_frame", "sub_frame"]);
  assert.equal(strip({ sites: ["*"], ...edit }).condition.requestDomains, undefined);
  assert.ok(strip({ sites: ["a.com"], forceSdk: { enabled: true, url: "https://localhost:8080/e.js" } }));
  assert.ok(buildSdkDnrRules(mergeSettings({ sites: ["a.com"] })).removeRuleIds.includes(91030));
});
