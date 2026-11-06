# Work in progress

## Released in 0.2.0
- SDK Tools injects the SDK into listed pages that never load it (Redirect and Edit), with a per-tab block so a late page SDK does not run twice. Setting `injectWhenMissing`, checkbox under Sites.
- SDK matching by file name on any host (adds `cdn.evergage.com`, self-hosted copies, `evergageTrackingOnly`, `evergageSmall`).
- Theme switch (System, Light, Dark) on every page.
- Popup header fits 420px.
- `tests/sdk-inject-e2e.mjs`: real-Chrome E2E for SDK Tools, 30 cases. Smoke test uses Cmd for multi-select on macOS.

## Next
- Upload `dist/interaction-studio-mcp-logger-v0.2.0.zip` to the Chrome Web Store and update the Privacy practices text from `docs/chrome-web-store.md`.
