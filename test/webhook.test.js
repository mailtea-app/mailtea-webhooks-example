import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { signWebhook } from "mailtea-sdk";
import { createApp, handleEvent } from "../app.js";
import { sampleData } from "../send-test-event.mjs";
import { startMockMailtea } from "./mock-mailtea.mjs";

const SIGNING_SECRET = "whsec_dGVzdHNpZ25pbmdrZXlub3RhcmVhbHNlY3JldA==";

/** Envelopes the handler saw, in order. Reset before every test. */
let received = [];
let server;
let baseUrl;

before(async () => {
  const app = createApp({
    signingSecret: SIGNING_SECRET,
    onEvent: (event) => received.push(event)
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/webhooks/mailtea`;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  received = [];
});

/**
 * Every event type Mailtea dispatches. `sampleData` (shared with the demo
 * script) supplies a realistic payload for each, so the switch is driven with
 * the field names the real thing sends rather than ones invented here.
 */
const EVENT_TYPES = [
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

function envelope(overrides = {}) {
  return {
    id: `evt_${randomUUID().replaceAll("-", "")}`,
    type: "email.delivered",
    created_at: new Date().toISOString(),
    data: {
      email_id: "txemail_00000000000000000000000000000000",
      to: "reader@mailtea.test",
      from: "Acme <hello@acme.com>",
      subject: "Hello",
      delivered_at: new Date().toISOString()
    },
    ...overrides
  };
}

/**
 * Build the three headers exactly as Mailtea's delivery worker does. `body` is
 * what gets signed and what gets sent — the tampering test is the one place
 * they deliberately differ.
 */
function deliver(body, { timestamp = Math.floor(Date.now() / 1000), signedBody = body } = {}) {
  const msgId = `whdel_${randomUUID().replaceAll("-", "")}`;
  return fetch(baseUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": msgId,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signWebhook({
        secret: SIGNING_SECRET,
        msgId,
        timestamp,
        payload: signedBody
      })
    },
    body
  });
}

/**
 * The two handler-failure tests below make the receiver log a real stack trace.
 * Silence it for the duration so a passing run does not look like a failing one.
 */
function quietErrors(t) {
  const original = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = original;
  });
}

test("accepts a correctly signed delivery and hands the envelope to the handler", async () => {
  const event = envelope();

  const response = await deliver(JSON.stringify(event));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { received: true });
  assert.equal(received.length, 1);
  assert.equal(received[0].id, event.id);
  assert.equal(received[0].type, "email.delivered");
  assert.equal(received[0].data.email_id, event.data.email_id);
});

test("rejects a body altered after signing", async () => {
  const original = JSON.stringify(envelope({ type: "email.delivered" }));
  const tampered = JSON.stringify(envelope({ type: "email.bounced" }));

  // The signature is valid — for a payload that is not the one being delivered.
  const response = await deliver(tampered, { signedBody: original });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid signature" });
  assert.equal(received.length, 0, "a tampered payload must never reach the handler");
});

test("rejects a timestamp outside the tolerance window", async () => {
  const stale = Math.floor(Date.now() / 1000) - 3600;

  // Signature and body are internally consistent; this is a captured delivery
  // being replayed an hour later.
  const response = await deliver(JSON.stringify(envelope()), { timestamp: stale });

  assert.equal(response.status, 400);
  assert.equal(received.length, 0);
});

test("rejects a delivery with no signature headers", async () => {
  const response = await fetch(baseUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope())
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Missing webhook signature headers" });
  assert.equal(received.length, 0);
});

test("processes a replayed envelope id exactly once", async () => {
  const body = JSON.stringify(envelope());

  // A real retry reuses the delivery row's `webhook-id` and re-signs with a
  // fresh timestamp; this sends a fresh delivery id too, which is the harder
  // case. Either way both requests verify, and only the envelope id gives the
  // duplicate away.
  const first = await deliver(body);
  const second = await deliver(body);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200, "a duplicate must still answer 2xx, or it gets retried forever");
  assert.equal(received.length, 1);
});

test("answers 2xx for an event type it does not handle", async () => {
  const response = await deliver(JSON.stringify(envelope({ type: "some.future.event" })));

  assert.equal(response.status, 200);
  assert.equal(received.length, 1);
});

test("the handler switch covers every event type Mailtea dispatches", () => {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(line);
  try {
    for (const type of EVENT_TYPES) {
      handleEvent({ id: "evt_1", type, created_at: "t", data: sampleData(type) });
    }
  } finally {
    console.log = original;
  }

  assert.equal(lines.length, EVENT_TYPES.length);
  for (const line of lines) {
    assert.doesNotMatch(line, /unhandled event type/, `fell through to default: ${line}`);
    assert.doesNotMatch(line, /undefined/, `read a field the payload does not carry: ${line}`);
  }
});

test("subscribe creates the endpoint and surfaces the signing secret", async (t) => {
  const mock = await startMockMailtea();
  t.after(() => mock.close());

  process.env.MAILTEA_API_KEY = "mt_pat_test_key";
  process.env.MAILTEA_PUBLICATION_ID = "pub_00000000000000000000000000000000";
  process.env.MAILTEA_WEBHOOK_ENDPOINT = "https://example.test/webhooks/mailtea";

  // Imported after the env is set: `subscribe()` reads the publication id and
  // the endpoint from the environment at call time.
  const { Mailtea } = await import("mailtea-sdk");
  const { subscribe } = await import("../subscribe.mjs");

  const webhook = await subscribe(new Mailtea(process.env.MAILTEA_API_KEY, { baseUrl: mock.url }));

  assert.equal(mock.last.method, "POST");
  assert.equal(mock.last.path, "/v1/webhooks/endpoints");
  assert.equal(mock.last.authorization, "Bearer mt_pat_test_key");
  assert.equal(mock.last.body.publication_id, "pub_00000000000000000000000000000000");
  assert.equal(mock.last.body.endpoint, "https://example.test/webhooks/mailtea");
  assert.ok(mock.last.body.events.includes("email.bounced"));
  assert.ok(webhook.signing_secret.startsWith("whsec_"));

  // Every event it subscribes to must be one the switch actually handles —
  // a subscription the receiver drops on the floor is a silent data loss.
  for (const type of mock.last.body.events) {
    assert.ok(EVENT_TYPES.includes(type), `subscribed to ${type}, which the handler does not handle`);
  }
});

test("a handler that throws is retryable — no 2xx, and no dedupe entry left behind", async (t) => {
  quietErrors(t);
  let attempts = 0;
  const app = createApp({
    signingSecret: SIGNING_SECRET,
    onEvent: () => {
      attempts += 1;
      // Fail the first attempt only, the way a flaky downstream call would.
      if (attempts === 1) throw new Error("downstream unavailable");
    }
  });
  const flaky = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => flaky.once("listening", resolve));
  t.after(() => new Promise((resolve) => flaky.close(resolve)));

  const url = `http://127.0.0.1:${flaky.address().port}/webhooks/mailtea`;
  const body = JSON.stringify(envelope());
  const send = () => {
    const msgId = `whdel_${randomUUID().replaceAll("-", "")}`;
    const timestamp = Math.floor(Date.now() / 1000);
    return fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": msgId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": signWebhook({ secret: SIGNING_SECRET, msgId, timestamp, payload: body })
      },
      body
    });
  };

  const failed = await send();
  assert.equal(failed.status, 500, "a failed handler must not report success, or Mailtea never retries");

  // The retry Mailtea sends carries the same envelope id. If the first attempt
  // had recorded that id, this would be deduped away and the event lost.
  const retried = await send();
  assert.equal(retried.status, 200);
  assert.equal(attempts, 2, "the retry must reach the handler");
});

test("an async handler that rejects is caught, not answered 200", async (t) => {
  quietErrors(t);
  const app = createApp({
    signingSecret: SIGNING_SECRET,
    onEvent: async () => {
      throw new Error("queue write failed");
    }
  });
  const server2 = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server2.once("listening", resolve));
  t.after(() => new Promise((resolve) => server2.close(resolve)));

  const url = `http://127.0.0.1:${server2.address().port}/webhooks/mailtea`;
  const body = JSON.stringify(envelope());
  const msgId = `whdel_${randomUUID().replaceAll("-", "")}`;
  const timestamp = Math.floor(Date.now() / 1000);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": msgId,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": signWebhook({ secret: SIGNING_SECRET, msgId, timestamp, payload: body })
    },
    body
  });

  assert.equal(response.status, 500);
});
