import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hydratePinnedModels } from "./hydrate-models.mjs";

function fixture(bytes) {
	const repoRoot = mkdtempSync(path.join(os.tmpdir(), "mantis-catalog-test-"));
	mkdirSync(path.join(repoRoot, "nix"));
	const revision = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
	writeFileSync(path.join(repoRoot, "nix/model-catalog.json"), JSON.stringify({ revision }));
	return { repoRoot, revision };
}

test("hydrator requests the pinned revision and passes verified bytes to the existing hydrator", async (t) => {
	const bytes = Buffer.from("pinned catalog");
	const { repoRoot, revision } = fixture(bytes);
	t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
	let hydrated;
	const result = await hydratePinnedModels({
		repoRoot,
		fetchImpl: async (url, options) => {
			assert.equal(url, `https://pi.dev/api/models/revisions/${revision}?types=chat,image,classifier`);
			assert.ok(options.signal);
			return { ok: true, arrayBuffer: async () => bytes };
		},
		hydrate: (root, data) => { hydrated = { root, data }; },
	});
	assert.equal(result, revision);
	assert.deepEqual(hydrated, { root: repoRoot, data: bytes });
});

test("hydrator rejects an invalid pin, an HTTP failure, and bytes with the wrong hash", async (t) => {
	const bytes = Buffer.from("catalog");
	const { repoRoot } = fixture(bytes);
	t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
	let hydrated = false;
	await assert.rejects(() => hydratePinnedModels({ repoRoot, fetchImpl: async () => ({ ok: false, status: 503 }), hydrate: () => { hydrated = true; } }), /HTTP 503/);
	await assert.rejects(() => hydratePinnedModels({ repoRoot, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => Buffer.from("wrong") }), hydrate: () => { hydrated = true; } }), /hash mismatch/);
	writeFileSync(path.join(repoRoot, "nix/model-catalog.json"), JSON.stringify({ revision: "latest" }));
	await assert.rejects(() => hydratePinnedModels({ repoRoot, fetchImpl: async () => { throw new Error("must not fetch"); }, hydrate: () => { hydrated = true; } }), /Invalid pinned/);
	assert.equal(hydrated, false);
});
