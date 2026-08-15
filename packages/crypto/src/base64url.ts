export function bytesToBase64url(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]!);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlToBytes(encoded: string): Uint8Array {
	let b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
	while (b64.length % 4) b64 += '=';
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** Connections / signaling aliases. */
export const uint8ToBase64url = bytesToBase64url;
export const base64urlToUint8 = base64urlToBytes;
