import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	HUB_RCLONE_PROFILES_CHANNEL,
	notifyTabChannel,
	subscribeTabChannel
} from '../src/crossTab.ts';

function wait(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

describe('crossTab BroadcastChannel', () => {
	it('subscribeTabChannel receives notifyTabChannel on another instance', async () => {
		let hits = 0;
		const unsub = subscribeTabChannel(HUB_RCLONE_PROFILES_CHANNEL, () => {
			hits += 1;
		});
		notifyTabChannel(HUB_RCLONE_PROFILES_CHANNEL);
		const deadline = Date.now() + 1000;
		while (hits < 1 && Date.now() < deadline) await wait(10);
		assert.equal(hits, 1);
		unsub();
		notifyTabChannel(HUB_RCLONE_PROFILES_CHANNEL);
		await wait(30);
		assert.equal(hits, 1);
	});

	it('swallows missing BroadcastChannel', () => {
		const orig = globalThis.BroadcastChannel;
		try {
			// @ts-expect-error -- simulate missing API
			globalThis.BroadcastChannel = undefined;
			assert.doesNotThrow(() => notifyTabChannel('hub-b2-profiles'));
			const unsub = subscribeTabChannel('hub-b2-profiles', () => {
				throw new Error('must not fire');
			});
			assert.equal(typeof unsub, 'function');
			unsub();
		} finally {
			globalThis.BroadcastChannel = orig;
		}
	});
});
