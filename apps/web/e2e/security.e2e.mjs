// Security checks: passkey (WebAuthn PRF) unlock with a virtual authenticator, encryption at rest for
// sessions, and the API refusing other websites.
// Usage: BASE_URL=http://localhost:3000 node e2e/security.e2e.mjs
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { startMockSession } from './mock-gform.mjs';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const channel = process.env.BROWSER_CHANNEL ?? 'msedge';
const browser = await chromium.launch({ channel, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
page.on('dialog', (d) => d.accept());

try {
  // 1. The API answers this site and the extension, not other websites.
  const evil = await fetch(`${BASE}/api/gform`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{"url":"x"}' });
  assert.equal(evil.status, 403, 'other origins are refused');
  const ext = await fetch(`${BASE}/api/tts`, { headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' } });
  assert.equal(ext.headers.get('access-control-allow-origin'), 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'the extension gets CORS');
  console.log('api guard: ok');

  // 2. Sessions are encrypted at rest.
  await startMockSession(page, BASE);
  await page.getByRole('button', { name: 'Read aloud' }).click();
  await page.getByRole('button', { name: /^Start, filling for/ }).click();
  await page.getByRole('textbox', { name: 'Your answer' }).fill('Sunita Devi');
  await page.getByRole('button', { name: 'Check answer' }).click();
  await page.getByRole('button', { name: /Confirm/ }).click();
  await page.waitForTimeout(800);
  const stored = await page.evaluate(() => localStorage.getItem('awaazform.session.gform'));
  assert.ok(stored?.startsWith('enc1:'), 'session is stored encrypted');
  assert.ok(!stored.includes('Sunita'), 'no answer in plain text');
  await page.reload();
  await page.getByText('Sunita Devi').first().waitFor(); // and it still resumes
  console.log('encryption at rest: ok');

  // 3. Passkey unlock, with a virtual platform authenticator that supports PRF.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', ctap2Version: 'ctap2_1', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  });
  await page.goto(`${BASE}/profiles`);
  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: /Me/ }) }).first();
  await card.getByRole('button', { name: /Add passphrase/ }).click();
  await page.getByLabel('Passphrase', { exact: true }).fill('correct horse battery');
  await page.getByLabel('Type it again').fill('correct horse battery');
  await page.getByRole('button', { name: 'Protect' }).click();
  await card.getByText(/Unlocked/).first().waitFor();

  await card.getByRole('button', { name: /fingerprint or face/ }).click();
  await page.getByLabel('Passphrase', { exact: true }).fill('correct horse battery');
  await page.getByRole('button', { name: 'Continue' }).click();
  await card.getByText(/Passkey on/).waitFor({ timeout: 15_000 });

  await card.getByRole('button', { name: 'Lock now' }).click();
  await card.getByText(/Locked/).first().waitFor();
  await card.getByRole('button', { name: /Unlock with passkey/ }).click();
  await card.getByText(/Unlocked/).first().waitFor({ timeout: 15_000 });
  const saved = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('awaazform');
    r.onsuccess = () => { const g = r.result.transaction('profiles').objectStore('profiles').get('me'); g.onsuccess = () => res(g.result); };
  }));
  assert.ok(saved.wrapped?.passphrase && saved.wrapped?.passkey?.credentialId, 'data key wrapped by passphrase and passkey');
  assert.ok(!JSON.stringify(saved).includes('Sunita'), 'saved values are encrypted');
  console.log('passkey unlock: ok');

  assert.deepEqual(problems, [], 'no page errors');
  console.log('SECURITY E2E PASS');
} catch (err) {
  console.error('SECURITY E2E FAIL:', err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
