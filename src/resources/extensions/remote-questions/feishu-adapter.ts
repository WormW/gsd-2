/**
 * Remote Questions — Feishu (Lark) adapter
 *
 * Feishu uses app_id + app_secret to obtain a tenant_access_token.
 * All API calls are authenticated with Bearer <tenant_access_token>.
 */

import {
  type ChannelAdapter,
  type RemotePrompt,
  type RemoteDispatchResult,
  type RemoteAnswer,
  type RemotePromptRef,
} from "./types.js";
import { formatForFeishu, parseFeishuReply } from "./format.js";
import { apiRequest } from "./http-client.js";

const FEISHU_API = "https://open.feishu.cn/open-apis";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry

interface FeishuTokenResponse {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
}

export class FeishuAdapter implements ChannelAdapter {
  readonly name = "feishu" as const;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly chatId: string;
  private tenantAccessToken: string | null = null;
  private tokenExpiryAt = 0;
  private refreshPromise: Promise<string> | null = null;
  private lastReadMessageId: string | null = null;

  constructor(appId: string, appSecret: string, chatId: string) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.chatId = chatId;
  }

  async validate(): Promise<void> {
    const token = await this.getAccessToken();
    const res = await apiRequest(
      `${FEISHU_API}/bot/v3/info`,
      "GET",
      undefined,
      { authScheme: "Bearer", authToken: token, errorLabel: "Feishu Bot Info" },
    );
    this.checkFeishuResponse(res, "Bot info validation failed");
  }

  async sendPrompt(prompt: RemotePrompt): Promise<RemoteDispatchResult> {
    const token = await this.getAccessToken();
    const formattedText = formatForFeishu(prompt);

    const res = await apiRequest(
      `${FEISHU_API}/im/v1/messages?receive_id_type=chat_id`,
      "POST",
      {
        receive_id: this.chatId,
        msg_type: "text",
        content: JSON.stringify({ text: formattedText }),
      },
      {
        authScheme: "Bearer",
        authToken: token,
        errorLabel: "Feishu Send Message",
        contentType: "application/json; charset=utf-8",
      },
    );

    this.checkFeishuResponse(res, "Failed to send prompt");

    const messageId = res.data?.message_id;
    if (!messageId) throw new Error("Feishu send failed: missing message_id in response");

    return {
      ref: {
        id: prompt.id,
        channel: "feishu",
        messageId: String(messageId),
        channelId: this.chatId,
      },
    };
  }

  async pollAnswer(prompt: RemotePrompt, _ref: RemotePromptRef): Promise<RemoteAnswer | null> {
    const token = await this.getAccessToken();
    const url = `${FEISHU_API}/im/v1/messages?container_id_type=chat&container_id=${encodeURIComponent(this.chatId)}&page_size=20`;

    const res = await apiRequest(url, "GET", undefined, {
      authScheme: "Bearer",
      authToken: token,
      errorLabel: "Feishu Poll Messages",
    });

    this.checkFeishuResponse(res, "Failed to poll messages");

    const items = Array.isArray(res.data?.items) ? res.data.items : [];
    const userMessages = items.filter((msg: FeishuMessageItem) => msg.sender?.sender_type === "user");

    if (userMessages.length === 0) return null;

    // Process newest first, skip already-read messages
    for (const msg of userMessages) {
      if (this.lastReadMessageId && msg.message_id === this.lastReadMessageId) {
        continue;
      }
      this.lastReadMessageId = msg.message_id;

      let text = "";
      if (msg.body?.content) {
        try {
          const parsed = JSON.parse(msg.body.content);
          text = parsed.text ?? "";
        } catch {
          text = msg.body.content;
        }
      }

      if (text) {
        return parseFeishuReply(text, prompt.questions);
      }
    }

    return null;
  }

  async acknowledgeAnswer(ref: RemotePromptRef): Promise<void> {
    try {
      const token = await this.getAccessToken();
      await apiRequest(
        `${FEISHU_API}/im/v1/messages?receive_id_type=chat_id`,
        "POST",
        {
          receive_id: this.chatId,
          msg_type: "text",
          content: JSON.stringify({ text: "✅" }),
        },
        {
          authScheme: "Bearer",
          authToken: token,
          errorLabel: "Feishu Acknowledge",
          contentType: "application/json; charset=utf-8",
        },
      );
    } catch {
      // Best-effort — acknowledgement failures must not affect the flow
    }
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tenantAccessToken && this.tokenExpiryAt > now + 60000) {
      return this.tenantAccessToken;
    }

    // Concurrent refresh safety: only one request should fetch a new token
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.fetchAccessToken();
    try {
      const token = await this.refreshPromise;
      return token;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async fetchAccessToken(): Promise<string> {
    const res: FeishuTokenResponse = await apiRequest(
      `${FEISHU_API}/auth/v3/tenant_access_token/internal`,
      "POST",
      { app_id: this.appId, app_secret: this.appSecret },
      { errorLabel: "Feishu Auth", contentType: "application/json; charset=utf-8" },
    );

    if (res.code !== 0) {
      const msg = this.sanitizeError(res.msg ?? "Unknown auth error");
      throw new Error(`Feishu auth failed: ${msg} (code: ${res.code})`);
    }

    const token = res.tenant_access_token;
    if (!token) throw new Error("Feishu auth failed: missing tenant_access_token");

    this.tenantAccessToken = token;
    const expireSeconds = res.expire ?? 7200;
    this.tokenExpiryAt = Date.now() + Math.max(0, expireSeconds * 1000 - TOKEN_REFRESH_BUFFER_MS);

    return token;
  }

  private checkFeishuResponse(res: Record<string, unknown>, context: string): void {
    const code = res.code;
    if (typeof code !== "number" || code !== 0) {
      const msg = this.sanitizeError(String(res.msg ?? "unknown error"));
      throw new Error(`${context}: ${msg} (code: ${typeof code === "number" ? code : "unknown"})`);
    }
  }

  private sanitizeError(message: string): string {
    return message.replace(new RegExp(this.appSecret, "g"), "[REDACTED]");
  }
}

interface FeishuMessageItem {
  message_id: string;
  sender?: {
    sender_type?: string;
  };
  body?: {
    content?: string;
  };
}
