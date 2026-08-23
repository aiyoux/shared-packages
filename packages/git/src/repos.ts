/**
 * IndexedDB store for saved git repo refs.
 */
import type { GitRepoRef } from './types.js';

export const GIT_REPOS_DB_NAME = 'scratch-git-repos';
export const GIT_REPOS_STORE = 'repos';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
	if (!dbPromise) {
		dbPromise = new Promise((resolve, reject) => {
			const req = indexedDB.open(GIT_REPOS_DB_NAME, 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(GIT_REPOS_STORE)) {
					db.createObjectStore(GIT_REPOS_STORE, { keyPath: 'id' });
				}
			};
			req.onsuccess = () => {
				const db = req.result;
				db.onversionchange = () => {
					db.close();
					dbPromise = null;
				};
				resolve(db);
			};
			req.onerror = () => {
				dbPromise = null;
				reject(req.error);
			};
		});
	}
	return dbPromise;
}

export async function closeGitReposDbForTests(): Promise<void> {
	if (!dbPromise) return;
	try {
		const db = await dbPromise;
		db.close();
	} catch {
		/* ignore */
	}
	dbPromise = null;
}

function txDone(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error);
	});
}

export async function listRepos(): Promise<GitRepoRef[]> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(GIT_REPOS_STORE, 'readonly');
		const req = tx.objectStore(GIT_REPOS_STORE).getAll();
		req.onsuccess = () => {
			const rows = (req.result as GitRepoRef[]) ?? [];
			resolve(rows.sort((a, b) => a.label.localeCompare(b.label)));
		};
		req.onerror = () => reject(req.error);
	});
}

export async function getRepo(id: string): Promise<GitRepoRef | undefined> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(GIT_REPOS_STORE, 'readonly');
		const req = tx.objectStore(GIT_REPOS_STORE).get(id);
		req.onsuccess = () => resolve(req.result as GitRepoRef | undefined);
		req.onerror = () => reject(req.error);
	});
}

export async function putRepo(repo: GitRepoRef): Promise<GitRepoRef> {
	const db = await openDb();
	const tx = db.transaction(GIT_REPOS_STORE, 'readwrite');
	tx.objectStore(GIT_REPOS_STORE).put(repo);
	await txDone(tx);
	return repo;
}

export async function deleteRepo(id: string): Promise<void> {
	const db = await openDb();
	const tx = db.transaction(GIT_REPOS_STORE, 'readwrite');
	tx.objectStore(GIT_REPOS_STORE).delete(id);
	await txDone(tx);
}
