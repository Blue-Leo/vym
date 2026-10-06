import { expect, test, describe, beforeEach } from "bun:test";
import { History, Vym, type HistoryEntry, type HistoryOp } from "./index";

// A counter the entries change, so each test can check the state undo/redo leave.
let value = 0;

// An entry that adds `amount` to value; its repeat adds it again.
const addEntry = (amount: number): HistoryEntry => ({
	label: `add ${amount}`,
	undo: () => { value -= amount; },
	redo: () => { value += amount; },
	repeat: () => { value += amount; return addEntry(amount); },
});

// Change value the way an app would: apply, then record.
const add = (history: History, amount: number): void => {
	value += amount;
	history.record(addEntry(amount));
};

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("history", () => {
	let history: History;
	let emptied: HistoryOp[];

	beforeEach(() => {
		value = 0;
		emptied = [];
		history = new History({ onEmpty: (op) => emptied.push(op) });
	});

	test("undo reverses the latest change and redo reapplies it", async () => {
		add(history, 1);
		add(history, 10);
		expect(await history.undo()).toBe(1);
		expect(value).toBe(1);
		expect(await history.redo()).toBe(1);
		expect(value).toBe(11);
	});

	test("recording a change clears redo", async () => {
		add(history, 1);
		await history.undo();
		expect(history.canRedo).toBe(true);
		add(history, 5);
		expect(history.canRedo).toBe(false);
		expect(await history.redo()).toBe(0);
		expect(emptied).toEqual(["redo"]);
	});

	test("the oldest entries drop past the cap", async () => {
		const capped = new History({ cap: 2 });
		add(capped, 1);
		add(capped, 10);
		add(capped, 100);
		expect(await capped.undo(5)).toBe(2);
		expect(value).toBe(1);
	});

	test("an empty stack reports nothing to undo, redo or repeat", async () => {
		expect(await history.undo()).toBe(0);
		expect(await history.redo()).toBe(0);
		expect(await history.repeat()).toBe(0);
		expect(emptied).toEqual(["undo", "redo", "repeat"]);
	});

	test("a partial count does not report empty", async () => {
		add(history, 1);
		expect(await history.undo(3)).toBe(1);
		expect(emptied).toEqual([]);
	});

	describe("repeat", () => {
		test("repeat applies the last change again, and undo reverses the repeat", async () => {
			add(history, 2);
			expect(await history.repeat(2)).toBe(2);
			expect(value).toBe(6);
			await history.undo();
			expect(value).toBe(4);
		});

		test("repeat applies to the target the app's getter returns", async () => {
			const names: string[] = [];
			let selected = "a";
			const rename = (name: string): HistoryEntry<string> => ({
				label: `rename ${name}`,
				undo: () => {},
				redo: () => {},
				repeat: (target) => { names.push(`${target}:${name}`); return rename(name); },
			});
			const targeted = new History<string>({ repeatTarget: () => selected });
			targeted.record(rename("x"));
			selected = "b";
			await targeted.repeat();
			expect(names).toEqual(["b:x"]);
		});

		test("repeat still repeats the last change after it is undone, as in vim", async () => {
			add(history, 3);
			await history.undo();
			await history.repeat();
			expect(value).toBe(3);
		});

		test("a repeat that can't apply reports empty and records nothing", async () => {
			history.record({ label: "noop", undo: () => {}, redo: () => {}, repeat: () => undefined });
			expect(await history.repeat()).toBe(0);
			expect(emptied).toEqual(["repeat"]);
			expect(await history.undo(2)).toBe(1);
		});

	});

	describe("async ordering", () => {
		const log: string[] = [];
		beforeEach(() => { log.length = 0; });

		// An entry whose undo/redo log their start and end around a delay.
		const slowEntry = (name: string, ms: number): HistoryEntry => ({
			label: name,
			undo: async () => { log.push(`undo ${name} start`); await tick(ms); log.push(`undo ${name} end`); },
			redo: async () => { log.push(`redo ${name}`); },
		});

		test("quick undos run one at a time, newest first, each awaited", async () => {
			history.record(slowEntry("a", 5));
			history.record(slowEntry("b", 20));
			history.undo();
			await history.undo();
			expect(log).toEqual(["undo b start", "undo b end", "undo a start", "undo a end"]);
		});

		test("a redo asked during an undo waits for it", async () => {
			history.record(slowEntry("a", 20));
			history.undo();
			await history.redo();
			expect(log).toEqual(["undo a start", "undo a end", "redo a"]);
		});
	});

	describe("errors", () => {
		test("a rejecting undo drops its entry, stops the count and reports the error", async () => {
			const errors: string[] = [];
			const failing = new History({ onError: (op, label, error) => errors.push(`${op} ${label}: ${(error as Error).message}`) });
			add(failing, 1);
			failing.record({ label: "broken", undo: () => Promise.reject(new Error("server down")), redo: () => {} });
			expect(await failing.undo(2)).toBe(0);
			expect(errors).toEqual(["undo broken: server down"]);
			expect(failing.canRedo).toBe(false);
			expect(await failing.undo()).toBe(1);
			expect(value).toBe(0);
		});

		test("a throwing onEmpty doesn't stall later operations", async () => {
			const throwing = new History({ onEmpty: () => { throw new Error("toast failed"); } });
			await expect(throwing.undo()).rejects.toThrow("toast failed");
			add(throwing, 1);
			expect(await throwing.undo()).toBe(1);
		});
	});

	describe("replay guard", () => {
		test("changes recorded by an undo's own save code are ignored", async () => {
			let recordedDuringUndo = true;
			history.record({
				label: "save",
				undo: async () => {
					await tick(1);
					recordedDuringUndo = history.record(addEntry(99));
				},
				redo: () => {},
			});
			await history.undo();
			expect(recordedDuringUndo).toBe(false);
			expect(history.canUndo).toBe(false);
			expect(history.canRedo).toBe(true);
		});
	});

	describe("vym commands", () => {
		test("u, r and . run undo, redo and repeat with count prefixes", async () => {
			const vym = new Vym();
			history.registerCommands(vym);
			vym.bind("normal", "u", "undo");
			vym.bind("normal", "r", "redo");
			vym.bind("normal", ".", "repeat");
			add(history, 1);
			for (const key of ["3", "."]) vym.handleKey(key);
			for (const key of ["2", "u"]) vym.handleKey(key);
			vym.handleKey("r");
			await history.redo(0);
			expect(value).toBe(3);
			for (const key of ["u", "u", "u"]) vym.handleKey(key);
			await history.undo(0);
			expect(value).toBe(0);
		});
	});
});
