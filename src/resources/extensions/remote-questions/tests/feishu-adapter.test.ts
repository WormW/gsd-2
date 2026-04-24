/**
 * Tests for FeishuAdapter.
 *
 * Framework: node:test + node:assert/strict
 *
 * Covers:
 *   - validate() success / failure
 *   - sendPrompt() dispatch
 *   - pollAnswer() parsing user replies
 *   - acknowledgeAnswer() best-effort
 *   - Token refresh behavior
 *   - Concurrent refresh deduplication
 *   - Error sanitization (app_secret redaction)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { FeishuAdapter } from "../feishu-adapter.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const APP_ID = "cli_testappid";
const APP_SECRET = "test_app_secret_value";
const CHAT_ID = "oc_testchatid";

interface MockCall {
  url: string;
  init: RequestInit;
}

type MockResponseFactory = (init: RequestInit) => Response | Promise<Response>;

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers(),
    redirected: false,
    type: "basic",
    url: "",
    clone: () => mockResponse(body, status),
    body: null,
    bodyUsed: false,
    arrayBuffer: async () => new ArrayBuffer(0),
    blob: async () => new Blob(),
    formData: async () => new FormData(),
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response;
}

function setupFetchMock(responses: Map<string, MockResponseFactory>): { calls: MockCall[]; reset: () => void } {
  const calls: MockCall[] = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    calls.push({ url: urlStr, init: init ?? {} });

    const baseUrl = urlStr.split("?")[0];
    const handler = responses.get(baseUrl) ?? responses.get(urlStr);
    if (handler) {
      return await handler(init ?? {});
    }

    return mockResponse({ code: 999, msg: "not found" }, 404);
  };

  return {
    calls,
    reset: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

function makeTokenResponse(token: string, expire = 7200): MockResponseFactory {
  return () => mockResponse({ code: 0, msg: "ok", tenant_access_token: token, expire });
}

function makeBotInfoResponse(): MockResponseFactory {
  return () => mockResponse({ code: 0, msg: "ok", data: { activate_status: 1, bot_name: "TestBot" } });
}

function makeSendMessageResponse(messageId: string): MockResponseFactory {
  return () => mockResponse({ code: 0, msg: "ok", data: { message_id: messageId } });
}

function makePollMessagesResponse(
  items: Array<{ message_id: string; sender?: { sender_type: string }; body?: { content: string } }>,
): MockResponseFactory {
  return () => mockResponse({ code: 0, msg: "ok", data: { items } });
}

function makeErrorResponse(code: number, msg: string): MockResponseFactory {
  return () => mockResponse({ code, msg, data: {} });
}

// ─── validate ────────────────────────────────────────────────────────────────

test("validate: success when token and bot info are valid", async () => {
  const responses = new Map<string, MockResponseFactory>([
    ["https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", makeTokenResponse("t-valid")],
    ["https://open.feishu.cn/open-apis/bot/v3/info", makeBotInfoResponse()],
  ]);
  const { reset } = setupFetchMock(responses);

  const adapter = new FeishuAdapter(APP_ID, APP_SECRET, CHAT_ID);
  await assert.doesNotReject(() => adapter.validate());

  reset();
});

test("validate: throws when auth returns non-zero code", async () => {
  const responses = new Map<string, MockResponseFactory>([
    ["https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", makeErrorResponse(99991, "Invalid app credentials")],
  ]);
  const { reset } = setupFetchMock(responses);

  const adapter = new FeishuAdapter(APP_ID, APP_SECRET, CHAT_ID);
  await assert.rejects(() => adapter.validate(), /Invalid app credentials/);

  reset();
});

test("validate: throws when bot info returns non-zero code", async () => {
  const responses = new Map<string, MockResponseFactory>([
    ["https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", makeTokenResponse("t-valid")],
    ["https://open.feishu.cn/open-apis/bot/v3/info", makeErrorResponse(1, "bot not found")],
  ]);
  const { reset } = setupFetchMock(responses);

  const adapter = new FeishuAdapter(APP_ID, APP_SECRET, CHAT_ID);
  await assert.rejects(() => adapter.validate(), /bot not found/);

  reset();
});

// ─── sendPrompt ──────────────────────────────────────────────────────────────

test("sendPrompt: dispatches formatted text and returns messageId", async () => {
  const responses = new Map<string, MockResponseFactory>([
    ["https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", makeTokenResponse("t-send")],
    ["https://open.feishu.cn/open-apis/im/v1/messages", makeSendMessageResponse("om_abc123")],
  ]);
  const { calls, reset } = setupFetchMock(responses);

  const adapter = new FeishuAdapter(APP_ID, APP_SECRET, CHAT_ID);
  const result = await adapter.sendPrompt({
    id: "prompt-1",
    channel: "feishu",
    createdAt: Date.now(),
    timeoutAt: Date.now() + 300_000,
    pollIntervalMs: 5000,
    questions: [
      {
        id: "q1",
        header: "Test Header",
        question: "Test Question",
        options: [{ label: "Yes", description: "Proceed" }, { label: "No", description: "Cancel" }],
        allowMultiple: false,
      },
    ],
  });

  assert.equal(result.ref.channel, "feishu");
  assert.equal(result.ref.messageId, "om_abc123");
  assert.equal(result.ref.channelId, CHAT_ID);

  // Verify the send request body
  const sendCall = calls.find((c) => c.url.includes("/im/v1/messages"));
  assert.ok(sendCall, "Expected send message call");
  const body = JSON.parse(String(sendCall?.init.body));
  assert.equal(body.receive_id, CHAT_ID);
  assert.equal(body.msg_type, "text");
  assert.equal(typeof body.content, "string");
  const content = JSON.parse(body.content);
  assert.ok(content.text.includes("Test Header"));

  reset();
});

test("sendPrompt: throws when Feishu returns error code", async () => {
  const responses = new Map<string, MockResponseFactory>([
    ["https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", makeTokenResponse("t-send")],
    ["https://open.feishu.cn/open-apis/im/v1/messages", makeErrorResponse(11232, "chat not found")],
  ]);
  const { reset } = setupFetchMock(responses);

  const adapter = new FeishuAdapter(APP_ID, APP_SECRET, CHAT_ID);
  await assert.rejects(
    () => adapter.sendPrompt({
      id: "prompt-err",
      channel: "feishu",
      createdAt: Date.now(),
      timeoutAt: Date.now() + 300_000,
      pollIntervalMs: 5000,
      questions: [],
    }),
    /chat not found/,
  );

  reset();
});

// ─── pollAnswer ──────────────────────────────────────────────────────────────

test("pollAnswer: returns null when no user messages", async () => {
  const responses = new Map<string, MockResponseFactory>([
    ["https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", makeTokenResponse("t-poll")],
    ["https://open.feishu.cn/open-apis/im/v1/messages", makePollMessagesResponse([])],
  ]);
  const { reset } = setupFetchMock(responses);

  const adapter = new FeishuAdapter(APP_ID, APP_SECRET, CHAT_ID);
  const answer = await adapter.pollAnswer(
    {
      id: "prompt-poll",
      channel: "feishu",
      createdAt: Date.now(),
      timeoutAt: Date.now() + 300_000,
      pollIntervalMs: 5000,
      questions: [
        {
          id: "q1",
          header: "H",
          question: "Q",
          options: [{ label: "A", description: "Option A" }],
          allowMultiple: false,
        },
      ],
    },
    { id: "prompt-poll", channel: "feishu", messageId: "om_1", channelId: CHAT_ID },
  );

  assert.equal(answer, null);

  reset();
});

test("pollAnswer: parses user text reply", async () => {
  const responses = new Map<string, MockResponseFactory>([
    ["https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", makeTokenResponse("t-poll")],
    [
      "https://open.feishu.cn/open-apis/im/v1/messages",
      makePollMessagesResponse([
        {
          message_id: "om_user_1",
          sender: { sender_type: "user" },
          body: { content: JSON.stringify({ text: "1" }) },
        },
      ]),
    ],
  ]);
  const { reset } = setupFetchMock(responses);

  const adapter = new FeishuAdapter(APP_ID, APP_SECRET, CHAT_ID);
  const answer = await adapter.pollAnswer(
    {
      id: "prompt-poll2",
      channel: "feishu",
      createdAt: Date.now(),
      timeoutAt: Date.now() + 300_000,
      pollIntervalMs: 5000,
      questions: [
        {
          id: "q1",
          header: "H",
          question: "Q",
          options: [{ label: "A", description: "Option A" }],
          allowMultiple: false,
        },
      ],
    },
    { id: "prompt-poll2", channel: "feishu", messageId: "om_1", channelId: CHAT_ID },
  );

  assert.ok(answer);
  assert.deepEqual(answer?.answers.q1, { answers: ["A"] });

  reset();
});

test("pollAnswer: skips bot messages and already-read messages", async () => {
  const responses = new Map<string, MockResponseFactory>([
    ["https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", makeTokenResponse("t-poll")],
    [
      "https://open.feishu.cn/open-apis/im/v1/messages",
      makePollMessagesResponse([
        {
          message_id: "om_bot_1",
          sender: { sender_type: "app" },
          body: { content: JSON.stringify({ text: "bot reply" }) },
        },
        {
          message_id: "om_user_old",
          sender: { sender_type: "user" },
          body: { content: JSON.stringify({ text: "1" }) },
        },
      ]),
    ],
  ]);
  const { reset } = setupFetchMock(responses);

  const adapter = new FeishuAdapter(APP_ID, APP_SECRET, CHAT_ID);

  // First poll: reads om_user_old
  const answer1 = await adapter.pollAnswer(
    {
      id: "prompt-poll3",
      channel: "feishu",
      createdAt: Date.now(),
      timeoutAt: Date.now() + 300_000,
      pollIntervalMs: 5000,
      questions: [
        {
          id: "q1",
          header: "H",
          question: "Q",
          options: [{ label: "Old", description: "Old option" }],
          allowMultiple: false,
        },
      ],
    },
    { id: "prompt-poll3", channel: "feishu", messageId: "om_1", channelId: CHAT_ID },
  );
  assert.ok(answer1);
  assert.deepEqual(answer1?.answers.q1, { answers: ["Old"] });

  // Second poll with same messages: returns null because om_user_old already read
  const answer2 = await adapter.pollAnswer(
    {
      id: "prompt-poll3",
      channel: "feishu",
      createdAt: Date.now(),
      timeoutAt: Date.now() + 300_000,
      pollIntervalMs: 5000,
      questions: [
        {
          id: "q1",
          header: "H",
          question: "Q",
          options: [{ label: "Old", description: "Old option" }],
          allowMultiple: false,
        },
      ],
    },
    { id: "prompt-poll3", channel: "feishu", messageId: "om_1", channelId: CHAT_ID },
  );
  assert.equal(answer2, null);

  reset();
});

// ─── acknowledgeAnswer ───────────────────────────────────────────────────────

test("acknowledgeAnswer: sends checkmark text without throwing", async () => {
  const responses = new Map<string, MockResponseFactory>([
    ["https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", makeTokenResponse("t-ack")],
    ["https://open.feishu.cn/open-apis/im/v1/messages", makeSendMessageResponse("om_ack")],
  ]);
  const { reset } = setupFetchMock(responses);

  const adapter = new FeishuAdapter(APP_ID, APP_SECRET, CHAT_ID);
  await assert.doesNotReject(() =>
    adapter.acknowledgeAnswer({ id: "p", channel: "feishu", messageId: "om_1", channelId: CHAT_ID }),
  );

  reset();
});

test("acknowledgeAnswer: swallows errors gracefully", async () => {
  const responses = new Map<string, MockResponseFactory>([
    ["https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", makeTokenResponse("t-ack")],
    ["https://open.feishu.cn/open-apis/im/v1/messages", makeErrorResponse(1, "fail")],
  ]);
  const { reset } = setupFetchMock(responses);

  const adapter = new FeishuAdapter(APP_ID, APP_SECRET, CHAT_ID);
  await assert.doesNotReject(() =>
    adapter.acknowledgeAnswer({ id: "p", channel: "feishu", messageId: "om_1", channelId: CHAT_ID }),
  );

  reset();
});

// ─── Token refresh ───────────────────────────────────────────────────────────

test("token refresh: reuses cached token when not expired", async () => {
  let authCalls = 0;
  const responses = new Map<string, MockResponseFactory>([
    [
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      () => {
        authCalls++;
        return mockResponse({ code: 0, msg: "ok", tenant_access_token: "t-reuse", expire: 7200 });
      },
    ],
    ["https://open.feishu.cn/open-apis/bot/v3/info", makeBotInfoResponse()],
  ]);
  const { reset } = setupFetchMock(responses);

  const adapter = new FeishuAdapter(APP_ID, APP_SECRET, CHAT_ID);
  await adapter.validate();
  await adapter.validate();

  assert.equal(authCalls, 1, "Expected only one auth call when token is cached");

  reset();
});

test("token refresh: fetches new token when expired", async () => {
  let authCalls = 0;
  const responses = new Map<string, MockResponseFactory>([
    [
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      () => {
        authCalls++;
        return mockResponse({ code: 0, msg: "ok", tenant_access_token: `t-${authCalls}`, expire: 2 });
      },
    ],
    ["https://open.feishu.cn/open-apis/bot/v3/info", makeBotInfoResponse()],
  ]);
  const { reset } = setupFetchMock(responses);

  const adapter = new FeishuAdapter(APP_ID, APP_SECRET, CHAT_ID);
  await adapter.validate(); // first auth

  await adapter.validate(); // should trigger second auth (token expired due to 2s expiry - 5min buffer)

  assert.equal(authCalls, 2, "Expected second auth call after token expiry");

  reset();
});

// ─── Concurrent refresh ──────────────────────────────────────────────────────

test("concurrent refresh: only one auth request when multiple calls race", async () => {
  let authCalls = 0;
  let resolveAuth!: () => void;
  const authPromise = new Promise<void>((resolve) => {
    resolveAuth = resolve;
  });

  const responses = new Map<string, MockResponseFactory>([
    [
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      async () => {
        authCalls++;
        await authPromise;
        return mockResponse({ code: 0, msg: "ok", tenant_access_token: "t-concurrent", expire: 7200 });
      },
    ],
    ["https://open.feishu.cn/open-apis/bot/v3/info", makeBotInfoResponse()],
  ]);
  const { reset } = setupFetchMock(responses);

  const adapter = new FeishuAdapter(APP_ID, APP_SECRET, CHAT_ID);

  // Force token to appear expired by manipulating internal state
  (adapter as unknown as Record<string, unknown>).tokenExpiryAt = 0;
  (adapter as unknown as Record<string, unknown>).tenantAccessToken = null;

  const p1 = adapter.validate();
  const p2 = adapter.validate();

  // Let the auth request complete
  resolveAuth();

  await Promise.all([p1, p2]);

  assert.equal(authCalls, 1, "Expected only one auth call during concurrent refresh");

  reset();
});

// ─── Error sanitization ──────────────────────────────────────────────────────

test("error sanitization: app_secret is redacted from thrown errors", async () => {
  const secret = "super_secret_12345";
  const responses = new Map<string, MockResponseFactory>([
    [
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      () => mockResponse({ code: 99991, msg: `Invalid app_id or app_secret: ${secret}` }),
    ],
  ]);
  const { reset } = setupFetchMock(responses);

  const adapter = new FeishuAdapter(APP_ID, secret, CHAT_ID);
  try {
    await adapter.validate();
    assert.fail("Expected validate to throw");
  } catch (err) {
    const msg = String((err as Error).message);
    assert.ok(!msg.includes(secret), `Expected secret to be redacted, got: ${msg}`);
    assert.ok(msg.includes("[REDACTED]"), "Expected [REDACTED] placeholder in error message");
  }

  reset();
});

test("error sanitization: app_secret is redacted from Feishu API errors", async () => {
  const secret = "leaked_secret_xyz";
  const responses = new Map<string, MockResponseFactory>([
    ["https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", makeTokenResponse("t-sani")],
    [
      "https://open.feishu.cn/open-apis/bot/v3/info",
      () => mockResponse({ code: 1, msg: `Internal error with secret ${secret}` }),
    ],
  ]);
  const { reset } = setupFetchMock(responses);

  const adapter = new FeishuAdapter(APP_ID, secret, CHAT_ID);
  try {
    await adapter.validate();
    assert.fail("Expected validate to throw");
  } catch (err) {
    const msg = String((err as Error).message);
    assert.ok(!msg.includes(secret), `Expected secret to be redacted, got: ${msg}`);
    assert.ok(msg.includes("[REDACTED]"), "Expected [REDACTED] placeholder in error message");
  }

  reset();
});
