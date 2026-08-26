import express from "express";
import { verifyWebhookSignature } from "mailtea-sdk";

/**
 * Mailtea signs webhooks with Standard Webhooks (https://standardwebhooks.com):
 *
 *   webhook-id         the delivery id, stable across retries of one delivery
 *   webhook-timestamp  Unix SECONDS (not milliseconds)
 *   webhook-signature  "v1,<base64 HMAC-SHA256>", space-delimited if rotating
 *
 * The signed content is `{webhook-id}.{webhook-timestamp}.{raw body}`, and the
 * HMAC key is the base64 remainder of your `whsec_…` signing secret decoded to
 * bytes. `verifyWebhookSignature` from the SDK does all of that, including a
 * constant-time compare and the timestamp-tolerance check that stops an
 * attacker from replaying a payload they captured last week.
 */

/** How far the `webhook-timestamp` may be from now, each way. */
const TOLERANCE_SECONDS = 300;

export function createApp({ signingSecret, onEvent = handleEvent } = {}) {
  if (!signingSecret) {
    throw new Error("signingSecret is required — see MAILTEA_WEBHOOK_SECRET in .env.example");
  }

  const app = express();

  /**
   * Envelope ids we have already processed. Mailtea retries a delivery that
   * does not answer 2xx, and a retry carries the SAME envelope `id`, so without
   * this an eventual success replays every side effect the earlier attempts had
   * already run. In production use your database — a unique index on the event
   * id, or an upsert keyed by it — because an in-memory Set forgets everything
   * on deploy and is not shared between instances.
   */
  const processed = new Set();

  app.post(
    "/webhooks/mailtea",
    // THE important line. `express.raw` hands the handler the exact bytes
    // Mailtea signed. Mounting `express.json()` on this route instead would
    // re-serialize the body before you got to it — key order, whitespace and
    // unicode escapes all shift, the HMAC no longer matches, and the usual
    // "fix" is to stop verifying. Parse only after the signature checks out.
    express.raw({ type: "application/json" }),
    async (req, res) => {
      if (!Buffer.isBuffer(req.body)) {
        // No raw body means some other parser ran first, or the sender used a
        // content type this route does not accept. Either way there is nothing
        // trustworthy to verify.
        return res.status(400).json({ error: "Expected a raw application/json body" });
      }

      const msgId = req.get("webhook-id");
      const timestamp = Number(req.get("webhook-timestamp"));
      const signatureHeader = req.get("webhook-signature");

      if (!msgId || !signatureHeader || !Number.isFinite(timestamp)) {
        return res.status(400).json({ error: "Missing webhook signature headers" });
      }

      const payload = req.body.toString("utf8");

      const valid = verifyWebhookSignature({
        secret: signingSecret,
        msgId,
        timestamp,
        payload,
        signatureHeader,
        toleranceSeconds: TOLERANCE_SECONDS
      });

      // Reject before parsing, logging the body, or touching your database.
      // An unsigned request is an anonymous stranger claiming a customer
      // bounced; treat it as one.
      if (!valid) {
        return res.status(400).json({ error: "Invalid signature" });
      }

      let event;
      try {
        event = JSON.parse(payload);
      } catch {
        return res.status(400).json({ error: "Invalid JSON" });
      }

      // `event.id` is the `evt_…` envelope id: one id per event, shared by every
      // endpoint it fans out to and reused by every retry, which is exactly the
      // key you want to dedupe on. A duplicate still answers 2xx — anything else
      // and Mailtea keeps retrying an event you have already handled.
      if (processed.has(event.id)) {
        return res.status(200).json({ received: true, duplicate: true });
      }

      try {
        // Awaited so an async handler's rejection lands in the catch below
        // rather than sailing past it as an unhandled rejection — which would
        // answer 200 for work that never happened.
        await onEvent(event);
      } catch (error) {
        // Marking it processed BEFORE the handler succeeds is the subtle way to
        // lose events: the 500 below asks Mailtea to retry, and the retry then
        // matches the dedupe entry this attempt left behind and is dropped. Mark
        // it only once the work is actually done.
        console.error(`handler failed for ${event.id}`, error);
        return res.status(500).json({ error: "Handler failed" });
      }

      processed.add(event.id);

      // Answer 2xx immediately. Mailtea gives a delivery 10 seconds and retries
      // anything slower or non-2xx, so a handler that sends its own email or
      // waits on a third-party API turns one event into several. Push the slow
      // part onto a queue and return here.
      res.status(200).json({ received: true });
    }
  );

  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  return app;
}

