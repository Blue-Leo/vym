// Undo, redo and repeat history, vim-style (u, redo, `.`).
//
// The app records each change as a HistoryEntry holding its own undo, redo and
// optional repeat functions, any of which may be async (e.g. reversing a change
// on a server). History owns the stacks and runs every operation one at a time,
// in the order asked, so a quick `uu` or `3u` reverses changes sequentially.
//
// Usage:
//   const history = new History({ repeatTarget: () => selectedGoal, onEmpty: (op) => toast(`Nothing to ${op}`) });
//   history.record({ label: 'complete goal', undo: () => api.reopen(id), redo: () => api.complete(id),
//     repeat: (goal) => completeGoal(goal) });
//   history.registerCommands(vym); // "undo", "redo", "repeat", honoring counts

import type { Vym } from './index';

export type HistoryOp = 'undo' | 'redo' | 'repeat';

export type HistoryEntry<Target = undefined> = {
	label: string;
	undo: () => void | Promise<void>;
	redo: () => void | Promise<void>;
	// Applies the same change to `target`, returning the entry for that new change
	// (so `u` undoes a repeat), or nothing when it can't apply there.
	repeat?: (target: Target) => HistoryEntry<Target> | void | Promise<HistoryEntry<Target> | void>;
};

export type HistoryOptions<Target = undefined> = {
	// Most undo entries kept; the oldest drop first. Defaults to 100.
	cap?: number;
	// The target `.` applies to, read at the moment each repeat runs.
	repeatTarget?: () => Target;
	// Called when an operation finds nothing to do, so the app can say "Nothing to undo".
	onEmpty?: (op: HistoryOp) => void;
	// Called when an entry's function throws or rejects. Defaults to console.error.
	onError?: (op: HistoryOp, label: string, error: unknown) => void;
};

// The outcome of one step: a failed step stops the rest of a count.
type StepResult = 'done' | 'empty' | 'failed';

export const DEFAULT_HISTORY_CAP = 100;

export class History<Target = undefined> {
	private readonly undoStack: HistoryEntry<Target>[] = [];
	private readonly redoStack: HistoryEntry<Target>[] = [];
	// The change `.` repeats: the latest recorded or repeated one. Undo leaves it, as in vim.
	private lastChange: HistoryEntry<Target> | null = null;
	// Tail of the operation queue; each operation starts when the previous settles.
	private queueTail: Promise<unknown> = Promise.resolve();
	private replaying = false;
	private readonly cap: number;

	constructor(private readonly options: HistoryOptions<Target> = {}) {
		this.cap = options.cap ?? DEFAULT_HISTORY_CAP;
		if (!Number.isInteger(this.cap) || this.cap < 1) throw new RangeError(`History cap must be a positive integer, got ${this.cap}`);
	}

	// True while an undo, redo or repeat runs. Records made then are side effects
	// of the replay (the app's own save code), so they're ignored.
	get isReplaying(): boolean {
		return this.replaying;
	}

	get canUndo(): boolean {
		return this.undoStack.length > 0;
	}

	get canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	// Push a new change. Clears redo, since the redo entries assumed the old state.
	// Returns false when ignored during a replay.
	record(entry: HistoryEntry<Target>): boolean {
		if (this.replaying) return false;
		this.pushChange(entry);
		return true;
	}

	// Each resolves to the number of steps that ran; it never rejects, since
	// errors go to onError.
	undo(count = 1): Promise<number> {
		return this.enqueue('undo', count, () => this.move(this.undoStack, this.redoStack, 'undo'));
	}

	redo(count = 1): Promise<number> {
		return this.enqueue('redo', count, () => this.move(this.redoStack, this.undoStack, 'redo'));
	}

	repeat(count = 1): Promise<number> {
		return this.enqueue('repeat', count, () => this.repeatOnce());
	}

	clear(): void {
		this.undoStack.length = 0;
		this.redoStack.length = 0;
		this.lastChange = null;
	}

	// Register "undo", "redo" and "repeat" as vym commands, so the app binds them
	// to keys of its choosing and a count prefix (3u) runs that many steps.
	registerCommands(vym: Pick<Vym, 'register'>): void {
		vym.register('undo', (count) => { void this.undo(count); });
		vym.register('redo', (count) => { void this.redo(count); });
		vym.register('repeat', (count) => { void this.repeat(count); });
	}

	private pushChange(entry: HistoryEntry<Target>): void {
		this.pushCapped(entry);
		this.redoStack.length = 0;
		this.lastChange = entry;
	}

	private pushCapped(entry: HistoryEntry<Target>): void {
		this.undoStack.push(entry);
		if (this.undoStack.length > this.cap) this.undoStack.shift();
	}

	// Chain an operation behind the ones already queued, so they never overlap.
	private enqueue(op: HistoryOp, count: number, step: () => Promise<StepResult>): Promise<number> {
		const run = this.queueTail.then(() => this.runSteps(op, count, step));
		// A throwing onEmpty/onError rejects only this run, never the operations after it.
		this.queueTail = run.catch(() => {});
		return run;
	}

	// Run up to `count` steps, stopping at the first that finds nothing or fails.
	// onEmpty fires only when no step ran, since a partial `3u` did something.
	private async runSteps(op: HistoryOp, count: number, step: () => Promise<StepResult>): Promise<number> {
		this.replaying = true;
		let stepsDone = 0;
		try {
			while (stepsDone < count) {
				const result = await step();
				if (result === 'empty' && stepsDone === 0) this.options.onEmpty?.(op);
				if (result !== 'done') break;
				stepsDone++;
			}
		} finally {
			this.replaying = false;
		}
		return stepsDone;
	}

	// Undo or redo the top entry of `from`, then hand it to `to`. A failed entry
	// is dropped from both stacks: its state is unknown, so neither retrying it
	// nor offering its reverse would be safe.
	private async move(from: HistoryEntry<Target>[], to: HistoryEntry<Target>[], op: 'undo' | 'redo'): Promise<StepResult> {
		const entry = from.pop();
		if (!entry) return 'empty';
		try {
			await entry[op]();
		} catch (error) {
			this.reportError(op, entry.label, error);
			return 'failed';
		}
		if (to === this.undoStack) this.pushCapped(entry);
		else to.push(entry);
		return 'done';
	}

	// Apply the last change to the current target and record the result as a new change.
	private async repeatOnce(): Promise<StepResult> {
		const entry = this.lastChange;
		if (!entry?.repeat) return 'empty';
		let repeated: HistoryEntry<Target> | void;
		// Without a repeatTarget getter, Target is the default undefined.
		try {
			repeated = await entry.repeat(this.options.repeatTarget?.() as Target);
		} catch (error) {
			this.reportError('repeat', entry.label, error);
			return 'failed';
		}
		if (!repeated) return 'empty';
		this.pushChange(repeated);
		return 'done';
	}

	private reportError(op: HistoryOp, label: string, error: unknown): void {
		if (this.options.onError) this.options.onError(op, label, error);
		else console.error(`vym history: ${op} "${label}" failed`, error);
	}
}
