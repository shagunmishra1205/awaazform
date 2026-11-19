// Microsoft Forms by link, against a real public form. Nothing is ever submitted.
// Usage: BASE_URL=http://localhost:3000 MSFORM_URL=https://forms.office.com/r/… node e2e/msform.e2e.mjs
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const FORM = process.env.MSFORM_URL ?? 'https://forms.office.com/r/ZS8SNWCRCG';
const channel = process.env.BROWSER_CHANNEL ?? 'msedge';
const browser = await chromium.launch({ channel, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));

try {
  await page.goto(`${BASE}/form`);
  await page.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('awaazform'); });
  await page.reload();
  await page.getByLabel(/Form link/).fill(FORM.replace(/^https:\/\//, ''));
  await page.getByRole('button', { name: /Read the form/ }).click();
  await page.getByRole('heading', { name: 'Ready when you are' }).waitFor({ timeout: 25_000 });
  await page.getByText('Microsoft Form', { exact: true }).first().waitFor();

  await page.getByRole('button', { name: 'Read aloud' }).click();
  await page.getByRole('button', { name: /^Start, filling for/ }).click();
  const first = await page.locator('#q-label').textContent();
  await page.getByRole('textbox', { name: 'Your answer' }).fill(/mail/i.test(first) ? 'test@example.com' : 'Automated Test');
  await page.getByRole('button', { name: 'Check answer' }).click();
  await page.getByRole('button', { name: /Confirm/ }).click();
  await page.waitForTimeout(800);

  // The hand-off: a pre-filled link if the owner allows it, otherwise the copy-answers dialog.
  const link = page.getByRole('link', { name: /Open in Microsoft Forms/ });
  if (await link.count()) {
    assert.match(await link.getAttribute('href'), /ResponsePage\.aspx\?id=/);
  } else {
    await page.getByRole('button', { name: /Your answers 1 confirmed/ }).click();
    await page.getByRole('dialog').getByText(/Copy your answers/).waitFor();
    await page.getByRole('button', { name: /^Copy answer to/ }).first().waitFor();
  }
  assert.deepEqual(problems, [], 'no page errors');
  console.log('MSFORM E2E PASS');
} catch (err) {
  console.error('MSFORM E2E FAIL:', err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
