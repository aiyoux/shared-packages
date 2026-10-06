/**
 * Types shared by the connection file pickers. They live in a .ts module, not
 * in a component's script — a type-only re-export out of a .svelte module does
 * not resolve under tsc (a .svelte module's named exports are values only).
 */
import type { ConnectionKind } from '../b2/index.js';
import type { ExplorerOpenTarget } from './explorerDriver.js';

/** One file the user opened: where it came from and how to read its bytes. */
export type ConnectionPick = {
	kind: ConnectionKind;
	entry: ExplorerOpenTarget;
	read: () => Promise<Blob>;
};

/** Batch multi-select Open — several files from one connection at once. */
export type ConnectionOpenMany = (picks: ConnectionPick[]) => void | Promise<void>;