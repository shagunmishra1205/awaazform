'use client';

import { db, type StoredPdf } from './db';

// Encryption at rest for what a session leaves in the browser: answers (localStorage) and uploaded
// PDF/Word files (IndexedDB). The key is a non-extractable AES-GCM key made on this device and kept in
// IndexedDB: this site's code can use it but nothing can read it out, so copies of the storage files,
// backups and other sites see only ciphertext. Everything also expires after 24 hours without use.

export const RETENTION_MS = 24 * 60 * 60 * 1000;
let keyPromise: Promise<CryptoKey> | null = null;

function deviceKey(): Promise<CryptoKey> {
  return (keyPromise ??= (async () => {
    const found = await db.meta.get('device-key');
    if (found) return found.key;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await db.meta.put({ id: 'device-key', key });
    return key;
  })().catch((err) => { keyPromise = null; throw err; }));
}

const b64 = (buf: ArrayBuffer | Uint8Array) => {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function sealText(text: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deviceKey(), new TextEncoder().encode(text));
  return `enc1:${b64(iv)}.${b64(ct)}`;
}

/** Returns null if the text was sealed with a key this device no longer has. Plain text passes through. */
export async function openText(stored: string): Promise<string | null> {
  if (!stored.startsWith('enc1:')) return stored;
  const [iv, ct] = stored.slice(5).split('.');
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv!) }, await deviceKey(), unb64(ct!));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

export async function putFile(f: Omit<StoredPdf, 'iv'>): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deviceKey(), f.bytes);
  await db.files.put({ ...f, bytes, iv, createdAt: new Date().toISOString() });
}

/** The decrypted file, or undefined if it is missing, expired or unreadable. */
export async function getFile(id: string): Promise<StoredPdf | undefined> {
  const f = await db.files.get(id);
  if (!f) return undefined;
  if (Date.now() - Date.parse(f.createdAt) > RETENTION_MS) {
    await db.files.delete(id);
    return undefined;
  }
  if (!f.iv) return f; // stored before encryption at rest
  try {
    return { ...f, bytes: await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(f.iv).slice() }, await deviceKey(), f.bytes) };
  } catch {
    await db.files.delete(id);
    return undefined;
  }
}
