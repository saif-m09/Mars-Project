const DB_NAME = 'p2p-web-share-db';
const DB_VERSION = 1;
const STORE_NAME = 'file-chunks';

export function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        // Index by roomId so we can query all chunks of a specific room/file
        store.createIndex('roomId', 'roomId', { unique: false });
      }
    };
  });
}

export async function saveChunk(roomId, chunkIndex, data) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const id = `${roomId}_${chunkIndex}`;
    
    const request = store.put({
      id,
      roomId,
      chunkIndex,
      data
    });

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getChunk(roomId, chunkIndex) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const id = `${roomId}_${chunkIndex}`;
    const request = store.get(id);

    request.onsuccess = () => resolve(request.result ? request.result.data : null);
    request.onerror = () => reject(request.error);
  });
}

export async function getStoredChunkCount(roomId) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('roomId');
    const request = index.count(IDBKeyRange.only(roomId));

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllChunks(roomId) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('roomId');
    const request = index.getAll(IDBKeyRange.only(roomId));

    request.onsuccess = () => {
      // Sort chunks by chunkIndex to maintain original sequence
      const sorted = request.result.sort((a, b) => a.chunkIndex - b.chunkIndex);
      resolve(sorted.map(item => item.data));
    };
    request.onerror = () => reject(request.error);
  });
}

export async function clearChunks(roomId) {
  const db = await initDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const index = store.index('roomId');
    const request = index.openCursor(IDBKeyRange.only(roomId));

    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        store.delete(cursor.primaryKey);
        cursor.continue();
      } else {
        resolve();
      }
    };
    request.onerror = () => reject(request.error);
  });
}
