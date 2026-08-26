import { randomUUID } from "node:crypto";
import { signWebhook } from "mailtea-sdk";

/**
 * Sign a payload the way Mailtea does and POST it at your running receiver, so
 * you can exercise the handler without waiting for a real bounce. Same helper
 * the delivery worker uses, so a payload this script accepts is one the real
 * thing accepts.
 *
 *   node --env-file=.env send-test-event.mjs email.delivered
 *
 * Pass `--replay` to send the same envelope id twice and watch the dedupe.
 */

/** Mailtea's delivery timeout. A receiver slower than this is retried. */
const DELIVERY_TIMEOUT_MS = 10_000;

const EMAIL_ID = "txemail_9d2f41a7c8b34e5fa61c07d3e8b95204";
// Real id prefixes, because they surprise people: a contact is `sub_`
// (subscriber), a topic is `tag_`, and an inbound email is `rxemail_`.
const CONTACT = { contact_id: "sub_1", publication_id: "pub_1", email: "reader@acme.test" };
const RUN = { run_id: "run_1", automation_id: "aut_1", publication_id: "pub_1", contact_id: "sub_1" };

/**
 * One representative payload per event type. Mailtea sends metadata only — ids,
 * addresses and timestamps — never the HTML or text body, so these are the real
 * shape and not a reduction of it.
 */
export function sampleData(type, at = new Date().toISOString()) {
  const email = { email_id: EMAIL_ID, to: "reader@acme.test", from: "Acme <hello@acme.test>", subject: "Test event" };
  switch (type) {
    case "email.sent": return { ...email, sent_at: at };
    case "email.delivered": return { ...email, delivered_at: at };
    case "email.delivery_delayed": return { ...email, delayed_at: at, reason: "Throttled by the receiving server" };
    case "email.failed": return { ...email, failed_at: at, reason: "Recipient address rejected" };
    case "email.suppressed": return { ...email, suppressed_at: at, reason: "on_suppression_list" };
    case "email.opened": return { email_id: EMAIL_ID, opened_at: at };
    case "email.clicked": return { email_id: EMAIL_ID, clicked_at: at, link: "https://acme.test/pricing" };
    case "email.bounced": return { email_id: EMAIL_ID, recipients: ["reader@acme.test"], bounce_type: "Permanent", bounced_at: at };
    case "email.complained": return { email_id: EMAIL_ID, recipients: ["reader@acme.test"], complained_at: at };
    // Every recipient field is present and every one is an ARRAY, unlike the
    // outbound events above where `to` is a single string. `message_id` is the
    // RFC 5322 Message-ID and is nullable, not absent.
    case "email.received": return { email_id: "rxemail_1", publication_id: "pub_1", from: "reader@acme.test", to: ["support@acme.test"], cc: [], bcc: [], reply_to: [], subject: "Re: your newsletter", message_id: "<CAF%3D1@mail.acme.test>", created_at: at, attachments: [] };
    case "contact.created":
    case "contact.updated":
    case "contact.unsubscribed": return { ...CONTACT, status: type === "contact.unsubscribed" ? "unsubscribed" : "active", created_at: at, updated_at: at };
    case "contact.deleted": return CONTACT;
    case "contact.topic_subscribed": return { ...CONTACT, topic_id: "tag_1", previous_status: "unsubscribed", status: "subscribed", source: "preference_center", occurred_at: at };
    case "contact.topic_unsubscribed": return { ...CONTACT, topic_id: "tag_1", previous_status: "subscribed", status: "unsubscribed", source: "one_click", occurred_at: at };
    case "automation.run.started": return { ...RUN, version: 1, is_test: false, started_at: at };
    case "automation.run.completed": return { ...RUN, version: 1, is_test: false, completed_at: at, steps_completed: 3 };
    case "automation.run.failed": return { ...RUN, version: 1, is_test: false, failed_at: at, step_key: "send_welcome", error: "Template render failed" };
    case "automation.run.exited": return { ...RUN, version: 1, is_test: false, exited_at: at, exit_reason: "contact_unsubscribed", step_key: "wait_2d" };
    case "automation.step.completed": return { ...RUN, version: 1, is_test: false, step_key: "send_welcome", step_type: "send_email", status: "succeeded", completed_at: at };
    default: return {};
  }
}

/**
 * POST one signed delivery. Returns the receiver's status code, or 0 when the
 * request never got a response at all — which is a failed delivery to Mailtea
 * too, not an exception it lets escape.
 *
 * `msgId` is a fresh delivery id here because each call is a NEW delivery. A
 * real Mailtea retry is the same delivery again: it reuses that row's
 * `whdel_` id and re-signs with a fresh timestamp. Either way the envelope
 * `evt_` id below is what stays constant, which is why that is the dedupe key.
 */
async function post(receiver, signingSecret, body) {
  // Unix SECONDS. Milliseconds here are the single most common reason a
  // receiver rejects everything with "timestamp outside tolerance".
  const timestamp = Math.floor(Date.now() / 1000);
  const msgId = `whdel_${randomUUID().replaceAll("-", "")}`;

  let response;
  try {
    response = await fetch(receiver, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": msgId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signWebhook({ secret: signingSecret, msgId, timestamp, payload: body })
      },
      body,
      // The same deadline the delivery worker enforces, so a handler too slow
      // for production fails here rather than looking fine locally.
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS)
    });
  } catch (error) {
    const reason =
      error?.name === "TimeoutError"
        ? `no response within ${DELIVERY_TIMEOUT_MS / 1000}s — Mailtea gives a delivery the same deadline and would retry`
        : (error?.cause?.code ?? error?.message ?? "request failed");
    console.error(`  could not reach ${receiver}: ${reason}`);
    console.error("  is the receiver running? `node --env-file=.env server.js`");
    return 0;
  }

  console.log(`  ${response.status} ${await response.text()}`);
  return response.status;
}

// `import.meta.main` is Node 24+; the fallback keeps this importable by the
// tests on any version the SDK supports.
const isMain = import.meta.main ?? process.argv[1]?.endsWith("send-test-event.mjs");

if (isMain) {
  const signingSecret = process.env.MAILTEA_WEBHOOK_SECRET;
  if (!signingSecret) {
    console.error("MAILTEA_WEBHOOK_SECRET is not set.");
    process.exit(1);
  }

  const receiver = process.env.RECEIVER_URL ?? "http://localhost:3000/webhooks/mailtea";
  const type = process.argv[2] ?? "email.delivered";
  const replay = process.argv.includes("--replay");

  const body = JSON.stringify({
    id: `evt_${randomUUID().replaceAll("-", "")}`,
    type,
    created_at: new Date().toISOString(),
    data: sampleData(type)
  });

  console.log(`POST ${receiver}  ${type}`);
  const status = await post(receiver, signingSecret, body);

  // Unreachable receiver, or a receiver that answered non-2xx: exit non-zero so
  // this is usable in a script and does not read as success in a terminal.
  if (status < 200 || status >= 300) {
    process.exitCode = 1;
  } else if (replay) {
    // Re-send the same envelope, which is what a retry is. Mailtea would reuse
    // the delivery id and re-sign with a fresh timestamp; the fresh id here
    // makes the point more sharply — the signature is valid either way, and the
    // envelope `id` is the only thing that reveals the duplicate.
    console.log("replaying the same envelope id");
    if ((await post(receiver, signingSecret, body)) !== 200) {
      process.exitCode = 1;
    }
  }
}
