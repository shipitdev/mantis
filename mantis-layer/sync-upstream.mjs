#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const upstream = "https://github.com/earendil-works/pi.git";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseArgs(args) {
	if (args.length !== 2 || args[0] !== "--tag" || !/^v\d+\.\d+\.\d+$/.test(args[1])) {
		throw new Error("Usage: node mantis-layer/sync-upstream.mjs --tag vN.N.N");
	}
	return { tag: args[1] };
}

function git(cwd, args, options = {}) {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function resolvedPath(candidate) {
	let existing = path.resolve(candidate);
	const missing = [];
	while (!existsSync(existing)) {
		missing.unshift(path.basename(existing));
		existing = path.dirname(existing);
	}
	return path.join(realpathSync(existing), ...missing);
}

function assertSafeOutputRoot(outputRoot, sourceRoot) {
	const source = realpathSync(sourceRoot);
	const output = resolvedPath(outputRoot);
	const relative = path.relative(source, output);
	if (relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
		throw new Error("Report output must be outside the source checkout");
	}
}

function reportFiles(outputRoot, report, status, diff = "") {
	mkdirSync(outputRoot, { recursive: true });
	writeFileSync(path.join(outputRoot, "sync-report.md"), report, "utf8");
	writeFileSync(path.join(outputRoot, "status.txt"), `${status}\n`, "utf8");
	writeFileSync(path.join(outputRoot, "candidate.diff"), diff, "utf8");
	if (!existsSync(path.join(outputRoot, "checks.log"))) writeFileSync(path.join(outputRoot, "checks.log"), "", "utf8");
}

function checkBoundary(candidate, tagSha, runner = execFileSync) {
	try {
		const stdout = runner("node", ["mantis-layer/check-upstream.mjs", "--base", tagSha], {
			cwd: candidate, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
		});
		return { passed: true, text: stdout.trim() };
	} catch (error) {
		return { passed: false, text: `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() || error.message };
	}
}

// upstreamUrl and gitEnv are test seams; the CLI always uses the official upstream above.
export function syncUpstream({ tag, sourceRoot = root, outputRoot = path.join(os.tmpdir(), `mantis-sync-${process.pid}`), upstreamUrl = upstream, gitEnv = process.env } = {}) {
	if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) throw new Error("Tag must match vN.N.N");
	assertSafeOutputRoot(outputRoot, sourceRoot);
	mkdirSync(outputRoot, { recursive: true });
	if (git(sourceRoot, ["status", "--porcelain"])) throw new Error("Source checkout has uncommitted changes; refusing to omit them from the sync report");
	const candidate = path.join(outputRoot, "candidate");
	git(sourceRoot, ["clone", "--no-hardlinks", sourceRoot, candidate]);
	git(candidate, ["remote", "add", "upstream", upstreamUrl]);
	git(candidate, ["fetch", "--no-tags", "upstream", `refs/tags/${tag}:refs/tags/upstream-${tag}`]);
	const tagSha = git(candidate, ["rev-parse", `refs/tags/upstream-${tag}^{commit}`]);
	const baseSha = git(candidate, ["rev-parse", "HEAD"]);
	let mergeText = "";
	let mergeSucceeded = true;
	try {
		mergeText = execFileSync("git", ["-c", "user.name=Mantis Sync Check", "-c", "user.email=sync-check@invalid", "merge", "--no-commit", "--no-ff", `refs/tags/upstream-${tag}`], {
			cwd: candidate, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv,
		});
	} catch (error) {
		mergeSucceeded = false;
		mergeText = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim() || error.message;
	}
	const conflictPaths = git(candidate, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
	const conflicts = conflictPaths.length > 0;
	const diff = git(candidate, ["diff", "HEAD", "--binary"]);
	const boundary = mergeSucceeded && !conflicts ? checkBoundary(candidate, tagSha) : { passed: false, text: "Not run because the merge did not complete cleanly." };
	const success = mergeSucceeded && !conflicts && boundary.passed;
	const status = JSON.stringify({ baseSha, tagSha, mergeSucceeded, conflicts, conflictPaths, boundaryPassed: boundary.passed, success }, null, 2) + "\n";
	const report = [
		"# Mantis upstream sync report", "", `- Mantis starting commit: \`${baseSha}\``, `- Upstream release tag: \`${tag}\``,
		`- Upstream tag commit: \`${tagSha}\``, `- Merge command: ${mergeSucceeded ? "succeeded" : "failed"}`,
		`- Merge conflicts: ${conflicts ? "yes" : "no"}`, `- Upstream boundary check: ${boundary.passed ? "passed" : "failed or not run"}`, "",
		"## Conflicts", "", ...(conflictPaths.length ? conflictPaths.map((file) => `- \`${file}\``) : ["None"]), "",
		"## Merge output", "", "```", mergeText, "```", "", "## Upstream boundary check", "", "```", boundary.text, "```", "",
		`To accept this update, set \`mantis-layer/upstream.json\` version/commit to \`${tag.slice(1)}\`/\`${tagSha}\` before the default boundary check.`,
		"The candidate remains uncommitted. No push, pull request, or release was created.", "",
	].join("\n");
	reportFiles(outputRoot, report, status, diff);
	writeFileSync(path.join(outputRoot, "sync.json"), JSON.stringify({ baseSha, tagSha, candidate, conflicts, success }, null, 2) + "\n", "utf8");
	return { baseSha, tagSha, candidate, outputRoot, mergeSucceeded, conflicts, conflictPaths, boundaryPassed: boundary.passed, success, report };
}

export function runCli(args, { sourceRoot = root, outputRoot = process.env.SYNC_REPORT_DIR ?? process.env.GITHUB_OUTPUT_DIR ?? path.join(os.tmpdir(), `mantis-sync-${process.pid}`) } = {}) {
	try {
		const { tag } = parseArgs(args);
		const result = syncUpstream({ tag, sourceRoot, outputRoot });
		return { status: result.success ? 0 : 1, report: result.report };
	} catch (error) {
		const report = `# Mantis upstream sync report\n\nSync preparation failed: ${error.message}\n`;
		try {
			assertSafeOutputRoot(outputRoot, sourceRoot);
			reportFiles(outputRoot, report, JSON.stringify({ success: false, error: error.message }, null, 2) + "\n");
		} catch {
			// Unsafe report paths must not write into the checkout.
		}
		return { status: 1, report, error };
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const result = runCli(process.argv.slice(2));
	if (result.status === 0) console.log(result.report);
	else {
		console.error(result.report);
		process.exitCode = result.status;
	}
}
