/**
 * `onnxruntime-web-flux2` is an npm alias of onnxruntime-web; the alias
 * package ships ORT's stock types.d.ts, whose ambient `declare module
 * 'onnxruntime-web/…'` blocks all name the *original* package. Importing
 * the alias's subpaths therefore resolves to a file that is not a module.
 * Re-declare the subpaths we use against the (API-stable) shared types.
 */
declare module 'onnxruntime-web-flux2/webgpu' {
	export * from 'onnxruntime-common';
}