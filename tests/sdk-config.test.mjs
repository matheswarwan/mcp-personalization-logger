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

test("edit mode blocks the CDN SDK on the sites only", () => {
  const r = buildSdkDnrRules(
    mergeSettings({
      sites: ["a.com", "b.org"],
      forceSdk: { enabled: true, url: "https://x.com/sdk.js" },
      localEdit: { enabled: true, edited: "console.log(1)" },
    })
  );
  assert.ok(r.addRules.every((x) => x.action.type === "block"));
  assert.deepEqual(r.addRules[0].condition.initiatorDomains, ["a.com", "b.org"]);
});
