import { describe, it } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../open-sse/executors/adapta-web.ts");

// The intermittent 401 healed itself on the next request: it was a stale cached session
// JWT, not a dead cookie. The executor now renews and repeats once, so the client never
// sees the transient failure.
describe("stale session JWT", () => {
  it("renews the JWT and retries once instead of surfacing the 401", async () => {
    const originalFetch = globalThis.fetch;
    const chatAuth: string[] = [];
    let tokenCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/client")) {
        return Response.json({ response: { sessions: [{ id: "sess-1", status: "active" }] } });
      }
      if (url.includes("/tokens")) {
        tokenCalls += 1;
        return Response.json({ jwt: `eyJ.token-${tokenCalls}.sig` });
      }
      const headers = (init?.headers ?? {}) as Record<string, string>;
      chatAuth.push(headers.Authorization ?? "");
      if (chatAuth.length === 1) {
        return new Response(JSON.stringify({ error: "invalid session" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        `data: ${JSON.stringify({ type: "text-delta", id: "1", delta: "ok" })}\n\n` +
          `data: ${JSON.stringify({ type: "done" })}\n\n`,
        { status: 200, headers: { "Content-Type": "text/event-stream" } }
      );
    }) as typeof fetch;

    try {
      const result = await new mod.AdaptaWebExecutor().execute({
        model: "adapta-one",
        stream: false,
        body: { messages: [{ role: "user", content: "hi" }] },
        credentials: { apiKey: "__client=unique-session-retry-cookie" },
        signal: null,
      });

      assert.equal(chatAuth.length, 2, "the chat call must be repeated once");
      assert.notEqual(chatAuth[0], chatAuth[1], "the retry must carry a fresh JWT");
      assert.equal(result.response.status, 200);
      const json = await result.response.json();
      assert.match(json.choices[0].message.content, /ok/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("still reports the 401 when the renewed token is rejected too", async () => {
    const originalFetch = globalThis.fetch;
    let chatCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/client")) {
        return Response.json({ response: { sessions: [{ id: "sess-1", status: "active" }] } });
      }
      if (url.includes("/tokens")) return Response.json({ jwt: "eyJ.always-rejected.sig" });
      chatCalls += 1;
      return new Response(JSON.stringify({ error: "invalid session" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const result = await new mod.AdaptaWebExecutor().execute({
        model: "adapta-one",
        stream: false,
        body: { messages: [{ role: "user", content: "hi" }] },
        credentials: { apiKey: "__client=unique-always-rejected-cookie" },
        signal: null,
      });
      assert.equal(chatCalls, 2, "exactly one retry, no loop");
      assert.equal(result.response.status, 401);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
