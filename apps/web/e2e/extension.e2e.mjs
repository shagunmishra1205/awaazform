// The built extension, end to end: Bolu appears on a real Google Form, a typed answer is read back,
// nothing reaches the page until Yes, then it is filled and verified. Nothing is ever submitted.
// Needs Playwright's full Chromium and a running server (the widget's AI and voice live there).
// Usage: BASE_URL=http://localhost:3000 node e2e/extension.e2e.mjs   (run `node ../extension/build.mjs` first)
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const FORM = process.env.GFORM_URL ?? 'https://docs.google.com/forms/d/e/1FAIpQLSd5pRDUpkOjWqXpEaYYLOLsJz2xYWbF8N1fDc2vyUmxW4RFyg/viewform';
const ext = fileURLToPath(new URL('../../extension/dist', import.meta.url));
const SHOTS = process.env.SHOTS;

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'awaaz-ext-')), {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 860 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const problems = [];
try {
  let [worker] = ctx.serviceWorkers();
  worker ??= await ctx.waitForEvent('serviceworker');
  // Point the widget at the test server.
  await worker.evaluate((base) => chrome.storage.local.set({ server: base, language: 'en' }), BASE);

  const page = await ctx.newPage();
  await page.goto(FORM, { waitUntil: 'networkidle' });
  const widget = async () => {
    for (let i = 0; i < 40; i++) {
      const f = page.frames().find((x) => x.url().includes('/widget.html'));
      if (f) return f;
      await page.waitForTimeout(250);
    }
    throw new Error('Bolu did not appear on the form');
  };
  const w = await widget();
  w.page().on('pageerror', (e) => problems.push(e.message));
  await w.locator('#fab').click();
  await w.locator('#panel').waitFor();
  await w.locator('#q-meta').filter({ hasText: /questions on this page/ }).waitFor({ timeout: 15_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/widget-open.png` });

  await w.locator('#kbd').click();
  await w.locator('#type-in').fill('test@example.com');
  await w.locator('#typer button[type=submit]').click();
  await w.locator('#readback').waitFor({ timeout: 15_000 });
  assert.equal(await w.locator('#rb-value').textContent(), 'test@example.com');
  const onPage = () => page.evaluate(() => [...document.querySelectorAll('input')].some((e) => e.value === 'test@example.com'));
  assert.equal(await onPage(), false, 'nothing filled before Yes');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/widget-readback.png` });

  await w.locator('#yes').click();
  await w.locator('#note.ok').waitFor({ timeout: 15_000 });
  assert.equal(await onPage(), true, 'filled on the real form after Yes');

  await w.locator('#tr-toggle').click();
  await w.locator('#transcript').waitFor();
  assert.ok((await w.locator('#tr-list li').count()) >= 2, 'transcript shows the conversation');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/widget-transcript.png` });

  // Language switch re-labels the widget.
  await w.locator('#lang').selectOption('hi');
  await w.waitForFunction(() => document.documentElement.lang === 'hi');
  assert.deepEqual(problems, [], 'no errors in the widget');
  console.log('EXTENSION E2E PASS (Bolu filled “Email” on the live Google Form)');
} catch (err) {
  console.error('EXTENSION E2E FAIL:', err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await ctx.close();
}
