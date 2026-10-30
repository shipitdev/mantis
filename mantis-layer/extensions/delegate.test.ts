import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitSessionShutdownEvent } from "../../packages/coding-agent/src/core/extensions/runner.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import {
	createHarness,
	type Harness,
} from "../../packages/coding-agent/test/suite/harness.ts";
import delegate from "./delegate.ts";

describe("Mantis text delegation", () => {
	const harnesses: Harness[] = [];
	const dirs: string[] = [];
	const previousAgentDir = process.env.MANTIS_CODING_AGENT_DIR;
	const faux = registerFauxProvider({
		provider: "mantis-fake-one",
		models: [
			{ id: "reviewer", name: "Reviewer", reasoning: false },
			{ id: "editor", name: "Editor", reasoning: false },
		],
	});

	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
		if (previousAgentDir === undefined)
			delete process.env.MANTIS_CODING_AGENT_DIR;
		else process.env.MANTIS_CODING_AGENT_DIR = previousAgentDir;
		vi.restoreAllMocks();
		faux.setResponses([]);
	});

	async function setup() {
		const agentDir = mkdtempSync(join(tmpdir(), "mantis-delegate-test-"));
		dirs.push(agentDir);
		process.env.MANTIS_CODING_AGENT_DIR = agentDir;
		const create = ModelRuntime.create;
		const spy = vi
			.spyOn(ModelRuntime, "create")
			.mockImplementation(async (options) => {
				const runtime = await create.call(ModelRuntime, options);
				const providerConfig = {
					baseUrl: faux.getModel().baseUrl,
					apiKey: "offline-test-key",
					api: faux.api,
					models: faux.models.map(
						({
							id,
							name,
							api,
							reasoning,
							input,
							inputLimits,
							cost,
							contextWindow,
							maxTokens,
							baseUrl,
						}) => ({
							id,
							name,
							api,
							reasoning,
							input,
							inputLimits,
							cost,
							contextWindow,
							maxTokens,
							baseUrl,
						}),
					),
				};
				runtime.registerProvider("mantis-fake-one", providerConfig);
				runtime.registerProvider("mantis-fake-two", providerConfig);
				return runtime;
			});
		const harness = await createHarness({ extensionFactories: [delegate] });
		harnesses.push(harness);
		return { harness, spy };
	}

	function tool(harness: Harness) {
		const registered = harness.session.agent.state.tools.find(
			({ name }) => name === "mantis_delegate",
		);
		if (!registered) throw new Error("mantis_delegate tool was not registered");
		return registered;
	}

	it("requires explicit provider and model for the first worker", async () => {
		const { harness } = await setup();
		const result = await tool(harness).execute("call-1", {
			task: "Review this text.",
		});
		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("explicit provider and model"),
		});
	});

	it("returns an aborted error when the call signal was already cancelled", async () => {
		const { harness } = await setup();
		const controller = new AbortController();
		controller.abort();
		const result = await tool(harness).execute(
			"call-aborted",
			{ task: "Review.", provider: "mantis-fake-one", model: "reviewer" },
			controller.signal,
		);
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({ state: "idle", outcome: "aborted" });
	});

	it("runs the requested configured model and carries task history into follow-up", async () => {
		const { harness } = await setup();
		writeFileSync(
			join(harness.tempDir, "AGENTS.md"),
			"PROJECT_CONTEXT_SENTINEL",
		);
		const seen: string[][] = [];
		const seenToolNames: string[][] = [];
		faux.setResponses([
			(context) => {
				seen.push(context.messages.map((message) => JSON.stringify(message)));
				seenToolNames.push(
					context.messages.flatMap((message) =>
						message.role === "system"
							? (message.toolsAdded ?? []).map(
									(providerTool) => providerTool.name,
								)
							: [],
					),
				);
				return fauxAssistantMessage("First answer");
			},
			(context) => {
				seen.push(context.messages.map((message) => JSON.stringify(message)));
				return fauxAssistantMessage("Follow-up answer");
			},
		]);
		const delegation = tool(harness);
		const first = await delegation.execute("call-1", {
			task: "Check this sentence: The sky are blue.",
			provider: "mantis-fake-two",
			model: "editor",
		});
		expect(first.content[0]).toMatchObject({
			text: expect.stringContaining("First answer"),
		});
		expect(first.content[0]).toMatchObject({
			text: expect.stringContaining("mantis-fake-two/editor"),
		});
		expect(first.details).toMatchObject({
			provider: "mantis-fake-two",
			model: "editor",
			state: "idle",
			outcome: "success",
		});
		const workerId = (first.details as { workerId: string }).workerId;
		const second = await delegation.execute("call-2", {
			task: "Now explain the correction.",
			workerId,
		});
		expect(second.content[0]).toMatchObject({
			text: expect.stringContaining("Follow-up answer"),
		});
		expect(seen[1]?.join("\n")).toContain("The sky are blue.");
		expect(seen[1]?.join("\n")).toContain("Now explain the correction.");
		const firstContext = seen[0]?.join("\n") ?? "";
		expect(firstContext).not.toContain("toolsAdded");
		expect(firstContext).toContain("You have no tools");
		expect(firstContext).not.toContain("PROJECT_CONTEXT_SENTINEL");
		expect(seenToolNames[0]).toEqual([]);
		const agentDir = process.env.MANTIS_CODING_AGENT_DIR;
		expect(agentDir).toBeDefined();
		const workerDir = join(agentDir ?? "", "mantis-workers", workerId);
		expect(readdirSync(workerDir).some((name) => name.endsWith(".jsonl"))).toBe(
			true,
		);
	});

	it("reports provider failures without exposing provider error text", async () => {
		const { harness } = await setup();
		faux.setResponses([
			fauxAssistantMessage("secret-output", {
				stopReason: "error",
				errorMessage: "secret-provider-detail",
			}),
		]);
		const result = await tool(harness).execute("call-1", {
			task: "Review.",
			provider: "mantis-fake-one",
			model: "reviewer",
		});
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).not.toContain("secret-provider-detail");
		expect(JSON.stringify(result)).not.toContain("secret-output");
	});

	it("treats an assistant aborted response as aborted even when the caller signal is live", async () => {
		const { harness } = await setup();
		faux.setResponses([
			fauxAssistantMessage("partial answer", { stopReason: "aborted" }),
		]);
		const result = await tool(harness).execute(
			"call-provider-abort",
			{
				task: "Review.",
				provider: "mantis-fake-one",
				model: "reviewer",
			},
			new AbortController().signal,
		);
		expect(result.isError).toBe(true);
		expect(result.details).toMatchObject({
			state: "idle",
			outcome: "aborted",
			output: "",
		});
		expect(JSON.stringify(result)).not.toContain("partial answer");
	});

	it("returns an aborted result when an active faux request is cancelled", async () => {
		const { harness } = await setup();
		let markStarted = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let release = () => {};
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		faux.setResponses([
			async () => {
				markStarted();
				await blocked;
				return fauxAssistantMessage("late answer");
			},
		]);
		const controller = new AbortController();
		try {
			const pending = tool(harness).execute(
				"call-active-abort",
				{ task: "Review.", provider: "mantis-fake-one", model: "reviewer" },
				controller.signal,
			);
			await started;
			controller.abort();
			release();
			const result = await pending;
			expect(result.isError).toBe(true);
			expect(result.details).toMatchObject({
				state: "idle",
				outcome: "aborted",
			});
			expect(JSON.stringify(result)).not.toContain("late answer");
		} finally {
			release();
		}
	});

	it("does not publish a worker when the parent shuts down during worker creation", async () => {
		const { harness, spy } = await setup();
		const create = spy.getMockImplementation();
		if (!create) throw new Error("Expected the faux runtime factory wrapper");
		let markStarted = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let release = () => {};
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		spy.mockImplementation(async (options) => {
			markStarted();
			await blocked;
			return create(options);
		});
		try {
			const pending = tool(harness).execute("call-shutdown", {
				task: "Review.",
				provider: "mantis-fake-one",
				model: "reviewer",
			});
			await started;
			await emitSessionShutdownEvent(harness.session.extensionRunner, {
				type: "session_shutdown",
				reason: "quit",
			});
			release();
			const result = await pending;
			expect(result.isError).toBe(true);
			expect(result.content[0]).toMatchObject({
				text: expect.stringContaining("parent session changed"),
			});
			expect(result.details).toMatchObject({
				state: "idle",
				outcome: "aborted",
			});
			expect(JSON.stringify(result)).not.toContain("workerId:");
		} finally {
			release();
		}
	});

	it("does not publish a worker when the parent changes session tree during worker creation", async () => {
		const { harness, spy } = await setup();
		harness.faux.setResponses([fauxAssistantMessage("lead response")]);
		await harness.session.prompt("Lead history.");
		const branch = harness.sessionManager.getBranch();
		const firstEntry = branch[0];
		if (!firstEntry) throw new Error("Expected a parent session entry");
		const create = spy.getMockImplementation();
		if (!create) throw new Error("Expected the faux runtime factory wrapper");
		let markStarted = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let release = () => {};
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		spy.mockImplementation(async (options) => {
			markStarted();
			await blocked;
			return create(options);
		});
		try {
			const pending = tool(harness).execute("call-tree", {
				task: "Review.",
				provider: "mantis-fake-one",
				model: "reviewer",
			});
			await started;
			await harness.session.navigateTree(firstEntry.id);
			release();
			const result = await pending;
			expect(result.isError).toBe(true);
			expect(result.details).toMatchObject({
				state: "idle",
				outcome: "aborted",
			});
			expect(JSON.stringify(result)).not.toContain("workerId:");
		} finally {
			release();
		}
	});

	it("rejects unknown handles, changed identity, and a second worker", async () => {
		const { harness } = await setup();
		const delegation = tool(harness);
		const unknown = await delegation.execute("call-1", {
			task: "Continue",
			workerId: "missing",
		});
		expect(unknown.isError).toBe(true);
		faux.setResponses([fauxAssistantMessage("ready")]);
		const first = await delegation.execute("call-2", {
			task: "Review.",
			provider: "mantis-fake-one",
			model: "reviewer",
		});
		const workerId = (first.details as { workerId: string }).workerId;
		const changed = await delegation.execute("call-3", {
			task: "Continue",
			workerId,
			model: "editor",
		});
		expect(changed.isError).toBe(true);
		const second = await delegation.execute("call-4", {
			task: "Start another",
			provider: "mantis-fake-one",
			model: "editor",
		});
		expect(second.isError).toBe(true);
	});
});
