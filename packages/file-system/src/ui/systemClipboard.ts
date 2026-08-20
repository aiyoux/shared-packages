/** Inspect OS clipboard contents for FileExplorer “paste into folder”. */

export type SystemClipKind = 'files' | 'image' | 'text' | 'link';

export type SystemClip = {
	kind: SystemClipKind;
	files: File[];
	label: string;
};

const URL_RE = /^(https?:\/\/|mailto:)/i;

export function looksLikeUrl(text: string): boolean {
	const t = text.trim();
	if (!t || /\s/.test(t)) return false;
	if (URL_RE.test(t)) return true;
	try {
		const u = new URL(t);
		return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:';
	} catch {
		return false;
	}
}

export function imageNameForType(type: string): string {
	if (type === 'image/jpeg' || type === 'image/jpg') return 'clipboard.jpg';
	if (type === 'image/webp') return 'clipboard.webp';
	if (type === 'image/gif') return 'clipboard.gif';
	if (type === 'image/svg+xml') return 'clipboard.svg';
	return 'clipboard.png';
}

export function textFileName(text: string, asLink: boolean): string {
	if (asLink) {
		try {
			const host = new URL(text.trim()).hostname.replace(/^www\./, '');
			if (host) return `${host}.txt`;
		} catch {
			/* fall through */
		}
		return 'link.txt';
	}
	const line = text.trim().split(/\r?\n/, 1)[0] ?? '';
	const slug = line
		.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 40);
	return `${slug || 'clipboard'}.txt`;
}

export function payloadFromText(text: string): SystemClip | null {
	if (!text) return null;
	const asLink = looksLikeUrl(text);
	const name = textFileName(text, asLink);
	const file = new File([text], name, { type: 'text/plain' });
	return {
		kind: asLink ? 'link' : 'text',
		files: [file],
		label: asLink ? `Paste link (${name})` : `Paste text (${name})`
	};
}

function namedImage(file: File): File {
	if (file.name && file.name !== 'image.png' && file.name !== 'blob') return file;
	const name = imageNameForType(file.type || 'image/png');
	return new File([file], name, { type: file.type || 'image/png' });
}

export function payloadFromDataTransfer(dt: DataTransfer | null | undefined): SystemClip | null {
	if (!dt) return null;
	const fromList: File[] = [];
	if (dt.files?.length) {
		for (let i = 0; i < dt.files.length; i++) {
			const f = dt.files.item(i);
			if (f) fromList.push(f);
		}
	}
	if (fromList.length) {
		const images = fromList.every((f) => f.type.startsWith('image/'));
		if (images && fromList.length === 1) {
			const img = namedImage(fromList[0]!);
			return { kind: 'image', files: [img], label: `Paste image (${img.name})` };
		}
		const label =
			fromList.length === 1 ? `Paste file (${fromList[0]!.name})` : `Paste ${fromList.length} files`;
		return { kind: 'files', files: fromList, label };
	}
	if (dt.items?.length) {
		const images: File[] = [];
		for (let i = 0; i < dt.items.length; i++) {
			const item = dt.items[i]!;
			if (item.kind === 'file' && item.type.startsWith('image/')) {
				const f = item.getAsFile();
				if (f) images.push(namedImage(f));
			}
		}
		if (images.length) {
			return {
				kind: 'image',
				files: images,
				label: images.length === 1 ? `Paste image (${images[0]!.name})` : `Paste ${images.length} images`
			};
		}
	}
	const text = dt.getData?.('text/plain') ?? '';
	return payloadFromText(text);
}

export async function payloadFromClipboardItems(items: ClipboardItems): Promise<SystemClip | null> {
	const files: File[] = [];
	const images: File[] = [];
	let text = '';
	for (const item of items) {
		const types = item.types ?? [];
		for (const type of types) {
			if (type.startsWith('image/')) {
				const blob = await item.getType(type);
				images.push(new File([blob], imageNameForType(type), { type }));
			} else if ((type === 'text/plain' || type === 'text/uri-list') && !text) {
				text = await (await item.getType(type)).text();
			} else if (!type.startsWith('text/')) {
				const blob = await item.getType(type);
				const ext = type.split('/')[1]?.split('+')[0] || 'bin';
				files.push(new File([blob], `clipboard.${ext}`, { type }));
			}
		}
	}
	if (files.length) {
		return {
			kind: 'files',
			files,
			label: files.length === 1 ? `Paste file (${files[0]!.name})` : `Paste ${files.length} files`
		};
	}
	if (images.length) {
		return {
			kind: 'image',
			files: images,
			label: images.length === 1 ? `Paste image (${images[0]!.name})` : `Paste ${images.length} images`
		};
	}
	return payloadFromText(text);
}
