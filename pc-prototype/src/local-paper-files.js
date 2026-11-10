async function openFiles() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('beitibao-paper-files', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('papers');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function storePaperFiles(id, files) {
  const db = await openFiles();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('papers', 'readwrite');
      transaction.objectStore('papers').put(files, id);
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

export async function readPaperFiles(id) {
  const db = await openFiles();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('papers').objectStore('papers').get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
