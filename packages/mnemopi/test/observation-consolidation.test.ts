/**
 * A repeated preference from another session strengthens one observation
 * (evidence = distinct sources). A contradicting preference ages the old one,
 * so recall returns the new claim and `memory_validations` records both moves.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	consolidateToEpisodic,
	extractAndStoreFacts,
	storeFactStrings,
} from "@oh-my-pi/pi-mnemopi/core/beam/consolidate";
import { factRecall, recallEnhanced } from "@oh-my-pi/pi-mnemopi/core/beam/recall";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam/schema";
import { forgetWorking } from "@oh-my-pi/pi-mnemopi/core/beam/store";
import type { BeamMemoryState } from "@oh-my-pi/pi-mnemopi/core/beam/types";
import {
	classifyObservation,
	normalizeObservationText,
	proofCountBoost,
} from "@oh-my-pi/pi-mnemopi/core/veracity-consolidation";

function makeBeam(db: Database, sessionId: string): BeamMemoryState {
	return {
		db,
		sessionId,
		authorId: null,
		authorType: null,
		channelId: sessionId,
		useCloud: false,
		pluginManager: null,
		annotations: null,
		triples: null,
		episodicGraph: null,
		veracityConsolidator: null,
		caches: { timestampParse: new Map(), extractionBuffer: [] },
		config: {
			workingMemoryLimit: 1000,
			workingMemoryTtlHours: 24,
			recencyHalflifeHours: 72,
			vecWeight: 0.5,
			ftsWeight: 0.3,
			importanceWeight: 0.2,
			useCloud: false,
			localLlmEnabled: false,
			maxEpisodeChars: 100_000,
			polyphonicRecall: false,
		},
	};
}

describe("observation classification", () => {
	it("treats a restated preference as the same claim and only explicit negation as a contradiction", () => {
		expect(classifyObservation("The user prefers dark mode", "the user prefers dark mode.")).toBe("same");
		expect(classifyObservation("The user prefers dark mode", "The user prefers light mode")).toBe("distinct");
		expect(classifyObservation("The user prefers dark mode", "The user dislikes dark mode")).toBe("contradicts");
		expect(classifyObservation("The user prefers rust", "The user prefers tea")).toBe("distinct");
		expect(classifyObservation("The staging cluster has 3 replicas", "The staging cluster has 5 replicas")).toBe(
			"distinct",
		);
		expect(
			classifyObservation(
				"Alice is the owner of the billing service",
				"Alice is not the owner of the billing service",
			),
		).toBe("contradicts");
		expect(classifyObservation("The user prefers tabs over spaces", "The user prefers spaces over tabs")).toBe(
			"distinct",
		);
		expect(classifyObservation("The user dislikes slow tests", "The user dislikes flaky tests")).toBe("distinct");
		expect(normalizeObservationText("Kullanıcı çay sever")).toBe("kullanıcı çay sever");
		expect(classifyObservation("Kullanıcı çay sever", "kullanıcı çay sever")).toBe("same");
	});

	it("adds a small boost only after the first distinct source", () => {
		expect(proofCountBoost(1)).toBe(1);
		expect(proofCountBoost(2)).toBeCloseTo(1 + 0.1 * Math.log1p(1), 12);
		expect(proofCountBoost(2)).toBeLessThan(1.1);
	});
});

describe("preference observations", () => {
	it("collapses the same preference from two sessions into one record with evidence 2", () => {
		const db = new Database(":memory:");
		initBeam(db);
		try {
			const first = makeBeam(db, "session-a");
			const second = makeBeam(db, "session-b");
			storeFactStrings(first, ["The user prefers dark mode"], 0, "mem-a");
			storeFactStrings(second, ["The user prefers dark mode"], 0, "mem-b");

			const facts = db
				.query(
					"SELECT fact_id, proof_count, sources_json, superseded_by FROM facts WHERE object = 'The user prefers dark mode'",
				)
				.all() as Array<{
				fact_id: string;
				proof_count: number;
				sources_json: string;
				superseded_by: string | null;
			}>;
			expect(facts).toHaveLength(1);
			const fact = facts[0];
			if (fact === undefined) throw new Error("expected one preference fact");
			expect(fact.superseded_by).toBeNull();
			expect(fact.proof_count).toBe(2);
			expect(JSON.parse(fact.sources_json)).toEqual(["mem-a", "mem-b"]);

			const preference = db
				.query("SELECT proof_count, sources_json, superseded_by FROM memoria_preferences")
				.get() as { proof_count: number; sources_json: string; superseded_by: string | null };
			expect(preference.proof_count).toBe(2);
			expect(JSON.parse(preference.sources_json)).toEqual(["mem-a", "mem-b"]);
			expect(preference.superseded_by).toBeNull();

			expect(db.query("SELECT scope FROM facts WHERE object = 'The user prefers dark mode'").get()).toEqual({
				scope: "session",
			});
			expect(factRecall(second, "prefers dark mode", 5)).toEqual([]);

			const journal = db.query("SELECT memory_id, validator, action, note FROM memory_validations").all() as Array<{
				memory_id: string;
				validator: string;
				action: string;
				note: string;
			}>;
			expect(journal).toEqual([
				{
					memory_id: fact.fact_id,
					validator: "mem-b",
					action: "reinforce",
					note: "The user prefers dark mode",
				},
			]);

			const recalled = factRecall(first, "prefers dark mode", 5);
			expect(recalled.map(row => row.content)).toEqual(["The user prefers dark mode"]);
		} finally {
			db.close();
		}
	});

	it("ages an explicit negation so recall returns the new claim and journals the weakening", async () => {
		const db = new Database(":memory:");
		initBeam(db);
		try {
			const later = makeBeam(db, "session-c");
			storeFactStrings(makeBeam(db, "session-a"), ["The user prefers dark mode"], 0, "mem-a");
			storeFactStrings(later, ["The user dislikes dark mode"], 0, "mem-c");

			const rows = db.query("SELECT fact_id, object, superseded_by FROM facts ORDER BY object").all() as Array<{
				fact_id: string;
				object: string;
				superseded_by: string | null;
			}>;
			const liked = rows.find(row => row.object === "The user prefers dark mode");
			const disliked = rows.find(row => row.object === "The user dislikes dark mode");
			if (liked === undefined || disliked === undefined) throw new Error("expected both preference facts");
			expect(liked.superseded_by).toBe(disliked.fact_id);
			expect(disliked.superseded_by).toBeNull();

			const recalled = factRecall(later, "dark mode", 5);
			expect(recalled.map(row => row.content)).toEqual(["The user dislikes dark mode"]);
			const enhanced = await recallEnhanced(later, "dark mode", 5, {
				includeFacts: true,
				queryEmbedding: null,
				useMmr: false,
			});
			expect(enhanced.map(row => row.content)).toContain("The user dislikes dark mode");
			expect(enhanced.map(row => row.content)).not.toContain("The user prefers dark mode");

			expect(
				db.query("SELECT memory_id, validator, action, note FROM memory_validations WHERE action = 'weaken'").get(),
			).toEqual({
				memory_id: liked.fact_id,
				validator: "mem-c",
				action: "weaken",
				note: "The user dislikes dark mode",
			});
		} finally {
			db.close();
		}
	});

	it("keeps two same-family preferences active when neither negates the other", () => {
		const db = new Database(":memory:");
		initBeam(db);
		try {
			const beam = makeBeam(db, "session-a");
			storeFactStrings(beam, ["The user prefers dark mode"], 0, "mem-a");
			storeFactStrings(beam, ["The user prefers light mode"], 0, "mem-b");
			storeFactStrings(beam, ["The user dislikes slow tests"], 0, "mem-c");
			storeFactStrings(beam, ["The user dislikes flaky tests"], 0, "mem-d");
			expect(
				(
					db.query("SELECT object FROM facts WHERE superseded_by IS NULL ORDER BY object").all() as Array<{
						object: string;
					}>
				).map(row => row.object),
			).toEqual([
				"The user dislikes flaky tests",
				"The user dislikes slow tests",
				"The user prefers dark mode",
				"The user prefers light mode",
			]);
		} finally {
			db.close();
		}
	});

	it("keeps unrelated preferences and does not double-count the same source", () => {
		const db = new Database(":memory:");
		initBeam(db);
		try {
			const beam = makeBeam(db, "session-a");
			storeFactStrings(beam, ["The user prefers rust"], 0, "mem-a");
			storeFactStrings(beam, ["The user prefers tea"], 0, "mem-b");
			storeFactStrings(beam, ["The user prefers rust"], 1, "mem-a");

			const active = db
				.query("SELECT object, proof_count FROM facts WHERE superseded_by IS NULL ORDER BY object")
				.all() as Array<{ object: string; proof_count: number }>;
			expect(active).toEqual([
				{ object: "The user prefers rust", proof_count: 1 },
				{ object: "The user prefers tea", proof_count: 1 },
			]);
			expect(db.query("SELECT COUNT(*) AS count FROM memory_validations").get()).toEqual({ count: 0 });
		} finally {
			db.close();
		}
	});

	it("consolidates extracted KG facts while polyphonic recall is off", () => {
		const db = new Database(":memory:");
		initBeam(db);
		try {
			extractAndStoreFacts(makeBeam(db, "session-a"), "Alice owns the launch checklist");
			expect(db.query("SELECT subject, predicate FROM consolidated_facts WHERE subject = 'Alice'").all()).toEqual([
				{ subject: "Alice", predicate: "related_to" },
			]);
		} finally {
			db.close();
		}
	});
});

describe("fact recall evidence", () => {
	it("ranks a better-evidenced fact above an equal lexical match and hides a superseded one", () => {
		const db = new Database(":memory:");
		initBeam(db);
		try {
			const beam = makeBeam(db, "s1");
			db.run(
				"INSERT INTO facts (fact_id, session_id, subject, predicate, object, confidence, scope, proof_count) VALUES (?, ?, ?, ?, ?, ?, 'global', ?)",
				["thin", "s1", "service", "uses", "alpha deploy runbook", 0.5, 1],
			);
			db.run(
				"INSERT INTO facts (fact_id, session_id, subject, predicate, object, confidence, scope, proof_count) VALUES (?, ?, ?, ?, ?, ?, 'global', ?)",
				["thick", "s2", "service", "uses", "alpha deploy runbook", 0.5, 3],
			);
			db.run(
				"INSERT INTO facts (fact_id, session_id, subject, predicate, object, confidence, scope, proof_count, superseded_by) VALUES (?, ?, ?, ?, ?, ?, 'global', ?, ?)",
				["dead", "s1", "service", "uses", "alpha deploy runbook alpha deploy runbook", 1, 9, "thick"],
			);

			const results = factRecall(beam, "alpha deploy runbook", 5);
			expect(results.map(row => row.fact_id)).toEqual(["thick", "thin"]);
			expect(results[0]?.score ?? 0).toBeGreaterThan(results[1]?.score ?? 0);
		} finally {
			db.close();
		}
	});
});

function insertWorking(db: Database, id: string, sessionId: string, scope = "session"): void {
	db.run(
		"INSERT INTO working_memory (id, content, source, timestamp, session_id, importance, scope, veracity, memory_type) VALUES (?, ?, 'test', ?, ?, 0.5, ?, 'stated', 'general')",
		[id, id, "2026-05-30T12:00:00.000Z", sessionId, scope],
	);
}

describe("observation regressions", () => {
	it("strengthens a fact older than the contradiction window instead of colliding on its id", () => {
		const db = new Database(":memory:");
		initBeam(db);
		try {
			const beam = makeBeam(db, "session-a");
			for (let index = 0; index < 81; index++) {
				storeFactStrings(beam, [`The user prefers option ${index}`], 0, "mem-a");
			}
			expect(() => storeFactStrings(beam, ["The user prefers option 0"], 0, "mem-b")).not.toThrow();
			const row = db
				.query(
					"SELECT proof_count, sources_json FROM facts WHERE object = 'The user prefers option 0' AND superseded_by IS NULL",
				)
				.get() as { proof_count: number; sources_json: string };
			expect(row.proof_count).toBe(2);
			expect(JSON.parse(row.sources_json)).toEqual(["mem-a", "mem-b"]);
		} finally {
			db.close();
		}
	});

	it("keeps same metric values with different subjects as separate facts", () => {
		const db = new Database(":memory:");
		initBeam(db);
		try {
			extractAndStoreFacts(
				makeBeam(db, "session-a"),
				"The p99 latency was 250ms and the request timeout was 250ms",
				0,
				"mem-metrics",
			);
			const rows = db.query("SELECT subject FROM facts WHERE object = '250ms' ORDER BY subject").all() as Array<{
				subject: string;
			}>;
			expect(rows.length).toBeGreaterThanOrEqual(2);
			expect(new Set(rows.map(row => row.subject)).size).toBe(rows.length);
		} finally {
			db.close();
		}
	});

	it("backfills sources_json from source_msg_id once", () => {
		const db = new Database(":memory:");
		initBeam(db);
		try {
			db.run(
				"INSERT INTO facts (fact_id, session_id, subject, predicate, object, source_msg_id, sources_json) VALUES ('legacy', 's', 'fact', 'entity', 'The user prefers tabs', 'mem-old', NULL)",
			);
			initBeam(db);
			expect(db.query("SELECT sources_json, proof_count FROM facts WHERE fact_id = 'legacy'").get()).toEqual({
				sources_json: JSON.stringify(["mem-old"]),
				proof_count: 1,
			});
			initBeam(db);
			expect(db.query("SELECT sources_json, proof_count FROM facts WHERE fact_id = 'legacy'").get()).toEqual({
				sources_json: JSON.stringify(["mem-old"]),
				proof_count: 1,
			});
		} finally {
			db.close();
		}
	});

	it("keeps a shared fact when one source is forgotten and drops its journal only when the fact goes", () => {
		const db = new Database(":memory:");
		initBeam(db);
		try {
			const beam = makeBeam(db, "session-a");
			insertWorking(db, "mem-a", beam.sessionId);
			insertWorking(db, "mem-b", beam.sessionId);
			storeFactStrings(beam, ["The user prefers dark mode"], 0, "mem-a");
			storeFactStrings(beam, ["The user prefers dark mode"], 0, "mem-b");
			const factId = (
				db.query("SELECT fact_id FROM facts WHERE object = 'The user prefers dark mode'").get() as {
					fact_id: string;
				}
			).fact_id;

			expect(forgetWorking(beam, "mem-a")).toBe(true);
			expect(
				db.query("SELECT source_msg_id, proof_count, sources_json FROM facts WHERE fact_id = ?").get(factId),
			).toEqual({ source_msg_id: "mem-b", proof_count: 1, sources_json: JSON.stringify(["mem-b"]) });

			expect(forgetWorking(beam, "mem-b")).toBe(true);
			expect(db.query("SELECT fact_id FROM facts WHERE fact_id = ?").get(factId)).toBeNull();
			expect(db.query("SELECT COUNT(*) AS count FROM memory_validations WHERE memory_id = ?").get(factId)).toEqual({
				count: 0,
			});
		} finally {
			db.close();
		}
	});

	it("does not revive a superseded fact from the summary of its old source", () => {
		const db = new Database(":memory:");
		initBeam(db);
		try {
			const beam = makeBeam(db, "session-a");
			insertWorking(db, "w1", beam.sessionId);
			storeFactStrings(beam, ["The user prefers dark mode"], 0, "w1");
			storeFactStrings(beam, ["The user dislikes dark mode"], 0, "w2");
			consolidateToEpisodic(beam, "The user prefers dark mode", ["w1"]);
			expect(
				db
					.query("SELECT superseded_by IS NULL AS live FROM facts WHERE object = 'The user prefers dark mode'")
					.get(),
			).toEqual({ live: 0 });
		} finally {
			db.close();
		}
	});

	it("follows the source memory scope instead of promoting every fact to global", () => {
		const db = new Database(":memory:");
		initBeam(db);
		try {
			const beam = makeBeam(db, "session-a");
			insertWorking(db, "mem-session", beam.sessionId, "session");
			insertWorking(db, "mem-global", beam.sessionId, "global");
			storeFactStrings(beam, ["The user prefers tabs"], 0, "mem-session");
			storeFactStrings(beam, ["The user prefers spaces"], 0, "mem-global");
			expect(db.query("SELECT scope FROM facts WHERE object = 'The user prefers tabs'").get()).toEqual({
				scope: "session",
			});
			expect(db.query("SELECT scope FROM facts WHERE object = 'The user prefers spaces'").get()).toEqual({
				scope: "global",
			});
		} finally {
			db.close();
		}
	});

	it("initializes the same database from two connections without duplicating evidence", () => {
		const dir = mkdtempSync(join(tmpdir(), "mnemopi-observation-init-"));
		const path = join(dir, "facts.db");
		const left = new Database(path);
		const right = new Database(path);
		try {
			left.exec("PRAGMA busy_timeout = 5000");
			right.exec("PRAGMA busy_timeout = 5000");
			initBeam(left);
			left.run(
				"INSERT INTO facts (fact_id, session_id, subject, predicate, object, source_msg_id, sources_json) VALUES ('legacy', 's', 'fact', 'entity', 'tabs', 'mem-old', NULL)",
			);
			initBeam(right);
			initBeam(left);
			expect(left.query("SELECT sources_json, proof_count FROM facts WHERE fact_id = 'legacy'").get()).toEqual({
				sources_json: JSON.stringify(["mem-old"]),
				proof_count: 1,
			});
		} finally {
			left.close();
			right.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
