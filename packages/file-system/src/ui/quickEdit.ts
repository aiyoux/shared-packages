import { memoryFileId } from '../fileSourceIds.js';
import { readExplorerBlob, type ExplorerDriver, type ExplorerEntry, type QuickEditFileContext } from './explorerDriver.js';

/** Save edited siblings through either driver write contract. */
export function canSaveQuickEdit(driver: ExplorerDriver): boolean {
	return !!driver.writeFile || !!driver.upload;
}

/** Capture the source connection and folder before handing control to a popup. */
export function quickEditContext(driver: ExplorerDriver, entry: ExplorerEntry): QuickEditFileContext {
	const id = entry.id;
	const parentId = entry.parentId;
	return {
		read: () => readExplorerBlob(driver, id),
		save: (file) => {
			if (driver.writeFile) return driver.writeFile(parentId, file);
			if (driver.upload) return driver.upload(parentId, file);
			return Promise.reject(new Error('This connection cannot save edited files.'));
		},
		sourceFileId: driver.id === 'local' ? id : driver.id === 'memory' ? memoryFileId(id) : undefined
	};
}
