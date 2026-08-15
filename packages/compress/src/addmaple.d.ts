declare module '@addmaple/gzip' {
	export function init(
		imports?: Record<string, unknown>,
		opts?: { backend?: string }
	): Promise<void>;
	export function compress(
		input: Uint8Array | ArrayBuffer | string,
		options?: { level?: number }
	): Promise<Uint8Array>;
	export function decompress(input: Uint8Array | ArrayBuffer | string): Promise<Uint8Array>;
}

declare module '@addmaple/brotli' {
	export function init(
		imports?: Record<string, unknown>,
		opts?: { backend?: string }
	): Promise<void>;
	export function compress(
		input: Uint8Array | ArrayBuffer | string,
		options?: { level?: number }
	): Promise<Uint8Array>;
	export function decompress(input: Uint8Array | ArrayBuffer | string): Promise<Uint8Array>;
}

declare module '@addmaple/lz4' {
	export function init(
		imports?: Record<string, unknown>,
		opts?: { backend?: string }
	): Promise<void>;
	export function compress(
		input: Uint8Array | ArrayBuffer | string,
		options?: { level?: number }
	): Promise<Uint8Array>;
	export function decompress(input: Uint8Array | ArrayBuffer | string): Promise<Uint8Array>;
}
