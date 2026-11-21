const CLOCK_IMAGE_DB = "milo-clock-face-image-v1";
const CLOCK_IMAGE_STORE = "images";

function openClockImageDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CLOCK_IMAGE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(CLOCK_IMAGE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveClockFaceImage(image: Blob | null): Promise<void> {
  const db = await openClockImageDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(CLOCK_IMAGE_STORE, "readwrite");
    const store = transaction.objectStore(CLOCK_IMAGE_STORE);
    if (image) store.put(image, "custom-face");
    else store.delete("custom-face");
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(transaction.error); };
  });
}

export async function loadClockFaceImage(): Promise<Blob | null> {
  try {
    const db = await openClockImageDb();
    return await new Promise((resolve) => {
      const request = db.transaction(CLOCK_IMAGE_STORE, "readonly").objectStore(CLOCK_IMAGE_STORE).get("custom-face");
      request.onsuccess = () => { db.close(); resolve(request.result instanceof Blob ? request.result : null); };
      request.onerror = () => { db.close(); resolve(null); };
    });
  } catch { return null; }
}
