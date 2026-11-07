# Work in progress

## State (2026-11-06)
- 0.2.0 is live in the Chrome Web Store (merged to main through PR #1).
- Nothing in progress.

## Shipped in 0.2.0
- SDK Tools injects the SDK into listed pages that never load it (Redirect and Edit), with a per-tab block so a late page SDK does not run twice. Setting `injectWhenMissing`, checkbox under Sites.
- SDK matching by file name on any host (adds `cdn.evergage.com`, self-hosted copies, `evergageTrackingOnly`, `evergageSmall`).
- Theme switch (System, Light, Dark) on every page.
- Popup header fits 420px.
- `tests/sdk-inject-e2e.mjs`: real-Chrome E2E for SDK Tools, 30 cases. Smoke test uses Cmd for multi-select on macOS.

## Notes for next time
- Not checked on a real customer site with a strict `<meta>` CSP: an injected SDK is blocked there (the console says so).
- The E2E and smoke tests need local port binding and a Chrome launch, which the Claude sandbox blocks; run them outside it.
