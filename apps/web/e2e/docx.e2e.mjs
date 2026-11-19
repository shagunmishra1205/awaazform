// Word (.docx) forms: blanks, ☐ boxes, empty table cells and a content control, filled and downloaded.
// Usage: BASE_URL=http://localhost:3000 node e2e/docx.e2e.mjs
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const channel = process.env.BROWSER_CHANNEL ?? 'msedge';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const p = (...runs) => `<w:p>${runs.join('')}</w:p>`;
const r = (t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
const cell = (t) => `<w:tc><w:p>${t ? r(t) : ''}</w:p></w:tc>`;
const body = [
  p(r('Scholarship Application')),
  p(r('Full name: '), r('______________________')),
  p(r('Category: ☐ General ☐ OBC ☐ SC ☐ ST')),
  `<w:tbl><w:tr>${cell('Date of birth')}${cell('')}</w:tr><w:tr>${cell('Mobile number')}${cell('')}</w:tr></w:tbl>`,
  `<w:p><w:sdt><w:sdtPr><w:alias w:val="Father's name"/><w:showingPlcHdr/><w:text/></w:sdtPr><w:sdtContent>${r('Click to enter text.')}</w:sdtContent></w:sdt></w:p>`,
  p(r('Bank account password: ________')),
].join('');
const docx = zipSync({
  '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
  '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
  'word/document.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`),
});

const browser = await chromium.launch({ channel, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const problems = [];
page.on('pageerror', (e) => problems.push(e.message));
const answer = async (text, shown = text) => {
  await page.getByRole('textbox', { name: 'Your answer' }).fill(text);
  await page.getByRole('button', { name: 'Check answer' }).click();
  await page.getByRole('group').getByText(shown, { exact: true }).waitFor();
  await page.getByRole('button', { name: /Confirm/ }).click();
  await page.waitForTimeout(900);
  const no = page.getByRole('button', { name: 'No', exact: true });
  if (await no.isVisible().catch(() => false)) { await no.click(); await page.waitForTimeout(800); }
};

try {
  await page.goto(`${BASE}/documents`);
  await page.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('awaazform'); });
  await page.goto(`${BASE}/documents`, { waitUntil: 'networkidle' });
  await page.getByLabel('Choose a file').setInputFiles({ name: 'scholarship.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(docx) });
  await page.getByRole('heading', { name: 'Check the questions' }).waitFor();
  const labels = await page.locator('ol input.field-input').evaluateAll((els) => els.map((e) => e.value));
  assert.deepEqual(labels, ['Full name', 'Category', 'Date of birth', 'Mobile number', "Father's name", 'Bank account password']);
  await page.getByRole('button', { name: /Start filling \(6\)/ }).click();
  await page.getByRole('heading', { name: 'Ready when you are' }).waitFor();
  await page.getByText('Word document', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Read aloud' }).click();
  await page.getByRole('button', { name: /^Start, filling for/ }).click();

  await answer('Priya Patil');
  await page.getByRole('heading', { name: 'Category' }).waitFor();
  await page.getByRole('button', { name: /OBC/ }).click();
  await page.getByRole('button', { name: /Confirm/ }).click();
  await page.waitForTimeout(900);
  await answer('5 June 2007', '5 June 2007');
  await answer('98440 12345', '9844012345');
  await answer('Ramesh Patil');
  // The password blank is never filled (PRD §9), and auto-advance passes over it.
  await page.getByRole('navigation', { name: 'Questions' }).getByRole('button', { name: /^Question 6:/ }).click();
  await page.getByText(/AwaazForm does not fill this/).first().waitFor();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download .docx' }).click();
  const file = await (await download).path();
  const { readFileSync } = await import('node:fs');
  const xml = strFromU8(unzipSync(new Uint8Array(readFileSync(file)))['word/document.xml']);
  for (const v of ['Priya Patil', '☒', '05/06/2007', '9844012345', 'Ramesh Patil']) assert.ok(xml.includes(v), `filled document contains ${v}`);
  assert.ok(!xml.includes('showingPlcHdr'), 'placeholder flag removed');
  assert.equal((xml.match(/☒/g) ?? []).length, 1, 'only one box ticked');
  assert.ok(xml.includes('Bank account password: </w:t>') || xml.includes('________'), 'password blank left alone');
  assert.deepEqual(problems, [], 'no page errors');
  console.log('DOCX E2E PASS');
} catch (err) {
  console.error('DOCX E2E FAIL:', err.message);
  if (problems.length) console.error(problems.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
