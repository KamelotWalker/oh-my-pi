import { logger, withTimeout } from "@oh-my-pi/pi-utils";
import type { MnemopiLlmCompletion } from "./runtime-options";

export interface ReflectMemory {
	id: string;
	content: string;
	timestamp?: string | null;
	kind?: string | null;
}

export interface ReflectResult {
	text: string;
	citedIds: string[];
	synthesized: boolean;
}

const MAX_INPUT_CHARS = 12_000;
const COMPLETION_TIMEOUT_SECONDS = 15;

function fitJsonString(value: string, budget: number): string {
	let high = Math.min(value.length, budget - 2);
	const candidate = value.slice(0, high);
	if (JSON.stringify(candidate).length <= budget) return candidate;
	let low = 0;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (JSON.stringify(value.slice(0, middle)).length <= budget) low = middle;
		else high = middle - 1;
	}
	return value.slice(0, low);
}

function reflectionInput(query: string, memories: readonly ReflectMemory[]): { input: string; ids: Set<string> } {
	// This is source data, not instructions: the host supplies the reflection system prompt.
	const prefix = `{"query":${JSON.stringify(fitJsonString(query, MAX_INPUT_CHARS / 4))},"memories":[`;
	const suffix = "]}";
	const entries: string[] = [];
	const ids = new Set<string>();
	let remaining = MAX_INPUT_CHARS - prefix.length - suffix.length;
	for (const memory of memories) {
		const separatorLength = entries.length === 0 ? 0 : 1;
		const budget = remaining - separatorLength;
		const row = {
			id: memory.id,
			timestamp: memory.timestamp ?? null,
			kind: memory.kind ?? null,
			content: "",
		};
		const metadataLength = JSON.stringify(row).length;
		if (metadataLength >= budget) break;

		// JSON escaping can expand source text. Fit the highest-ranked memory before
		// considering any later one, including when that first memory is oversized.
		row.content = fitJsonString(memory.content, budget - metadataLength + 2);
		const entry = JSON.stringify(row);
		entries.push(entry);
		ids.add(memory.id);
		remaining -= separatorLength + entry.length;
		if (row.content.length < memory.content.length) break;
	}
	return { input: `${prefix}${entries.join(",")}${suffix}`, ids };
}

function citationIdMatcher(ids: ReadonlySet<string>): (value: string) => boolean {
	const hexLengths = new Set<number>();
	const hexGroups = new Set<string>();
	const prefixes = new Set<string>();
	for (const id of ids) {
		if (/^[\da-f]{8,}$/i.test(id)) {
			hexLengths.add(id.length);
		} else if (/^[\da-f]+(?:-[\da-f]+)+$/i.test(id)) {
			hexGroups.add(
				id
					.split("-")
					.map(part => part.length)
					.join("-"),
			);
		} else {
			const prefixed = /^(.+[-_:.])[A-Za-z0-9]+$/.exec(id);
			if (prefixed) prefixes.add(prefixed[1]!);
		}
	}
	return value => {
		if (/^[\da-f]{8,}$/i.test(value) && hexLengths.has(value.length)) return true;
		if (
			/^[\da-f]+(?:-[\da-f]+)+$/i.test(value) &&
			hexGroups.has(
				value
					.split("-")
					.map(part => part.length)
					.join("-"),
			)
		) {
			return true;
		}
		for (const prefix of prefixes) {
			if (value.startsWith(prefix) && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value.slice(prefix.length))) {
				return true;
			}
		}
		return false;
	};
}

function cleanCitations(raw: string, ids: ReadonlySet<string>): { text: string; citedIds: string[] } {
	const resemblesId = citationIdMatcher(ids);
	const citedIds = new Set<string>();
	const text = raw.replace(
		/([ \t]*)\[([^[\]\r\n]+)\]([ \t]*)/g,
		(match, before: string, content: string, after: string, offset: number) => {
			const next = raw[offset + match.length] ?? "";
			// Markdown links and ordinary bracketed prose are not memory citations.
			if (next === "(") return match;
			const parts = content.split(/[,;]/).map(part => part.trim());
			if (!parts.every(part => ids.has(part) || resemblesId(part))) return match;
			const known = parts.filter(part => ids.has(part));
			for (const id of known) citedIds.add(id);
			if (known.length === parts.length) return match;
			if (known.length > 0) return `${before}[${known.join(", ")}]${after}`;
			// Remove only whitespace stranded by a removed citation, not prose formatting.
			if (next === "" || /^[.,;:!?)}\]]$/.test(next)) return "";
			return before && after ? " " : before || after;
		},
	);
	return { text: text.trim(), citedIds: [...citedIds] };
}

/** Answer from recalled memories, or let the caller retain its non-LLM fallback. */
export async function synthesizeReflection(
	complete: MnemopiLlmCompletion | null | undefined,
	query: string,
	memories: readonly ReflectMemory[],
	opts: { maxTokens?: number; signal?: AbortSignal } = {},
): Promise<ReflectResult | null> {
	opts.signal?.throwIfAborted();
	if (!complete || memories.length === 0) {
		logger.debug("mnemopi reflection falling back", {
			reason: !complete ? "completion_unavailable" : "no_memories",
		});
		return null;
	}

	try {
		const { input, ids } = reflectionInput(query, memories);
		if (ids.size === 0) {
			logger.debug("mnemopi reflection falling back", { reason: "no_memories_within_budget" });
			return null;
		}
		const raw = await withTimeout(
			Promise.resolve(
				complete(input, {
					maxTokens: opts.maxTokens ?? 2048,
					temperature: 0,
					timeout: COMPLETION_TIMEOUT_SECONDS,
					signal: opts.signal,
					task: { kind: "memory-reflect", input },
				}),
			),
			COMPLETION_TIMEOUT_SECONDS * 1000,
			"Memory reflection timed out",
			opts.signal,
		);
		opts.signal?.throwIfAborted();
		if (typeof raw !== "string" || raw.trim() === "") {
			logger.debug("mnemopi reflection falling back", {
				reason: raw === null ? "completion_returned_null" : "completion_returned_empty",
			});
			return null;
		}

		const { text, citedIds } = cleanCitations(raw, ids);
		if (text === "") {
			logger.debug("mnemopi reflection falling back", { reason: "no_text_after_citation_cleanup" });
			return null;
		}
		return { text, citedIds, synthesized: true };
	} catch (error) {
		opts.signal?.throwIfAborted();
		if (error instanceof Error && error.name === "AbortError") throw error;
		logger.debug("mnemopi reflection falling back", { reason: "completion_failed", error: String(error) });
		return null;
	}
}
