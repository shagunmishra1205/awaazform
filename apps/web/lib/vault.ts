'use client';

import {
  addPasskey, decryptFields, lockProfile, removePasskey, unlockKey, unlockKeyWithPasskey, unlockProfilePermanently, upgradeProfile,
  type CanonicalKey, type Profile,
} from '@awaazform/core';
import { db } from './db';
import { createPasskey, evaluate } from './passkey';

// Keys for unlocked profiles live only in memory: a reload locks everything again (FR-36), and so does
// 10 minutes without any activity on the page.
const keys = new Map<string, CryptoKey>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

const IDLE_MS = 10 * 60_000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
function touch() {
  if (idleTimer) clearTimeout(idleTimer);
  if (keys.size) idleTimer = setTimeout(lockAll, IDLE_MS);
}
if (typeof window !== 'undefined') {
  for (const ev of ['pointerdown', 'keydown', 'touchstart'] as const) window.addEventListener(ev, touch, { passive: true });
  // Leaving the tab hidden for the idle period locks too.
  document.addEventListener('visibilitychange', touch);
}

export function onVaultChange(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export const isUnlocked = (p: Profile) => !p.encrypted || keys.has(p.id);
export const keyFor = (profileId: string) => keys.get(profileId);
export const hasPasskey = (p: Profile) => !!p.wrapped?.passkey;

function remember(id: string, key: CryptoKey) {
  keys.set(id, key);
  touch();
  notify();
}

export function lockAll() {
  keys.clear();
  notify();
}

export async function setPassphrase(p: Profile, passphrase: string) {
  const { profile, key } = await lockProfile(p, passphrase);
  await db.profiles.put(profile);
  remember(p.id, key);
}

/** Returns false for a wrong passphrase. Older profiles are upgraded to envelope encryption on the way. */
export async function unlock(p: Profile, passphrase: string): Promise<boolean> {
  if (p.encrypted && !p.wrapped?.passphrase) {
    const up = await upgradeProfile(p, passphrase);
    if (!up) return false;
    await db.profiles.put(up.profile);
    remember(p.id, up.key);
    return true;
  }
  const key = await unlockKey(p, passphrase);
  if (!key) return false;
  remember(p.id, key);
  return true;
}

/** Unlock with the profile's passkey (fingerprint, face, PIN or security key). */
export async function unlockWithPasskey(p: Profile): Promise<boolean> {
  const pk = p.wrapped?.passkey;
  if (!pk) return false;
  const key = await unlockKeyWithPasskey(p, await evaluate(pk.credentialId, pk.prfSalt));
  if (!key) return false;
  remember(p.id, key);
  return true;
}

/** Adds a passkey. The passphrase confirms it's the owner and lets the data key be re-wrapped. */
export async function enrolPasskey(p: Profile, passphrase: string) {
  let profile = p;
  if (!p.wrapped?.passphrase) {
    const up = await upgradeProfile(p, passphrase);
    if (!up) throw new Error('That passphrase is not right.');
    profile = up.profile;
  }
  const { credentialId, prfSalt, output } = await createPasskey(p.label);
  await db.profiles.put(await addPasskey(profile, passphrase, output, credentialId, prfSalt));
  notify();
}

export async function forgetPasskey(p: Profile) {
  await db.profiles.put(removePasskey(p));
  notify();
}

export function lock(profileId: string) {
  keys.delete(profileId);
  notify();
}

export async function removePassphrase(p: Profile) {
  const key = keys.get(p.id);
  if (!key) throw new Error('Unlock this profile first');
  await db.profiles.put(await unlockProfilePermanently(p, key));
  keys.delete(p.id);
  notify();
}

/** Plain saved values, or `null` while the profile is locked. */
export async function readValues(p: Profile): Promise<Partial<Record<CanonicalKey, string>> | null> {
  if (!p.encrypted) return Object.fromEntries(Object.values(p.fields).map((f) => [f!.key, f!.value]));
  const key = keys.get(p.id);
  return key ? decryptFields(p, key) : null;
}
