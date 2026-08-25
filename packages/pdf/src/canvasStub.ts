/** Minimal 2D context so pdf.js can paint with disableFontFace and compile glyph DrawOPS. */

export function ensurePath2D(): void {
	if (typeof (globalThis as { Path2D?: unknown }).Path2D !== 'undefined') return;
	(globalThis as { Path2D: unknown }).Path2D = class {
		constructor(_d?: string) {}
		addPath() {}
		moveTo() {}
		lineTo() {}
		bezierCurveTo() {}
		quadraticCurveTo() {}
		closePath() {}
		rect() {}
		ellipse() {}
		arc() {}
	};
}

export function stubContext2d(): CanvasRenderingContext2D {
	const noop = () => undefined;
	const ident = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
	const canvas: { width: number; height: number; getContext: (id: string) => CanvasRenderingContext2D } = {
		width: 1,
		height: 1,
		getContext: (_id: string) => ctx as unknown as CanvasRenderingContext2D
	};
	const ctx: Record<string, unknown> = {
		canvas,
		fillStyle: '#000000',
		strokeStyle: '#000000',
		lineWidth: 1,
		lineCap: 'butt',
		lineJoin: 'miter',
		miterLimit: 10,
		globalAlpha: 1,
		globalCompositeOperation: 'source-over',
		font: '10px sans-serif',
		textAlign: 'start',
		textBaseline: 'alphabetic',
		direction: 'ltr',
		shadowBlur: 0,
		shadowColor: 'rgba(0,0,0,0)',
		lineDashOffset: 0,
		filter: 'none',
		imageSmoothingEnabled: false,
		save: noop,
		restore: noop,
		scale: noop,
		rotate: noop,
		translate: noop,
		transform: noop,
		setTransform: noop,
		resetTransform: noop,
		getTransform: () => ({ ...ident, is2D: true, isIdentity: true }),
		beginPath: noop,
		closePath: noop,
		moveTo: noop,
		lineTo: noop,
		bezierCurveTo: noop,
		quadraticCurveTo: noop,
		arc: noop,
		arcTo: noop,
		ellipse: noop,
		rect: noop,
		fill: noop,
		stroke: noop,
		clip: noop,
		fillRect: noop,
		strokeRect: noop,
		clearRect: noop,
		fillText: noop,
		strokeText: noop,
		measureText: (t: string) => ({
			width: (t?.length ?? 0) * 5,
			actualBoundingBoxAscent: 8,
			actualBoundingBoxDescent: 2,
			actualBoundingBoxLeft: 0,
			actualBoundingBoxRight: (t?.length ?? 0) * 5,
			fontBoundingBoxAscent: 8,
			fontBoundingBoxDescent: 2
		}),
		drawImage: noop,
		createLinearGradient: () => ({ addColorStop: noop }),
		createRadialGradient: () => ({ addColorStop: noop }),
		createPattern: () => null,
		getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1, colorSpace: 'srgb' }),
		putImageData: noop,
		createImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
		setLineDash: noop,
		getLineDash: () => [],
		isPointInPath: () => false,
		isPointInStroke: () => false
	};
	return ctx as unknown as CanvasRenderingContext2D;
}

export type PathBank = Map<string, ArrayLike<number>>;

type Objs = {
	get: (id: string, cb?: (v: unknown) => void) => unknown;
	has?: (id: string) => boolean;
	__pathBankHooked?: boolean;
};

function capturePath(id: unknown, value: unknown, bank: PathBank) {
	if (!value || typeof value !== 'object' || typeof id !== 'string' || !id.includes('_path_')) return;
	const rec = value as { path?: ArrayLike<number> };
	if (rec.path && rec.path.length) bank.set(id, rec.path);
}

export function hookPathBank(objs: Objs | null | undefined, bank: PathBank): void {
	if (!objs || typeof objs.get !== 'function' || objs.__pathBankHooked) return;
	objs.__pathBankHooked = true;
	const origGet = objs.get.bind(objs);
	objs.get = (id: string, cb?: (v: unknown) => void) => {
		if (typeof cb === 'function') {
			return origGet(id, (value: unknown) => {
				capturePath(id, value, bank);
				cb(value);
			});
		}
		const value = origGet(id);
		capturePath(id, value, bank);
		return value;
	};
}

export class FsStandardFontDataFactory {
	#dir: string;
	constructor(params: { baseUrl?: string } | string = {}) {
		this.#dir = typeof params === 'string' ? params : (params.baseUrl ?? '');
	}
	async fetch({ filename }: { filename: string }): Promise<Uint8Array> {
		const { readFile } = await import('node:fs/promises');
		const { join } = await import('node:path');
		const { fileURLToPath } = await import('node:url');
		const dir = this.#dir.startsWith('file:') ? fileURLToPath(this.#dir) : this.#dir;
		return new Uint8Array(await readFile(join(dir, filename)));
	}
}

export class StubCanvasFactory {
	create(width: number, height: number) {
		const context = stubContext2d();
		const canvas = context.canvas as { width: number; height: number };
		canvas.width = Math.max(1, width);
		canvas.height = Math.max(1, height);
		return { canvas, context };
	}
	reset(
		pair: { canvas: { width: number; height: number }; context: CanvasRenderingContext2D },
		width: number,
		height: number
	) {
		pair.canvas.width = Math.max(1, width);
		pair.canvas.height = Math.max(1, height);
	}
	destroy(pair: { canvas: { width: number; height: number }; context: CanvasRenderingContext2D | null }) {
		pair.canvas.width = 0;
		pair.canvas.height = 0;
		pair.context = null;
	}
}

export function lookupGlyphPath(
	bank: PathBank,
	loadedName: string,
	character: string
): ArrayLike<number> | null {
	if (!loadedName || !character) return null;
	return (
		bank.get(`${loadedName}_path_${character}`) ??
		bank.get(`g_${loadedName}_path_${character}`) ??
		null
	);
}
