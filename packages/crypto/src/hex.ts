const HEX = '0123456789abcdef';

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
	const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let out = '';
	for (let i = 0; i < u8.length; i++) {
		out += HEX[u8[i]! >> 4] + HEX[u8[i]! & 0xf];
	}
	return out;
}

export function hexToBytes(hex: string): Uint8Array {
	const clean = hex.trim().toLowerCase().replace(/^0x/, '').replace(/[\s:]/g, '');
	if (!clean.length || clean.length % 2) throw new Error('Hash must be even-length hex');
	if (!/^[0-9a-f]+$/.test(clean)) throw new Error('Hash must be hexadecimal');
	const out = new Uint8Array(clean.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
	}
	return out;
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}

export function timingSafeEqualHex(a: string, b: string): boolean {
	const aa = a.trim().toLowerCase().replace(/^0x/, '').replace(/[\s:]/g, '');
	const bb = b.trim().toLowerCase().replace(/^0x/, '').replace(/[\s:]/g, '');
	if (aa.length !== bb.length) return false;
	let diff = 0;
	for (let i = 0; i < aa.length; i++) diff |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
	return diff === 0;
}
