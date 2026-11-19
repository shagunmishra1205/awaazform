// Run against a production build: BROWSER_CHANNEL= pnpm --filter web test:pwa
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';

const require = createRequire(import.meta.url);
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'msedge', headless: true });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  reducedMotion: 'reduce', bypassCSP: true,
});
const page = await ctx.newPage();
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: ({ files }) => !!files?.length });
  Object.defineProperty(navigator, 'share', { configurable: true, value: async ({ files }) => { window.__sharedFile = { name: files[0].name, size: files[0].size }; } });
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const notice = page.getByRole('complementary', { name: 'AwaazForm app' });
const check = (label) => console.log(`PWA ✓ ${label}`);
const waitForWorker = async (p = page) => {
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.waitForFunction(() => !!navigator.serviceWorker.controller);
};
const share = async (fields) => {
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.evaluate((values) => {
    // Android sends a navigation POST, not a fetch followed by a non-navigation redirect.
    const form = document.createElement('form');
    form.method = 'POST'; form.action = '/share-target'; form.enctype = 'multipart/form-data';
    for (const [key, value] of Object.entries(values)) {
      const input = document.createElement('input'); input.name = key;
      if (key === 'files') {
        input.type = 'file'; input.multiple = true;
        const transfer = new DataTransfer();
        for (const f of value) transfer.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
        input.files = transfer.files;
      } else { input.type = 'hidden'; input.value = value; }
      form.append(input);
    }
    document.body.append(form); form.submit();
  }, fields)]);
  return new URL(page.url()).searchParams.get('id');
};
const fakeInstall = async (outcome) => page.evaluate((result) => {
  const event = new Event('beforeinstallprompt', { cancelable: true });
  window.__prompted = 0;
  event.prompt = async () => { window.__prompted++; };
  event.userChoice = Promise.resolve({ outcome: result });
  window.dispatchEvent(event);
}, outcome);

