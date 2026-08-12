import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { RadarFeedSchema } from "../../src/lib/radar/feedSchema.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/radar-feed-canonical.json", import.meta.url), "utf8")
) as Record<string, unknown>;

test("canonical fixture carries D25 localized setup and accepts localized quirks", () => {
  const localized = structuredClone(fixture) as {
    models: Array<{ setup: { steps: unknown[] } | null }>;
    quirks: Array<{ title: unknown; body: unknown }>;
  };
  localized.quirks = [
    {
      slug: "shared-pool",
      title: { en: "Shared quota", pt: "Cota compartilhada" },
      body: { en: "Models share one pool." },
      severity: "info",
      targets: [{ provider: "groq", modelGlob: null }],
    },
  ];
  const parsed = RadarFeedSchema.parse(localized);
  assert.deepEqual(parsed.models[0]!.setup!.steps[0], {
    en: "Create a free account in the Groq console",
    pt: "Crie uma conta gratuita no console da Groq",
  });
});

test("RadarFeedSchema preserves schema-v1 legacy setup and quirk strings", () => {
  const legacy = structuredClone(fixture) as {
    models: Array<{ setup: { steps: unknown[] } | null }>;
    quirks: Array<{ title: unknown; body: unknown }>;
  };
  legacy.models[0]!.setup!.steps[0] = "Create an account";
  legacy.quirks[0]!.title = "Shared quota";
  legacy.quirks[0]!.body = "Models share one pool.";

  const parsed = RadarFeedSchema.parse(legacy);
  assert.equal(parsed.models[0]!.setup!.steps[0], "Create an account");
  assert.equal(parsed.quirks[0]!.title, "Shared quota");
  assert.equal(parsed.quirks[0]!.body, "Models share one pool.");
});
