import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
	createAgentSession,
	createExtensionRuntime,
	type ExtensionAPI,
	getAgentDir,
	ModelRuntime,
	type ResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ENTRY_TYPE = "mantis_delegate";
const MAX_OUTPUT_LENGTH = 12_000;

interface WorkerRef {
	id: string;
	provider: string;
	model: string;
	session: Awaited<ReturnType<typeof createAgentSession>>["session"];
}

type WorkerOutcome = "success" | "error" | "aborted";

function textResult<T>(text: string, details: T, isError = true) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		...(isError ? { isError: true as const } : {}),
	};
}

function workerResult(
	worker: WorkerRef,
	state: "idle" | "running",
	outcome: WorkerOutcome | undefined,
	output: string,
) {
	const header = `workerId: ${worker.id} | ${worker.provider}/${worker.model} | state: ${state}${outcome ? ` | outcome: ${outcome}` : ""}`;
	return textResult(
		`${header}\n\n${output}`,
		{
			workerId: worker.id,
			provider: worker.provider,
			model: worker.model,
			state,
			...(outcome ? { outcome } : {}),
			output: outcome === "success" ? output : "",
		},
		state === "running" || outcome === "error" || outcome === "aborted",
	);
}

const resourceLoader: ResourceLoader = {
	getExtensions: () => ({
		extensions: [],
		errors: [],
		runtime: createExtensionRuntime(),
	}),
	getSkills: () => ({ skills: [], diagnostics: [] }),
	getPrompts: () => ({ prompts: [], diagnostics: [] }),
	getThemes: () => ({ themes: [], diagnostics: [] }),
	getAgentsFiles: () => ({ agentsFiles: [] }),
	getSystemPrompt: () =>
		"Complete the lead's text task using only the text included in the task. You have no tools.",
	getSystemPromptSource: () => undefined,
	getAppendSystemPrompt: () => [],
	getAppendSystemPromptSources: () => [],
	extendResources: () => {},
	reload: async () => {},
};

