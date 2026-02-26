# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the bot
npm start
# or directly:
node index.js
```

There are no lint or test scripts configured.

## Required Environment Variables

Create a `.env` file in the root directory:

```
GCP_PROJECT=your-gcp-project-id
GCP_LOCATION=us-central1
CALENDAR_ID=your-google-calendar-id
GEMINI_KEY=your-gemini-key
MAPS_KEY=your-google-maps-api-key
SPREADSHEET_ID=your-google-sheets-id
```

`service-account.json` must also be present in the root for Google Vertex AI, Sheets, and Calendar auth. The `GOOGLE_APPLICATION_CREDENTIALS` env var is set programmatically in `index.js` to point to it.

## Architecture

This is a **WhatsApp Multi-Tenant SaaS Bot Engine**. Each bot entry in `bots.json` gets its own WhatsApp client, Vertex AI session, and business logic instance — all started in parallel via `botsConfig.forEach(startBot)`.

### Request flow (per incoming WhatsApp message)

1. `index.js` receives `message_create` event from `whatsapp-web.js`
2. Skips group chats, broadcast statuses, outgoing-message loops, and unauthorized admin commands (messages starting with `!`)
3. Reads `faq_deliveries.txt` and calls `getOrCreateCache()` which creates/reuses a **Vertex AI context cache** (cached for 24h per day, TTL=86400s). The cache holds the system instruction + tools, reducing token costs on repeated calls.
4. Retrieves or creates a per-user `chatSession` from the `sessions` Map (keyed by WhatsApp sender ID). On each message, the chat history is **sliding-windowed to the last 8 turns** (4 user/model pairs) to keep context bounded.
5. Sends the message (prepended with current time) to Gemini via `chat.sendMessage()`
6. Enters a **function call loop**: while Gemini returns `functionCall` parts, each is dispatched to the corresponding tool in `botTools`. The sender's phone number is auto-injected as `senderPhone` into every tool call's args.
7. Tool results that include `sendFile` cause a file to be sent and deleted after. Results with `adminAlert` are forwarded to the admin's WhatsApp number.
8. Final text response is sent back via `msg.reply()`

### How to add a new bot type

1. Add a new entry to `bots.json` with a unique `id`, `logicType`, and `toolsFile`.
2. Create `tools/<toolsFile>.js` — export an array of Vertex AI `functionDeclarations` objects.
3. Create `logic/<logicType>.js` — export a factory `(config) => ({ toolName: async (args) => {...}, ... })`.
4. Register the new logic type in `logicFactory.js`.

### Key files

| File | Purpose |
|------|---------|
| `index.js` | Main engine: WhatsApp client, Vertex AI cache + chat, function call loop |
| `bots.json` | Bot configurations. Supports `${ENV_VAR}` interpolation. |
| `logicFactory.js` | Maps `logicType` strings to their logic module |
| `logic/delivery.js` | Business logic tool implementations for the delivery bot |
| `tools/delivery.js` | Gemini function schemas (tool definitions) for the delivery bot |
| `faq_deliveries.txt` | FAQ content injected into the system instruction via `{{FAQ}}` placeholder |

### Tool result conventions (`logic/*.js`)

Tool functions return plain objects. Special keys have engine-level behavior:
- `sendFile: filePath` — `index.js` will send the file as WhatsApp media and delete it after
- `adminAlert: message` + `adminNumber: whatsappId` — `index.js` will forward the message to the admin

### Delivery bot specifics

- **Pricing**: 50 NIS base + 5 NIS per km beyond 5 km (via Google Maps Distance Matrix API)
- **Sheet columns A–O**: date, time, orderer name, sender phone, pickup address, pickup contact, pickup phone, delivery address, delivery contact, delivery phone, distance, price, payment status (M), completed status (N), package details (O)
- **Admin commands**: Messages starting with `!` are admin-only. Admins can query orders, update statuses, and request CSV reports.
- **Order flow**: Gemini collects all order details → calls `calculateDistanceAndPrice` → presents summary → waits for user to type `מאשר` → calls `saveOrderToSheet` + `saveOrderToCalendar` in sequence.
