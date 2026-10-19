# Chrome Web Store listing: privacy practices

Text for the Privacy practices tab, checked against how the code uses each permission (version 0.0.6). Update it when permissions or features change.

## Single purpose

Debugging Salesforce Marketing Cloud Personalization and Data Cloud Web SDK implementations: capture and decode the events a site sends, and let developers test a replacement or edited SDK on chosen sites.

## Permission justifications

### scripting

Used by the SDK Tools "Edit SDK" feature. A developer loads a copy of the Marketing Cloud Personalization SDK, edits it, and chooses the sites to test it on. If the edited file is too large to serve in place of the SDK request (over 1,400 KB), the extension uses chrome.scripting.executeScript to run the edited copy in pages on those listed sites only. It never runs on other sites, and nothing runs unless the developer turns Edit SDK on.

### declarativeNetRequest

Used by SDK Tools to swap the Marketing Cloud Personalization (evergage.min.js) or Data Cloud (c360a.min.js) SDK while a developer tests. Session rules redirect the SDK script request to a URL the developer enters, or to their edited copy, or block it when the edited copy is injected instead. While a tool is on, a rule also removes the Content-Security-Policy header from the listed sites' pages, because a page CSP would otherwise block the replacement SDK. Rules only match those two SDK script URLs (plus the page responses of the listed sites for the CSP header), only on sites the developer has listed, and are removed when the tool is switched off.

### declarativeNetRequestWithHostAccess

Chrome requires host access for declarativeNetRequest redirect rules. The extension redirects the SDK script request (from cdn.evgnet.com or cdn.c360a.salesforce.com) to the developer's replacement or edited SDK, only on the sites the developer lists in SDK Tools, and removes the Content-Security-Policy header from those sites' pages while the tool is on. No other requests are redirected or changed.

### tabs

Used to read the URLs of the developer's open tabs in SDK Tools: to pre-fill "Page to open" with the most recently used web page and to offer one-click "add this site" chips for the Sites list. It is also used to open the Event Explorer, SDK Tools and the chosen test page in new tabs. Tab URLs are only shown on the extension's own pages; they are not stored beyond the settings the developer saves, and nothing is sent anywhere.

### webRequest

Reads requests the page sends to Marketing Cloud Personalization (evergage.com/api2/event/) and the Data Cloud Web SDK (c360a.salesforce.com/web/events/) to capture and decode the event payloads and their response status. Other requests are ignored. Data stays in local storage on the device.

### storage, unlimitedStorage

Captured events and SDK Tools settings are kept in chrome.storage.local on the device so the developer can review them in the popup and Event Explorer. The extension also keeps short notes on the last 15 page loads where SDK Tools was on (what it did there), for the Feedback page. unlimitedStorage prevents long test sessions from hitting the default quota. Nothing is sent off the device except a feedback report the developer chooses to send.

### Host permission (<all_urls>)

Personalization and Data Cloud are installed on customers' own websites, which can be any domain. The extension needs to see the event requests these sites send, and to redirect SDK requests on the sites a developer lists in SDK Tools.

## Remote code

No remote code is executed as part of the extension. Developers can choose to replace the page's own SDK with their own copy for testing; this only affects sites they list.

## Data usage

Captured events and settings stay in the browser's local extension storage until the developer clears them. The only data sent anywhere is a feedback report, and only when the developer fills in the Feedback page and clicks Send: their message, an optional email address, and (unless they untick it) technical details shown in full on the page before sending: extension version, browser user agent, SDK Tools settings (site names, SDK URLs, file sizes, no SDK code), the extension's active rules, and notes from recent page loads with SDK Tools on (page address without query string). Captured event payloads are never sent. Reports go to the developer's feedback endpoint on Cloudflare Workers and are used only to fix problems and plan features.

For the "Data usage" form: tick "Website content" and "Personally identifiable information" (only if the user types an email into Feedback); certify that data is not sold, not used for unrelated purposes, and not used for creditworthiness.