export default function (pi: ExtensionAPI) {
	let worker: WorkerRef | undefined;
	let starting = false;
	let working = false;
	let closed = false;
	let generation = 0;
	let resolveActiveWait: (() => void) | undefined;

	const disposeWorker = () => {
		generation++;
		resolveActiveWait?.();
		resolveActiveWait = undefined;
		worker?.session.dispose();
		worker = undefined;
		working = false;
	};

	pi.on("session_shutdown", () => {
		closed = true;
		disposeWorker();
	});
	pi.on("session_tree", disposeWorker);
	pi.on("session_before_fork", disposeWorker);

	pi.registerTool({
		name: "mantis_delegate",
		label: "Delegate text task",
		description:
			"Ask one configured provider/model to review or transform text supplied in the task. The worker has no tools, extensions, skills, or project context files. Use workerId to continue its saved conversation in this Mantis session.",
		parameters: Type.Object({
			task: Type.String({
				description:
					"Text task, including any excerpts or context the worker needs",
			}),
			provider: Type.Optional(
				Type.String({
					description:
						"Exact configured provider ID; required for a new worker",
				}),
			),
			model: Type.Optional(
				Type.String({
					description: "Exact configured model ID; required for a new worker",
				}),
			),
			workerId: Type.Optional(
				Type.String({
					description: "ID returned by an earlier delegation in this session",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const provider = params.provider;
			const modelId = params.model;
			if (!params.task.trim()) {
				return textResult("Task text must not be empty.", {
					state: "idle",
					outcome: "error",
				});
			}
			if (closed) {
				return textResult("The parent session is closing.", {
					state: "idle",
					outcome: "aborted",
				});
			}
			if (signal?.aborted) {
				return textResult("Delegation aborted before starting.", {
					state: "idle",
					outcome: "aborted",
				});
			}

			if (params.workerId) {
				if (!worker || worker.id !== params.workerId) {
					return textResult(
						`Unknown or inactive workerId: ${params.workerId}`,
						{ workerId: params.workerId, state: "idle", outcome: "error" },
					);
				}
				if (
					(params.provider && params.provider !== worker.provider) ||
					(params.model && params.model !== worker.model)
				) {
					return workerResult(
						worker,
						"idle",
						"error",
						"A worker's provider and model cannot be changed.",
					);
				}
				if (!worker.session.isIdle || working) {
					return workerResult(
						worker,
						"running",
						undefined,
						"This worker is already processing a task.",
					);
				}
			} else if (worker || starting) {
				return textResult(
					"This session already owns a worker. Continue it with workerId.",
					{ workerId: worker?.id, state: "idle", outcome: "error" },
				);
			}

			if (!params.workerId && (!params.provider || !params.model)) {
				return textResult(
					"A new worker requires explicit provider and model IDs.",
					{ state: "idle", outcome: "error" },
				);
			}

			let active = worker;
			if (!params.workerId) {
				starting = true;
				const startGeneration = generation;
				let createdSession: WorkerRef["session"] | undefined;
				try {
					const agentDir = getAgentDir();
					const runtime = await ModelRuntime.create({
						authPath: join(agentDir, "auth.json"),
						modelsPath: join(agentDir, "models.json"),
						refreshOnCreate: false,
					});
					if (closed || generation !== startGeneration)
						return textResult(
							"Delegation canceled because the parent session changed.",
							{ state: "idle", outcome: "aborted" },
						);
					if (!provider || !modelId) {
						return textResult(
							"A new worker requires explicit provider and model IDs.",
							{ state: "idle", outcome: "error" },
						);
					}
					const model = runtime.getModel(provider, modelId);
					if (!model) {
						return textResult(
							`Model ${provider}/${modelId} is not available from Pi's configured providers/models.`,
							{ state: "idle", outcome: "error" },
						);
					}
					if (!runtime.hasConfiguredAuth(model.provider)) {
						return textResult(
							`No configured authentication for provider ${model.provider}.`,
							{ state: "idle", outcome: "error" },
						);
					}
					if (closed || generation !== startGeneration)
						return textResult(
							"Delegation canceled because the parent session changed.",
							{ state: "idle", outcome: "aborted" },
						);

					const id = randomUUID();
					const { session } = await createAgentSession({
						cwd: ctx.cwd,
						agentDir,
						model,
						modelRuntime: runtime,
						resourceLoader,
						settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
						sessionManager: SessionManager.create(
							ctx.cwd,
							join(agentDir, "mantis-workers", id),
						),
						tools: [],
						noTools: "all",
					});
					createdSession = session;
					if (signal?.aborted || closed || generation !== startGeneration) {
						session.dispose();
						return textResult(
							"Delegation canceled before the worker started.",
							{ state: "idle", outcome: "aborted" },
						);
					}
					pi.appendEntry(ENTRY_TYPE, {
						workerId: id,
						provider: model.provider,
						model: model.id,
						sessionId: session.sessionId,
						parentSessionId: ctx.sessionManager.getSessionId(),
					});
					active = worker = {
						id,
						provider: model.provider,
						model: model.id,
						session,
					};
				} catch {
					createdSession?.dispose();
					const aborted =
						signal?.aborted || closed || generation !== startGeneration;
					return textResult(
						aborted
							? "Delegation canceled because the parent session changed."
							: "Could not create worker from the configured provider/model.",
						{ state: "idle", outcome: aborted ? "aborted" : "error" },
					);
				} finally {
					starting = false;
				}
			}

			if (!active) {
				return textResult("Worker could not be created.", {
					state: "idle",
					outcome: "error",
				});
			}
			working = true;
			const taskGeneration = generation;
			const messageCount = active.session.messages.length;

			let settledAborted = false;
			let resolveSettled!: () => void;
			const settled = new Promise<void>((resolve) => {
				resolveSettled = resolve;
			});
			resolveActiveWait = resolveSettled;
			const unsubscribe = active.session.subscribe((event) => {
				if (event.type === "agent_settled") {
					settledAborted = event.aborted;
					resolveSettled();
				}
			});
			const abort = () => active?.session.abort();
			signal?.addEventListener("abort", abort, { once: true });
			try {
				await Promise.race([
					active.session
						.prompt(params.task, {
							expandPromptTemplates: false,
							source: "extension",
						})
						.then(() => settled),
					settled,
				]);
			} catch {
				const outcome =
					generation !== taskGeneration || signal?.aborted
						? "aborted"
						: "error";
				return workerResult(
					active,
					"idle",
					outcome,
					"Worker failed. Provider error details are not shown here.",
				);
			} finally {
				signal?.removeEventListener("abort", abort);
				unsubscribe();
				if (resolveActiveWait === resolveSettled) resolveActiveWait = undefined;
				if (generation === taskGeneration) working = false;
			}

			if (generation !== taskGeneration) {
				return workerResult(
					active,
					"idle",
					"aborted",
					"Worker canceled because the parent session changed.",
				);
			}

			const lastAssistant = active.session.messages
				.slice(messageCount)
				.reverse()
				.find((message) => message.role === "assistant");
			const output =
				lastAssistant?.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("") ?? "";
			const wasAborted =
				settledAborted ||
				signal?.aborted ||
				lastAssistant?.stopReason === "aborted";
			const failure =
				wasAborted ||
				lastAssistant?.stopReason === "error" ||
				Boolean(lastAssistant?.errorMessage);
			const outcome = wasAborted ? "aborted" : failure ? "error" : "success";
			const boundedOutput = failure
				? ""
				: output.length > MAX_OUTPUT_LENGTH
					? `${output.slice(0, MAX_OUTPUT_LENGTH)}\n[Output truncated]`
					: output;
			if (generation === taskGeneration) {
				pi.appendEntry(ENTRY_TYPE, {
					workerId: active.id,
					provider: active.provider,
					model: active.model,
					sessionId: active.session.sessionId,
					sessionFile: active.session.sessionFile,
					parentSessionId: ctx.sessionManager.getSessionId(),
					outcome,
				});
			}
			return workerResult(
				active,
				"idle",
				outcome,
				failure
					? "Worker failed. Provider error details are not shown here."
					: boundedOutput || "(no text output)",
			);
		},
	});
}
