# Project context: Interaction Studio (MCP) Logger

Chrome MV3 extension, version 0.2.0 (live in the Chrome Web Store, 2026-11-06).
Logs and decodes events sent to Marketing Cloud Personalization (Evergage, `evergage.min.js`) and the Data Cloud Web SDK (`c360a.min.js`), and offers SDK Tools to swap or edit the SDK on chosen sites.
User-facing docs: `readme.md`. Store listing notes: `docs/chrome-web-store.md`.

## Layout
- `manifest.json`: MV3, service worker `js/background.js`, content scripts `js/sdk-config.js` + `js/contentScript.js` (top frame, `document_start`).
- `js/background.js`: webRequest capture of SDK event requests into `chrome.storage.local`; SDK Tools messages (`MCP_SAVE_SETTINGS`, `MCP_INJECT_LOCAL_SDK`, `MCP_INJECT_MISSING_SDK`, `MCP_STOP_SDK_TOOLS`, `MCP_PAGE_DIAG`, ...).
- `js/sdk-config.js`: shared by the service worker, settings page, content script and Node tests. Settings shape (`__mcp_settings__`), SDK URL regexes (`SDK_SCRIPT_REGEXES`, `isSdkScriptUrl`), DNR session rule builders.
- `js/contentScript.js`: asks the background for the page's SDK Tools status, injects the SDK when the page has none, writes console notes and page diagnostics.
- `popup.*`, `fullscreen.*` (Event Explorer), `settings.*` (SDK Tools), `feedback.*`.
- `js/theme.js` + `css/theme.css`: System / Light / Dark switch on every page (`[data-theme-switch]` placeholder). Choice in extension `localStorage` (`mcp-theme`), set as `data-theme` on `<html>` before first paint; dark tokens apply for system-dark unless `data-theme="light"`, or for `data-theme="dark"`. Pages sync via the `storage` event; `mcp-themechange` lets the Ace editor follow.
- `tests/`: `npm test` (Node unit tests), `npm run test:smoke` (Puppeteer, extension UI), `npm run test:e2e-sdk` (Puppeteer, SDK Tools on fake sites and CDN via `--host-resolver-rules`; needs local port binding).
- `package.sh` builds `dist/interaction-studio-mcp-logger-v<version>.zip`.

## SDK Tools design
- Modes: Off, Redirect (replacement URL), Edit (edited copy). One at a time. Applies only to `sites` (subdomains included, `*` = all).
- Pages that load the SDK: DNR session rules, scoped by `initiatorDomains`.
  - Redirect: redirect SDK script requests to the URL (priority 50); an allow rule (60) for the URL itself prevents loops. Non-localhost http URLs are fetched on save and served as a `data:` URL.
  - Edit: `data:` URL redirect when under ~1.4 MB; larger copies block the SDK (100) and `injectLocalSdk` evals the code at `document_start`.
  - While a mode is on, the page `Content-Security-Policy` header is removed on the listed sites.
- Pages that do not load the SDK (`injectWhenMissing`, default on, modelled on the Salesforce Interactions SDK Launcher's Inject SDK): at DOMContentLoaded the content script checks script tags and resource timing; if no SDK, `injectMissingSdk` adds the tab to a per-tab block rule (fixed ids 91040+, `condition.tabIds`, priority 55) and injects in the MAIN world (script tag for a direct URL, eval for edited or fetched code). The tab leaves the block list on its next main-frame request or when closed; settings changes clear it.
- Console notes and per-load reports (`__mcp_diag__`) go to Feedback.
