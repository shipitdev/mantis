#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function pathsFrom(buffer) {
	return buffer.toString("utf8").split("\0").filter(Boolean);
}

function isAllowedNewPath(file, prefixes) {
	return prefixes.some((prefix) => prefix.endsWith("/") || prefix.endsWith("-") ? file.startsWith(prefix) : file === prefix);
}

export function checkUpstream({ base, repoRoot = root } = {}) {
	const manifest = JSON.parse(readFileSync(path.join(repoRoot, "mantis-layer/upstream.json"), "utf8"));
	if (!/^[0-9a-f]{40}$/.test(manifest.commit)) throw new Error("Manifest commit must be a full 40-character Git SHA");
	if (!manifest.allowedModifiedPaths || typeof manifest.allowedModifiedPaths !== "object" || Array.isArray(manifest.allowedModifiedPaths) || Object.values(manifest.allowedModifiedPaths).some((reason) => typeof reason !== "string" || !reason.trim())) {
		throw new Error("Manifest allowedModifiedPaths must map paths to nonempty reasons");
	}
	if (!Array.isArray(manifest.allowedNewPaths) || manifest.allowedNewPaths.some((prefix) => typeof prefix !== "string" || !prefix)) {
		throw new Error("Manifest allowedNewPaths must contain nonempty path prefixes");
	}
	if (base !== undefined && !/^[0-9a-f]{40}$/.test(base)) throw new Error("--base must be a full 40-character Git SHA");
	const gitAtRoot = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: null, stdio: ["ignore", "pipe", "pipe"] });
	const baseline = base ?? manifest.commit;
	try {
		gitAtRoot(["cat-file", "-e", `${baseline}^{commit}`]);
	} catch {
		throw new Error(`Baseline commit is unavailable: ${baseline}`);
	}
	const conflicts = pathsFrom(gitAtRoot(["ls-files", "-u", "-z"]));
	if (conflicts.length) throw new Error(`Unresolved merge conflicts: ${conflicts.join(", ")}`);
	const diff = pathsFrom(gitAtRoot(["diff", "--name-status", "-z", baseline, "--"]));
	const deleted = new Set();
	const changed = new Set();
	for (let i = 0; i < diff.length;) {
		const status = diff[i++];
		const count = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
		const files = diff.slice(i, i + count);
		i += count;
		for (const file of files) changed.add(file);
		if (status === "D" || status.startsWith("R")) deleted.add(files[0]);
	}
	for (const file of pathsFrom(gitAtRoot(["ls-files", "--others", "--exclude-standard", "-z"]))) changed.add(file);
	const denied = [...changed].filter((file) => {
		if (deleted.has(file)) return true;
		if (Object.hasOwn(manifest.allowedModifiedPaths, file)) return false;
		return !isAllowedNewPath(file, manifest.allowedNewPaths);
	});
	return { baseline, changed: [...changed].sort(), denied: denied.sort() };
}

function main(args) {
	let base;
	if (args.length) {
		if (args.length !== 2 || args[0] !== "--base") throw new Error("Usage: node mantis-layer/check-upstream.mjs [--base <full-commit-sha>]");
		base = args[1];
	}
	const result = checkUpstream({ base });
	if (result.denied.length) {
		console.error(`Upstream boundary check failed against ${result.baseline}:`);
		for (const file of result.denied) console.error(`  ${file}: outside allowed Mantis paths and declared upstream edits`);
		process.exitCode = 1;
	} else {
		console.log(`Upstream boundary check passed against ${result.baseline} (${result.changed.length} changed path${result.changed.length === 1 ? "" : "s"}).`);
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(`Upstream boundary check failed: ${error.message}`);
		process.exitCode = 1;
	}
}
