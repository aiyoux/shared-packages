import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
	acceptedExtensionsFor,
	forceExtension,
	getFileTypeByExtension,
	inferFileTypeFromName
} from '../src/registry.ts';

describe('registry multi-ext image + forceExtension', () => {
	it('acceptedExtensionsFor image lists common image formats', () => {
		const exts = acceptedExtensionsFor('image');
		for (const e of ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg']) {
			assert.ok(exts.includes(e), `expected ${e}`);
		}
	});

	it('acceptedExtensionsFor product types is primary only', () => {
		assert.deepEqual(acceptedExtensionsFor('skch'), ['.skch']);
		assert.deepEqual(acceptedExtensionsFor('vrec'), ['.vrec']);
		assert.deepEqual(acceptedExtensionsFor('igfx'), ['.igfx']);
		assert.deepEqual(acceptedExtensionsFor('cari'), ['.cari']);
		assert.deepEqual(acceptedExtensionsFor('kb'), ['.kb']);
		assert.deepEqual(acceptedExtensionsFor('anim'), ['.anim']);
		assert.deepEqual(acceptedExtensionsFor('json'), ['.json']);
		assert.deepEqual(acceptedExtensionsFor('unknown'), []);
	});

	it('forceExtension preserves multi-ext image names (no photo.jpg.png)', () => {
		assert.equal(forceExtension('photo.jpg', 'image'), 'photo.jpg');
		assert.equal(forceExtension('photo.jpeg', 'image'), 'photo.jpeg');
		assert.equal(forceExtension('shot.PNG', 'image'), 'shot.PNG');
		assert.equal(forceExtension('icon.webp', 'image'), 'icon.webp');
		assert.equal(forceExtension('anim.gif', 'image'), 'anim.gif');
		assert.equal(forceExtension('vector.svg', 'image'), 'vector.svg');
		assert.equal(forceExtension('Photo.JPG', 'image'), 'Photo.JPG');
	});

	it('forceExtension appends primary .png only when image has no accepted ext', () => {
		assert.equal(forceExtension('photo', 'image'), 'photo.png');
		assert.equal(forceExtension('screenshot', 'image'), 'screenshot.png');
	});

	it('forceExtension preserves multi-ext video names', () => {
		assert.equal(forceExtension('clip.mp4', 'video'), 'clip.mp4');
		assert.equal(forceExtension('clip.webm', 'video'), 'clip.webm');
		assert.equal(forceExtension('take.MOV', 'video'), 'take.MOV');
		assert.equal(forceExtension('take', 'video'), 'take.mp4');
	});

	it('forceExtension still enforces product single extensions', () => {
		assert.equal(forceExtension('demo', 'skch'), 'demo.skch');
		assert.equal(forceExtension('demo.skch', 'skch'), 'demo.skch');
		assert.equal(forceExtension('clip', 'vrec'), 'clip.vrec');
		assert.equal(forceExtension('demo', 'igfx'), 'demo.igfx');
		assert.equal(forceExtension('demo.igfx', 'igfx'), 'demo.igfx');
		assert.equal(forceExtension('face', 'cari'), 'face.cari');
		assert.equal(forceExtension('face.cari', 'cari'), 'face.cari');
		assert.equal(forceExtension('demo', 'kb'), 'demo.kb');
		assert.equal(forceExtension('index.kb', 'kb'), 'index.kb');
		assert.equal(forceExtension('clip', 'anim'), 'clip.anim');
		assert.equal(forceExtension('clip.anim', 'anim'), 'clip.anim');
		assert.equal(forceExtension('note.json', 'json'), 'note.json');
		assert.equal(forceExtension('note', 'json'), 'note.json');
		// wrong product ext stripped then primary applied
		assert.equal(forceExtension('x.vrec', 'skch'), 'x.skch');
		assert.equal(forceExtension('x.igfx', 'skch'), 'x.skch');
		assert.equal(forceExtension('x.igfx', 'cari'), 'x.cari');
		assert.equal(forceExtension('x.cari', 'igfx'), 'x.igfx');
		assert.equal(forceExtension('x.anim', 'skch'), 'x.skch');
		assert.equal(forceExtension('x.skch', 'anim'), 'x.anim');
	});

	it('inferFileTypeFromName maps image multi-ext and product types', () => {
		assert.equal(inferFileTypeFromName('photo.jpg'), 'image');
		assert.equal(inferFileTypeFromName('photo.jpeg'), 'image');
		assert.equal(inferFileTypeFromName('a.webp'), 'image');
		assert.equal(inferFileTypeFromName('a.png'), 'image');
		assert.equal(inferFileTypeFromName('clip.mp4'), 'video');
		assert.equal(inferFileTypeFromName('clip.webm'), 'video');
		assert.equal(inferFileTypeFromName('draft.skch'), 'skch');
		assert.equal(inferFileTypeFromName('mesh.ob3d'), 'ob3d');
		assert.equal(inferFileTypeFromName('face.cari'), 'cari');
		assert.equal(inferFileTypeFromName('x.igfx'), 'igfx');
		assert.equal(inferFileTypeFromName('a.cari'), 'cari');
		assert.equal(inferFileTypeFromName('index.kb'), 'kb');
		assert.equal(inferFileTypeFromName('loop.anim'), 'anim');
		assert.equal(inferFileTypeFromName('report.pdf'), 'pdf');
		assert.deepEqual(acceptedExtensionsFor('pdf'), ['.pdf']);
		assert.equal(inferFileTypeFromName('noext'), 'unknown');
	});

	it('getFileTypeByExtension resolves multi-ext images', () => {
		assert.equal(getFileTypeByExtension('.jpg')?.id, 'image');
		assert.equal(getFileTypeByExtension('jpeg')?.id, 'image');
		assert.equal(getFileTypeByExtension('.png')?.id, 'image');
		assert.equal(getFileTypeByExtension('.mp4')?.id, 'video');
		assert.equal(getFileTypeByExtension('.webm')?.id, 'video');
		assert.equal(getFileTypeByExtension('.skch')?.id, 'skch');
		assert.equal(getFileTypeByExtension('.igfx')?.id, 'igfx');
		assert.equal(getFileTypeByExtension('.cari')?.id, 'cari');
		assert.equal(getFileTypeByExtension('.kb')?.id, 'kb');
		assert.equal(getFileTypeByExtension('.anim')?.id, 'anim');
		assert.equal(getFileTypeByExtension('.pdf'), undefined);
	});
});
