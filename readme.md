# Interaction Studio (MCP) Logger

A Chrome extension that logs every event a page sends to Salesforce Marketing Cloud Personalization (formerly Interaction Studio, served by `evergage.min.js`) and to the Data Cloud Web SDK (`c360a.min.js`). The payloads are base64 encoded, so the extension decodes them and shows formatted JSON, which makes debugging a site's personalization setup much quicker for developers and testers.

"MCP" here means Marketing Cloud Personalization, not the Model Context Protocol.

## Installation

1. Unzip the extension (the latest build is in `dist/`).
2. Open `chrome://extensions`.
3. Turn on Developer mode.
4. Click **Load unpacked** and pick the unzipped folder.
5. Pin the extension.

<img src="gitImages/1.png" width="200px" height="125px"/>

## Use

1. Open a site that uses Marketing Cloud Personalization. Some examples: alc.ca, becu.org, macro.com.ar, lendingclub.com, zebra.com.
2. When an event is recorded, the icon changes color for a moment and the event shows in the popup.
3. Click **Full Screen** in the popup to open the Event Explorer: one tab per site, time range filters, a status filter (All statuses or Failed only), a text search and a time-ordered event stream.

Both `GET` requests with an encoded payload and `POST` requests with form data or a raw body are supported.

<img src="gitImages/2.png" width="200px" height="250px"/>

## Export

In the Event Explorer, **Export** works on the events in the current view (the selected site with the current filters) or on all sites with the same filters:

- **Copy for agent (Markdown):** copies a Markdown summary to paste into an AI assistant: what was exported and the filters used, a table of actions with counts and failures, the pages seen, failed requests, and then every event (oldest first) with its page, SDK, request URL and decoded payload. Each payload is cut at 4,000 characters so the text fits in a prompt.
- **Download Markdown:** the same document as a `.md` file, with full payloads.
- **Download JSON:** the same data as JSON (`summary` plus `events`), for scripts or other tools.
- **Download HTML report:** a single HTML file that works offline and needs no scripts: summary, pages, and one expandable entry per event. It follows the system's light or dark mode.

**Hide personal data** is on by default. It replaces email addresses (anywhere, including URL-encoded ones in page URLs) and the values of fields such as email, phone, first and last name, address, postal code, birth date, password, token and cookie with `[masked]`. Turn it off if you need the real values.

The event details panel also has **Copy for agent** for the selected event, plus **Copy JSON** and **Download JSON** for its raw payload.

## SDK Tools

Open **SDK Tools** from the popup or the Event Explorer.

**Sites:** both tools only apply on the sites you list (subdomains included, so `example.com` covers `www.example.com`; `*` means every site). Every other site loads the SDK normally. Chips under the box add sites from your open tabs.

**Redirect SDK:** requests the listed sites make for `evergage(.min).js` on `cdn.evgnet.com` or `c360a(.min).js` on `cdn.c360a.salesforce.com`, over http or https, go to the URL you enter. The replacement can be http or https. Chrome blocks an http script on an https page (mixed content) unless it comes from `localhost` or `127.0.0.1`; for any other http URL on an https site, use Edit SDK with Load from URL instead. Reload the site with the cache off after saving.

**Edit SDK:** load an SDK from a URL or a file, edit it, and compare it with the original or download it. Enter the **Page to open** and click **Inject and open**: the edited SDK is saved, injection is turned on, the page's site is added to Sites if needed, and the page opens in a new tab with the CDN SDK blocked and your copy injected instead. Injection then continues on every page load on the listed sites until you turn it off.

Only one of Redirect and Edit can be on at a time (Edit blocks the SDK that Redirect would replace).

The edited copy is injected when the page starts loading, but it can still run after the page's own inline scripts, so code that calls the SDK straight after its script tag may run before it exists.

## Development

- Unit tests for the export code: `cd tests && npm test` (Node's built-in test runner, no install needed).
- Browser smoke test (loads the unpacked extension in Chrome with Puppeteer): `cd tests && npm install && npm run test:smoke`.
- Package a release: `./package.sh` writes `dist/interaction-studio-mcp-logger-v<version>.zip`, without tests and dev files.
