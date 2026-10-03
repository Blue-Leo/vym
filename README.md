# vym

Lightweight vim-style key bindings for web apps, so power users can drive an app from the keyboard. It has no dependencies and is about 200 lines of TypeScript.

- **Modes:** each mode has its own bindings (`normal`, `insert`, or whatever your app needs).
- **Multi-key sequences:** `gg`, `dd`, `g<C-s>`. When `g` and `gg` are both bound, `g` fires if the next key doesn't continue the sequence, or after an optional timeout.
- **Count prefixes:** `3j` runs the `j` action with a count of 3. A bare `0` stays bindable.
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

## Install

`bun add github:Blue-Leo/vym#v0.1.0`. vym ships as TypeScript source, for bundlers such as Vite or Bun.

## Develop

`bun install`, then `bun test`.

## License

MIT
