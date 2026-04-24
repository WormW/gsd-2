/**
 * Remote Notifications — one-way alert delivery to configured channels.
 *
 * Sends informational messages to Slack/Discord/Telegram without expecting
 * a reply. Used for auto-mode events like secrets-required pauses where
 * the user needs to be notified but should NOT send sensitive data back
 * through the channel.
 */

import { resolveRemoteConfig } from "./config.js";
import type { ResolvedConfig } from "./config.js";
import { PER_REQUEST_TIMEOUT_MS } from "./types.js";

const FEISHU_API = "https://open.feishu.cn/open-apis";

/**
 * Send a one-way notification to the configured remote channel.
 * Non-blocking, non-fatal — failures are silently ignored.
 *
 * SECURITY: This is intentionally one-way. Never use remote channels
 * to collect secrets or sensitive values.
 */
export async function sendRemoteNotification(title: string, message: string): Promise<void> {
  let config: ResolvedConfig | null;
  try {
    config = resolveRemoteConfig();
  } catch {
    return; // Remote not configured — skip silently
  }
  if (!config) return;

  try {
    switch (config.channel) {
      case "slack":
        await sendSlackNotification(config, title, message);
        break;
      case "discord":
        await sendDiscordNotification(config, title, message);
        break;
      case "telegram":
        await sendTelegramNotification(config, title, message);
        break;
      case "feishu":
        await sendFeishuNotification(config, title, message);
        break;
    }
  } catch {
    // Non-fatal — remote notifications are best-effort
  }
}

async function sendSlackNotification(config: ResolvedConfig, title: string, message: string): Promise<void> {
  const response = await fetch(`https://slack.com/api/chat.postMessage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: config.channelId,
      text: `⚠️ *${title}*\n${message}`,
    }),
    signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Slack HTTP ${response.status}`);
}

async function sendDiscordNotification(config: ResolvedConfig, title: string, message: string): Promise<void> {
  const response = await fetch(`https://discord.com/api/v10/channels/${config.channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: `⚠️ **${title}**\n${message}`,
    }),
    signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Discord HTTP ${response.status}`);
}

async function sendTelegramNotification(config: ResolvedConfig, title: string, message: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: config.channelId,
      text: `⚠️ *${title}*\n${message}`,
      parse_mode: "Markdown",
    }),
    signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
}

async function sendFeishuNotification(config: ResolvedConfig, title: string, message: string): Promise<void> {
  const tokenRes = await fetch(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: config.token, app_secret: config.appSecret }),
    signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
  });
  if (!tokenRes.ok) throw new Error(`Feishu auth HTTP ${tokenRes.status}`);

  const tokenData = (await tokenRes.json().catch(() => ({}))) as { code?: number; tenant_access_token?: string };
  if (tokenData.code !== 0 || !tokenData.tenant_access_token) {
    throw new Error("Feishu auth failed: could not obtain tenant_access_token");
  }

  const response = await fetch(`${FEISHU_API}/im/v1/messages?receive_id_type=chat_id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenData.tenant_access_token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      receive_id: config.channelId,
      msg_type: "text",
      content: JSON.stringify({ text: `⚠️ ${title}\n${message}` }),
    }),
    signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Feishu HTTP ${response.status}`);
}
