import { describe, it } from "node:test";
import assert from "node:assert/strict";

const mod = await import("../../open-sse/executors/adapta-web.ts");

describe("redactUpstreamText", () => {
  it("removes the cookie value and JWT-looking tokens", () => {
    const raw =
      '{"error":"bad","cookie":"__client=eyJhbGciOiJSUzI1NiJ9.abc.def","auth":"Bearer abcdef1234567890xyz"}';
    const out = mod.redactUpstreamText(raw);
    assert.doesNotMatch(out, /__client=eyJ/);
    assert.doesNotMatch(out, /Bearer abcdef/);
    assert.match(out, /__client=<redacted>/);
  });
});

describe("upstream debug capture", () => {
  it("logs the upstream 401 body only when the opt-in flag is set", async () => {
    const originalFetch = globalThis.fetch;
    const warns: string[] = [];
    const log = {
      info: () => undefined,
      warn: (_tag: string, message: string) => warns.push(message),
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/client")) {
        return Response.json({ response: { sessions: [{ id: "sess-1", status: "active" }] } });
      }
      if (url.includes("/tokens")) return Response.json({ jwt: "eyJ.debug.jwt" });
      return new Response(JSON.stringify({ error: "session_revoked" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      process.env.OMNIROUTE_ADAPTA_DEBUG_UPSTREAM = "1";
      const result = await new mod.AdaptaWebExecutor().execute({
        model: "adapta-one",
        stream: false,
        body: { messages: [{ role: "user", content: "hi" }] },
        credentials: { apiKey: "__client=unique-debug-capture-cookie" },
        signal: null,
        log,
      });
      assert.equal(result.response.status, 401);
      const captured = warns.find((w) => w.includes("session_revoked"));
      assert.ok(captured, `expected the upstream body in the debug log, got: ${warns.join(" | ")}`);

      warns.length = 0;
      delete process.env.OMNIROUTE_ADAPTA_DEBUG_UPSTREAM;
      await new mod.AdaptaWebExecutor().execute({
        model: "adapta-one",
        stream: false,
        body: { messages: [{ role: "user", content: "hi" }] },
        credentials: { apiKey: "__client=unique-debug-off-cookie" },
        signal: null,
        log,
      });
      assert.equal(
        warns.some((w) => w.includes("session_revoked")),
        false,
        "must be opt-in"
      );
    } finally {
      delete process.env.OMNIROUTE_ADAPTA_DEBUG_UPSTREAM;
      globalThis.fetch = originalFetch;
    }
  });
});
