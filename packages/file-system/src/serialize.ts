/** Serialize body for OPFS storage. */
export async function serializeBody(
	body: unknown,
	contentType?: string
): Promise<{ bytes: Uint8Array; contentType: string }> {
	if (body instanceof Blob) {
		const ab = await body.arrayBuffer();
		return {
			bytes: new Uint8Array(ab),
			contentType: contentType ?? body.type ?? 'application/octet-stream'
		};
	}
	if (body instanceof ArrayBuffer) {
		return {
			bytes: new Uint8Array(body),
			contentType: contentType ?? 'application/octet-stream'
		};
	}
	if (ArrayBuffer.isView(body)) {
		const view = body as ArrayBufferView;
		return {
			bytes: new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
			contentType: contentType ?? 'application/octet-stream'
		};
	}
	// structured JSON
	const json = JSON.stringify(body);
	const bytes = new TextEncoder().encode(json);
	return { bytes, contentType: contentType ?? 'application/json' };
}

export function parseJsonBytes(bytes: Uint8Array): unknown {
	const text = new TextDecoder().decode(bytes);
	return JSON.parse(text);
}
