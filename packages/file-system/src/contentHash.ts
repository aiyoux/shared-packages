const HEX = '0123456789abcdef';

function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let out = '';
	for (let i = 0; i < u8.length; i++) {
		out += HEX[u8[i]! >> 4]! + HEX[u8[i]! & 0xf]!;
	}
	return out;
}

function asDigestSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}

/** SHA-256 hex of `data`. Same digest Connections stores as `meta.sha256`. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', asDigestSource(data));
	return bytesToHex(digest);
}
