const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const site = process.env.ARC_WEB_URL;

if (!token || !secret || !site) {
  console.error("Set TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and ARC_WEB_URL in the deployment environment.");
  process.exit(1);
}

const base = new URL(site);
if (base.protocol !== "https:") {
  console.error("ARC_WEB_URL must use HTTPS.");
  process.exit(1);
}

const webhookUrl = new URL("/api/telegram/webhook", base).toString();
const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false
  }),
  cache: "no-store"
});

const result = await response.json();
if (!response.ok || !result.ok) {
  console.error("Telegram webhook registration failed:", result.description ?? response.statusText);
  process.exit(1);
}

console.log("Telegram webhook registered:", webhookUrl);
