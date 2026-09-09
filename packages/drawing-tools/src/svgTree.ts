import { generateId } from './id.ts';
import type { SvgElement, SvgGroupElement, SvgTransform } from './types.ts';

export function isSvgGroup(el: SvgElement | undefined | null): el is SvgGroupElement {
	return el?.type === 'group';
}

export function copySvgTransform(t: SvgTransform | undefined): SvgTransform | undefined {
	if (!t) return t;
	const next: SvgTransform = { x: t.x, y: t.y };
	if (t.rotation != null) next.rotation = t.rotation;
	if (t.sx != null) next.sx = t.sx;
	if (t.sy != null) next.sy = t.sy;
	return next;
}

export function copySvgElement(el: SvgElement): SvgElement {
	if (el.type === 'group') {
		return {
			type: 'group',
			id: el.id,
			children: copySvgElements(el.children),
			transform: copySvgTransform(el.transform),
			opacity: el.opacity,
			hidden: el.hidden
		};
	}
	return { ...el };
}

export function copySvgElements(elements: SvgElement[]): SvgElement[] {
	return elements.map(copySvgElement);
}

/** New ids throughout. Groups keep structure. */
export function cloneSvgElement(el: SvgElement): SvgElement {
	if (el.type === 'group') {
		return {
			type: 'group',
			id: generateId(),
			children: el.children.map(cloneSvgElement),
			transform: copySvgTransform(el.transform),
			opacity: el.opacity,
			hidden: el.hidden
		};
	}
	return { ...el, id: generateId() };
}

export function findSvgElement(elements: SvgElement[], id: string): SvgElement | null {
	for (const el of elements) {
		if (el.id === id) return el;
		if (el.type === 'group') {
			const inner = findSvgElement(el.children, id);
			if (inner) return inner;
		}
	}
	return null;
}

/** Depth-first: each group, then its descendants. */
export function flattenSvgElements(elements: SvgElement[]): SvgElement[] {
	const out: SvgElement[] = [];
	const walk = (list: SvgElement[]) => {
		for (const el of list) {
			out.push(el);
			if (el.type === 'group') walk(el.children);
		}
	};
	walk(elements);
	return out;
}

export function mapSvgElement(
	elements: SvgElement[],
	id: string,
	fn: (el: SvgElement) => SvgElement
): SvgElement[] {
	return elements.map((el) => {
		if (el.id === id) return fn(el);
		if (el.type === 'group') {
			return { ...el, children: mapSvgElement(el.children, id, fn) };
		}
		return el;
	});
}

export function deleteSvgElements(elements: SvgElement[], ids: string[]): SvgElement[] {
	const drop = new Set(ids);
	const walk = (list: SvgElement[]): SvgElement[] =>
		list
			.filter((el) => !drop.has(el.id))
			.map((el) => (el.type === 'group' ? { ...el, children: walk(el.children) } : el));
	return walk(elements);
}

/**
 * Wrap current siblings named by `ids` in a new group, inserted where the
 * first selected sibling sat. Ids that are not siblings at this level are
 * ignored. Returns the original array when fewer than two siblings match.
 */
export function groupSvgElements(elements: SvgElement[], ids: string[]): SvgElement[] {
	const want = new Set(ids);
	const children = elements.filter((el) => want.has(el.id));
	if (children.length < 2) {
		return elements.map((el) =>
			el.type === 'group' ? { ...el, children: groupSvgElements(el.children, ids) } : el
		);
	}
	const first = elements.findIndex((el) => want.has(el.id));
	const group: SvgGroupElement = { type: 'group', id: generateId(), children };
	const before = elements.slice(0, first).filter((el) => !want.has(el.id));
	const after = elements.slice(first + 1).filter((el) => !want.has(el.id));
	return [...before, group, ...after];
}

export function ungroupSvgElement(elements: SvgElement[], groupId: string): SvgElement[] {
	const out: SvgElement[] = [];
	for (const el of elements) {
		if (el.type === 'group' && el.id === groupId) {
			out.push(...el.children);
			continue;
		}
		if (el.type === 'group') {
			out.push({ ...el, children: ungroupSvgElement(el.children, groupId) });
			continue;
		}
		out.push(el);
	}
	return out;
}

/** Pull named nodes out of the tree. Ancestors named in `ids` keep their children. */
export function extractSvgElements(
	elements: SvgElement[],
	ids: string[]
): { tree: SvgElement[]; taken: SvgElement[] } {
	const want = new Set(ids);
	const taken: SvgElement[] = [];
	const walk = (list: SvgElement[]): SvgElement[] => {
		const out: SvgElement[] = [];
		for (const el of list) {
			if (want.has(el.id)) {
				taken.push(el);
				continue;
			}
			if (el.type === 'group') out.push({ ...el, children: walk(el.children) });
			else out.push(el);
		}
		return out;
	};
	return { tree: walk(elements), taken };
}

function insertSvgSiblings(
	list: SvgElement[],
	items: SvgElement[],
	beforeId?: string | null,
	afterId?: string | null
): SvgElement[] {
	if (beforeId) {
		const i = list.findIndex((el) => el.id === beforeId);
		if (i >= 0) return [...list.slice(0, i), ...items, ...list.slice(i)];
	}
	if (afterId) {
		const i = list.findIndex((el) => el.id === afterId);
		if (i >= 0) return [...list.slice(0, i + 1), ...items, ...list.slice(i + 1)];
	}
	return [...list, ...items];
}

function insertSvgElements(
	elements: SvgElement[],
	items: SvgElement[],
	target: { groupId: string | null; beforeId?: string | null; afterId?: string | null }
): SvgElement[] {
	if (!items.length) return elements;
	if (!target.groupId) return insertSvgSiblings(elements, items, target.beforeId, target.afterId);
	return elements.map((el) => {
		if (el.type === 'group' && el.id === target.groupId) {
			return {
				...el,
				children: insertSvgSiblings(el.children, items, target.beforeId, target.afterId)
			};
		}
		if (el.type === 'group') {
			return { ...el, children: insertSvgElements(el.children, items, target) };
		}
		return el;
	});
}

/** Move named nodes into `target.groupId` (null = layer root), optionally beside a sibling. */
export function reparentSvgElements(
	elements: SvgElement[],
	ids: string[],
	target: { groupId: string | null; beforeId?: string | null; afterId?: string | null }
): SvgElement[] {
	if (!ids.length) return elements;
	const { tree, taken } = extractSvgElements(elements, ids);
	if (!taken.length) return elements;
	return insertSvgElements(tree, taken, target);
}
