// Regression: real pointer strokes, typed signatures, table columns, and the downloaded PDF.
// BASE_URL=http://localhost:3100 node e2e/signature.e2e.mjs
import { chromium } from 'playwright-core';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const base = process.env.BASE_URL ?? 'http://localhost:3100';
const standardFontDataUrl = new URL('./standard_fonts/', import.meta.resolve('pdfjs-dist/package.json')).pathname;
const doc = await PDFDocument.create();
const sheet = doc.addPage([612, 792]);
const font = await doc.embedFont(StandardFonts.Helvetica);
const print = (text, x, y) => sheet.drawText(text, { x, y, font, size: 12 });
print('Student application', 40, 740);
print('Subjects: tick Internal and External as applicable', 40, 650);
for (const [y, label] of [[600, 'Subject'], [560, 'Embedded Systems'], [520, 'Immersive Technology']]) {
  for (const [x, width] of [[40, 300], [340, 100], [440, 100]]) {
    sheet.drawRectangle({ x, y, width, height: 40, borderWidth: 1, borderColor: rgb(0, 0, 0) });
  }
  print(label, 50, y + 14);
}
print('Internal', 350, 614);
print('External', 450, 614);
print('Date:', 40, 350);
sheet.drawLine({ start: { x: 80, y: 348 }, end: { x: 550, y: 348 }, thickness: 0.5 });
print('Signature of the student', 380, 350);
const fixture = process.env.PDF_FILE ? fs.readFileSync(process.env.PDF_FILE) : Buffer.from(await doc.save());

const originalTask = pdfjs.getDocument({ data: new Uint8Array(fixture), standardFontDataUrl });
const original = await originalTask.promise;
const originalOps = await (await original.getPage(original.numPages)).getOperatorList();
const originalImages = originalOps.fnArray.filter((fn) => fn === pdfjs.OPS.paintImageXObject).length;
await originalTask.destroy();

