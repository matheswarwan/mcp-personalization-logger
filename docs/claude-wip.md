# Work in progress

## State (2026-11-13)
- 0.2.0 is live in the Chrome Web Store.
- 0.3.0 committed and packaged (`dist/interaction-studio-mcp-logger-v0.3.0.zip`), not yet uploaded: Tools page (feedback #1001 decoder in Explorer and popup, plus user asks: Inject SDK & open page, SDK info, clear cookies). Adds the `cookies` permission; justification in docs/chrome-web-store.md.
- Checked live with the real Data Cloud and Personalization SDKs (see claude-context.md). Unit 47/47, Tools E2E 16/16 (five runs in a row), SDK Tools E2E 30/30, smoke 13/13.
- Next: upload 0.3.0 to the Chrome Web Store.

## Shipped in 0.2.0
- SDK Tools injects the SDK into listed pages that never load it (Redirect and Edit), with a per-tab block so a late page SDK does not run twice. Setting `injectWhenMissing`, checkbox under Sites.
- SDK matching by file name on any host (adds `cdn.evergage.com`, self-hosted copies, `evergageTrackingOnly`, `evergageSmall`).
- Theme switch (System, Light, Dark) on every page.
- Popup header fits 420px.
- `tests/sdk-inject-e2e.mjs`: real-Chrome E2E for SDK Tools, 30 cases. Smoke test uses Cmd for multi-select on macOS.

## Notes for next time
- SDK Tools' per-tab block (`buildTabBlockRules`, 0.2.0) is tab-wide and removed asynchronously on main-frame navigation, like the open-with-SDK rules were before they were scoped by site (that race made the Tools E2E fail intermittently). A page on another site loaded in the same tab could have its SDK blocked in that short window. Not seen in the 30 SDK Tools E2E cases; fix the same way (scope by the page's site with `initiatorDomains`).
- Not checked on a real customer site with a strict `<meta>` CSP: an injected SDK is blocked there (the console says so).
- The E2E and smoke tests need local port binding and a Chrome launch, which the Claude sandbox blocks; run them outside it.
