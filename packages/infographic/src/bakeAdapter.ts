/** Types-only until PR-7. resolve stays sync; 3D uses an async bake cache. */

export type BakedPath = { d: string; stroke: string; fill: string; strokeWidth: number };

export interface Scene3dObject {
	id: string;
	primitive: 'box' | 'sphere' | 'cylinder' | 'bar3d';
	position: [number, number, number];
	rotation: [number, number, number];
	scale: [number, number, number];
	color?: string;
}

export interface Scene3dCamera {
	position: [number, number, number];
	target: [number, number, number];
	fov: number;
}

export interface Scene3dMark {
	id: string;
	kind: 'scene3d';
	layout: { x: number; y: number; w: number; h: number };
	scene: {
		objects: Scene3dObject[];
		camera: Scene3dCamera;
	};
	bindings: {
		values?: { ref: string };
	};
	style?: Record<string, string | number | boolean>;
}

export interface Live3dContext {
	canvas: HTMLCanvasElement;
	setSceneFromMark(mark: Scene3dMark, tMs: number): void;
	waitSettled(): Promise<void>;
	renderTo(target: OffscreenCanvas | HTMLCanvasElement): void;
	dispose(): void;
}

export interface BakeAdapter {
	encodeToSvg(input: {
		mark: Scene3dMark;
		tMs: number;
		width: number;
		height: number;
	}): Promise<BakedPath[]>;
	acquireLive(): Promise<Live3dContext>;
}

export function bakeSignature(mark: Scene3dMark, tMs: number, fps: number): string {
	return `${mark.id}@${tMs}|${fps}`;
}

export async function ensureBaked(_mark: Scene3dMark, _tMs: number): Promise<BakedPath[]> {
	return [];
}

export function peekBake(_markId: string, _signature: string): BakedPath[] | undefined {
	return undefined;
}
