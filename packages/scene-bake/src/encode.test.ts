import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { computeVisibleSpans } from './hiddenLine.js';
import { encodeSceneToSvg, encodeSceneToSvgAsync } from './svgBake.js';

function cubeScene() {
	const scene = new THREE.Scene();
	const mesh = new THREE.Mesh(
		new THREE.BoxGeometry(1, 1, 1),
		new THREE.MeshBasicMaterial({ color: 0xff0000 })
	);
	scene.add(mesh);
	const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
	camera.position.set(2, 2, 2);
	camera.lookAt(0, 0, 0);
	return { scene, camera };
}

describe('encodeSceneToSvg', () => {
	it('emits path data for a cube', () => {
		const { scene, camera } = cubeScene();
		const paths = encodeSceneToSvg(scene, camera, 200, 200);
		expect(paths.length).toBeGreaterThan(0);
		expect(paths.some((p) => p.d.length > 0)).toBe(true);
	});

	it('async encode matches sync when computeSpans is inline', async () => {
		const { scene, camera } = cubeScene();
		const sync = encodeSceneToSvg(scene, camera, 200, 200);
		const asyncPaths = await encodeSceneToSvgAsync(scene, camera, 200, 200, (prepared) =>
			Promise.resolve(
				computeVisibleSpans(
					prepared.request,
					(id) => prepared.boundsTrees.get(id) ?? null,
					(id) => prepared.edgePositions.get(id) ?? null
				)
			)
		);
		expect(asyncPaths.map((p) => p.d)).toEqual(sync.map((p) => p.d));
	});
});
