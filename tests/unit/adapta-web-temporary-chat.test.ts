import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { resolveIsTemporaryChat } =
  await import("../../open-sse/executors/adapta-web/temporaryChat.ts");

describe("resolveIsTemporaryChat", () => {
  it("defaults to temporary so iteration does not pollute the upstream history", () => {
    assert.equal(resolveIsTemporaryChat({}), true);
  });

  it("allows an explicit opt-in under provider_options", () => {
    assert.equal(
      resolveIsTemporaryChat({ provider_options: { adapta: { isTemporaryChat: false } } }),
      false
    );
    assert.equal(
      resolveIsTemporaryChat({ provider_options: { "adapta-web": { isTemporaryChat: false } } }),
      false
    );
  });

  it("allows an explicit opt-out back to temporary", () => {
    assert.equal(
      resolveIsTemporaryChat({ provider_options: { adapta: { isTemporaryChat: true } } }),
      true
    );
  });

  it("ignores malformed provider_options", () => {
    assert.equal(resolveIsTemporaryChat({ provider_options: "nope" }), true);
    assert.equal(resolveIsTemporaryChat({ provider_options: { adapta: 42 } }), true);
  });
});
