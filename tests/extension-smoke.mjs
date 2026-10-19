import puppeteer from "puppeteer";
import path from "path";
import { fileURLToPath } from "url";
import assert from "assert";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, "..");

const samplePayloadA = {
  action: "Page View",
  itemAction: "View Item",
  source: {
    pageType: "product",
    url: "https://shop.example.com/p/123",
  },
  user: { anonymousId: "abc" },
};

const samplePayloadB = {
  action: "Add To Cart",
  itemAction: "AddToCart",
  source: {
    pageType: "product",
    url: "https://shop.example.com/p/123",
  },
};

const seedData = {
  "shop.example.com | usf (ds: prod)": [
    {
      [String(Date.now() - 60_000)]: {
        url: "https://usf.evergage.com/api2/event/prod?event=abc",
        payload: samplePayloadA,
        datetime: Date.now() - 60_000,
        website: "shop.example.com",
        statusCode: 200,
      },
    },
    {
      [String(Date.now() - 30_000)]: {
        url: "https://usf.evergage.com/api2/event/prod",
        payload: samplePayloadB,
        datetime: Date.now() - 30_000,
        website: "shop.example.com",
        statusCode: 200,
      },
    },
    {
      [String(Date.now() - 48 * 3600_000)]: {
        url: "https://usf.evergage.com/api2/event/prod",
        payload: { action: "Old Event" },
        datetime: Date.now() - 48 * 3600_000,
        website: "shop.example.com",
        statusCode: 500,
      },
    },
  ],
  "other.example.com | eu (ds: stage)": [
    {
      [String(Date.now() - 10_000)]: {
        url: "https://eu.evergage.com/api2/event/stage",
        payload: {
          action: "Login",
          source: { url: "https://other.example.com/login" },
        },
        datetime: Date.now() - 10_000,
        website: "other.example.com",
        statusCode: 201,
      },
    },
  ],
};

async function waitForExtensionId(browser, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const swTarget = (await browser.targets()).find(
      (t) =>
        t.type() === "service_worker" &&
        t.url().startsWith("chrome-extension://")
    );
    if (swTarget) {
      return swTarget.url().split("/")[2];
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Timed out waiting for extension service worker");
}

async function seedStorage(page, data) {
  await page.evaluate(async (payload) => {
    await new Promise((resolve, reject) => {
      chrome.storage.local.clear(() => {
        chrome.storage.local.set(payload, () => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve();
          }
        });
      });
    });
  }, data);
}

