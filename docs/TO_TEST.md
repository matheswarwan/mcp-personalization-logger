# To test

Changes not yet in a Chrome Web Store release. Tick each one off after trying it on a real site (load the unpacked folder or a test zip).

## Next version (after 0.3.0)

### Responses saved with each event (feedback #1003)
- **Where:** Event Explorer, an event's details; Export menu.
- **Steps:**
  1. Open a site that uses Marketing Cloud Personalization (evergage.min.js) and browse a page or two.
  2. Open the Event Explorer and click a Personalization event.
  3. Scroll the details below the payload.
  4. Use Copy for agent and Download Markdown on that event.
  5. On a site with the Data Cloud Web SDK, open a Data Cloud event.
- **Expect:** a Response section with the HTTP status, the campaigns served (campaign / experience, user group) when the response has `campaignResponses`, then the full body. The exports include the response, masked like the payload. Data Cloud events show their (usually short) response. Events captured before this version say no response was saved. The page itself behaves as before.
- **Also check:** events still appear quickly when a page sends many at once (the save queue no longer waits for the icon blink).
