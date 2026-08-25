import { describe, expect, it } from 'vitest';
import { allowlistedHref, allowlistedSrc } from './href.js';
import { project } from './project.js';
import { callout, code, divider, heading, image, item, page, para } from './testFixtures.js';

function host(): HTMLDivElement {
	const el = document.createElement('div');
	document.body.append(el);
	return el;
}

describe('project', () => {
	it('does not use innerHTML', () => {
		const el = host();
		const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!;
		let wrote = false;
		Object.defineProperty(Element.prototype, 'innerHTML', {
			configurable: true,
			get: desc.get,
			set() {
				wrote = true;
			}
		});
		try {
			project(el, page([para('p', 'hello')]));
			expect(wrote).toBe(false);
		} finally {
			Object.defineProperty(Element.prototype, 'innerHTML', desc);
			el.remove();
		}
	});

	it('empty block click+type: persistent empty Text node is the restore target', () => {
		const el = host();
		project(el, page([para('p', '')]));
		const block = el.querySelector('[data-block-id="p"]') as HTMLElement;
		const text = [...block.childNodes].find((n) => n.nodeType === Node.TEXT_NODE) as Text;
		expect(text).toBeTruthy();
		expect(text.data).toBe('');
		text.data = 'A';
		expect(block.querySelector('br')).toBeNull();
		el.remove();
	});

	it('projects an empty paragraph as an empty Text node and strips magic br', () => {
		const el = host();
		el.appendChild(document.createElement('br'));
		project(el, page([para('p', '')]));
		const block = el.querySelector('[data-block-id="p"]') as HTMLElement;
		expect(block).toBeTruthy();
		expect(block.tagName).toBe('P');
		expect(block.querySelector('br')).toBeNull();
		const texts = [...block.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE) as Text[];
		expect(texts.length).toBeGreaterThanOrEqual(1);
		expect(texts[0].data).toBe('');
		el.remove();
	});

	it('wraps marks without flattening via textContent on the block', () => {
		const el = host();
		project(
			el,
			page([
				{
					id: 'p',
					type: 'paragraph',
					content: [{ type: 'text', text: 'b', marks: [{ type: 'bold' }, { type: 'italic' }] }]
				}
			])
		);
		const block = el.querySelector('[data-block-id="p"]')!;
		expect(block.querySelector('strong')).toBeTruthy();
		expect(block.querySelector('em')).toBeTruthy();
		expect(block.textContent).toBe('b');
		el.remove();
	});

	it('allowlists link href and blocks javascript/data/vbscript', () => {
		const el = host();
		project(
			el,
			page([
				{
					id: 'p',
					type: 'paragraph',
					content: [
						{ type: 'text', text: 'x', marks: [{ type: 'link', href: 'javascript:alert(1)' }] },
						{ type: 'text', text: 'y', marks: [{ type: 'link', href: 'https://example.com' }] },
						{ type: 'text', text: 'z', marks: [{ type: 'link', href: 'data:text/html,x' }] }
					]
				}
			])
		);
		const anchors = [...el.querySelectorAll('a')];
		expect(anchors.some((a) => a.getAttribute('href')?.startsWith('javascript:'))).toBe(false);
		expect(anchors.some((a) => a.getAttribute('href')?.startsWith('data:'))).toBe(false);
		expect(anchors.some((a) => a.getAttribute('href') === 'https://example.com')).toBe(true);
		el.remove();
	});

	it('does not wrap list_item in ul/ol; each item is a direct child of the host', () => {
		const el = host();
		project(el, page([item('a', 'one'), item('b', 'two', true), heading('h', 'H', 2), code('c', 'x=1'), divider('d')]));
		expect(el.querySelector('ul')).toBeNull();
		expect(el.querySelector('ol')).toBeNull();
		expect([...el.children].map((c) => c.getAttribute('data-block-id'))).toEqual(['a', 'b', 'h', 'c', 'd']);
		expect(el.querySelector('[data-block-id="a"]')?.getAttribute('data-block-type')).toBe('list_item');
		expect(el.querySelector('[data-block-id="h"]')?.tagName).toBe('H2');
		expect(el.querySelector('[data-block-id="c"]')?.tagName).toBe('PRE');
		expect(el.querySelector('[data-block-id="d"]')?.tagName).toBe('HR');
		el.remove();
	});

	it('projects an image block as createElement img with alt and page-relative src', () => {
		const el = host();
		project(el, page([image('i', 'assets/diagram.png', 'Diagram')]));
		const block = el.querySelector('[data-block-id="i"]') as HTMLElement;
		expect(block.getAttribute('data-block-type')).toBe('image');
		const img = block.tagName === 'IMG' ? (block as HTMLImageElement) : block.querySelector('img');
		expect(img).toBeTruthy();
		expect(img!.getAttribute('src')).toBe('assets/diagram.png');
		expect(img!.getAttribute('alt')).toBe('Diagram');
		el.remove();
	});

	it('does not set javascript/data image src', () => {
		const el = host();
		project(
			el,
			page([
				image('a', 'javascript:alert(1)', 'x'),
				image('b', 'data:image/png;base64,aaaa', 'y')
			])
		);
		const imgs = [...el.querySelectorAll('img')];
		expect(imgs.length).toBeGreaterThanOrEqual(2);
		for (const img of imgs) {
			expect(img.getAttribute('src')).toBeNull();
		}
		el.remove();
	});

	it('projects nested children as host-direct siblings in visible order', () => {
		const el = host();
		project(el, page([callout('c', [para('n', 'inside')]), para('z', 'Z')]));
		expect([...el.children].map((c) => c.getAttribute('data-block-id'))).toEqual(['c', 'n', 'z']);
		expect(el.querySelector('[data-block-id="n"]')?.getAttribute('data-parent-id')).toBe('c');
		expect(el.querySelector('[data-block-id="n"]')?.getAttribute('data-depth')).toBe('1');
		expect(el.querySelector('[data-block-id="c"]')?.getAttribute('data-block-type')).toBe('callout');
		el.remove();
	});
});

