'use client';

// Passkeys as a hardware-backed unlock for saved details. WebAuthn's PRF extension asks the authenticator
// (TPM, Secure Enclave, Android keystore or a security key) to compute a secret from a salt; it never
// leaves the authenticator's control without a fingerprint, face or PIN check. That secret wraps the
// profile's data key. No server is involved: the challenge is random and nothing is verified remotely.

const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

/** Whether this browser can create passkeys at all. PRF support is only known after trying. */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials?.create;
}

/** Creates a passkey for a profile and returns its PRF output. Throws a plain message if PRF isn't available. */
export async function createPasskey(label: string): Promise<{ credentialId: string; prfSalt: string; output: ArrayBuffer }> {
  const salt = random(32);
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: 'AwaazForm' },
      user: { id: random(16), name: `awaazform-${label}`, displayName: `AwaazForm · ${label}` },
      challenge: random(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
      timeout: 120_000,
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('No passkey was created.');
  const credentialId = b64(cred.rawId);
  const ext = cred.getClientExtensionResults() as PrfResults;
  if (ext.prf?.enabled === false) throw new Error('This passkey can’t protect data (it has no PRF support). Try a different device or security key.');
  // Some authenticators return the secret at creation; others only when the passkey is used.
  const output = ext.prf?.results?.first ?? (await evaluate(credentialId, b64(salt)));
  return { credentialId, prfSalt: b64(salt), output };
}

/** Uses a profile's passkey (fingerprint, face or PIN) and returns its PRF output. */
export async function evaluate(credentialId: string, prfSalt: string): Promise<ArrayBuffer> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      allowCredentials: [{ type: 'public-key', id: unb64(credentialId) }],
      userVerification: 'required',
      timeout: 120_000,
      extensions: { prf: { eval: { first: unb64(prfSalt) } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const out = (cred?.getClientExtensionResults() as PrfResults | undefined)?.prf?.results?.first;
  if (!out) throw new Error('This passkey can’t protect data (it has no PRF support). Try a different device or security key.');
  return out;
}
