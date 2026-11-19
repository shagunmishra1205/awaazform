// Profile helpers: save guard and optional passphrase encryption (FR-31, FR-36, FR-38).
import { isSensitive } from './safety';
import { CANONICAL_KEYS, type CanonicalKey, type Profile } from './types';

export function canSave(key: string, questionLabel: string): key is CanonicalKey {
  return (CANONICAL_KEYS as readonly string[]).includes(key) && !isSensitive(questionLabel);
}

/** Returns a new profile with the value saved. Throws if saving is not allowed. */
export function saveToProfile(
  p: Profile, key: CanonicalKey, value: string, questionLabel: string, source: string, now = new Date().toISOString(),
): Profile {
  if (!canSave(key, questionLabel)) throw new Error('This kind of information is never saved.');
  const prev = p.fields[key];
  const sources = prev?.sources.includes(source) ? prev.sources : [...(prev?.sources ?? []), source];
  return { ...p, fields: { ...p.fields, [key]: { key, value, confirmedAt: now, sources } } };
}

export function forgetField(p: Profile, key: CanonicalKey): Profile {
  const { [key]: _gone, ...rest } = p.fields;
  return { ...p, fields: rest };
}

// --- Encryption: AES-GCM with a PBKDF2-derived key (WebCrypto, no dependencies) ---

const PBKDF2_ITERATIONS = 310_000;

const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function newSalt(): string {
  return b64(crypto.getRandomValues(new Uint8Array(16)));
}

export async function deriveKey(passphrase: string, saltB64: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: unb64(saltB64), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Returns `base64(iv).base64(ciphertext)`. */
export async function encryptValue(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return `${b64(iv)}.${b64(ct)}`;
}

/** Throws if the passphrase is wrong (AES-GCM authentication fails). */
export async function decryptValue(key: CryptoKey, payload: string): Promise<string> {
  const [iv, ct] = payload.split('.');
  if (!iv || !ct) throw new Error('Malformed ciphertext');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct));
  return new TextDecoder().decode(pt);
}

// --- Whole-profile lock/unlock (FR-36), with envelope encryption ---
//
// v2: a random 256-bit data key (DEK) encrypts the values. The DEK is stored only wrapped: by the
// passphrase key (PBKDF2), and optionally by a passkey key (HKDF of a WebAuthn PRF output, computed inside
// the authenticator's secure hardware). Unlocking either way yields the same non-extractable DEK.

const VERIFIER = 'awaazform-verifier-v1';

async function wrapWith(kek: CryptoKey, dek: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv });
  return `${b64(iv)}.${b64(ct)}`;
}

async function unwrapWith(kek: CryptoKey, payload: string): Promise<CryptoKey> {
  const [iv, ct] = payload.split('.');
  if (!iv || !ct) throw new Error('Malformed ciphertext');
  // The unwrapped data key is not extractable: it can encrypt and decrypt, never be read out.
  return crypto.subtle.unwrapKey('raw', unb64(ct), kek, { name: 'AES-GCM', iv: unb64(iv) }, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function passphraseKek(passphrase: string, saltB64: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: unb64(saltB64), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey'],
  );
}

/** The key-wrapping key from a passkey's PRF output (32 secret bytes from the authenticator). */
export async function passkeyKek(prfOutput: ArrayBuffer | Uint8Array): Promise<CryptoKey> {
  const bytes = new Uint8Array(prfOutput).slice();
  const base = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('awaazform-passkey-v1'), info: new TextEncoder().encode('profile key wrapping') },
    base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey'],
  );
}

/** Encrypts every saved value under a new data key. Returns the locked profile and the (unlocked) data key. */
export async function lockProfile(p: Profile, passphrase: string): Promise<{ profile: Profile; key: CryptoKey }> {
  if (p.encrypted) throw new Error('Profile is already locked');
  if (passphrase.length < 8) throw new Error('Use a passphrase of at least 8 characters');
  const salt = newSalt();
  const dek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const wrappedPass = await wrapWith(await passphraseKek(passphrase, salt), dek);
  // Re-import as non-extractable for use from here on.
  const key = await unwrapWith(await passphraseKek(passphrase, salt), wrappedPass);
  const fields: Profile['fields'] = {};
  for (const f of Object.values(p.fields)) {
    if (f) fields[f.key] = { ...f, value: await encryptValue(key, f.value) };
  }
  return { profile: { ...p, encrypted: true, salt, verifier: await encryptValue(key, VERIFIER), wrapped: { passphrase: wrappedPass }, fields }, key };
}

