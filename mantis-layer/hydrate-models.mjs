#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { hydrateModelCatalogBytes } from "../scripts/update-model-catalog-pin.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const revisionPattern = /^sha256-[0-9a-f]{64}$/;

export async function hydratePinnedModels({ repoRoot = root, fetchImpl = fetch, hydrate = hydrateModelCatalogBytes } = {}) {
	const revision = JSON.parse(readFileSync(path.join(repoRoot, "nix/model-catalog.json"), "utf8")).revision;
	if (typeof revision !== "string" || !revisionPattern.test(revision)) throw new Error("Invalid pinned model catalog revision");
	const response = await fetchImpl(`https://pi.dev/api/models/revisions/${revision}?types=chat,image,classifier`, {
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error(`Pinned model catalog request failed: HTTP ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	const actual = `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
	if (actual !== revision) throw new Error(`Pinned model catalog hash mismatch: expected ${revision}, got ${actual}`);
	hydrate(repoRoot, bytes);
	return revision;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	console.log(`Hydrated pinned model catalog ${await hydratePinnedModels()}`);
}
