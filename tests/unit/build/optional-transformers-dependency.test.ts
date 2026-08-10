import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = process.cwd();

function readJson<T = Record<string, unknown>>(relPath: string): T {
  return JSON.parse(readFileSync(join(repoRoot, relPath), "utf8")) as T;
}

test("@huggingface/transformers is a regular dependency so npm ci never skips it", () => {
  // #9962 deliberately moved @huggingface/transformers out of optionalDependencies:
  // as an optional dep, npm silently skipped the whole subtree on Node 24/26 (old
  // pin dragged onnxruntime-node@1.21.0 whose NAN build no longer compiles), which
  // broke `npm ci`/`next build` with "Can't resolve @huggingface/transformers"
  // (lazy import in src/lib/memory/embedding/transformersLocal.ts). As a regular
  // dep with onnxruntime-node@~1.24.3 (napi prebuilds, no node-gyp) it stays
  // installable and the memory embedding path requires() cleanly.
  const pkg = readJson<{
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  }>("package.json");

  assert.equal(
    pkg.dependencies?.["@huggingface/transformers"],
    "^4.2.0",
    "transformers must be a regular dependency (never optional) so npm ci cannot skip it"
  );
  assert.equal(pkg.optionalDependencies?.["@huggingface/transformers"], undefined);
});

test("transformers + onnxruntime-node are regular dependencies (not optional)", () => {
  const pkg = readJson<{
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  }>("package.json");

  assert.equal(
    pkg.dependencies?.["onnxruntime-node"],
    "~1.24.3",
    "onnxruntime-node is a regular dep (napi prebuilds, installable on Node 24/26)"
  );
  assert.equal(pkg.optionalDependencies?.["onnxruntime-node"], undefined);

  const lock = readJson<{
    packages: Record<string, { optional?: boolean; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>;
  }>("package-lock.json");

  assert.equal(
    lock.packages[""]?.dependencies?.["@huggingface/transformers"],
    "^4.2.0",
    "root lock dependencies must hold transformers as a regular (non-optional) dep"
  );
  // Optional flag is only written `true` for genuinely optional packages;
  // regular deps leave it absent/null. Assert each is NOT optional.
  assert.ok(!lock.packages["node_modules/@huggingface/transformers"]?.optional, "transformers must not be marked optional in the lockfile");
  assert.ok(!lock.packages["node_modules/onnxruntime-node"]?.optional, "onnxruntime-node must not be marked optional in the lockfile");
  assert.ok(!lock.packages["node_modules/onnxruntime-common"]?.optional, "onnxruntime-common must not be marked optional in the lockfile");
});
