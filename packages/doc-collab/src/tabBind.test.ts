import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindTabCollab } from './index.js';

type HideListener = (event: Event) => void;

function stubPagehideWindow(): void {
	const listeners = new Set<HideListener>();
	const windowStub = {
		addEventListener(type: string, fn: HideListener) {
			if (type === 'pagehide') listeners.add(fn);
		},
		removeEventListener(type: string, fn: HideListener) {
			if (type === 'pagehide') listeners.delete(fn);
		},
		dispatchEvent(event: Event) {
			if (event.type === 'pagehide') {
				for (const fn of [...listeners]) fn(event);
			}
			return true;
		}
	};
	vi.stubGlobal('window', windowStub);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('bindTabCollab', () => {
	it('stops both watches on dispose and closes once on a non-persisted pagehide', () => {
		stubPagehideWindow();
		const stopSequencer = vi.fn();
		const stopPersist = vi.fn();
		const close = vi.fn();
		const dispose = bindTabCollab({
			startSequencer: (onRole) => {
				onRole('replica');
				return stopSequencer;
			},
			startPersist: (onOwner) => {
				onOwner(false);
				return stopPersist;
			},
			close
		});
		expect(stopSequencer).not.toHaveBeenCalled();
		expect(stopPersist).not.toHaveBeenCalled();

		globalThis.window.dispatchEvent(new Event('pagehide'));
		expect(close).toHaveBeenCalledTimes(1);

		dispose();
		expect(stopSequencer).toHaveBeenCalledTimes(1);
		expect(stopPersist).toHaveBeenCalledTimes(1);

		globalThis.window.dispatchEvent(new Event('pagehide'));
		expect(close).toHaveBeenCalledTimes(1);
	});

	it('does not close when pagehide is persisted', () => {
		stubPagehideWindow();
		const close = vi.fn();
		const dispose = bindTabCollab({
			startSequencer: () => () => {},
			startPersist: () => () => {},
			close
		});
		const persisted = new Event('pagehide');
		Object.defineProperty(persisted, 'persisted', { value: true });
		globalThis.window.dispatchEvent(persisted);
		expect(close).not.toHaveBeenCalled();
		dispose();
	});
});
