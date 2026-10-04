import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveMemoryCompletionInput, resolveMemoryCompletionSignal } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { loadMnemopi, loadMnemopiCore, MnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { MemoryReflectTool } from "@oh-my-pi/pi-coding-agent/tools/memory-reflect";
import type { ReflectMemory } from "@oh-my-pi/pi-mnemopi";
import type { MnemopiLlmCompletion } from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import { TempDir } from "@oh-my-pi/pi-utils";
import memoryReflectionPrompt from "../src/prompts/system/memory-reflect-system.md" with { type: "text" };

await Promise.all([loadMnemopi(), loadMnemopiCore()]);

interface ReflectionInput {
	query: string;
	memories: ReflectMemory[];
}

const states: MnemopiSessionState[] = [];
const dirs: TempDir[] = [];

function startSession(
	options: {
		complete?: MnemopiLlmCompletion;
		llmMode?: "smol" | "none" | "remote";
		scoped?: boolean;
		recallLimit?: number;
	} = {},
): { state: MnemopiSessionState; tool: MemoryReflectTool } {
	const dir = TempDir.createSync("@mnemopi-reflect-");
	dirs.push(dir);
	const settings = Settings.isolated({
		"memory.backend": "mnemopi",
		"mnemopi.scoping": "global",
		"mnemopi.dbPath": dir.join("mnemopi.db"),
		"mnemopi.noEmbeddings": true,
		"mnemopi.llmMode": options.llmMode ?? "smol",
		"mnemopi.autoRetain": false,
	});
	const config = loadMnemopiConfig(settings, dir.path());
	config.providerOptions = {
		...config.providerOptions,
		llm: options.complete ? { complete: options.complete } : false,
	};
	if (options.recallLimit !== undefined) config.recallLimit = options.recallLimit;
	if (options.scoped) {
		config.scoping = "per-project-tagged";
		config.bank = config.retainBank = "reflect-project";
		config.baseBank = config.globalBank = "reflect-global";
		config.recallBanks = ["reflect-project", "reflect-global"];
	}
	const state = new MnemopiSessionState({
		sessionId: "reflect-session",
		config,
		session: {
			sessionId: "reflect-session",
			settings,
			sessionManager: { getEntries: () => [], getCwd: () => dir.path() },
			emitNotice: () => {},
			subscribe: () => () => {},
		} as never,
	});
	states.push(state);
	const tools = {
		cwd: dir.path(),
		hasUI: false,
		settings,
		getMnemopiSessionState: () => state,
	} as unknown as ToolSession;
	return { state, tool: MemoryReflectTool.createIf(tools)! };
}

function remember(state: MnemopiSessionState, content: string, global = false): string {
	return state.rememberScoped(
		content,
		{ extract: false, extractEntities: false, memoryType: "episode" },
		global ? state.getGlobalRetainTarget() : state.getScopedRetainTarget(),
	);
}

afterEach(async () => {
	for (const state of states.splice(0)) await state.dispose({ consolidate: false });
	for (const dir of dirs.splice(0)) await dir.remove();
});

describe("Mnemopi reflect", () => {
	it("synthesizes across scoped banks beyond the normal recall limit and exposes only cited memory links", async () => {
		let input: ReflectionInput | undefined;
		let projectId = "";
		let globalId = "";
		const { state, tool } = startSession({
			scoped: true,
			recallLimit: 1,
			complete: (_prompt, options) => {
				if (options?.task?.kind !== "memory-reflect") throw new Error("Unexpected memory task");
				input = JSON.parse(options.task.input) as ReflectionInput;
				return `Alice owns the launch checklist in the wiki [${projectId}] [${globalId}].`;
			},
		});
		projectId = remember(state, "Alice owns the launch checklist");
		globalId = remember(state, "The launch checklist lives in the wiki", true);
		const uncitedId = remember(state, "The launch checklist is reviewed each Monday");

		const result = await tool.execute("reflect", {
			query: "launch checklist",
			context: "Who owns it and where is it?",
		});
		const [block] = result.content;
		if (block?.type !== "text") throw new Error("reflect returned no text block");
		expect(input?.query).toContain("Who owns it and where is it?");
		expect(input?.memories.map(memory => memory.id)).toEqual(
			expect.arrayContaining([projectId, globalId, uncitedId]),
		);
		expect(block.text).toContain(`Alice owns the launch checklist in the wiki [${projectId}] [${globalId}].`);
		expect(block.text).toContain(`memory://${projectId}`);
		expect(block.text).toContain(`memory://${globalId}`);
		expect(block.text).not.toContain(`memory://${uncitedId}`);
		expect(block.text).not.toContain("Based on recalled memories:");
		expect(result.details).toEqual({ synthesized: true, citedIds: [projectId, globalId] });
	});

	it("answers from evidence past the recall preview boundary rather than only the first 500 characters", async () => {
		let memoryId = "";
		const { state, tool } = startSession({
			complete: (_prompt, options) => {
				if (options?.task?.kind !== "memory-reflect") throw new Error("Unexpected memory task");
				const input = JSON.parse(options.task.input) as ReflectionInput;
				const evidence = input.memories.find(memory => memory.id === memoryId)?.content ?? "";
				return evidence.includes("The owner is Mina.")
					? `Mina owns the checklist [${memoryId}].`
					: "The owner is unknown.";
			},
		});
		memoryId = remember(state, `Launch checklist background: ${"background notes ".repeat(50)}The owner is Mina.`);
		const result = await tool.execute("reflect", { query: "launch checklist" });
		const [block] = result.content;
		if (block?.type !== "text") throw new Error("reflect returned no text block");
		expect(block.text).toContain(`Mina owns the checklist [${memoryId}]`);
		expect(block.text).toContain(`memory://${memoryId}`);
	});

	it("clips the fallback to the old preview without attributing a second recall to the memory", async () => {
		const { state, tool } = startSession({ complete: () => null, recallLimit: 1 });
		const content = `Launch checklist background: ${"background notes ".repeat(50)}Hidden end of checklist.`;
		const id = remember(state, content);
		const oldResults = await state.recallResultsScoped("launch checklist");
		const oldOutput = `Based on recalled memories:\n\n${state.formatContextScoped(oldResults)}`;
		const before = state.memory.db.query("SELECT recall_count FROM working_memory WHERE id = ?").get(id) as {
			recall_count: number;
		};
		const result = await tool.execute("reflect", { query: "launch checklist" });
		const [block] = result.content;
		if (block?.type !== "text") throw new Error("reflect returned no text block");
		expect(block.text).toBe(oldOutput);
		expect(block.text).not.toContain("Hidden end of checklist.");
		const row = state.memory.db.query("SELECT recall_count FROM working_memory WHERE id = ?").get(id) as {
			recall_count: number;
		};
		expect(row.recall_count - before.recall_count).toBe(1);
		expect(result.details).toEqual({ synthesized: false, citedIds: [] });
	});

	it("propagates caller cancellation into the completion instead of returning recalled-memory fallback", async () => {
		const started = Promise.withResolvers<void>();
		let completionSignal: AbortSignal | undefined;
		const { state } = startSession({
			complete: (_prompt, options) => {
				completionSignal = options?.signal;
				const completion = Promise.withResolvers<string | null>();
				completionSignal?.addEventListener("abort", () => completion.reject(completionSignal?.reason), {
					once: true,
				});
				started.resolve();
				return completion.promise;
			},
		});
		remember(state, "The launch checklist lives in the wiki");
		const controller = new AbortController();
		const operation = state.reflectScoped("launch checklist", controller.signal);
		await started.promise;
		controller.abort(new Error("Reflection cancelled"));
		await expect(operation).rejects.toThrow("Reflection cancelled");
		expect(completionSignal?.aborted).toBe(true);
	});

	it("keeps the recalled-memory output when llmMode is none even if a callback exists", async () => {
		let calls = 0;
		const { state, tool } = startSession({
			llmMode: "none",
			complete: () => {
				calls++;
				return "This completion must not be used.";
			},
		});
		remember(state, "The launch checklist lives in the wiki");
		const summary = state.formatContextScoped(await state.recallResultsScoped("launch checklist"));
		const result = await tool.execute("reflect", { query: "launch checklist" });
		expect(result.content).toEqual([{ type: "text", text: `Based on recalled memories:\n\n${summary}` }]);
		expect(result.details).toEqual({ synthesized: false, citedIds: [] });
		expect(calls).toBe(0);
	});

	it("returns recalled memories rather than failing when the LLM throws", async () => {
		let calls = 0;
		const { state, tool } = startSession({
			complete: () => {
				calls++;
				throw new Error("Memory model unavailable");
			},
		});
		remember(state, "The launch checklist lives in the wiki");
		const summary = state.formatContextScoped(await state.recallResultsScoped("launch checklist"));
		const result = await tool.execute("reflect", { query: "launch checklist" });
		expect(calls).toBe(1);
		expect(result.content).toEqual([{ type: "text", text: `Based on recalled memories:\n\n${summary}` }]);
		expect(result.details).toEqual({ synthesized: false, citedIds: [] });
	});

	it("keeps the fallback for remote configurations without a completion callback", async () => {
		const { state, tool } = startSession({ llmMode: "remote" });
		remember(state, "The launch checklist lives in the wiki");
		const result = await tool.execute("reflect", { query: "launch checklist" });
		const [block] = result.content;
		if (block?.type !== "text") throw new Error("reflect returned no text block");
		expect(block.text).toContain("Based on recalled memories:");
		expect(block.text).toContain("The launch checklist lives in the wiki");
		expect(result.details).toEqual({ synthesized: false, citedIds: [] });
	});

	it("reports no relevant information without invoking the LLM when recall is empty", async () => {
		let calls = 0;
		const { tool } = startSession({
			complete: () => {
				calls++;
				return "Unsupported answer";
			},
		});
		const result = await tool.execute("reflect", { query: "launch checklist" });
		expect(result.content).toEqual([{ type: "text", text: "No relevant information found to reflect on." }]);
		expect(result.details).toEqual({ synthesized: false, citedIds: [] });
		expect(calls).toBe(0);
	});

	it("routes reflection data into the user turn and reflection instructions into the system turn", () => {
		const input = JSON.stringify({
			query: "Who owns the checklist?",
			memories: [{ id: "memory-1", content: "Alice owns it" }],
		});
		const request = resolveMemoryCompletionInput("discard this rendered prompt", {
			task: { kind: "memory-reflect", input },
		});
		expect(request).toEqual({ prompt: input, systemPrompt: memoryReflectionPrompt });
	});

	it("converts a 15-second completion deadline to a 15000ms platform timeout instead of 15ms", () => {
		const timeout = spyOn(AbortSignal, "timeout");
		try {
			resolveMemoryCompletionSignal({ timeout: 15 });
			expect(timeout).toHaveBeenCalledWith(15_000);
		} finally {
			timeout.mockRestore();
		}
	});

	it("combines the timeout with caller cancellation so an aborted tool cancels its model request", () => {
		const controller = new AbortController();
		const signal = resolveMemoryCompletionSignal({ timeout: 15, signal: controller.signal });
		const reason = new Error("User cancelled reflection");
		controller.abort(reason);
		expect(signal?.aborted).toBe(true);
		expect(signal?.reason).toBe(reason);
	});
});