async function verified(p: Profile, key: CryptoKey): Promise<CryptoKey | null> {
  try {
    return (await decryptValue(key, p.verifier!)) === VERIFIER ? key : null;
  } catch {
    return null;
  }
}

/** Returns the data key if the passphrase is right, otherwise `null`. Works for v1 and v2 profiles. */
export async function unlockKey(p: Profile, passphrase: string): Promise<CryptoKey | null> {
  if (!p.encrypted || !p.salt || !p.verifier) return null;
  if (!p.wrapped?.passphrase) return verified(p, await deriveKey(passphrase, p.salt)); // v1
  try {
    return verified(p, await unwrapWith(await passphraseKek(passphrase, p.salt), p.wrapped.passphrase));
  } catch {
    return null; // wrong passphrase: unwrapping fails authentication
  }
}

/** Unlocks with a passkey's PRF output. */
export async function unlockKeyWithPasskey(p: Profile, prfOutput: ArrayBuffer | Uint8Array): Promise<CryptoKey | null> {
  const pk = p.wrapped?.passkey;
  if (!p.encrypted || !pk || !p.verifier) return null;
  try {
    return verified(p, await unwrapWith(await passkeyKek(prfOutput), pk.key));
  } catch {
    return null;
  }
}

/**
 * Adds a passkey to a v2 profile. The data key can't be read out, so it is re-wrapped by first
 * unwrapping it again as extractable with the passphrase, which the user enters to confirm.
 */
export async function addPasskey(p: Profile, passphrase: string, prfOutput: ArrayBuffer | Uint8Array, credentialId: string, prfSalt: string): Promise<Profile> {
  if (!p.encrypted || !p.salt || !p.wrapped?.passphrase) throw new Error('Protect this profile with a passphrase first');
  const kek = await passphraseKek(passphrase, p.salt);
  let dek: CryptoKey;
  try {
    const [iv, ct] = p.wrapped.passphrase.split('.');
    dek = await crypto.subtle.unwrapKey('raw', unb64(ct!), kek, { name: 'AES-GCM', iv: unb64(iv!) }, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  } catch {
    throw new Error('That passphrase is not right.');
  }
  const key = await wrapWith(await passkeyKek(prfOutput), dek);
  return { ...p, wrapped: { ...p.wrapped, passkey: { credentialId, prfSalt, key, createdAt: new Date().toISOString() } } };
}

export function removePasskey(p: Profile): Profile {
  if (!p.wrapped?.passkey) return p;
  const { passkey: _gone, ...rest } = p.wrapped;
  return { ...p, wrapped: rest };
}

/** Upgrades a v1 profile (passphrase key used directly) to envelope encryption. Needs the passphrase. */
export async function upgradeProfile(p: Profile, passphrase: string): Promise<{ profile: Profile; key: CryptoKey } | null> {
  if (!p.encrypted || p.wrapped?.passphrase) return null;
  const old = await unlockKey(p, passphrase);
  if (!old) return null;
  const plain = await decryptFields(p, old);
  const fields: Profile['fields'] = {};
  for (const f of Object.values(p.fields)) if (f) fields[f.key] = { ...f, value: plain[f.key]! };
  const { salt: _s, verifier: _v, wrapped: _w, ...rest } = p;
  return lockProfile({ ...rest, encrypted: false, fields }, passphrase);
}

/** Plain values of a locked profile, for display and reuse while unlocked. */
export async function decryptFields(p: Profile, key: CryptoKey): Promise<Partial<Record<CanonicalKey, string>>> {
  const out: Partial<Record<CanonicalKey, string>> = {};
  for (const f of Object.values(p.fields)) if (f) out[f.key] = p.encrypted ? await decryptValue(key, f.value) : f.value;
  return out;
}

/** Removes encryption (requires the key). */
export async function unlockProfilePermanently(p: Profile, key: CryptoKey): Promise<Profile> {
  const plain = await decryptFields(p, key);
  const fields: Profile['fields'] = {};
  for (const f of Object.values(p.fields)) if (f) fields[f.key] = { ...f, value: plain[f.key]! };
  const { salt: _s, verifier: _v, wrapped: _w, ...rest } = p;
  return { ...rest, encrypted: false, fields };
}
