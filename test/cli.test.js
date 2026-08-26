import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";

/**
 * The two scripts in this example are the first thing a reader runs, and both
 * of them fail for the same two boring reasons: a blank in `.env`, or a
 * receiver that is not up yet. A raw `MailteaError` thrown during module load,
 * or a bare `TypeError: fetch failed`, reads as a bug in the example rather
 * than as the thing the reader forgot — so each script's unhappy path is
 * pinned here.
 *
 * Run in a child process because that is the only honest way to observe what
 * the terminal actually prints and what exit code the shell actually sees.
 */

const run = promisify(execFile);
const dir = fileURLToPath(new URL("..", import.meta.url));

/** Run a script with a controlled env; resolve with its output either way. */
async function script(file, env, args = []) {
  try {
    const { stdout, stderr } = await run(process.execPath, [file, ...args], {
      cwd: dir,
      // A clean slate: a developer's own MAILTEA_* vars must not decide the
      // outcome of these assertions.
      env: { PATH: process.env.PATH, ...env }
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("subscribe.mjs names the missing env var instead of throwing during import", async () => {
  const result = await script("subscribe.mjs", {});

  assert.equal(result.code, 1);
  assert.match(result.stderr, /MAILTEA_PUBLICATION_ID/);
  assert.match(result.stderr, /MAILTEA_WEBHOOK_ENDPOINT/);
  assert.doesNotMatch(result.stderr, /at ModuleJob|at async/, "printed a stack trace");
});

test("subscribe.mjs reports a missing API key as a message, not an HTTP status", async () => {
  const result = await script("subscribe.mjs", {
    MAILTEA_PUBLICATION_ID: "pub_00000000000000000000000000000000",
    MAILTEA_WEBHOOK_ENDPOINT: "https://example.test/webhooks/mailtea"
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /Missing Mailtea API key/);
  // The SDK raises this before any request, so there is no status to report.
  assert.doesNotMatch(result.stderr, /Mailtea returned 0/);
  assert.doesNotMatch(result.stderr, /at ModuleJob|at async/, "printed a stack trace");
});

test("send-test-event.mjs explains an unreachable receiver and exits non-zero", async () => {
  const result = await script("send-test-event.mjs", {
    MAILTEA_WEBHOOK_SECRET: "whsec_dGVzdHNpZ25pbmdrZXlub3RhcmVhbHNlY3JldA==",
    // Port 1 is reserved and never listening, so this always refuses.
    RECEIVER_URL: "http://127.0.0.1:1/webhooks/mailtea"
  });

  assert.equal(result.code, 1, "a delivery that never landed must not exit 0");
  assert.match(result.stderr, /could not reach/);
  assert.match(result.stderr, /is the receiver running/);
  assert.doesNotMatch(result.stderr, /TypeError: fetch failed/, "leaked the raw fetch error");
});

test("send-test-event.mjs requires the signing secret", async () => {
  const result = await script("send-test-event.mjs", {});

  assert.equal(result.code, 1);
  assert.match(result.stderr, /MAILTEA_WEBHOOK_SECRET/);
});
