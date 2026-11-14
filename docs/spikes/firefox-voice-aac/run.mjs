// Throwaway spike runner (docs/spikes/firefox-voice-aac.md). Serves this folder on localhost (a secure context, which
// WebCodecs needs), opens one page in Firefox headless with its volume at zero, and prints what the page POSTs to /result.
// Usage: node run.mjs <page.html> playwright|stock [outFile]
//   playwright: Playwright's patched Firefox (apps/pwa's playwright).
//   stock:      the Firefox installed at /Applications/Firefox.app, headless, fresh throwaway profile.
// Nothing here plays sound: pages only encode; media.volume_scale is 0 in both modes anyway.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const here = path.dirname(new URL(import.meta.url).pathname);
const [page, mode = 'playwright', outFile] = process.argv.slice(2);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.wav': 'audio/wav' };
const extraRoot = process.env.SPIKE_VENDOR; // optional folder of downloaded libraries, served under /vendor/

let resolveResult;
const result = new Promise((r) => { resolveResult = r; });
const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/result') {
        const parts = [];
        req.on('data', (d) => parts.push(d));
        req.on('end', () => { res.end('ok'); resolveResult(Buffer.concat(parts)); });
        return;
    }
    if (req.method === 'POST' && req.url.startsWith('/file/')) {
        const parts = [];
        req.on('data', (d) => parts.push(d));
        req.on('end', () => {
            const name = path.basename(req.url.slice(6));
            fs.writeFileSync(path.join(process.env.SPIKE_OUT ?? os.tmpdir(), name), Buffer.concat(parts));
            res.end('ok');
        });
        return;
    }
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = url.startsWith('/vendor/') && extraRoot ? path.join(extraRoot, url.slice(8)) : path.join(here, url);
    if (!file.startsWith(here) && !(extraRoot && file.startsWith(extraRoot))) { res.statusCode = 403; return res.end(); }
    fs.readFile(file, (err, body) => {
        if (err) { res.statusCode = 404; return res.end(); }
        res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
        // Cross-origin isolation, in case a WASM build wants SharedArrayBuffer threads.
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        res.end(body);
    });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://localhost:${server.address().port}/${page}`;
const timeout = setTimeout(() => resolveResult(Buffer.from(JSON.stringify({ error: 'timeout after 300 s' }))), 300_000);

let close;
if (mode === 'playwright') {
    const require = createRequire(path.join(here, '../../../apps/pwa/package.json'));
    const { firefox } = require('playwright');
    const browser = await firefox.launch({ headless: true, firefoxUserPrefs: { 'media.volume_scale': '0.0' } });
    const p = await browser.newPage();
    p.on('console', (m) => process.stderr.write(`[console] ${m.text()}\n`));
    p.on('pageerror', (e) => process.stderr.write(`[pageerror] ${e.message}\n`));
    await p.goto(url);
    close = () => browser.close();
} else {
    const profile = fs.mkdtempSync(path.join(process.env.SPIKE_OUT ?? os.tmpdir(), 'ffprofile-'));
    fs.writeFileSync(path.join(profile, 'user.js'), [
        'user_pref("media.volume_scale", "0.0");',
        'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
        'user_pref("toolkit.telemetry.reporting.policy.firstRun", false);',
        'user_pref("browser.startup.homepage_override.mstone", "ignore");',
        'user_pref("app.update.disabledForTesting", true);',
    ].join('\n'));
    const child = spawn('/Applications/Firefox.app/Contents/MacOS/firefox', ['--headless', '--no-remote', '--profile', profile, url], { stdio: 'ignore' });
    process.stderr.write(`[stock firefox pid ${child.pid}]\n`);
    close = async () => { child.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 1500)); if (child.exitCode === null) child.kill('SIGKILL'); };
}
const body = await result;
clearTimeout(timeout);
await close();
server.close();
const text = body.toString();
if (outFile) fs.writeFileSync(outFile, text);
console.log(text);