const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, deviceScaleFactor: 2, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.route('**/api/extract', async (route) => {
  const { items } = route.request().postDataJSON();
  const find = (re) => items.find((i) => re.test(i.text));
  const subject = find(/^Subjects:|Please select your subject/i);
  if (!subject) return route.fulfill({ json: { questions: [] } });
  await route.fulfill({ json: { questions: [
    { itemId: subject.id, label: 'Subjects', type: 'multichoice', required: false,
      options: [/^Embedded Systems/, /^Immersive Technology/].map((re) => ({ itemId: find(re).id, text: find(re).text })) },
    { itemId: find(/^Date:/).id, label: 'Date', type: 'date', required: false },
    ...(!process.env.PDF_FILE ? [{ itemId: find(/Signature of the student/).id, label: 'Signature of the student', type: 'text', required: false }] : []),
  ] } });
});
// No AI or speech service is needed for this deterministic input test.
await page.route('**/api/chat', (route) => route.fulfill({ status: 503, json: { error: 'Offline test' } }));
const ink = (canvas) => canvas.evaluate((c) => {
  const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let x0 = c.width, x1 = -1, y0 = c.height, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    if (data[(y * c.width + x) * 4 + 3] > 10) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  return { width: x1 < 0 ? 0 : x1 - x0 + 1, height: y1 < 0 ? 0 : y1 - y0 + 1, canvasWidth: c.width };
});
try {
  await page.goto(`${base}/documents`);
  await page.getByLabel('Choose a file').setInputFiles({ name: 'signature-regression.pdf', mimeType: 'application/pdf', buffer: fixture });
  await page.getByRole('heading', { name: 'Check the questions and boxes' }).waitFor({ timeout: 120_000 });
  const subjectBox = await page.getByRole('button', { name: /^Answer box for Subjects\./ }).boundingBox();
  const dateBox = await page.getByRole('button', { name: /^Answer box for Date\./ }).boundingBox();
  const signatureBox = await page.getByRole('button', { name: /^Answer box for Signature of the student\./ }).boundingBox();
  assert.ok(dateBox.x + dateBox.width < signatureBox.x, 'date stops before the signature');
  assert.ok(subjectBox.width < signatureBox.width, 'subject outline surrounds tick columns only');
  assert.ok(signatureBox.y + signatureBox.height < dateBox.y + dateBox.height, 'signature goes above its caption');
  await page.getByRole('button', { name: /Start filling/ }).click();
  await page.getByRole('button', { name: /^Start, filling for/ }).click();
  const nav = page.getByRole('navigation', { name: 'Questions' });
  await nav.getByRole('button', { name: /signature/i }).click();
  const pad = page.getByRole('img', { name: /Signature pad/ });
  await pad.scrollIntoViewIfNeeded();
  // Wait for the question transition before taking coordinates.
  await page.waitForTimeout(500);
  const b = await pad.boundingBox();
  await page.mouse.move(b.x + 30, b.y + 100);
  await page.mouse.down();
  for (let i = 0; i <= 60; i++) await page.mouse.move(b.x + 30 + i * (b.width - 60) / 60, b.y + 90 - 35 * Math.sin(i / 4), { steps: 2 });
  await page.mouse.up();
  const drawn = await ink(pad);
  console.log('Drawn ink:', drawn);
  assert.ok(drawn.width > drawn.canvasWidth * 0.65, 'signature stroke spans the pad, not just its first vertical segment');
  assert.ok(drawn.height > 50, 'signature retains its vertical movement');
  // A responsive size change must preserve the existing signature.
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.waitForTimeout(250);
  const resized = await ink(pad);
  assert.ok(resized.width > resized.canvasWidth * 0.65, 'resize preserves signature ink');
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  assert.equal((await ink(pad)).width, 0, 'Clear removes all ink');
  assert.ok(await page.getByRole('button', { name: 'Use this signature' }).isDisabled());

  // Exercise real touch events, including capture outside the pad before returning.
  const touch = await context.newCDPSession(page);
  const tb = await pad.boundingBox();
  const sendTouch = (type, x, y) => touch.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, force: 0.5 }],
  });
  await sendTouch('touchStart', tb.x + 20, tb.y + 90);
  for (let i = 0; i <= 30; i++) await sendTouch('touchMove', tb.x + 20 + i * (tb.width - 40) / 30, tb.y + 90 + 30 * Math.sin(i / 3));
  await sendTouch('touchMove', tb.x + tb.width + 10, tb.y + 90);
  await sendTouch('touchMove', tb.x + tb.width - 20, tb.y + 110);
  await sendTouch('touchEnd');
  assert.ok((await ink(pad)).width > (await ink(pad)).canvasWidth * 0.7, 'touch draws a complete signature');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/signature-pad.png` });
  await page.getByRole('button', { name: 'Use this signature' }).click();
  await page.getByRole('img', { name: 'Your signature', exact: true }).waitFor();
  const confirm = async () => {
    await page.getByRole('button', { name: /Confirm/ }).click();
    await page.waitForTimeout(400);
  };
  await confirm();
  const answer = async (label, value) => {
    await nav.getByRole('button', { name: label }).click();
    await page.getByLabel('Your answer').fill(value);
    await page.getByRole('button', { name: 'Check answer' }).click();
    await confirm();
  };
  await answer(/Subjects/, 'Embedded Systems (Internal), Embedded Systems (External)');
  await answer(/Date/, '19/11/2026');

  const download = async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download PDF' }).click()]);
    if (process.env.SHOTS) await dl.saveAs(`${process.env.SHOTS}/signature-filled.pdf`);
    const task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(await dl.path())), standardFontDataUrl });
    const pdf = await task.promise;
    const last = await pdf.getPage(pdf.numPages);
    const text = (await last.getTextContent()).items.filter((i) => 'str' in i);
    const ops = await last.getOperatorList();
    const images = ops.fnArray.filter((fn) => fn === pdfjs.OPS.paintImageXObject).length;
    assert.equal(images, originalImages + 1, 'one signature image is stamped into the PDF');
    const ticks = text.filter((i) => i.str === 'X');
    assert.equal(ticks.length, 2, 'exactly two table ticks');
    assert.ok(ticks[1].transform[4] > ticks[0].transform[4], 'ticks occupy separate columns');
    assert.equal(ticks[0].transform[5], ticks[1].transform[5], 'ticks occupy the same subject row');
    if (!process.env.PDF_FILE) {
      assert.ok(ticks[0].transform[4] > 340 && ticks[0].transform[4] < 440, 'Internal tick is inside its cell');
      assert.ok(ticks[1].transform[4] > 440 && ticks[1].transform[4] < 540, 'External tick is inside its cell');
    }
    await task.destroy();
    return text.map((i) => i.str).join(' ');
  };
  assert.match(await download(), /19\/11\/2026/);
  // Edit after downloading: old signatures and dates must not accumulate.
  await nav.getByRole('button', { name: /Signature of the student/ }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Or type your name to use as a signature').fill('Asha Rao');
  const typed = await ink(pad);
  assert.ok(typed.width > 100 && typed.height > 20, 'typed name creates visible ink');
  await page.getByRole('button', { name: 'Use this signature' }).click();
  await confirm();
  await nav.getByRole('button', { name: /Date/ }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Your answer').fill('20/11/2026');
  await page.getByRole('button', { name: 'Check answer' }).click();
  await confirm();
  const revised = await download();
  assert.match(revised, /20\/11\/2026/);
  assert.doesNotMatch(revised, /19\/11\/2026/);
  assert.equal((revised.match(/20\/11\/2026/g) ?? []).length, 1);
  await download();
  assert.deepEqual(errors, [], 'no browser runtime errors');
  console.log('SIGNATURE PDF E2E PASS');
} finally {
  if (errors.length) console.error(errors);
  await browser.close();
}
