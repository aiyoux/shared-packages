/**
 * The `onnxruntime-web/webgpu` subpath ships no type declarations (bundle
 * `.mjs` only). Runtime values come from there; static types come from
 * `onnxruntime-common`, which declares the shared API surface.
 */
declare module 'onnxruntime-web/webgpu';
