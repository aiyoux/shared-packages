/**
 * Minimal onnxruntime-web surface the scan engine uses.
 *
 * Hand-written (like `opencv-js.d.ts`): the engine runs against whatever
 * ORT build the host app vendors, and this records exactly what the
 * detector needs. Full types ship with the `onnxruntime-web` npm package.
 */
declare module 'onnxruntime-web' {
	export type OrtTensorData = Float32Array | Int32Array | Uint8Array;
	export type OrtTensor = {
		readonly data: OrtTensorData;
		readonly dims: readonly number[];
	};
	export type OrtSession = {
		readonly inputNames: readonly string[];
		run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
		release?(): Promise<void>;
	};
	export type OrtTensorConstructor = new (
		type: 'float32',
		data: Float32Array | Uint8ClampedArray | number[],
		dims: readonly number[]
	) => OrtTensor;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const InferenceSession: { create(model: string | Uint8Array, opts?: any): Promise<OrtSession> };
	const Tensor: OrtTensorConstructor;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const env: any;
}
