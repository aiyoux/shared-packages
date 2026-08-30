import { describe, it, expect, beforeEach } from 'vitest';
import { ClipboardStore } from './clipboardStore.svelte.js';

describe('ClipboardStore', () => {
	let store: ClipboardStore;

	beforeEach(() => {
		store = new ClipboardStore();
		store.clear();
		store.syncWithSystem = false;
	});

	it('starts empty with syncWithSystem false', () => {
		expect(store.items.length).toBe(0);
		expect(store.current).toBeNull();
		expect(store.syncWithSystem).toBe(false);
	});

	it('copies item and updates current and items history', async () => {
		const item = await store.copy('test/plain', 'Test Note', { text: 'hello' }, 'hello');
		expect(store.items.length).toBe(1);
		expect(store.current).toEqual(item);
		expect(item.type).toBe('test/plain');
		expect(item.label).toBe('Test Note');
		expect(item.data).toEqual({ text: 'hello' });
		expect(item.textPreview).toBe('hello');
	});

	it('pastes matching expected type', async () => {
		await store.copy('sketcher/strokes', 'Strokes', [1, 2, 3]);
		await store.copy('text/plain', 'Text', 'my text');

		const text = await store.paste<string>('text/plain');
		expect(text).toBe('my text');

		const strokes = await store.paste<number[]>('sketcher/strokes');
		expect(strokes).toEqual([1, 2, 3]);

		const missing = await store.paste('unknown/type');
		expect(missing).toBeNull();
	});

	it('pastes latest item if no expected type specified', async () => {
		await store.copy('item-1', 'Item 1', 'first');
		await store.copy('item-2', 'Item 2', 'second');

		const latest = await store.paste();
		expect(latest).toBe('second');
	});

	it('removes item by id', async () => {
		const a = await store.copy('a', 'A', '1');
		const b = await store.copy('b', 'B', '2');
		expect(store.items.length).toBe(2);

		store.removeItem(a.id);
		expect(store.items.length).toBe(1);
		expect(store.items[0]?.id).toBe(b.id);
	});

	it('clears all items', async () => {
		await store.copy('a', 'A', '1');
		await store.copy('b', 'B', '2');
		expect(store.items.length).toBe(2);

		store.clear();
		expect(store.items.length).toBe(0);
		expect(store.current).toBeNull();
	});

	it('caps history at 20 items', async () => {
		for (let i = 0; i < 25; i++) {
			await store.copy('t', `Item ${i}`, i);
		}
		expect(store.items.length).toBe(20);
		expect(store.current?.label).toBe('Item 24');
	});
});
