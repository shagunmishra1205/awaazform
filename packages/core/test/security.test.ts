import { describe, expect, it } from 'vitest';
import {
  addPasskey, createShield, decryptFields, deriveKey, encryptValue, lockProfile, newSalt, removePasskey,
  unlockKey, unlockKeyWithPasskey, upgradeProfile, type Profile,
} from '../src';

const base: Profile = {
  id: 'p', label: 'Maa', createdAt: '2026-01-01', encrypted: false,
  fields: { full_name: { key: 'full_name', value: 'Sunita Devi', confirmedAt: '2026-01-01', sources: ['Form'] } },
};
const prf = (n: number) => new Uint8Array(32).fill(n);

describe('envelope encryption and passkeys', () => {
  it('locks with a data key and unlocks with the passphrase', async () => {
    const { profile } = await lockProfile(base, 'correct horse battery');
    expect(profile.wrapped?.passphrase).toBeTruthy();
    expect(profile.fields.full_name?.value).not.toContain('Sunita');
    expect(await unlockKey(profile, 'wrong one!!')).toBeNull();
    const key = await unlockKey(profile, 'correct horse battery');
    expect((await decryptFields(profile, key!)).full_name).toBe('Sunita Devi');
  });

  it('adds a passkey that unlocks the same data, and only with the right PRF output', async () => {
    const { profile } = await lockProfile(base, 'correct horse battery');
    await expect(addPasskey(profile, 'nope nope nope', prf(7), 'cred', 'salt')).rejects.toThrow();
    const withKey = await addPasskey(profile, 'correct horse battery', prf(7), 'cred', 'salt');
    expect(withKey.wrapped?.passkey?.credentialId).toBe('cred');
    expect(await unlockKeyWithPasskey(withKey, prf(8))).toBeNull();
    const key = await unlockKeyWithPasskey(withKey, prf(7));
    expect((await decryptFields(withKey, key!)).full_name).toBe('Sunita Devi');
    // The passphrase still works, and removing the passkey keeps the data.
    expect(await unlockKey(withKey, 'correct horse battery')).not.toBeNull();
    expect(await unlockKeyWithPasskey(removePasskey(withKey), prf(7))).toBeNull();
  });

  it('upgrades a v1 profile (passphrase key used directly) to envelope encryption', async () => {
    const salt = newSalt();
    const k = await deriveKey('correct horse battery', salt);
    const v1: Profile = { ...base, encrypted: true, salt, verifier: await encryptValue(k, 'awaazform-verifier-v1'),
      fields: { full_name: { ...base.fields.full_name!, value: await encryptValue(k, 'Sunita Devi') } } };
    expect(await unlockKey(v1, 'correct horse battery')).not.toBeNull();
    const up = await upgradeProfile(v1, 'correct horse battery');
    expect(up?.profile.wrapped?.passphrase).toBeTruthy();
    expect((await decryptFields(up!.profile, up!.key)).full_name).toBe('Sunita Devi');
  });
});

describe('privacy shield', () => {
  it('hides identifiers from the AI and restores them locally', () => {
    const s = createShield();
    const hidden = s.hide('My email is asha.rao@example.com, phone +91 98440 12345, Aadhaar 2345 6789 0123, PAN ABCDE1234F. I am Asha.');
    expect(hidden).not.toMatch(/example\.com|98440|6789|ABCDE1234F/);
    expect(hidden).toContain('Asha.');
    expect(hidden).toContain('⟦EMAIL_1⟧');
    expect(s.reveal('{"value":"⟦EMAIL_1⟧"}')).toBe('{"value":"asha.rao@example.com"}');
    expect(s.reveal(hidden)).toContain('+91 98440 12345');
    // The same value gets the same placeholder in later turns.
    expect(s.hide('again asha.rao@example.com')).toBe('again ⟦EMAIL_1⟧');
  });
});
