import { serviceNames } from './names.js';

/** One row per id. Read/modify/write happens in one IndexedDB transaction. */
export function createRecordStore<T extends { id: string }>(name: string, factory: IDBFactory = indexedDB) {
 let db: Promise<IDBDatabase> | null = null;
 function open(): Promise<IDBDatabase> {
  return db ??= new Promise((resolve, reject) => {
   const request = factory.open(name, 1);
   request.onupgradeneeded = () => request.result.createObjectStore(serviceNames.recordStore, { keyPath: 'id' });
   request.onerror = () => { db = null; reject(request.error); };
   request.onblocked = () => { db = null; reject(new Error(`Storage upgrade for ${name} is blocked by another tab`)); };
   request.onsuccess = () => {
    const result = request.result;
    result.onversionchange = () => { result.close(); db = null; };
    resolve(result);
   };
  });
 }
 return {
  async list(): Promise<T[]> {
   const database = await open();
   return new Promise((resolve, reject) => {
    const tx = database.transaction(serviceNames.recordStore, 'readonly');
    const request = tx.objectStore(serviceNames.recordStore).getAll();
    tx.oncomplete = () => resolve(request.result as T[]);
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
   });
  },
  async mutate(id: string, update: (current: T | undefined) => T | undefined): Promise<T | undefined> {
   const database = await open();
   return new Promise((resolve, reject) => {
    const tx = database.transaction(serviceNames.recordStore, 'readwrite');
    const records = tx.objectStore(serviceNames.recordStore);
    const request = records.get(id);
    let next: T | undefined;
    let thrown: unknown;
    request.onsuccess = () => {
     try {
      next = update(request.result as T | undefined);
      if (next) records.put(next);
     } catch (error) { thrown = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(next);
    tx.onabort = () => reject(thrown ?? tx.error);
    tx.onerror = () => reject(thrown ?? tx.error);
   });
  },
  async remove(id: string, when?: (current: T | undefined) => boolean): Promise<void> {
   const database = await open();
   return new Promise((resolve, reject) => {
    const tx = database.transaction(serviceNames.recordStore, 'readwrite');
    const records = tx.objectStore(serviceNames.recordStore);
    if (!when) records.delete(id);
    else { const request = records.get(id); request.onsuccess = () => { try { if (when(request.result as T | undefined)) records.delete(id); } catch { tx.abort(); } }; }
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
   });
  },
  async close() { (await db)?.close(); db = null; }
 };
}
export type RecordStore<T extends { id: string }> = ReturnType<typeof createRecordStore<T>>;
