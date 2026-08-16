import type { FileTypeDef, FileTypeId } from './types.js';

const DEFAULT_TYPES: FileTypeDef[] = [
	{
		id: 'skch',
		extension: '.skch',
		mime: 'application/x-scratch-sketch+json',
		label: 'Sketch',
		schemaVersion: 1
	},
	{
		id: 'ob3d',
		extension: '.ob3d',
		mime: 'application/x-scratch-ob3d+json',
		label: '3D Object',
		schemaVersion: 1
	},
	{
		id: 'cari',
		extension: '.cari',
		mime: 'application/x-scratch-cari+json',
		label: 'Caricature',
		schemaVersion: 1
	},
	{
		id: 'vrec',
		extension: '.vrec',
		mime: 'application/x-scratch-vrec+json',
		label: 'Voice Recording',
		schemaVersion: 1
	},
	{
		id: 'igfx',
		extension: '.igfx',
		mime: 'application/x-scratch-igfx+json',
		label: 'Infographic',
		schemaVersion: 1
	},
	{
		id: 'image',
		extension: '.png',
		mime: 'image/png',
		label: 'Image',
		schemaVersion: 1
	},
	{
		id: 'video',
		extension: '.mp4',
		mime: 'video/mp4',
		label: 'Video',
		schemaVersion: 1
	},
	{
		id: 'json',
		extension: '.json',
		mime: 'application/json',
		label: 'JSON',
		schemaVersion: 1
	}
];

/**
 * Multi-extension file types: any listed extension is accepted as already
 * correct by `forceExtension` (primary registry `extension` is the default
 * when none matches). Prevents `photo.jpg` → `photo.jpg.png` for image.
 */
const MULTI_EXT: Partial<Record<FileTypeId, readonly string[]>> = {
	image: ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'],
	video: ['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.ogv']
};

/** Product extensions stripped before re-applying a forced primary extension. */
const STRIPPABLE_PRODUCT_EXT = /\.(skch|ob3d|cari|vrec|igfx|json)$/i;

const registry = new Map<FileTypeId, FileTypeDef>(DEFAULT_TYPES.map((t) => [t.id, t]));

export function getFileType(id: FileTypeId): FileTypeDef | undefined {
	return registry.get(id);
}

export function getFileTypeByExtension(ext: string): FileTypeDef | undefined {
	const normalized = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
	for (const def of registry.values()) {
		if (def.extension === normalized) return def;
	}
	// multi-ext images (and any future multi-ext types)
	for (const [id, exts] of Object.entries(MULTI_EXT) as [FileTypeId, readonly string[]][]) {
		if (exts.includes(normalized)) return registry.get(id);
	}
	return undefined;
}

export function registerFileType(def: FileTypeDef): void {
	registry.set(def.id, def);
}

export function listFileTypes(): FileTypeDef[] {
	return [...registry.values()];
}

export function extensionFor(id: FileTypeId): string {
	return registry.get(id)?.extension ?? '';
}

/**
 * Extensions accepted as already-correct for a file type (primary + multi-ext).
 * Empty for unknown / unregistered types.
 */
export function acceptedExtensionsFor(id: FileTypeId): string[] {
	const multi = MULTI_EXT[id];
	if (multi) return [...multi];
	const primary = extensionFor(id);
	return primary ? [primary] : [];
}

/**
 * Ensure `name` ends with an accepted extension for `fileType`.
 * Multi-ext types (image): preserve `.jpg`/`.webp`/…; only append primary
 * when no accepted extension is present (e.g. bare `photo` → `photo.png`).
 * Single-ext product types: replace/append primary (e.g. `demo` → `demo.skch`).
 */
export function forceExtension(name: string, fileType: FileTypeId): string {
	const accepted = acceptedExtensionsFor(fileType);
	if (accepted.length === 0) return name;
	const lower = name.toLowerCase();
	if (accepted.some((ext) => lower.endsWith(ext))) return name;
	const primary = extensionFor(fileType);
	if (!primary) return name;
	const stripped = name.replace(STRIPPABLE_PRODUCT_EXT, '');
	return `${stripped}${primary}`;
}

export function inferFileTypeFromName(name: string): FileTypeId {
	const dot = name.lastIndexOf('.');
	if (dot < 0) return 'unknown';
	const def = getFileTypeByExtension(name.slice(dot));
	return def?.id ?? 'unknown';
}
