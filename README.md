# vym

Lightweight vim-style key bindings for web apps, so power users can drive an app from the keyboard. It has no dependencies and is about 400 lines of TypeScript.

- **Modes:** each mode has its own bindings (`normal`, `insert`, or whatever your app needs).
- **Multi-key sequences:** `gg`, `dd`, `g<C-s>`. When `g` and `gg` are both bound, `g` fires if the next key doesn't continue the sequence, or after an optional timeout.
- **Count prefixes:** `3j` runs the `j` action with a count of 3. A bare `0` stays bindable.
- **Undo, redo and repeat:** an optional `History` keeps async-friendly undo and redo stacks and a vim-style `.`.
- **Named commands:** bind a key to a command name and register its action separately, in either order. That keeps binding config serializable, for example across `postMessage`.

```ts
import { Vym, normalizeKeyboardEvent } from "vym";

const vym = new Vym("normal", 1000); // a partial sequence waits up to 1s for its next key
vym.register("next-goal", (count) => selectGoal(+count));
vym.bind("normal", "j", "next-goal");
vym.bind("normal", "gg", () => selectGoal("first"));

window.addEventListener("keydown", (e) => {
	const key = normalizeKeyboardEvent(e);
	if (key) vym.handleKey(key);
	else vym.nudge(); // a modifier press means the user is still typing a sequence
});
```

`normalizeKeyboardEvent` turns a `KeyboardEvent` into vym's key notation: `j`, `J`, `<C-s>`, `<Enter>`, `<C-S-Enter>`.

## History

`History` gives an app undo, redo and repeat. The app records each change with the functions that reverse and reapply it, which may be async (e.g. calls to a server). Operations run one at a time in order, so `3u` reverses three changes, awaiting each. Changes the app records while an undo, redo or repeat runs (its own save code reacting) are ignored.

```ts
import { History, Vym, type HistoryEntry } from "vym";

const history = new History<Goal>({
	repeatTarget: () => selectedGoal, // what `.` applies to
	onEmpty: (op) => showAlert(`Nothing to ${op}`),
	onError: (op, label, error) => showAlert(`Couldn't ${op} ${label}`),
});

const completeGoal = async (goal: Goal): Promise<HistoryEntry<Goal>> => {
	await api.complete(goal.id);
	return {
		label: "complete goal",
		undo: () => api.reopen(goal.id),
		redo: () => api.complete(goal.id),
		repeat: (target) => completeGoal(target), // the new entry, so `u` undoes a repeat
	};
};
history.record(await completeGoal(selectedGoal));

history.registerCommands(vym); // "undo", "redo" and "repeat", honoring counts
vym.bind("normal", "u", "undo");
vym.bind("normal", "r", "redo"); // not <C-r>: browsers own it
vym.bind("normal", ".", "repeat");
```

Recording clears redo. Undo keeps the newest 100 entries (`cap` changes it). An undo or redo that throws drops its entry, stops the rest of a count and goes to `onError`. `.` repeats the latest recorded or repeated change, even after it was undone, as in vim; a `repeat` that returns nothing reports `onEmpty("repeat")`.

## Install

`bun add github:Blue-Leo/vym#v0.2.0`. vym ships as TypeScript source, for bundlers such as Vite or Bun.

## Develop

`bun install`, then `bun test`.

## License

MIT
