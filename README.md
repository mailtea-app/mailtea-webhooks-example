# Mailtea + Webhooks Example

This example shows how to use [Mailtea](https://mailtea.app) with Express to
receive webhooks, verify their signatures, and handle each event type exactly
once.

## Prerequisites

To get the most out of this guide, you'll need to:

- [Create an API key](https://studio.mailtea.app/api-keys)
- [Verify your domain](https://docs.mailtea.app/docs/documentation/domains)

## Instructions

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` and add your API key:
   ```bash
   cp .env.example .env
   ```
3. Tell Mailtea where to deliver, and save the signing secret it prints into
   `.env` as `MAILTEA_WEBHOOK_SECRET`:
   ```bash
   node --env-file=.env subscribe.mjs
   ```
4. Run it:
   ```bash
   node --env-file=.env server.js
   ```

Then fire a signed event at it, without waiting for a real bounce:

```bash
node --env-file=.env send-test-event.mjs email.bounced
```

```
POST http://localhost:3000/webhooks/mailtea  email.bounced
  200 {"received":true}
```

```
bounced (Permanent): reader@acme.test
```

Add `--replay` to send the same envelope twice and watch the second one get
deduped:

```bash
node --env-file=.env send-test-event.mjs email.opened --replay
```

```
  200 {"received":true}
replaying the same envelope id
  200 {"received":true,"duplicate":true}
```

Mailtea will not deliver to `localhost` — an outbound webhook to a private
address is an SSRF vector, so the delivery worker refuses it. To receive real
events on your machine, put a tunnel in front and subscribe that URL:

```bash
ngrok http 3000
MAILTEA_WEBHOOK_ENDPOINT=https://<id>.ngrok.app/webhooks/mailtea node --env-file=.env subscribe.mjs
```

## How the verification works

Mailtea signs every delivery with
[Standard Webhooks](https://standardwebhooks.com) and sends three headers:

| Header | Meaning |
|---|---|
| `webhook-id` | Delivery id, stable across retries of one delivery |
| `webhook-timestamp` | Unix **seconds** — not milliseconds |
| `webhook-signature` | `v1,<base64 HMAC-SHA256>`, space-delimited during key rotation |

The signed content is `{webhook-id}.{webhook-timestamp}.{raw body}`, and the
HMAC key is the base64 remainder of your `whsec_…` secret decoded to bytes.
`verifyWebhookSignature` from `mailtea-sdk` does all of that — including the
constant-time compare and the timestamp tolerance — so there is no HMAC code in
this example to get subtly wrong.

Four things are easy to get wrong, and all four are load-bearing:

- **Read the raw body.** This route mounts `express.raw({ type:
  "application/json" })`, not `express.json()`. A JSON parser re-serializes the
  body before your handler sees it: key order, whitespace and unicode escapes
  all shift, the HMAC stops matching, and the usual "fix" is to stop verifying.
  Verify the exact bytes, then parse.
- **Reject before you process.** An unsigned request is an anonymous stranger
  claiming your customer bounced. This example answers `400` before parsing,
  logging, or touching a database.
- **Let the timestamp check run.** It is what stops someone replaying a payload
  they captured last week. The default tolerance is five minutes each way.
- **Dedupe on the envelope `id`.** A delivery that does not answer 2xx is
  retried, and the retry carries the same `evt_…` id — so without deduping, an
  eventual success replays every side effect the earlier attempts already ran.
  This example keeps an in-memory `Set`; **use your database in production**,
  because a `Set` forgets on deploy and is not shared between instances.

One subtlety worth copying exactly: the id is recorded **after** the handler
succeeds, never before. Recording it first means a handler that throws answers
`500`, Mailtea retries, and the retry matches the dedupe entry the failed
attempt left behind — the event is dropped and never comes back.

Finally, answer 2xx fast. Mailtea gives a delivery 10 seconds and retries
anything slower or non-2xx, so a handler that sends its own email or calls a
third-party API turns one event into several. Push the slow part onto a queue
and return.

## What this example covers

- Verifying Standard Webhooks signatures with `verifyWebhookSignature()`
- Reading the raw request body so the signature still matches
- Rejecting missing, invalid, and expired signatures with `400` before any
  processing happens
- Idempotent handling, keyed on the envelope `id`, that survives a retry
- Failing loudly enough to be retried when a handler throws
- Handling every event type Mailtea dispatches, with a `default` branch so a
  new event type never fails a delivery
- Creating the endpoint with `mailtea.webhooks.create()` and storing the
  signing secret it returns once
- Signing a payload locally with `signWebhook()` to test the receiver

## Tests

```bash
npm test
```

The tests run against a bundled mock Mailtea server and a receiver on an
ephemeral loopback port, so they need no API key and reach no external network.
They cover the signature and dedupe rules above, every event type in the switch,
and what each script prints when `.env` is blank or the receiver is not up.

## Learn more

- [Documentation](https://docs.mailtea.app)
- [API reference](https://docs.mailtea.app/docs/api-reference)
- [Node.js SDK](https://github.com/mailtea-app/mailtea-node) ·
  [Python SDK](https://github.com/mailtea-app/mailtea-python) ·
  [MCP server](https://github.com/mailtea-app/mailtea-mcp)
