// Serves the pdf.js worker from our own origin (CSP: worker-src 'self').
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const src = join(dirname(require.resolve('pdfjs-dist/package.json')), 'build', 'pdf.worker.min.mjs');
mkdirSync('public', { recursive: true });
copyFileSync(src, 'public/pdf.worker.min.mjs');

// Live Mode's voice detector (Silero VAD) runs in the browser: its model, audio worklet and the ONNX
// runtime's WebAssembly are served from our origin too (CSP), under /vad/.
const vadDir = dirname(require.resolve('@ricky0123/vad-web'));
const ortDir = join(dirname(createRequire(join(vadDir, 'index.js')).resolve('onnxruntime-web/wasm')), '.');
mkdirSync('public/vad', { recursive: true });
for (const f of ['silero_vad_v5.onnx', 'vad.worklet.bundle.min.js']) copyFileSync(join(vadDir, f), join('public/vad', f));
for (const f of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) copyFileSync(join(ortDir, f), join('public/vad', f));
