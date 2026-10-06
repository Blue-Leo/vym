// Vym — lightweight vim-style key binding engine.
//
// Each mode owns a trie of key sequences. Keys are fed in one at a time via
// handleKey(); when a sequence matches, the bound action fires.
//
// Actions can be bound as direct lambdas or as string command names that
// resolve through a registry at execution time — keeping binding config
// serializable across Comlink / postMessage boundaries.
//
// Usage:
//   const v = new Vym();
//   v.register('move-down', (n) => editor.moveDown(n));
//   v.bind('normal', 'j',  'move-down');       // string → registry lookup
//   v.bind('normal', 'dd', (n) => del(n));      // direct lambda
//   v.bind('normal', 'gg', 'goto-top');
//   // feed keys from a keydown listener:
//   v.handleKey(normalizeKeyboardEvent(e));

import { insertSequence, trieNode, type TrieAction, type TrieNode } from './trie';

export { History, DEFAULT_HISTORY_CAP, type HistoryEntry, type HistoryOp, type HistoryOptions } from './history';

export class Vym {
	private readonly roots: Map<string, TrieNode> = new Map();   // mode → root of its trie
	private readonly commands: Map<string, TrieAction> = new Map(); // name → action
	private cursor: TrieNode | null = null;   // current position in the active trie
	private count = 0;                        // accumulated numeric prefix (e.g. "3" in "3j")
	private pendingAction: TrieAction | null = null; // action at an ambiguous node (has children)
	private pendingTimer: ReturnType<typeof setTimeout> | null = null;

	// timeoutMs: how long a partial sequence waits for its next key; 0 waits forever.
	constructor(private mode = 'normal', private readonly timeoutMs = 0) {}

	setMode(mode: string): void {
		this.mode = mode;
		this.reset();
	}

	// Register a named command. Bindings that reference this name will
	// resolve here at execution time, so register/bind order doesn't matter.
	register(name: string, action: TrieAction): void {
		this.commands.set(name, action);
	}

	unregister(name: string): void {
		this.commands.delete(name);
	}

	// Bind a key sequence in a mode to either a command name or a direct lambda.
	// String actions are looked up in the command registry when the binding fires.
	bind(mode: string, keys: string, action: string | TrieAction): void {
		const resolved = typeof action === 'string'
			? (count: number) => { this.commands.get(action)?.(count); }
			: action;
		insertSequence(this.rootFor(mode), parseKeys(keys), resolved);
	}

	// Feed a single key. Call this from a keydown listener.
	// Accumulates a numeric prefix, then walks the trie for the current mode.
	// When a full sequence matches, fires the bound action with the count.
	handleKey(key: string): void {
		// Numeric prefix: "3j" → count=3, then "j" fires with count 3.
		// '0' only counts if a digit was already pressed (so bare '0' can be bound).
		if (this.cursor === null && isCountDigit(key, this.count)) {
			this.count = this.count * 10 + parseInt(key, 10);
			return;
		}
		const next = (this.cursor ?? this.rootFor(this.mode)).children.get(key);
		if (next) this.advance(next);
		// No match — if a shorter prefix had an action (ambiguous node), fire it.
		// e.g. both "g" and "gg" are bound; "g" then "x" fires "g".
		else if (this.pendingAction) this.exec(this.pendingAction);
		else this.reset();
	}

	// Restart the timeout if mid-sequence (e.g. a modifier-only keypress like
	// Shift indicates the user is still composing a sequence, not idle).
	nudge(): void {
		if (this.cursor !== null) this.startTimeout();
	}

	reset(): void {
		this.clearTimeout();
		this.cursor = null;
		this.count = 0;
		this.pendingAction = null;
	}

	// One trie per mode, created on first use.
	private rootFor(mode: string): TrieNode {
		let root = this.roots.get(mode);
		if (!root) this.roots.set(mode, (root = trieNode()));
		return root;
	}

	// Step onto a matched node. A leaf fires at once; a node holding an action
	// AND longer sequences is ambiguous, so its action is stashed to fire if
	// the next key doesn't continue (or the timeout expires); a bare partial
	// match only waits for the follow-up key (e.g. "g" then a pause resets).
	private advance(next: TrieNode): void {
		this.cursor = next;
		if (next.action && next.children.size === 0) {
			this.exec(next.action);
			return;
		}
		if (next.action) this.pendingAction = next.action;
		this.startTimeout();
	}

	// If timeoutMs > 0, start a timer. On expiry: fire pending action if one
	// exists (ambiguous node), otherwise just reset (partial with no action).
	private startTimeout(): void {
		if (this.timeoutMs <= 0) return;
		this.clearTimeout();
		this.pendingTimer = setTimeout(() => {
			if (this.pendingAction) this.exec(this.pendingAction);
			else this.reset();
		}, this.timeoutMs);
	}

	private clearTimeout(): void {
		if (this.pendingTimer !== null) {
			clearTimeout(this.pendingTimer);
			this.pendingTimer = null;
		}
	}

	private exec(action: TrieAction): void {
		const count = this.count || 1;
		this.reset();
		action(count);
	}
}

// '1'-'9' always start/extend a count. '0' extends only if count already > 0.
const isCountDigit = (key: string, currentCount: number): boolean =>
	(key.length === 1 && key >= '1' && key <= '9') || (key === '0' && currentCount > 0);

// Split key notation into tokens. Single chars are individual tokens;
// bracketed sequences like "<C-s>" or "<Enter>" are kept as one token.
//   "gg"       → ["g", "g"]
//   "<C-s>"    → ["<C-s>"]
//   "g<C-s>"   → ["g", "<C-s>"]
const parseKeys = (notation: string): string[] => {
	const keys: string[] = [];
	let i = 0;
	while (i < notation.length) {
		if (notation[i] === '<') {
			const end = notation.indexOf('>', i);
			if (end !== -1) { keys.push(notation.substring(i, end + 1)); i = end + 1; continue; }
		}
		keys.push(notation[i]);
		i++;
	}
	return keys;
};

// Convert a DOM KeyboardEvent to a vym key string. Returns null for
// modifier-only presses. Shift is only explicit for non-printable keys
// or when combined with Ctrl/Alt/Meta (for printable chars it's already
// reflected in the key value, e.g. 'J' not 'j').
//   'j'  |  'J'  |  '<C-s>'  |  '<Enter>'  |  '<C-S-Enter>'
export const normalizeKeyboardEvent = (e: KeyboardEvent): string | null => {
	const { key, ctrlKey, altKey, metaKey, shiftKey } = e;
	if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') return null;

	const mods: string[] = [];
	if (ctrlKey) mods.push('C');
	if (altKey) mods.push('A');
	if (metaKey) mods.push('M');
	if (shiftKey && (key.length > 1 || ctrlKey || altKey || metaKey)) mods.push('S');

	if (mods.length === 0 && key.length === 1) return key;
	return `<${[...mods, key].join('-')}>`;
};
