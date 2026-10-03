import { expect, test, describe, beforeEach } from "bun:test";
import { Vym, normalizeKeyboardEvent } from "./index";

describe("vym", () => {
	let v: Vym;
	let log: string[];

	beforeEach(() => {
		v = new Vym();
		log = [];
	});

	describe("command registry", () => {
		test("register after bind — late binding works", () => {
			v.bind("normal", "x", "cut");
			v.handleKey("x");
			expect(log).toEqual([]); // not registered yet, silent no-op

			v.register("cut", (n) => log.push(`cut:${n}`));
			v.handleKey("x");
			expect(log).toEqual(["cut:1"]);
		});

		test("unregister stops command from firing", () => {
			v.register("cut", (n) => log.push(`cut:${n}`));
			v.bind("normal", "x", "cut");
			v.handleKey("x");
			expect(log).toEqual(["cut:1"]);

			v.unregister("cut");
			v.handleKey("x");
			expect(log).toEqual(["cut:1"]); // no second entry
		});

		test("direct lambda and string binding coexist", () => {
			v.register("up", (n) => log.push(`up:${n}`));
			v.bind("normal", "k", "up");
			v.bind("normal", "j", (n) => log.push(`down:${n}`));
			v.handleKey("k");
			v.handleKey("j");
			expect(log).toEqual(["up:1", "down:1"]);
		});
	});

	describe("multi-key sequences", () => {
		test("longer match wins over shorter prefix", () => {
			v.register("g-action", () => log.push("g"));
			v.register("gg-action", () => log.push("gg"));
			v.bind("normal", "g", "g-action");
			v.bind("normal", "gg", "gg-action");
			v.handleKey("g");
			v.handleKey("g");
			expect(log).toEqual(["gg"]);
		});

		test("shorter prefix fires when next key doesn't continue", () => {
			v.register("g-action", () => log.push("g"));
			v.bind("normal", "g", "g-action");
			v.bind("normal", "gg", () => log.push("gg"));
			v.handleKey("g");
			v.handleKey("x"); // no "gx" binding — fires pending "g"
			expect(log).toEqual(["g"]);
		});
	});

	describe("pending timeout", () => {
		test("fires pending action after timeout expires", async () => {
			const tv = new Vym("normal", 50);
			tv.bind("normal", "g", () => log.push("g"));
			tv.bind("normal", "gg", () => log.push("gg"));

			tv.handleKey("g");
			expect(log).toEqual([]); // waiting for more input

			await new Promise((r) => setTimeout(r, 80));
			expect(log).toEqual(["g"]); // timeout fired the pending action
		});

		test("resets partial match (no action) after timeout", async () => {
			const tv = new Vym("normal", 50);
			// "g" node has no action — only children do
			tv.bind("normal", "gg", () => log.push("gg"));
			tv.bind("normal", "g+", () => log.push("g+"));

			tv.handleKey("g");
			expect(log).toEqual([]); // partial, waiting

			await new Promise((r) => setTimeout(r, 80));
			expect(log).toEqual([]); // no action to fire, but state is reset

			// Confirm reset: "gg" should work fresh
			tv.handleKey("g");
			tv.handleKey("g");
			expect(log).toEqual(["gg"]);
		});

		test("timeout is cancelled when next key arrives in time", async () => {
			const tv = new Vym("normal", 50);
			tv.bind("normal", "g", () => log.push("g"));
			tv.bind("normal", "gg", () => log.push("gg"));

			tv.handleKey("g");
			tv.handleKey("g"); // arrived before timeout
			expect(log).toEqual(["gg"]);

			await new Promise((r) => setTimeout(r, 80));
			expect(log).toEqual(["gg"]); // no extra firing
		});

		test("nudge restarts timeout for modifier-only keypresses", async () => {
			const tv = new Vym("normal", 50);
			tv.bind("normal", "+", () => log.push("zoom"));
			tv.bind("normal", "g+", () => log.push("g+"));

			tv.handleKey("g");
			await new Promise((r) => setTimeout(r, 30));
			tv.nudge(); // e.g. Shift pressed — restart timer
			await new Promise((r) => setTimeout(r, 30));
			tv.handleKey("+"); // within 50ms of nudge
			expect(log).toEqual(["g+"]);
		});

		test("nudge without timeout has no effect when not mid-sequence", () => {
			const tv = new Vym("normal", 50);
			tv.bind("normal", "+", () => log.push("zoom"));
			tv.nudge(); // no-op, cursor is null
			tv.handleKey("+");
			expect(log).toEqual(["zoom"]);
		});

		test("without nudge, shifted key fires standalone binding after timeout", async () => {
			const tv = new Vym("normal", 50);
			tv.bind("normal", "+", () => log.push("zoom"));
			tv.bind("normal", "g+", () => log.push("g+"));

			tv.handleKey("g");
			await new Promise((r) => setTimeout(r, 80)); // timeout expires
			tv.handleKey("+"); // cursor was reset — matches standalone +
			expect(log).toEqual(["zoom"]);
		});
	});

	describe("modes", () => {
		test("bindings are scoped to their mode", () => {
			v.register("down", () => log.push("down"));
			v.bind("normal", "j", "down");
			v.bind("insert", "j", () => log.push("literal-j"));

			v.handleKey("j");
			v.setMode("insert");
			v.handleKey("j");
			expect(log).toEqual(["down", "literal-j"]);
		});
	});

	describe("count prefix", () => {
		test("digits before a binding pass their number as the count", () => {
			v.bind("normal", "j", (n) => log.push(`down:${n}`));
			for (const key of ["1", "2", "j"]) v.handleKey(key);
			expect(log).toEqual(["down:12"]);
		});

		test("a bare 0 is a key of its own, not a count", () => {
			v.bind("normal", "0", (n) => log.push(`line-start:${n}`));
			v.handleKey("0");
			expect(log).toEqual(["line-start:1"]);
		});
	});

	describe("key notation", () => {
		test("bracketed keys like <C-s> are one key", () => {
			v.bind("normal", "g<C-s>", () => log.push("save-all"));
			v.handleKey("g");
			v.handleKey("<C-s>");
			expect(log).toEqual(["save-all"]);
		});

		test("normalizeKeyboardEvent names modifiers only where the key doesn't already", () => {
			const event = (init: Partial<KeyboardEvent>) => ({ ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...init }) as KeyboardEvent;
			expect(normalizeKeyboardEvent(event({ key: "J", shiftKey: true }))).toBe("J");
			expect(normalizeKeyboardEvent(event({ key: "s", ctrlKey: true }))).toBe("<C-s>");
			expect(normalizeKeyboardEvent(event({ key: "Enter", ctrlKey: true, shiftKey: true }))).toBe("<C-S-Enter>");
			expect(normalizeKeyboardEvent(event({ key: "Shift", shiftKey: true }))).toBeNull();
		});
	});
});
