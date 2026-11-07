/**
 * The Algorithm Diet's store: IndexedDB in the shell extension's own origin, so the background
 * (live tracking), the Diet page and the sidebar's summary all read and write the same visits.
 * Nothing here leaves the Mac. Same shape as the iOS app's SQLite tables (DietDatabase.swift):
 * visits are unique on (url, at, source), so importing a file twice adds nothing.
 */
import type { DietCategory, DietVisit } from './dietModel';
import type { DietHints } from './dietClassifier';

const NAME = 'anus-diet';
const VERSION = 1;

interface StoredVisit extends DietVisit {
  key: string;
}

let opening: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const visits = db.createObjectStore('visits', { keyPath: 'id', autoIncrement: true });
      visits.createIndex('at', 'at');
      visits.createIndex('key', 'key', { unique: true });
      db.createObjectStore('hostHints', { keyPath: 'host' });
      db.createObjectStore('titleHints', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another page asked for a newer version (a shell update): let it, and open again next time.
      db.onversionchange = () => {
        db.close();
        opening = undefined;
      };
      resolve(db);
    };
    req.onerror = () => {
      opening = undefined;
      reject(req.error);
    };
  });
  return opening;
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('aborted'));
  });

const result = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const visitKey = (v: Pick<DietVisit, 'url' | 'at' | 'source'>) => `${v.url}|${v.at}|${v.source}`;

function strip(v: StoredVisit): DietVisit {
  const { key: _key, ...visit } = v;
  return visit;
}

/** Every visit, oldest first. */
export async function allVisits(): Promise<DietVisit[]> {
  const db = await open();
  const rows = await result(db.transaction('visits').objectStore('visits').index('at').getAll() as IDBRequest<StoredVisit[]>);
  return rows.map(strip);
}

/** Visits in [start, end), oldest first. */
export async function visitsBetween(start: number, end: number): Promise<DietVisit[]> {
  const db = await open();
  const range = IDBKeyRange.bound(start, end, false, true);
  const rows = await result(db.transaction('visits').objectStore('visits').index('at').getAll(range) as IDBRequest<StoredVisit[]>);
  return rows.map(strip);
}

export async function visitCount(): Promise<number> {
  const db = await open();
  return result(db.transaction('visits').objectStore('visits').count());
}

/** Adds visits, skipping ones already there; returns the added ones with their ids. */
export async function insertVisits(visits: Array<Omit<DietVisit, 'id'> & { id?: number }>): Promise<DietVisit[]> {
  const db = await open();
  const tx = db.transaction('visits', 'readwrite');
  const store = tx.objectStore('visits');
  const added: DietVisit[] = [];
  for (const v of visits) {
    const { id: _id, ...rest } = v;
    const row = { ...rest, key: visitKey(v) };
    const req = store.add(row);
    req.onsuccess = () => added.push({ ...rest, id: req.result as number });
    // A duplicate (url, at, source): skip it without aborting the rest.
    req.onerror = (e) => {
      if (req.error?.name === 'ConstraintError') {
        e.preventDefault();
        e.stopPropagation();
      }
    };
  }
  await done(tx);
  return added.sort((a, b) => a.at - b.at);
}

/** Saves a live visit's growing time, title and excerpt. */
export async function updateVisit(v: DietVisit) {
  const db = await open();
  const tx = db.transaction('visits', 'readwrite');
  tx.objectStore('visits').put({ ...v, key: visitKey(v) });
  await done(tx);
}

export async function hints(): Promise<DietHints> {
  const db = await open();
  const tx = db.transaction(['hostHints', 'titleHints']);
  const [hosts, titles] = await Promise.all([
    result(tx.objectStore('hostHints').getAll() as IDBRequest<Array<{ host: string; category: DietCategory }>>),
    result(tx.objectStore('titleHints').getAll() as IDBRequest<Array<{ key: string; category: DietCategory }>>),
  ]);
  return {
    hosts: Object.fromEntries(hosts.map((h) => [h.host, h.category])),
    titles: Object.fromEntries(titles.map((t) => [t.key, t.category])),
  };
}

export async function saveHints(found: Partial<DietHints>, method = 'woof') {
  const db = await open();
  const tx = db.transaction(['hostHints', 'titleHints'], 'readwrite');
  for (const [host, category] of Object.entries(found.hosts ?? {})) tx.objectStore('hostHints').put({ host, category, method });
  for (const [key, category] of Object.entries(found.titles ?? {})) tx.objectStore('titleHints').put({ key, category, method });
  await done(tx);
}

/** Erases every visit and hint (tabs and browser history are not touched). */
export async function eraseAll() {
  const db = await open();
  const tx = db.transaction(['visits', 'hostHints', 'titleHints'], 'readwrite');
  for (const name of ['visits', 'hostHints', 'titleHints']) tx.objectStore(name).clear();
  await done(tx);
}
