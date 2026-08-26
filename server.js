import { createApp } from "./app.js";

const signingSecret = process.env.MAILTEA_WEBHOOK_SECRET;
if (!signingSecret) {
  console.error("MAILTEA_WEBHOOK_SECRET is not set. Run `node subscribe.mjs` to create an endpoint and get one.");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);

createApp({ signingSecret }).listen(port, () => {
  console.log(`Listening for Mailtea webhooks on http://localhost:${port}/webhooks/mailtea`);
});
