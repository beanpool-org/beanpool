/**
 * The web app's own voice encoder (src/lib/voice-encode.ts: FFmpeg's AAC encoder in WebAssembly and mediabunny's muxer,
 * ~340 KB gzip) is fetched only at the first click on the microphone in a browser whose recorder can't write .m4a, never
 * on page load, and only from the node. On the web app built as it ships, this fails unless:
 *
 *   1. the encoder is a chunk of its own (assets/voice-encode-*.js) holding the encoder (registerAacEncoder's worker);
 *   2. nothing the page loads at start reaches it: index.html's scripts and modulepreloads, and every chunk they import
 *      statically, hold none of the encoder and import its chunk only by import(), never statically;
 *   3. the capture worklet is a file of the node's own (assets/voice-capture-worklet-*.js), never a data: or blob: URL,
 *      which the web app's script-src 'self' would refuse (Vite inlines a small asset unless told not to);
 *   4. no .wasm file is fetched from anywhere (the WebAssembly is inside the chunk) and the chunk imports nothing by URL.
 *
 * Run: node e2e/voice-encoder-chunk-check.mjs [built-dir] (from apps/pwa). With no dir it builds into a temp folder.
 */
/* global console, process */
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(ok, msg) { console.log(`${ok ? '✓' : '✗'} ${msg}`); if (!ok) failures++; }

let dir = process.argv[2];
if (!dir) {
    dir = fs.mkdtempSync(path.join(process.env.VOICE_TMP || os.tmpdir(), 'bp-voice-chunk-'));
    console.log(`Building the web app into ${dir}…`);
    await build({ root: PWA_DIR, logLevel: 'warn', build: { outDir: dir, emptyOutDir: true } });
}
const assets = path.join(dir, 'assets');
const files = fs.readdirSync(assets);
const read = (f) => fs.readFileSync(path.join(assets, f), 'utf8');

// 1. Its own chunk, holding the encoder.
const encoderChunks = files.filter((f) => /^voice-encode-[\w-]+\.js$/.test(f));
check(encoderChunks.length === 1, `one encoder chunk (${encoderChunks.join(', ') || 'none'})`);
const ENCODER_MARK = 'AAC encoder worker failed to load';
const holding = files.filter((f) => f.endsWith('.js') && read(f).includes(ENCODER_MARK));
check(holding.length === 1 && holding[0] === encoderChunks[0], `the encoder's code is in that chunk only (${holding.join(', ') || 'nowhere'})`);

// 2. Nothing loaded at start reaches it.
const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const startFiles = [...html.matchAll(/(?:src|href)="\/?assets\/([^"]+\.js)"/g)].map((m) => m[1]);
check(startFiles.length > 0, `index.html loads ${startFiles.length} script(s) at start`);
const STATIC_IMPORT = /(?:^|[;\n}])\s*(?:import|export)\s*(?:[\w*{}\s,$]*?from\s*)?["']\.\/([^"']+\.js)["']/g;
const seen = new Set();
const queue = [...startFiles];
while (queue.length) {
    const f = queue.shift();
    if (seen.has(f) || !files.includes(f)) continue;
    seen.add(f);
    for (const m of read(f).matchAll(STATIC_IMPORT)) queue.push(m[1]);
}
check(!encoderChunks.some((c) => seen.has(c)), `the ${seen.size} chunk(s) the page loads at start don't import the encoder's chunk statically`);
check([...seen].every((f) => !read(f).includes(ENCODER_MARK)), 'none of them holds the encoder');
check(!encoderChunks.some((c) => html.includes(c)), 'index.html neither loads nor preloads it');
const dynamicRefs = files.filter((f) => f.endsWith('.js') && encoderChunks.some((c) => read(f).includes(c)) && !encoderChunks.includes(f));
check(dynamicRefs.length > 0, `it is reached by import() from ${dynamicRefs.join(', ') || 'nothing (dead?)'}`);

// 3. The worklet is a file of the node's own.
const worklets = files.filter((f) => /^voice-capture-worklet-[\w-]+\.js$/.test(f));
check(worklets.length === 1 && read(worklets[0]).includes("registerProcessor('beanpool-voice-capture'"), `the capture worklet is its own file (${worklets.join(', ') || 'none'})`);
const enc = encoderChunks[0] ? read(encoderChunks[0]) : '';
check(worklets[0] ? enc.includes(worklets[0]) : false, 'the encoder\'s chunk loads it by its file name');
check(!/data:(?:text|application)\/javascript/.test(enc), 'no data: script in the encoder\'s chunk (script-src \'self\' refuses one)');

// 4. No .wasm fetched, no import by URL.
check(!files.some((f) => f.endsWith('.wasm')), 'no .wasm file: the WebAssembly is inside the chunk');
check(!/import\(\s*["'`]https?:/.test(enc) && !/fetch\(\s*["'`]https?:/.test(enc), 'the chunk imports and fetches nothing by URL');

const gz = (await import('node:zlib')).gzipSync(Buffer.from(enc)).length;
console.log(`  (encoder chunk: ${(enc.length / 1024).toFixed(0)} KB, ${(gz / 1024).toFixed(0)} KB gzip)`);
if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall checks passed');