/**
 * Replace the bodies with your own work. The point of the switch is the
 * `default` branch: Mailtea adds event types over time, and an endpoint that
 * throws on an unfamiliar `type` fails the delivery and earns itself retries
 * for an event it was never going to care about.
 *
 * Payloads are metadata only — ids, addresses, timestamps — never the HTML or
 * text body. Fetch content from the REST API with the ids carried here.
 */
export function handleEvent(event) {
  switch (event.type) {
    case "email.sent":
      console.log(`sent ${event.data.email_id} to ${event.data.to}`);
      break;
    case "email.delivered":
      console.log(`delivered ${event.data.email_id} to ${event.data.to}`);
      break;
    case "email.delivery_delayed":
      console.log(`delayed ${event.data.email_id}: ${event.data.reason ?? "unknown reason"}`);
      break;
    case "email.opened":
      console.log(`opened ${event.data.email_id} at ${event.data.opened_at}`);
      break;
    case "email.clicked":
      console.log(`clicked ${event.data.link} in ${event.data.email_id}`);
      break;
    case "email.bounced":
      // A hard bounce is the signal to stop mailing that address. Mailtea
      // suppresses it for you, but your own copy of the list should learn too.
      console.log(`bounced (${event.data.bounce_type ?? "unknown"}): ${event.data.recipients.join(", ")}`);
      break;
    case "email.complained":
      // Someone pressed "report spam". Never mail them again, whatever your
      // records say about their consent.
      console.log(`complaint from ${event.data.recipients.join(", ")}`);
      break;
    case "email.failed":
      console.log(`failed ${event.data.email_id}: ${event.data.reason}`);
      break;
    case "email.suppressed":
      console.log(`suppressed ${event.data.to}: ${event.data.reason}`);
      break;
    case "email.received":
      console.log(`inbound from ${event.data.from}: ${event.data.subject}`);
      break;
    case "contact.created":
      console.log(`contact created ${event.data.email}`);
      break;
    case "contact.updated":
      console.log(`contact updated ${event.data.email} (${event.data.status})`);
      break;
    case "contact.deleted":
      console.log(`contact deleted ${event.data.email}`);
      break;
    case "contact.unsubscribed":
      console.log(`contact unsubscribed ${event.data.email}`);
      break;
    case "contact.topic_subscribed":
      console.log(`${event.data.email} joined topic ${event.data.topic_id} via ${event.data.source}`);
      break;
    case "contact.topic_unsubscribed":
      console.log(`${event.data.email} left topic ${event.data.topic_id} via ${event.data.source}`);
      break;
    case "automation.run.started":
      console.log(`automation ${event.data.automation_id} started run ${event.data.run_id}`);
      break;
    case "automation.run.completed":
      console.log(`run ${event.data.run_id} completed ${event.data.steps_completed} steps`);
      break;
    case "automation.run.failed":
      console.log(`run ${event.data.run_id} failed at ${event.data.step_key}: ${event.data.error}`);
      break;
    case "automation.run.exited":
      console.log(`run ${event.data.run_id} exited early: ${event.data.exit_reason}`);
      break;
    case "automation.step.completed":
      console.log(`run ${event.data.run_id} step ${event.data.step_key} ${event.data.status}`);
      break;
    default:
      console.log(`ignoring unhandled event type ${event.type}`);
  }
}