async function run() {
  // CHROME_PATH picks a local Chrome/Chromium; HEADLESS=1 runs without a window.
  const browser = await puppeteer.launch({
    headless: process.env.HEADLESS === "1",
    executablePath: process.env.CHROME_PATH || undefined,
    pipe: true,
    enableExtensions: [EXTENSION_PATH],
    // CHROME_ARGS adds flags, e.g. "--no-sandbox" where the sandbox is unavailable.
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1400,900",
      ...(process.env.CHROME_ARGS || "").split(/\s+/).filter(Boolean),
    ],
  });

  const failures = [];
  const pass = (name) => console.log(`PASS  ${name}`);
  const fail = (name, err) => {
    console.error(`FAIL  ${name}: ${err?.message || err}`);
    failures.push(name);
  };

  try {
    const extensionId = await waitForExtensionId(browser);
    console.log("Extension ID:", extensionId);

    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: "domcontentloaded",
    });
    await seedStorage(popup, seedData);
    await popup.reload({ waitUntil: "domcontentloaded" });
    await popup.waitForSelector("#BtnFullScreen", { timeout: 5000 });

    try {
      const btnText = await popup.$eval("#BtnFullScreen", (el) =>
        el.textContent.trim()
      );
      assert.strictEqual(btnText, "Open Explorer");
      pass("popup has Open Explorer button");
    } catch (e) {
      fail("popup has Open Explorer button", e);
    }

    try {
      await popup.waitForFunction(
        () =>
          document.getElementById("eventList")?.textContent?.includes("shop.example.com"),
        { timeout: 5000 }
      );
      pass("popup lists seeded site");
    } catch (e) {
      fail("popup lists seeded site", e);
    }

    const fsPage = await browser.newPage();
    await fsPage.goto(`chrome-extension://${extensionId}/fullscreen.html`, {
      waitUntil: "domcontentloaded",
    });
    await fsPage.click("#BtnFsRefresh");
    await fsPage.waitForFunction(
      () => document.querySelectorAll(".fs-tab").length >= 3,
      { timeout: 5000 }
    );

    try {
      const tabCount = await fsPage.$$eval(".fs-tab", (els) => els.length);
      assert.strictEqual(tabCount, 3);
      pass("explorer shows All sites plus 2 site tabs");
    } catch (e) {
      fail("explorer shows All sites plus 2 site tabs", e);
    }

    try {
      await fsPage.waitForFunction(
        () => document.querySelectorAll(".fs-event").length === 3,
        { timeout: 5000 }
      );
      pass("All sites + 24h shows 3 recent events");
    } catch (e) {
      fail("All sites + 24h shows 3 recent events", e);
    }

    try {
      await fsPage.click('.fs-tab[data-site^="other.example.com"]');
      await fsPage.waitForFunction(
        () => document.querySelectorAll(".fs-event").length === 1,
        { timeout: 5000 }
      );
      const action = await fsPage.$eval(".fs-event-action", (el) =>
        el.textContent.trim()
      );
      assert.strictEqual(action, "Login");
      pass("other.example.com tab shows its Login event");
    } catch (e) {
      fail("other.example.com tab shows its Login event", e);
    }

    try {
      await fsPage.click('.fs-tab[data-site^="shop.example.com"]');
      await fsPage.waitForFunction(
        () => document.querySelectorAll(".fs-event").length === 2,
        { timeout: 5000 }
      );
      const actions = await fsPage.$$eval(".fs-event-action", (els) =>
        els.map((el) => el.textContent.trim())
      );
      assert.ok(actions.includes("Add To Cart"));
      assert.ok(actions.includes("Page View"));
      assert.ok(!actions.includes("Old Event"));
      pass("shop tab + 24h filter shows 2 recent events");
    } catch (e) {
      fail("shop tab + 24h filter shows 2 recent events", e);
    }

    try {
      await fsPage.click('[data-range="all"]');
      await fsPage.waitForFunction(
        () =>
          [...document.querySelectorAll(".fs-event-action")].some(
            (el) => el.textContent.trim() === "Old Event"
          ),
        { timeout: 5000 }
      );
      const count = await fsPage.$$eval(".fs-event", (els) => els.length);
      assert.strictEqual(count, 3);
      pass("All time filter includes older events");
    } catch (e) {
      fail("All time filter includes older events", e);
    }

    try {
      // Capture clipboard writes (headless has no clipboard permission).
      await fsPage.evaluate(() => {
        window.__copied = [];
        navigator.clipboard.writeText = async (t) => window.__copied.push(t);
      });
      const boxes = await fsPage.$$(".fs-event .ex-check");
      await boxes[0].click();
      await fsPage.keyboard.down("Shift");
      await boxes[2].click();
      await fsPage.keyboard.up("Shift");
      const count = await fsPage.$eval("#fsSelCount", (el) => el.textContent.trim());
      assert.strictEqual(count, "3 events selected");
      assert.strictEqual(await fsPage.$eval("#fsSelBar", (el) => el.hidden), false);
      await fsPage.click('#fsSelBar [data-sel="copy-json"]');
      await fsPage.waitForFunction(() => window.__copied.length === 1, { timeout: 5000 });
      const model = JSON.parse(await fsPage.evaluate(() => window.__copied[0]));
      assert.strictEqual(model.events.length, 3);
      assert.strictEqual(model.scope, "Selected events");
      pass("tick + shift-click selects a range and Copy JSON copies it");

      await fsPage.click('.fs-tab[data-site^="other.example.com"]');
      const hidden = await fsPage.$eval("#fsSelHidden", (el) => el.textContent.trim());
      assert.strictEqual(hidden, "(3 not in this view)");
      await fsPage.click(".fs-event", { modifiers: [] });
      await fsPage.keyboard.down("Control");
      await fsPage.click(".fs-event .ex-col-action");
      await fsPage.keyboard.up("Control");
      assert.strictEqual(await fsPage.$eval("#fsSelCount", (el) => el.textContent.trim()), "4 events selected");
      await fsPage.click('#fsSelBar [data-sel="clear"]');
      assert.strictEqual(await fsPage.$eval("#fsSelBar", (el) => el.hidden), true);
      await fsPage.click('.fs-tab[data-site^="shop.example.com"]');
      pass("selection spans sites, Ctrl+click ticks, Clear empties it");
    } catch (e) {
      fail("multi-select", e);
    }

    try {
      await fsPage.evaluate(() => {
        const input = document.getElementById("fsSearch");
        input.value = "Add To Cart";
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await fsPage.waitForFunction(
        () => document.querySelectorAll(".fs-event").length === 1,
        { timeout: 5000 }
      );
      const action = await fsPage.$eval(".fs-event-action", (el) =>
        el.textContent.trim()
      );
      assert.strictEqual(action, "Add To Cart");
      pass("search filter narrows to matching action");
    } catch (e) {
      fail("search filter narrows to matching action", e);
    }

    try {
      await fsPage.evaluate(() => {
        document.getElementById("fsSearch").value = "";
        document
          .getElementById("fsSearch")
          .dispatchEvent(new Event("input", { bubbles: true }));
      });
      await fsPage.waitForFunction(
        () => document.querySelectorAll(".fs-event").length === 3,
        { timeout: 5000 }
      );
      await fsPage.click(".fs-event");
      await fsPage.waitForSelector("#fsJsonMount .json-viewer", {
        timeout: 5000,
      });
      const detailText = await fsPage.$eval(
        "#fsDetailBody",
        (el) => el.textContent
      );
      assert.ok(detailText.includes("Action"));
      assert.ok(detailText.includes("Status"));
      pass("event detail pane renders JSON viewer");
    } catch (e) {
      fail("event detail pane renders JSON viewer", e);
    }

    try {
      const workerTarget = (await browser.targets()).find(
        (t) => t.type() === "service_worker" && t.url().includes(extensionId)
      );
      const worker = await workerTarget.worker();
      const decodeOk = await worker.evaluate(() => {
        const encoded = btoa(
          unescape(encodeURIComponent(JSON.stringify({ action: "X café" })))
        );
        const binary = atob(encoded);
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        const text = new TextDecoder().decode(bytes);
        return JSON.parse(text).action === "X café";
      });
      assert.ok(decodeOk);
      pass("UTF-8 base64 decode works in service worker context");
    } catch (e) {
      fail("UTF-8 base64 decode works in service worker context", e);
    }

    try {
      const page = await browser.newPage();
      await page.goto("https://example.com", {
        waitUntil: "domcontentloaded",
        timeout: 20000,
      });
      await new Promise((r) => setTimeout(r, 1500));
      const injected = await page.evaluate(() => {
        return [...document.scripts].some((s) =>
          (s.src || "").includes("cdn.evgnet.com/beacon/freshbooks")
        );
      });
      assert.strictEqual(injected, false);
      pass("no Freshbooks beacon injected on example.com");
      await page.close();
    } catch (e) {
      fail("no Freshbooks beacon injected on example.com", e);
    }

    await popup.close();
    await fsPage.close();
  } finally {
    await browser.close();
  }

  if (failures.length) {
    console.error(`\n${failures.length} test(s) failed`);
    process.exit(1);
  }
  console.log("\nAll smoke tests passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
