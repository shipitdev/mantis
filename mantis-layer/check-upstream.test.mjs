import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkUpstream } from "./check-upstream.mjs";

function fixture(t) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "mantis-upstream-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const run = (args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
	run(["init", "-q"]);
	run(["config", "user.name", "Test"]);
	run(["config", "user.email", "test@example.invalid"]);
	mkdirSync(path.join(dir, "mantis-layer"));
	writeFileSync(path.join(dir, "source.ts"), "upstream\n");
	writeFileSync(path.join(dir, ".gitignore"), "dist/\n");
	const manifest = {
		repository: "example/pi",
		version: "1.4.0",
		commit: "0".repeat(40),
		allowedModifiedPaths: { "source.ts": "fixture declared patch" },
		allowedNewPaths: ["mantis", "mantis-layer/", ".github/workflows/mantis-"]
	};
	writeFileSync(path.join(dir, "mantis-layer/upstream.json"), JSON.stringify(manifest));
	run(["add", "."]);
	run(["commit", "-qm", "baseline"]);
	manifest.commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
	writeFileSync(path.join(dir, "mantis-layer/upstream.json"), JSON.stringify(manifest));
	return { dir, run, manifest };
}

test("clean baseline passes; owned files and declared source patch pass", (t) => {
	const f = fixture(t);
	assert.deepEqual(checkUpstream({ repoRoot: f.dir }).denied, []);
	writeFileSync(path.join(f.dir, "mantis-layer/new-feature.mjs"), "export {};\n");
	writeFileSync(path.join(f.dir, "source.ts"), "Mantis patch\n");
	assert.deepEqual(checkUpstream({ repoRoot: f.dir }).denied, []);
});

test("unexpected edits, additions, and deletions are rejected", (t) => {
	const f = fixture(t);
	writeFileSync(path.join(f.dir, "source.ts"), "changed\n");
	writeFileSync(path.join(f.dir, "surprise.ts"), "new\n");
	assert.deepEqual(checkUpstream({ repoRoot: f.dir }).denied, ["surprise.ts"]);
	rmSync(path.join(f.dir, "source.ts"));
	assert.deepEqual(checkUpstream({ repoRoot: f.dir }).denied, ["source.ts", "surprise.ts"]);
});

test("tracked metadata edits and source renames into owned paths are rejected", (t) => {
	const f = fixture(t);
	writeFileSync(path.join(f.dir, ".gitignore"), "dist/\nchanged\n");
	assert.deepEqual(checkUpstream({ repoRoot: f.dir }).denied, [".gitignore"]);
	f.run(["mv", "source.ts", "mantis-layer/moved.ts"]);
	assert.deepEqual(checkUpstream({ repoRoot: f.dir }).denied, [".gitignore", "source.ts"]);
});

test("unresolved merge conflicts fail", (t) => {
	const f = fixture(t);
	const baseline = f.manifest.commit;
	f.run(["checkout", "-qb", "side"]);
	writeFileSync(path.join(f.dir, "source.ts"), "side\n");
	f.run(["commit", "-qam", "side edit"]);
	f.run(["checkout", "-q", "-B", "main", baseline]);
	writeFileSync(path.join(f.dir, "source.ts"), "main\n");
	f.run(["commit", "-qam", "main edit"]);
	assert.throws(() => f.run(["merge", "side"]));
	assert.throws(() => checkUpstream({ repoRoot: f.dir }), /Unresolved merge conflicts/);
});

test("ignored build output is excluded", (t) => {
	const f = fixture(t);
	mkdirSync(path.join(f.dir, "dist"));
	writeFileSync(path.join(f.dir, "dist/output.js"), "generated\n");
	assert.deepEqual(checkUpstream({ repoRoot: f.dir }).denied, []);
});

test("invalid or missing candidate baseline is rejected", (t) => {
	const f = fixture(t);
	assert.throws(() => checkUpstream({ repoRoot: f.dir, base: "HEAD" }), /full 40-character/);
	assert.throws(() => checkUpstream({ repoRoot: f.dir, base: "f".repeat(40) }), /unavailable/);
	f.manifest.allowedModifiedPaths = ["source.ts"];
	writeFileSync(path.join(f.dir, "mantis-layer/upstream.json"), JSON.stringify(f.manifest));
	assert.throws(() => checkUpstream({ repoRoot: f.dir }), /allowedModifiedPaths/);
});
