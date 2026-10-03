import { readExplorerBlob, type ExplorerDriver, type ExplorerEntry } from './explorerDriver.js';
import { coerceMediaBlob } from './feThumbnails.js';
import { FILE_CLIPBOARD_TYPE, FILE_CLIPBOARD_WEB_TYPE, type FileClipboardPayload } from './fileClipboard.js';

/** The portable native clipboard image format is PNG. Keep the full image dimensions. */
export async function clipboardImageBlob(driver: ExplorerDriver, entry: ExplorerEntry): Promise<Blob> {
	const blob = coerceMediaBlob(await readExplorerBlob(driver, entry.id), entry.name, 'image');
	if (blob.type === 'image/png') return blob;
	let image: ImageBitmap | HTMLImageElement;
	let url: string | undefined;
	try {
		try {
			image = await createImageBitmap(blob);
		} catch {
			// SVG and some browser-specific decoders need the <img> path.
			url = URL.createObjectURL(blob);
			image = new Image();
			image.src = url;
			await image.decode();
		}
		try {
			const canvas = document.createElement('canvas');
			canvas.width = image instanceof HTMLImageElement ? image.naturalWidth : image.width;
			canvas.height = image instanceof HTMLImageElement ? image.naturalHeight : image.height;
			const ctx = canvas.getContext('2d');
			if (!ctx) throw new Error('Could not prepare the image for the clipboard');
			ctx.drawImage(image, 0, 0);
			return await new Promise<Blob>((resolve, reject) => canvas.toBlob(
				(png) => png ? resolve(png) : reject(new Error('Could not encode the clipboard image')), 'image/png'));
		} finally {
			if ('close' in image) image.close();
		}
	} finally {
		if (url) URL.revokeObjectURL(url);
	}
}

/** Start the native write during the click/keypress, before downloading remote bytes. */
export async function copyImageToSystem(driver: ExplorerDriver, entry: ExplorerEntry, payload: FileClipboardPayload): Promise<void> {
	if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
		return Promise.reject(new Error('This browser cannot copy image data to the system clipboard'));
	}
	const png = clipboardImageBlob(driver, entry);
	// A write can fail before the promised bytes finish loading.
	void png.catch(() => {});
	const data: Record<string, Blob | Promise<Blob>> = { 'image/png': png };
	if (ClipboardItem.supports?.(FILE_CLIPBOARD_WEB_TYPE)) {
		// Custom web metadata stays separate from native image/text paste targets.
		data[FILE_CLIPBOARD_WEB_TYPE] = new Blob([JSON.stringify(payload)], { type: FILE_CLIPBOARD_TYPE });
	}
	return navigator.clipboard.write([new ClipboardItem(data)]);
}
