import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseArgs, runCli, syncUpstream } from "./sync-upstream.mjs";

const require = createRequire(import.meta.url);
const YAML = require("yaml");
const workflow = (name) => YAML.parse(readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"));

function command(cwd, args, env = {}) {
	return execFileSync(args[0], args.slice(1), { cwd, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture({ conflict = false, denied = false } = {}) {
	const temp = mkdtempSync(path.join(os.tmpdir(), "mantis-sync-test-"));
	const remote = path.join(temp, "upstream.git");
	const source = path.join(temp, "mantis");
	mkdirSync(remote);
	command(temp, ["git", "init", "--bare", remote]);
	mkdirSync(source);
	command(source, ["git", "init", "-b", "main"]);
	command(source, ["git", "config", "user.name", "Test"]);
	command(source, ["git", "config", "user.email", "test@example.com"]);
	command(source, ["git", "remote", "add", "origin", remote]);
	writeFileSync(path.join(source, "shared.txt"), "base\n");
	mkdirSync(path.join(source, "mantis-layer"));
	writeFileSync(path.join(source, "mantis-layer/upstream.json"), JSON.stringify({ commit: "0".repeat(40), allowedModifiedPaths: conflict ? { "shared.txt": "fixture" } : {}, allowedNewPaths: denied ? [] : ["mantis-layer/"] }));
	writeFileSync(path.join(source, "mantis-layer/check-upstream.mjs"), readFileSync(new URL("./check-upstream.mjs", import.meta.url)));
	command(source, ["git", "add", "."]);
	command(source, ["git", "commit", "-m", "upstream base"]);
	const base = command(source, ["git", "rev-parse", "HEAD"]);
	command(source, ["git", "push", "origin", "main"]);
	command(source, ["git", "clone", remote, path.join(temp, "upstream-work")]);
	const upstreamWork = path.join(temp, "upstream-work");
	command(upstreamWork, ["git", "config", "user.name", "Test"]);
	command(upstreamWork, ["git", "config", "user.email", "test@example.com"]);
	command(upstreamWork, ["git", "checkout", base]);
	writeFileSync(path.join(upstreamWork, conflict ? "shared.txt" : "upstream.txt"), conflict ? "upstream edit\n" : "release content\n");
	command(upstreamWork, ["git", "add", "."]);
	command(upstreamWork, ["git", "commit", "-m", "release change"]);
	command(upstreamWork, ["git", "tag", "v1.0.0"]);
	command(upstreamWork, ["git", "push", "origin", "HEAD:main", "refs/tags/v1.0.0"]);
	command(source, ["git", "checkout", "-b", "mantis"]);
	writeFileSync(path.join(source, conflict ? "shared.txt" : "mantis-layer/local-note"), conflict ? "Mantis edit\n" : "local customization\n");
	command(source, ["git", "add", "."]);
	command(source, ["git", "commit", "-m", "Mantis customization"]);
	return { temp, remote, source };
}

test("sync accepts only stable release tags", () => {
	assert.deepEqual(parseArgs(["--tag", "v1.4.0"]), { tag: "v1.4.0" });
	for (const args of [["--tag", "main"], ["--tag", "v1.4.0-rc.1"], ["--tag", "v1.4"], ["--tag", "v1.4.0;echo bad"], ["--remote", "https://example.com"]]) {
		assert.throws(() => parseArgs(args), /Usage:/);
	}
});

test("sync records an uncommitted clean merge and boundary pass", (t) => {
	const f = fixture();
	t.after(() => rmSync(f.temp, { recursive: true, force: true }));
	const result = syncUpstream({ tag: "v1.0.0", sourceRoot: f.source, outputRoot: path.join(f.temp, "report"), upstreamUrl: f.remote });
	assert.equal(result.success, true);
	assert.equal(result.mergeSucceeded, true);
	assert.equal(result.boundaryPassed, true);
	assert.match(readFileSync(path.join(result.outputRoot, "candidate.diff"), "utf8"), /release content/);
	assert.equal(command(result.candidate, ["git", "status", "--porcelain"]).length > 0, true);
});

test("sync reports text conflicts and fails", (t) => {
	const f = fixture({ conflict: true });
	t.after(() => rmSync(f.temp, { recursive: true, force: true }));
	const result = syncUpstream({ tag: "v1.0.0", sourceRoot: f.source, outputRoot: path.join(f.temp, "report"), upstreamUrl: f.remote });
	assert.equal(result.success, false);
	assert.deepEqual(result.conflictPaths, ["shared.txt"]);
});

test("sync fails on a non-conflict merge error", (t) => {
	const f = fixture();
	t.after(() => rmSync(f.temp, { recursive: true, force: true }));
	const env = { ...process.env, GIT_INDEX_FILE: path.join(f.temp, "missing-directory", "index") };
	const result = syncUpstream({ tag: "v1.0.0", sourceRoot: f.source, outputRoot: path.join(f.temp, "report"), upstreamUrl: f.remote, gitEnv: env });
	assert.equal(result.mergeSucceeded, false);
	assert.deepEqual(result.conflictPaths, []);
	assert.equal(result.success, false);
});

test("sync reports a boundary failure", (t) => {
	const f = fixture({ denied: true });
	t.after(() => rmSync(f.temp, { recursive: true, force: true }));
	const result = syncUpstream({ tag: "v1.0.0", sourceRoot: f.source, outputRoot: path.join(f.temp, "report"), upstreamUrl: f.remote });
	assert.equal(result.mergeSucceeded, true);
	assert.equal(result.boundaryPassed, false);
	assert.equal(result.success, false);
});

test("sync refuses a dirty source without changing it", (t) => {
	const f = fixture();
	t.after(() => rmSync(f.temp, { recursive: true, force: true }));
	writeFileSync(path.join(f.source, "uncommitted"), "local edit");
	assert.throws(() => syncUpstream({ tag: "v1.0.0", sourceRoot: f.source, outputRoot: path.join(f.temp, "report"), upstreamUrl: f.remote }), /uncommitted changes/);
	assert.equal(readFileSync(path.join(f.source, "uncommitted"), "utf8"), "local edit");
});

test("sync refuses output paths inside the source before creating them", (t) => {
	const f = fixture();
	t.after(() => rmSync(f.temp, { recursive: true, force: true }));
	const outputRoot = path.join(f.source, "mantis-layer", "report");
	const before = command(f.source, ["git", "status", "--porcelain"]);
	assert.throws(() => syncUpstream({ tag: "v1.0.0", sourceRoot: f.source, outputRoot, upstreamUrl: f.remote }), /outside the source checkout/);
	assert.equal(existsSync(outputRoot), false);
	assert.equal(command(f.source, ["git", "status", "--porcelain"]), before);
});

test("sync rejects an output symlink that resolves into the source", (t) => {
	const f = fixture();
	t.after(() => rmSync(f.temp, { recursive: true, force: true }));
	const alias = path.join(f.temp, "source-alias");
	symlinkSync(f.source, alias);
	const outputRoot = path.join(alias, "report");
	assert.throws(() => syncUpstream({ tag: "v1.0.0", sourceRoot: f.source, outputRoot, upstreamUrl: f.remote }), /outside the source checkout/);
	assert.equal(existsSync(path.join(f.source, "report")), false);
});

test("CLI error handling does not write to an unsafe report path", (t) => {
	const f = fixture();
	t.after(() => rmSync(f.temp, { recursive: true, force: true }));
	const outputRoot = path.join(f.source, "mantis-layer", "unsafe-report");
	const original = process.env.SYNC_REPORT_DIR;
	process.env.SYNC_REPORT_DIR = outputRoot;
	try {
		const result = runCli(["--tag", "v1.0.0"], { sourceRoot: f.source });
		assert.equal(result.status, 1);
		assert.match(result.report, /Report output must be outside/);
	} finally {
		if (original === undefined) delete process.env.SYNC_REPORT_DIR;
		else process.env.SYNC_REPORT_DIR = original;
	}
	assert.equal(existsSync(outputRoot), false);
});

test("CI workflows keep read-only permissions, full history, and package-local tests", () => {
	const check = workflow("mantis-check.yml");
	assert.equal(check.permissions.contents, "read");
	assert.ok(check.on.workflow_dispatch);
	assert.equal(check.jobs.check["timeout-minutes"], 30);
	assert.equal(check.jobs.check.steps.find((step) => step.name === "Checkout").with["fetch-depth"], 0);
	const focused = check.jobs.check.steps.find((step) => step.name === "Run focused tests").run;
	assert.match(focused, /node --test mantis-layer\/\*\.test\.mjs/);
	assert.match(focused, /cd packages\/coding-agent/);
	assert.match(focused, /node \.\.\/\.\.\/node_modules\/vitest/);
});

test("sync report workflow shares its report directory and uploads only report files", () => {
	const sync = workflow("mantis-upstream.yml");
	assert.equal(sync.permissions.contents, "read");
	assert.equal(sync.jobs.report["timeout-minutes"], 30);
	const steps = sync.jobs.report.steps;
	const validate = steps.find((step) => step.name === "Validate release tag");
	const create = steps.find((step) => step.name === "Create sync report");
	assert.equal(validate.env.SYNC_REPORT_DIR, "${{ runner.temp }}/mantis-sync-report");
	assert.equal(create.env.SYNC_REPORT_DIR, validate.env.SYNC_REPORT_DIR);
	assert.match(steps.find((step) => step.name === "Record candidate check results").run, /mkdir -p "\$SYNC_REPORT_DIR"/);
	const artifact = steps.find((step) => step.name === "Upload report and candidate diff");
	assert.equal(artifact.if, "always()");
	assert.match(artifact.with.path, /sync-report\.md/);
	assert.match(artifact.with.path, /candidate\.diff/);
	assert.match(artifact.with.path, /checks\.log/);
	assert.doesNotMatch(artifact.with.path, /candidate\/|node_modules|\.git/);
});
