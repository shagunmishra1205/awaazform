// The extension's content script on real Google and Microsoft forms: scan, fill, read back.
// Injected with a chrome.runtime stub (no extension install needed). Nothing is ever submitted.
// Usage: node e2e/extension-content.e2e.mjs
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const channel = process.env.BROWSER_CHANNEL ?? 'msedge';
const GFORM = process.env.GFORM_URL ?? 'https://docs.google.com/forms/d/e/1FAIpQLSd5pRDUpkOjWqXpEaYYLOLsJz2xYWbF8N1fDc2vyUmxW4RFyg/viewform';
const MSFORM = process.env.MSFORM_URL ?? 'https://forms.office.com/r/ZS8SNWCRCG';
const script = readFileSync(new URL('../../extension/content.js', import.meta.url), 'utf8');
const stub = `window.chrome = { runtime: { onMessage: { addListener(fn) { window.__awaaz = (m) => new Promise((r) => fn({ awaazform: true, ...m }, {}, r)); } } } };`;

const browser = await chromium.launch({ channel, headless: true });
const call = (page, m) => page.evaluate((m) => window.__awaaz(m), m);
const open = async (url) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  // Pages like Google's enforce Trusted Types, so load the script the way the browser would: at document start.
  await page.addInitScript(`${stub}\n${script}`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
  await page.waitForTimeout(1500);
  return page;
};

try {
  // Google: questions come from data-params, parsed by the shared parser.
  const g = await open(GFORM);
  const scan = await call(g, { type: 'scan' });
  assert.equal(scan.result.platform, 'google');
  // The same fields the shared parser reads: [id, title, help, type, [[entryId, options, required]]].
  const TYPES = { 0: 'text', 1: 'paragraph', 2: 'choice', 3: 'dropdown', 4: 'checkbox', 5: 'scale' };
  const form = { questions: scan.result.items.filter((it) => TYPES[it[3]]).map((it) => ({
    id: `g${it[0]}`, label: it[1], type: TYPES[it[3]], options: (it[4][0][1] ?? []).map((o) => o[0]).filter(Boolean),
    source: { kind: 'google-form', entryId: String(it[4][0][0]) },
  })) };
  if (scan.result.collectEmail) form.questions.unshift({ id: 'gemail', label: 'Email', type: 'email', source: { kind: 'google-form', entryId: 'emailAddress' } });
  const written = [];
  for (const q of form.questions) {
    const v = q.options?.length ? q.options.at(-1) : q.type === 'email' ? 'test@example.com' : 'Automated test, please ignore';
    const w = await call(g, { type: 'write', question: q, value: v });
    assert.equal(w.ok, true, `wrote ${q.label}: ${w.error ?? ''}`);
    assert.equal((await call(g, { type: 'read', question: q })).result, v, `read back ${q.label}`);
    written.push(q.label);
  }
  assert.ok(written.length >= 2, 'filled questions on page one');
  console.log(`google: wrote and verified ${written.length} questions (${written.join(' | ').slice(0, 120)})`);

  // Microsoft: questions read from the DOM.
  const m = await open(MSFORM);
  const ms = await call(m, { type: 'scan' });
  assert.equal(ms.result.platform, 'microsoft');
  assert.ok(ms.result.questions.length >= 5, 'found Microsoft questions');
  const mq = (x) => ({ id: `e-${x.key}`, label: x.label, type: x.control === 'radio' ? 'choice' : 'text', options: x.options, source: { kind: 'dom', url: MSFORM, key: x.key, platform: 'microsoft' } });
  const mText = mq(ms.result.questions.find((x) => x.control === 'text'));
  const mRadio = mq(ms.result.questions.find((x) => x.control === 'radio'));
  assert.equal((await call(m, { type: 'write', question: mText, value: 'Automated Test' })).ok, true);
  assert.equal((await call(m, { type: 'read', question: mText })).result, 'Automated Test');
  assert.equal((await call(m, { type: 'write', question: mRadio, value: mRadio.options[0] })).ok, true);
  assert.equal((await call(m, { type: 'read', question: mRadio })).result, mRadio.options[0]);
  console.log(`microsoft: ${ms.result.questions.length} questions; wrote “${mText.label}” and “${mRadio.label}”`);

  // Generic page with an ordinary HTML form.
  const p = await browser.newPage();
  await p.addInitScript(`${stub}\n${script}`);
  await p.goto('about:blank');
  await p.setContent(`<form><label for=n>Full name</label><input id=n>
    <fieldset><legend>Gender</legend><label><input type=radio name=g value=Male>Male</label><label><input type=radio name=g value=Female>Female</label></fieldset>
    <label>City <select><option value="">Choose</option><option>Pune</option><option>Mumbai</option></select></label>
    <label>Password <input type=password></label><button>Submit</button></form>`);
  const gs = (await call(p, { type: 'scan' })).result;
  assert.deepEqual(gs.questions.map((x) => [x.label, x.control]), [['Full name', 'text'], ['Gender', 'radio'], ['City Choose Pune Mumbai', 'select']].map(([l, c]) => [gs.questions.find((q) => q.control === c).label, c]));
  assert.ok(!gs.questions.some((x) => /password/i.test(x.label)), 'password fields are never offered');
  const sel = gs.questions.find((x) => x.control === 'select');
  await call(p, { type: 'write', question: { id: 'x', label: sel.label, type: 'dropdown', options: sel.options, source: { kind: 'dom', key: sel.key } }, value: 'Pune' });
  assert.equal((await call(p, { type: 'read', question: { id: 'x', type: 'dropdown', source: { kind: 'dom', key: sel.key } } })).result, 'Pune');
  console.log('generic page: OK');
  console.log('EXTENSION CONTENT E2E PASS');
} catch (err) {
  console.error('EXTENSION CONTENT E2E FAIL:', err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
