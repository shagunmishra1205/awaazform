// Builds the extension into dist/ and zips it for the website's download button.
//   node build.mjs                 → dist/ + ../web/public/downloads/awaazform-extension.zip
//   AWAAZ_SERVER=https://… node build.mjs   sets the server the widget talks to by default
import { build } from 'esbuild';
import { zipSync } from 'fflate';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '../web');
const dist = join(here, 'dist');
const server = process.env.AWAAZ_SERVER || process.env.NEXT_PUBLIC_SITE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'locales'), { recursive: true });

await build({
  entryPoints: [join(here, 'src/widget.ts')],
  outfile: join(dist, 'widget.js'),
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  minify: true,
  legalComments: 'none',
  alias: { '@': web },
  define: { __AWAAZ_SERVER__: JSON.stringify(server.replace(/\/+$/, '')), 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});

for (const f of ['manifest.json', 'background.js', 'content.js', 'widget.html', 'widget.css', 'permission.html', 'permission.js']) cpSync(join(here, f), join(dist, f));
cpSync(join(here, 'icons'), join(dist, 'icons'), { recursive: true });
// Translations, without the bookkeeping the translation script keeps.
const locales = join(web, 'lib/i18n/locales');
if (existsSync(locales)) {
  for (const f of readdirSync(locales).filter((x) => x.endsWith('.json'))) {
    const { _source, ...strings } = JSON.parse(readFileSync(join(locales, f), 'utf8'));
    writeFileSync(join(dist, 'locales', f), JSON.stringify(strings));
  }
}

// Zip under a folder name, so “extract here” gives one tidy folder to load.
const files = {};
const walk = (dir) => readdirSync(dir).forEach((f) => {
  const p = join(dir, f);
  if (statSync(p).isDirectory()) walk(p);
  else files[`awaazform-extension/${relative(dist, p)}`] = readFileSync(p);
});
walk(dist);
const zip = zipSync(files, { level: 9 });
const out = join(web, 'public/downloads');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'awaazform-extension.zip'), zip);
const { version } = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
writeFileSync(join(out, 'extension.json'), JSON.stringify({ version, bytes: zip.length }));
console.log(`extension ${version}: dist/ and public/downloads/awaazform-extension.zip (${Math.round(zip.length / 1024)} KB), server ${server}`);