try {
  const response = await page.goto(BASE);
  assert.equal(response.status(), 200);
  const manifestHref = await page.locator('link[rel=manifest]').getAttribute('href');
  const manifest = await (await ctx.request.get(BASE + manifestHref)).json();
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.id, '/');
  assert.equal(manifest.share_target.method, 'POST');
  assert.equal(manifest.shortcuts.length, 3);
  for (const icon of manifest.icons) {
    const r = await ctx.request.get(BASE + icon.src);
    const bytes = await r.body();
    assert.equal(r.headers()['content-type'], 'image/png');
    const size = Number(icon.sizes.split('x')[0]);
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
  const workerResponse = await ctx.request.get(BASE + '/sw.js');
  assert.match(workerResponse.headers()['cache-control'], /no-store/);
  assert.equal(workerResponse.headers()['service-worker-allowed'], '/');
  await waitForWorker();
  check('manifest, launcher/maskable icons, root scope, worker headers and installation');

  await notice.getByRole('button', { name: 'Install app', exact: true }).waitFor();
  await fakeInstall('dismissed');
  await notice.getByRole('button', { name: 'Install app', exact: true }).click();
  await notice.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.__prompted), 1);
  await page.reload();
  await waitForWorker();
  assert.equal(await notice.count(), 0);
  check('native install invoked once; dismissal survives reload');

  await page.goto(BASE + '/settings');
  const app = page.getByRole('group', { name: 'AwaazForm app' });
  await app.getByRole('button', { name: 'How to install' }).click();
  await app.getByText(/In Chrome or Edge, open the browser menu/).waitFor();
  await fakeInstall('accepted');
  await app.getByRole('button', { name: 'Install app', exact: true }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await app.getByText('AwaazForm is installed', { exact: true }).waitFor();
  assert.equal(await app.getByRole('button', { name: 'Install app', exact: true }).count(), 0);
  check('Settings recovery, Android fallback, and appinstalled state');

  // Re-open the invitation to audit the actual narrow-screen UI.
  await page.evaluate(() => localStorage.removeItem('awaazform.installDismissedAt'));
  await page.goto(BASE);
  await waitForWorker();
  await notice.waitFor();
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  let audit = await page.evaluate(() => window.axe.run(document.querySelector('.pwa-notice'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } }));
  assert.deepEqual(audit.violations, []);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(await page.evaluate(() => parseFloat(getComputedStyle(document.body).paddingBottom) >= document.querySelector('.pwa-notice').getBoundingClientRect().height));
  await mkdir('/tmp/awaazform-pwa', { recursive: true });
  await page.waitForTimeout(600);
  await page.screenshot({ path: '/tmp/awaazform-pwa/install-android.png' });
  await page.evaluate(() => { document.documentElement.dataset.contrast = 'high'; document.documentElement.dataset.text = 'large'; document.documentElement.dir = 'rtl'; });
  await page.setViewportSize({ width: 320, height: 780 });
  audit = await page.evaluate(() => window.axe.run(document.querySelector('.pwa-notice'), { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } }));
  assert.deepEqual(audit.violations, []);
  assert.ok(await page.evaluate(() => { const box = document.querySelector('.pwa-notice').getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; }));
  await page.screenshot({ path: '/tmp/awaazform-pwa/install-accessible.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  check('mobile install banner: axe, safe content space, large text, high contrast and RTL');

  await page.goto(BASE + '/form');
  assert.equal(await notice.count(), 0, 'install invitation never covers a form');
  await share({ text: 'Please fill https://forms.gle/example' });
  await page.getByRole('button', { name: 'Open this item' }).click();
  await page.waitForURL('**/form?shared=*');
  assert.equal(await page.locator('input[inputmode=url]').inputValue(), 'https://forms.gle/example');
  check('Android link sharing prefills a supported link without scanning or replacing a session');

  const docx = zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
    'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Full name: __________</w:t></w:r></w:p></w:body></w:document>'),
  });
  const file = { name: 'private-application.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes: Array.from(docx) };
  const id = await share({ files: [file] });
  await page.getByText(file.name, { exact: true }).waitFor();
  const encrypted = await page.evaluate(async (key) => new Promise((resolve) => {
    const open = indexedDB.open('awaazform-share', 1);
    open.onsuccess = () => {
      const db = open.result;
      const req = db.transaction('items').objectStore('items').get(key);
      req.onsuccess = () => { const r = req.result; resolve({ ciphertext: new TextDecoder().decode(r.bytes), extractable: r.key.extractable, name: r.name }); db.close(); };
    };
  }), id);
  assert.equal(encrypted.extractable, false);
  assert.equal(encrypted.name, undefined);
  assert.ok(!encrypted.ciphertext.includes(file.name));
  assert.ok(!encrypted.ciphertext.includes('Full name'));
  await page.getByRole('button', { name: 'Open this item' }).click();
  await page.getByRole('heading', { name: 'Check the questions' }).waitFor();
  await page.getByRole('button', { name: /Start filling/ }).click();
  await page.getByRole('heading', { name: 'Ready when you are' }).waitFor();
  await page.waitForFunction(() => localStorage.getItem('awaazform.session.docx')?.startsWith('enc1:'));
  await page.getByRole('button', { name: 'Prepare to share', exact: true }).click();
  await page.getByRole('button', { name: 'Share file…', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__sharedFile.name), 'private-application-filled.docx');
  check('shared DOCX encrypted at rest, imported locally and opened in the document workflow');

  await ctx.setOffline(true);
  await page.reload();
  await page.getByRole('heading', { name: 'Ready when you are' }).waitFor();
  await notice.getByText('You’re offline', { exact: true }).waitFor();
  for (const route of ['/', '/profiles', '/settings', '/form']) {
    await page.goto(BASE + route);
    await page.locator('h1').waitFor();
    assert.ok((await page.locator('h1').innerText()).length > 0);
  }
  await page.goto(BASE + '/not-cached');
  await page.getByRole('heading', { name: 'You’re offline' }).waitFor();
  await page.getByRole('link', { name: 'Documents', exact: true }).last().click();
  await page.getByRole('heading', { name: 'Ready when you are' }).waitFor();
  await share({ files: [file] });
  await page.getByText(file.name, { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForURL(BASE + '/');
  check('cold offline startup, saved document resume, fallback page and offline Android sharing');

  await ctx.setOffline(false);
  await notice.getByText('You’re offline', { exact: true }).waitFor({ state: 'hidden' });
  await share({ files: [{ name: 'bad.txt', type: 'text/plain', bytes: [1, 2] }] });
  await page.getByRole('alert').filter({ hasText: 'Share a PDF' }).waitFor();
  await share({ files: [file, file] });
  await page.getByRole('alert').filter({ hasText: 'one document' }).waitFor();
  await share({ url: 'https://example.com/forms/private' });
  await page.getByRole('alert').filter({ hasText: 'Share a PDF' }).waitFor();
  await page.goto(BASE + '/share?id=11111111-1111-4111-8111-111111111111');
  await page.getByRole('alert').filter({ hasText: 'no longer available' }).waitFor();
  const keys = await page.evaluate(async () => {
    const names = await caches.keys();
    return (await Promise.all(names.map(async (name) => (await (await caches.open(name)).keys()).map((r) => r.url)))).flat();
  });
  assert.ok(!keys.some((url) => /\/api\/|\/share-target|[?&](shared|id)=/.test(url)));
  check('unsupported, multiple and expired shares rejected; no private payloads in Cache Storage');
  assert.deepEqual(errors, [], 'no browser exceptions');

  // Serve two real versions of the worker on an isolated origin; don't mutate public/sw.js.
  let updateVersion = false;
  const proxy = createServer(async (req, res) => {
    try {
      const upstream = await fetch(BASE + req.url);
      const headers = new Headers(upstream.headers);
      for (const name of ['content-length', 'content-encoding', 'transfer-encoding', 'connection']) headers.delete(name);
      let body = Buffer.from(await upstream.arrayBuffer());
      if (req.url === '/sw.js' && updateVersion) body = Buffer.from(body.toString().replace(/const VERSION = '([^']+)';/, "const VERSION = '$1-update';"));
      res.writeHead(upstream.status, Object.fromEntries(headers)); res.end(body);
    } catch { res.writeHead(502); res.end(); }
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const updateContext = await browser.newContext();
  try {
    const updatePage = await updateContext.newPage();
    const updateBase = `http://127.0.0.1:${proxy.address().port}`;
    await updatePage.goto(updateBase);
    await waitForWorker(updatePage);
    await updatePage.evaluate(() => localStorage.setItem('pwa-test-preserve', 'saved'));
    updateVersion = true;
    await updatePage.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await updatePage.getByText('An AwaazForm update is ready', { exact: true }).waitFor();
    assert.equal(await updatePage.evaluate(() => localStorage.getItem('pwa-test-preserve')), 'saved');
    await Promise.all([
      updatePage.waitForEvent('load'),
      updatePage.getByRole('button', { name: 'Reload to update', exact: true }).click(),
    ]);
    await waitForWorker(updatePage);
    assert.equal(await updatePage.evaluate(() => localStorage.getItem('pwa-test-preserve')), 'saved');
    const cacheNames = await updatePage.evaluate(() => caches.keys());
    assert.equal(cacheNames.filter((n) => n.startsWith('awaazform-shell-')).length, 2);
    assert.ok(cacheNames.some((n) => n.endsWith('-update')));
    check('real worker update waits for consent, reloads on request and preserves local data');
  } finally {
    await updateContext.close();
    await new Promise((resolve) => proxy.close(resolve));
  }
  console.log('PWA E2E PASS');
} catch (error) {
  console.error('PWA browser errors:', errors);
  console.error('PWA last screen:', (await page.locator('body').innerText()).slice(0, 1800));
  throw error;
} finally {
  await ctx.close();
  await browser.close();
}