describe('allowlistedHref', () => {
	it('allows http(s), slash, and relative; blocks javascript/data/vbscript', () => {
		expect(allowlistedHref('https://a.com')).toBe('https://a.com');
		expect(allowlistedHref('http://a.com')).toBe('http://a.com');
		expect(allowlistedHref('/wiki')).toBe('/wiki');
		expect(allowlistedHref('getting-started')).toBe('getting-started');
		expect(allowlistedHref('javascript:alert(1)')).toBeNull();
		expect(allowlistedHref('data:text/html,x')).toBeNull();
		expect(allowlistedHref('vbscript:msgbox(1)')).toBeNull();
		expect(allowlistedHref('\0javascript:alert(1)')).toBeNull();
		expect(allowlistedHref(' javascript:alert(1)')).toBeNull();
		expect(allowlistedHref('java\nscript:alert(1)')).toBeNull();
	});
});

describe('allowlistedSrc', () => {
	it('allows page-relative assets/<file> and blocks javascript/data like href', () => {
		expect(allowlistedSrc('assets/diagram.png')).toBe('assets/diagram.png');
		expect(allowlistedSrc('javascript:alert(1)')).toBeNull();
		expect(allowlistedSrc('data:image/png;base64,aaaa')).toBeNull();
		expect(allowlistedSrc('vbscript:msgbox(1)')).toBeNull();
		expect(allowlistedSrc('\0javascript:alert(1)')).toBeNull();
		expect(allowlistedSrc('https://evil.com/x.png')).toBeNull();
		expect(allowlistedSrc('/assets/x.png')).toBeNull();
		expect(allowlistedSrc('assets/../secret.png')).toBeNull();
		expect(allowlistedSrc('diagram.png')).toBeNull();
	});
});
