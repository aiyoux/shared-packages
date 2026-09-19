import { describe, expect, it, vi } from 'vitest';
import { createAttachRegistry } from './attach.js';

const peerA = { kind: 'peer' } as const;
const tabA = { kind: 'tab' } as const;

describe('attach registry', () => {
	it('returns BOTH slots — the bug was choosing between them', () => {
		const reg = createAttachRegistry<object>();
		reg.setTab(tabA);
		reg.setPeer(peerA);
		expect(reg.active()).toEqual([peerA, tabA]);
	});

	it('hands the tab slot back when a peer disconnects', () => {
		const reg = createAttachRegistry<object>();
		reg.setTab(tabA);
		reg.setPeer(peerA);
		reg.setPeer(null);
		expect(reg.active()).toEqual([tabA]);
	});

	it('is empty when nothing is attached', () => {
		expect(createAttachRegistry<object>().active()).toEqual([]);
	});

	it('does not notify when the live set is unchanged', () => {
		const reg = createAttachRegistry<object>();
		const fn = vi.fn();
		reg.subscribe(fn);
		reg.setTab(tabA);
		expect(fn).toHaveBeenCalledTimes(1);
		// Same object again: a rebuild here would mint a new clientId and pile
		// up duplicate peers.
		reg.setTab(tabA);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('notifies on a real change, and unsubscribes', () => {
		const reg = createAttachRegistry<object>();
		const fn = vi.fn();
		const off = reg.subscribe(fn);
		reg.setPeer(peerA);
		expect(fn).toHaveBeenCalledTimes(1);
		off();
		reg.setPeer(null);
		expect(fn).toHaveBeenCalledTimes(1);
	});
});
