// Prefix trie mapping key sequences to actions — one per Vym mode.
export type TrieAction = (count: number) => void;

/** A single key in a sequence. Leaf nodes (or intermediates) may hold an action. */
export type TrieNode = { children: Map<string, TrieNode>; action: TrieAction | null };

export const trieNode = (): TrieNode => ({ children: new Map(), action: null });

/** Walk/create the path for `keys` under `root`, attaching `action` at the end. */
export const insertSequence = (root: TrieNode, keys: readonly string[], action: TrieAction): void => {
	let node = root;
	for (const key of keys) {
		let child = node.children.get(key);
		if (!child) node.children.set(key, (child = trieNode()));
		node = child;
	}
	node.action = action;
};
