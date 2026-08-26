import { Mailtea, MailteaError } from "mailtea-sdk";

/**
 * Point Mailtea at your receiver. Run this once per environment — the endpoint
 * persists, and re-running it creates a second subscription that delivers every
 * event twice.
 *
 * Mailtea will not deliver to localhost (an outbound webhook to a private
 * address is an SSRF vector), so for local development put a tunnel in front:
 *
 *   ngrok http 3000
 *   MAILTEA_WEBHOOK_ENDPOINT=https://<id>.ngrok.app/webhooks/mailtea node subscribe.mjs
 */

/**
 * Built on demand, not at import time. The SDK throws a `MailteaError` when
 * there is no API key, and a client constructed at module scope throws it
 * during the import — before any `try` in this file can turn it into a readable
 * message. As a default parameter it is constructed inside `subscribe()`, so
 * the rejection lands in the handler below.
 */
function defaultClient() {
  return new Mailtea(process.env.MAILTEA_API_KEY, {
    // Only needed for local dev or a self-hosted Mailtea. Omit in production.
    baseUrl: process.env.MAILTEA_API_BASE_URL
  });
}

/**
 * Subscribe only to what you handle. Every subscribed event is a delivery you
 * pay for in retries and log volume, and `email.opened` alone can outnumber
 * everything else here.
 */
const events = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.opened",
  "email.clicked",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.suppressed",
  "email.received",
  "contact.created",
  "contact.updated",
  "contact.deleted",
  "contact.unsubscribed",
  "contact.topic_subscribed",
  "contact.topic_unsubscribed",
  "automation.run.started",
  "automation.run.completed",
  "automation.run.failed",
  "automation.run.exited",
  "automation.step.completed"
];

export async function subscribe(client = defaultClient()) {
  return client.webhooks.create({
    publication_id: process.env.MAILTEA_PUBLICATION_ID,
    endpoint: process.env.MAILTEA_WEBHOOK_ENDPOINT,
    events
  });
}

// `import.meta.main` is Node 24+; the fallback keeps this importable by the
// tests on any version the SDK supports.
const isMain = import.meta.main ?? process.argv[1]?.endsWith("subscribe.mjs");

if (isMain) {
  // Named up front, because the API's own 400 for a missing publication or a
  // malformed endpoint reads like a bug in this script rather than a blank in
  // your `.env`.
  const missing = ["MAILTEA_PUBLICATION_ID", "MAILTEA_WEBHOOK_ENDPOINT"].filter(
    (name) => !process.env[name]
  );
  if (missing.length > 0) {
    console.error(`Not set in your environment: ${missing.join(", ")}. See .env.example.`);
    process.exit(1);
  }

  try {
    const webhook = await subscribe();
    console.log(`Created ${webhook.id} -> ${webhook.endpoint}`);
    console.log(`Subscribed to ${webhook.events.length} event types`);
    // Returned by `create` and never again. Store it wherever you keep secrets
    // and read it back as MAILTEA_WEBHOOK_SECRET; if you lose it, delete the
    // endpoint and make a new one.
    console.log(`\nSigning secret (shown once):\n${webhook.signing_secret}`);
  } catch (error) {
    if (error instanceof MailteaError) {
      // `status` is 0 for the errors the SDK raises before it reaches the wire
      // — a missing API key, most often — so do not dress those up as an HTTP
      // response the server never sent.
      console.error(
        error.status > 0
          ? `Mailtea returned ${error.status}: ${error.message}`
          : error.message
      );
      process.exit(1);
    }
    throw error;
  }
}
