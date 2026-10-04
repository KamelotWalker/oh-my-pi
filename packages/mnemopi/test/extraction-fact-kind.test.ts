import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";
import { initBeam } from "@oh-my-pi/pi-mnemopi/core/beam/schema";
import { storeFactStrings } from "@oh-my-pi/pi-mnemopi/core/beam/consolidate";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("extracted semantic fact kinds", () => {
	it("persists world and experience separately and exposes them in fact recall", async () => {
		const memory = new Mnemopi({
			sessionId: "fact-kinds",
			dbPath: ":memory:",
			noEmbeddings: true,
			llm: {
				enabled: true,
				complete: () => JSON.stringify({
					facts: [
						{ text: "The user prefers tabs.", kind: "world" },
						{ text: "The agent fixed the parser.", kind: "experience" },
					],
					instructions: [], preferences: [], timelines: [], kg: [],
				}),
			},
		});
		try {
			memory.remember("The user prefers tabs. The agent fixed the parser.", { extract: true });
			await memory.flushExtractions();
			expect(memory.conn.query("SELECT value, memory_kind FROM memoria_facts ORDER BY id").all()).toEqual([
				{ value: "The user prefers tabs", memory_kind: "world" },
				{ value: "The agent fixed the parser", memory_kind: "experience" },
			]);
			expect(memory.beam.factRecall("parser", 5)[0]?.memory_kind).toBe("experience");
			expect(memory.beam.factRecall("tabs", 5)[0]?.memory_kind).toBe("world");
			expect(memory.beam.formatContext(memory.beam.factRecall("parser", 5))).toContain("[experience]");
			expect(memory.conn.query("SELECT object, memory_kind FROM facts ORDER BY object").all()).toEqual([
				{ object: "The agent fixed the parser", memory_kind: "experience" },
				{ object: "The user prefers tabs", memory_kind: "world" },
			]);
		} finally {
			memory.close();
		}
	});

	it("opens an old database without losing facts and migrates their kind only once", async () => {
		const dir = TempDir.createSync("@mnemopi-fact-kind-migration-");
		const dbPath = dir.join("old.db");
		try {
			{
				using db = new Database(dbPath);
				initBeam(db);
				db.exec("ALTER TABLE facts DROP COLUMN memory_kind");
				db.exec("ALTER TABLE memoria_facts DROP COLUMN memory_kind");
				db.run("INSERT INTO facts (fact_id, session_id, subject, predicate, object) VALUES (?, ?, ?, ?, ?)", [
					"old", "old-session", "fact", "entity", "The user prefers tabs",
				]);
				db.run("INSERT INTO memoria_facts (session_id, fact_type, key, value) VALUES (?, ?, ?, ?)", [
					"old-session", "entity", "fact", "The user prefers tabs",
				]);
			}
			const memory = new Mnemopi({ dbPath, sessionId: "old-session", noEmbeddings: true, llm: false });
			try {
				expect(memory.beam.factRecall("tabs", 5)[0]?.memory_kind).toBe("world");
				expect(memory.conn.query("SELECT value, memory_kind FROM memoria_facts").get()).toEqual({
					value: "The user prefers tabs", memory_kind: "world",
				});
				memory.conn.run("UPDATE facts SET memory_kind = 'experience' WHERE fact_id = 'old'");
				initBeam(memory.conn);
				expect(memory.beam.factRecall("tabs", 5)[0]?.memory_kind).toBe("experience");
			} finally {
				memory.close();
			}
		} finally {
			await dir.remove();
		}
	});

	it("never stores chatter as facts and keeps identical world/experience text distinct", () => {
		const memory = new Mnemopi({ dbPath: ":memory:", noEmbeddings: true, llm: false });
		try {
			expect(storeFactStrings(memory.beam, ["Selam Echo", "Thank you very much"])).toBe(0);
			const fact = "The parser uses tabs";
			storeFactStrings(memory.beam, [fact]);
			storeFactStrings(memory.beam, [fact], 0, null, 0.7, { factKinds: { [fact]: "experience" } });
			expect(memory.conn.query("SELECT memory_kind FROM facts ORDER BY memory_kind").all()).toEqual([
				{ memory_kind: "experience" }, { memory_kind: "world" },
			]);
		} finally {
			memory.close();
		}
	});
});
