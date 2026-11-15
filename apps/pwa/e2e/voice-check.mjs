/**
 * Voice messages on the web (slice V4 of scratch/fable-design/DESIGN-cross-chat-voice-fable.md, §11's red test) against a
 * REAL node on this machine (e2e/home-node-harness.ts: the server's own message, group and attachment routes and its
 * signature middleware), the web app built as it ships and served by that node, at 320 px with 1.3x text, light and dark:
 *
 *   1. Chrome records (Google Chrome with its fake microphone, AAC in .m4a): Ana sends a voice message in her DM with Ben
 *      and in the Garden group's locked chat; the node stores each as a `voice` line whose part is sealed (mime audio/mp4,
 *      no .m4a bytes readable), and the part opens under Ben's key as an .m4a of the length the bubble says;
 *   2. a second browser plays it: Ben in WebKit (Safari's engine) plays both, and the speed steps to 1.5×;
 *   3. Firefox (or Chrome with Firefox's recorder answer, no AAC in .m4a): the web app's own encoder records, fetched only at
 *      the click (no request for it before), under the node's real CSP; the node stores a sealed voice line whose part opens
 *      under Ben's key as an .m4a of AAC-LC at 24 kHz mono, and the same browser plays the voice messages;
 *   4. the gate: a node that says nothing of voice lines (features.voiceLines absent, as from before V2) gets no microphone.
 *
 * The node says features.voiceLines: true itself (#3120); step 4's browser has it taken out of GET /api/community/info's
 * answer, as a node from before V2 answers (counted in the log). Everything else is the node's own.
 *
 * Fails on any sideways scroll at 320 px, or a request to any host but this machine (aborted; the app's Inter is the node's
 * own files). Chrome's fake microphone beeps, so Chrome runs muted. VOICE_SHOTS names a folder for screenshots.
 *
 * Run: node e2e/voice-check.mjs (from apps/pwa). Needs Google Chrome, and Playwright's WebKit and Firefox once:
 * pnpm --filter @beanpool/pwa exec playwright install webkit firefox
 */
/* global URL, Buffer, fetch, console, process, setTimeout, document -- Node, and the page's side of evaluate() */
import { build } from 'vite';
import { chromium, webkit, firefox } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const PWA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.resolve(PWA_DIR, '../server');
process.chdir(PWA_DIR);
const TMP = process.env.VOICE_TMP || os.tmpdir();
const SHOTS = process.env.VOICE_SHOTS || '';
const VIEW = { width: 320, height: 720 };
const TEXT_SCALE = 1.3;
const RECORD_MS = 3200;

const failures = [];
function check(ok, what) {
    if (ok) console.log(`  ✓ ${what}`);
    else { failures.push(what); console.error(`  ✗ ${what}`); }
}

function memberIdentity(callsign) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
        privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex'),
        callsign,
        createdAt: new Date().toISOString(),
    };
}

async function startNode(root, members) {
    const dataDir = fs.mkdtempSync(path.join(TMP, 'bp-voice-data-'));
    const child = spawn(process.execPath, ['--import', 'tsx', '../pwa/e2e/home-node-harness.ts'], {
        cwd: SERVER_DIR,
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, FIXTURE_ROOT: root, FIXTURE_PROFILE: 'local', FIXTURE_MEMBERS: JSON.stringify(members) },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    console.log(`  (node pid ${child.pid})`);
    const log = [];
    const waiting = new Map();
    let ready;
    const readyAt = new Promise((resolve, reject) => {
        ready = resolve;
        child.on('exit', (code) => reject(new Error(`the node exited (${code}) before it was ready:\n${log.slice(-30).join('\n')}`)));
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
        if (line.startsWith('FIXTURE_READY ')) ready(JSON.parse(line.slice('FIXTURE_READY '.length)));
        else if (line.startsWith('FIXTURE_ANSWER ')) {
            const a = JSON.parse(line.slice('FIXTURE_ANSWER '.length));
            waiting.get(a.id)?.(a);
            waiting.delete(a.id);
        } else log.push(line);
    });
    readline.createInterface({ input: child.stderr }).on('line', (line) => log.push(line));
    const { port } = await readyAt;
    let n = 0;
    const ask = (req) => new Promise((resolve, reject) => {
        const id = ++n;
        waiting.set(id, (a) => (a.ok ? resolve(a.result) : reject(new Error(`node: ${a.error}`))));
        child.stdin.write(`${JSON.stringify({ id, ...req })}\n`);
    });
    const stop = async () => {
        child.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 300));
        if (child.exitCode === null) child.kill('SIGKILL');
        fs.rmSync(dataDir, { recursive: true, force: true });
    };
    return { port, ask, log, stop, origin: `https://localhost:${port}` };
}

let infoChanged = 0;
const otherHosts = new Set();
async function shot(page, name) { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch((e) => console.error('shot', name, e?.message)); }

/** A browser context signed in as `identity`; `voiceLines: 'drop'` takes features.voiceLines out of the node's info (an old node). */
async function openAs(browser, origin, identity, { theme = 'light', voiceLines = 'as-is', mic = false } = {}) {
    const context = await browser.newContext({ viewport: VIEW, ignoreHTTPSErrors: true, reducedMotion: 'reduce', ...(mic ? { permissions: ['microphone'] } : {}) });
    await context.addInitScript((mode) => {
        try {
            localStorage.setItem('beanpool-theme-mode', mode);
            localStorage.setItem('beanpool-install-dismissed-forever', '1');
        } catch { /* none */ }
    }, theme);
    // Network requests only: the page's own blob: URLs (a voice message opened here) have no host and never leave it.
    await context.route((url) => /^(https?|wss?):$/.test(url.protocol) && url.hostname !== 'localhost', (route) => { otherHosts.add(new URL(route.request().url()).hostname); return route.abort(); });
    if (voiceLines === 'drop') {
        await context.route((url) => url.hostname === 'localhost' && url.pathname === '/api/community/info', async (route) => {
            const res = await route.fetch();
            const body = await res.json().catch(() => null);
            if (body?.features && 'voiceLines' in body.features) { delete body.features.voiceLines; infoChanged += 1; }
            await route.fulfill({ response: res, json: body });
        });
    }
    const page = await context.newPage();
    await page.goto(`${origin}/app`, { waitUntil: 'load' });
    await page.evaluate((id) => new Promise((resolve, reject) => {
        const open = indexedDB.open('beanpool-identity', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('keys');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const tx = open.result.transaction('keys', 'readwrite');
            tx.objectStore('keys').put(id, 'sovereign-identity');
            tx.oncomplete = () => { open.result.close(); resolve(); };
            tx.onerror = () => reject(tx.error);
        };
    }), identity);
    return { context, page };
}

async function openChat(page, node, name) {
    await node.ask({ op: 'resetLimits' });
    await page.goto(`${node.origin}/app`, { waitUntil: 'load' });
    await page.addStyleTag({ content: `html { font-size: ${TEXT_SCALE * 100}% !important; }` });
    await page.getByRole('button', { name: /Chat/ }).first().click({ timeout: 30_000 });
    await page.getByText(name, { exact: true }).first().click({ timeout: 30_000 });
    await page.getByPlaceholder('Message...').waitFor({ timeout: 30_000 });
}

async function noSidewaysScroll(page, where) {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(over <= 1, `${where}: no sideways scroll at 320 px with 1.3x text${over > 1 ? ` (it scrolls ${over}px)` : ''}`);
}

async function signedFetch(core, origin, identity, method, p, body) {
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const key = crypto.createPrivateKey({ key: Buffer.from(identity.privateKey, 'hex'), format: 'der', type: 'pkcs8' });
    const headers = await core.buildBoundRequestHeaders({
        method, url: `${origin}${p}`, body: bodyString, publicKeyHex: identity.publicKey,
        sign: async (bytes) => new Uint8Array(crypto.sign(null, Buffer.from(bytes), key)),
    });
    const res = await fetch(`${origin}${p}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: bodyString }) });
    return { status: res.status, body: await res.json().catch(() => null) };
}

/** Ana records `RECORD_MS` with Chrome's fake microphone and sends it; resolves once her bubble shows. */
async function recordAndSend(page, where, theme) {
    await page.getByRole('button', { name: 'Record a voice message' }).click();
    await page.getByRole('button', { name: 'Stop recording' }).waitFor({ timeout: 15_000 });
    await page.waitForTimeout(RECORD_MS);
    await noSidewaysScroll(page, `${where}, recording (${theme})`);
    await shot(page, `voice-${where}-recording-320-${theme}`);
    await page.getByRole('button', { name: 'Stop recording' }).click();
    await page.getByRole('button', { name: 'Play recording' }).waitFor({ timeout: 15_000 });
    await shot(page, `voice-${where}-review-320-${theme}`);
    await page.getByRole('button', { name: 'Send voice message' }).click();
    await page.getByRole('button', { name: 'Record a voice message' }).waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: /^Play voice message, 0:0[3-4]$/ }).first().waitFor({ timeout: 30_000 });
}

/** Play the first voice message: it plays when its button turns to Pause and the clock moves. */
async function plays(page, who) {
    const play = page.getByRole('button', { name: /^Play voice message, / }).first();
    await play.waitFor({ timeout: 30_000 });
    const label = await play.getAttribute('aria-label');
    await play.click();
    const pause = page.getByRole('button', { name: 'Pause voice message' }).first();
    const started = await pause.waitFor({ timeout: 10_000 }).then(() => true, () => false);
    await page.waitForTimeout(1300);
    // Played, not only marked playing: the position the <audio> reports has moved (a refused source never moves).
    const at = Number(await page.getByTestId('voice-wave').first().getAttribute('data-position-ms'));
    check(started && at > 200, `${who}: the voice message plays (${label} → Pause; at ${at} ms after 1.3 s)`);
    return started;
}

async function main() {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const root = fs.mkdtempSync(path.join(TMP, 'bp-voice-check-'));
    const ana = memberIdentity('Ana');
    const ben = memberIdentity('Ben');
    let node = null;
    const browsers = [];
    try {
        console.log('Building the web app…');
        await build({ root: PWA_DIR, logLevel: 'warn', build: { outDir: path.join(root, 'public'), emptyOutDir: true } });
        node = await startNode(root, [{ publicKey: ana.publicKey, callsign: 'Ana' }, { publicKey: ben.publicKey, callsign: 'Ben' }]);
        const core = await import('@beanpool/core');
        const [{ id: G }] = await node.ask({ op: 'sql', sql: "SELECT id FROM groups WHERE name = 'Garden group'", all: true });
        await node.ask({ op: 'joinGroup', groupId: G, member: ben.publicKey });
        const made = await signedFetch(core, node.origin, ana, 'POST', '/api/messages/conversation', { type: 'dm', participants: [ana.publicKey, ben.publicKey], createdBy: ana.publicKey });
        const DM = made.body?.conversation?.id;
        check(!!DM, `Ana and Ben have a direct chat (${made.status})`);
        const own = await fetch(`${node.origin}/api/community/info`).then((r) => r.json());
        console.log(`  (this node's own features.voiceLines: ${JSON.stringify(own?.features?.voiceLines)})`);

        console.log('1. Chrome records; the node stores it sealed');
        const chrome = await chromium.launch({ channel: 'chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--mute-audio'] });
        browsers.push(chrome);
        const recordable = await (await chrome.newPage()).evaluate(() => MediaRecorder.isTypeSupported('audio/mp4;codecs=mp4a.40.2'));
        check(recordable, 'Chrome writes AAC in .m4a (MediaRecorder audio/mp4;codecs=mp4a.40.2)');
        for (const theme of ['light', 'dark']) {
            const a = await openAs(chrome, node.origin, ana, { theme, mic: true });
            await openChat(a.page, node, 'Ben');
            await noSidewaysScroll(a.page, `Ana's DM with the microphone (${theme})`);
            await shot(a.page, `voice-dm-mic-320-${theme}`);
            await recordAndSend(a.page, 'dm', theme);
            await noSidewaysScroll(a.page, `Ana's DM with her voice message (${theme})`);
            await shot(a.page, `voice-dm-bubble-320-${theme}`);
            if (theme === 'light') {
                await openChat(a.page, node, 'Garden group');
                await a.page.getByTestId('group-chat-notice').waitFor({ timeout: 30_000 });
                await recordAndSend(a.page, 'group', theme);
                await shot(a.page, `voice-group-bubble-320-${theme}`);
            }
            await a.context.close();
        }
        const lines = await node.ask({ op: 'sql', sql: "SELECT m.id, m.conversation_id AS conv, m.type, m.nonce, a.mime, a.data, a.nonce AS anonce, a.storage_key AS sk FROM messages m LEFT JOIN message_attachments a ON a.message_id = m.id WHERE m.author_pubkey = ? AND m.type = 'voice' ORDER BY m.timestamp", params: [ana.publicKey], all: true });
        const dmLines = lines.filter((l) => l.conv === DM);
        const groupLines = lines.filter((l) => l.conv === G);
        check(dmLines.length === 2 && groupLines.length === 1, `the node holds Ana's voice lines as type voice: ${dmLines.length} in the DM, ${groupLines.length} in the group`);
        check(lines.every((l) => l.mime === 'audio/mp4'), `each part is kept marked audio/mp4 (${lines.map((l) => l.mime).join(', ')})`);
        for (const l of lines) {
            const part = await signedFetch(core, node.origin, ben, 'GET', `/api/messages/${encodeURIComponent(l.id)}/attachment`);
            const raw = Buffer.from(String(part.body?.data ?? ''), 'base64');
            check(part.status === 200 && !raw.includes(Buffer.from('ftyp')) && !raw.includes(Buffer.from('mp4a')),
                `${l.conv === DM ? 'DM' : 'group'} line ${l.id.slice(0, 8)}: the node serves its part sealed (${part.status}, ${raw.length} bytes, no .m4a box readable)`);
            if (l.conv === DM && part.status === 200) {
                const opened = core.openDmVoice({ ciphertext: part.body.data, nonce: part.body.nonce }, { myEdPrivHex: ben.privateKey, peerEdPubHex: ana.publicKey },
                    { conversationId: DM, senderPubHex: ana.publicKey, messageId: l.id, metadata: null });
                const kbps = (opened.sound.length * 8) / opened.durationMs;
                if (process.env.VOICE_SAVE) fs.writeFileSync(process.env.VOICE_SAVE, opened.sound);
                check(core.looksLikeM4a(opened.sound) && opened.durationMs >= RECORD_MS && opened.durationMs < RECORD_MS + 3000,
                    `it opens under Ben's key as Ana's .m4a: ${opened.durationMs} ms, ${opened.sound.length} bytes (${kbps.toFixed(1)} kbps), ${opened.bars.length} bars`);
            }
        }

        console.log('2. A second browser plays it: Ben in WebKit (Safari\'s engine)');
        const wk = await webkit.launch();
        browsers.push(wk);
        for (const theme of ['light', 'dark']) {
            const b = await openAs(wk, node.origin, ben, { theme });
            await openChat(b.page, node, 'Ana');
            await plays(b.page, `Ben's DM in WebKit (${theme})`);
            await noSidewaysScroll(b.page, `Ben's DM playing (${theme})`);
            await shot(b.page, `voice-dm-playing-webkit-320-${theme}`);
            if (theme === 'light') {
                await b.page.getByRole('button', { name: 'Playback speed 1×' }).first().click();
                check(await b.page.getByRole('button', { name: 'Playback speed 1.5×' }).count() > 0, 'the speed steps 1× → 1.5×');
                await openChat(b.page, node, 'Garden group');
                await plays(b.page, "Ben's group chat in WebKit");
            }
            await b.context.close();
        }

        console.log("3. Firefox: the web app's own encoder records, fetched at the click; it plays");
        // Playwright's Firefox where it starts; else Chrome answering as Firefox's recorder does (no AAC in .m4a), said in the log.
        // Firefox's own fake microphone, asked without a prompt; muted.
        let ff = await firefox.launch({ firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true, 'media.volume_scale': '0.0' } }).catch((e) => { console.log(`  (Playwright's Firefox didn't start here: ${String(e?.message).split('\n').find((l) => l.includes('[err]') && !l.includes('headless')) ?? 'no reason given'}; Chrome stands in with Firefox's MediaRecorder answer)`); return null; });
        const firefoxStandIn = !ff;
        const ffName = firefoxStandIn ? 'Firefox stand-in (Chrome, no AAC recorder)' : 'Firefox';
        if (!ff) ff = chrome;
        else browsers.push(ff);
        for (const theme of ['light', 'dark']) {
            const f = await openAs(ff, node.origin, ana, { theme, mic: firefoxStandIn });
            if (firefoxStandIn) {
                await f.context.addInitScript(() => {
                    const was = MediaRecorder.isTypeSupported.bind(MediaRecorder);
                    MediaRecorder.isTypeSupported = (type) => (String(type).startsWith('audio/mp4') ? false : was(type));
                });
            }
            // The encoder's chunk (its WebAssembly is inside it) and the capture worklet: counted, so a fetch before the click shows.
            const encoderFetches = [];
            const cspRefusals = [];
            f.page.on('request', (r) => { if (/voice-(encode|capture)/.test(r.url())) encoderFetches.push(r.url()); });
            const pageErrors = [];
            f.page.on('console', (m) => {
                if (/content security policy|wasm|webassembly/i.test(m.text())) cspRefusals.push(m.text());
                if (m.type() === 'error') pageErrors.push(m.text());
            });
            f.page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e)));
            await openChat(f.page, node, 'Ben');
            await f.page.getByRole('button', { name: /^Play voice message, / }).first().waitFor({ timeout: 30_000 });
            check(await f.page.getByRole('button', { name: 'Record a voice message' }).count() === 1, `${ffName} (${theme}): the microphone, not the "can't record" line`);
            check(encoderFetches.length === 0, `${ffName} (${theme}): nothing of the encoder fetched before the click (${encoderFetches.length})`);
            if (theme === 'light') {
                const went = await recordAndSend(f.page, 'dm-encoder', theme).then(() => true, async (e) => {
                    const note = await f.page.getByTestId('voice-note').textContent({ timeout: 2000 }).catch(() => '(no note)');
                    console.log(`  (the encoder's send didn't finish: ${String(e?.message).split('\n')[0]}; the note says "${note}"; page errors: ${pageErrors.join(' | ') || 'none'})`);
                    return false;
                });
                check(went, `${ffName}: recorded through the encoder and sent`);
                check(encoderFetches.length > 0 && encoderFetches.every((u) => new URL(u).hostname === 'localhost'),
                    `${ffName}: the encoder fetched at the click, from the node only (${encoderFetches.map((u) => new URL(u).pathname).join(', ')})`);
                check(cspRefusals.length === 0, `${ffName}: no policy refusal under the node's own CSP (${cspRefusals.join(' | ') || 'none'})`);
                await plays(f.page, `Ana's DM in ${ffName}`);
            }
            await noSidewaysScroll(f.page, `Ana's DM in ${ffName} (${theme})`);
            await shot(f.page, `voice-dm-firefox-320-${theme}`);
            await f.context.close();
        }
        const encoded = await node.ask({ op: 'sql', sql: "SELECT m.id FROM messages m WHERE m.author_pubkey = ? AND m.type = 'voice' AND m.conversation_id = ? ORDER BY m.timestamp", params: [ana.publicKey, DM], all: true });
        check(encoded.length === 3, `the node holds the encoder's voice line beside Chrome's two (${encoded.length} in the DM)`);
        const last = encoded[encoded.length - 1];
        if (last) {
            const part = await signedFetch(core, node.origin, ben, 'GET', `/api/messages/${encodeURIComponent(last.id)}/attachment`);
            const opened = core.openDmVoice({ ciphertext: part.body.data, nonce: part.body.nonce }, { myEdPrivHex: ben.privateKey, peerEdPubHex: ana.publicKey },
                { conversationId: DM, senderPubHex: ana.publicKey, messageId: last.id, metadata: null });
            const { Input, BufferSource, ALL_FORMATS } = await import('mediabunny');
            const track = await new Input({ source: new BufferSource(opened.sound), formats: ALL_FORMATS }).getPrimaryAudioTrack();
            const seconds = await track.computeDuration();
            if (process.env.VOICE_SAVE_ENCODER) fs.writeFileSync(process.env.VOICE_SAVE_ENCODER, opened.sound);
            check(core.looksLikeM4a(opened.sound) && track.codec === 'aac' && track.sampleRate === 24000 && track.numberOfChannels === 1
                && (await track.getCodecParameterString()) === 'mp4a.40.2' && seconds * 1000 >= RECORD_MS - 300,
                `the encoder's line opens under Ben's key as the phone's .m4a: ${track.codec} ${await track.getCodecParameterString()}, ${track.sampleRate} Hz, ${track.numberOfChannels} ch, ${seconds.toFixed(2)} s, ${opened.sound.length} bytes`);
        }

        console.log("4. The gate: a node that says nothing of voice lines gets no microphone");
        check(own?.features?.voiceLines === true, `this node says features.voiceLines: true itself (#3120): ${JSON.stringify(own?.features?.voiceLines)}`);
        const g = await openAs(chrome, node.origin, ana, { voiceLines: 'drop', mic: true });
        await openChat(g.page, node, 'Ben');
        await g.page.getByRole('button', { name: /^Play voice message, / }).first().waitFor({ timeout: 30_000 });
        check(await g.page.getByRole('button', { name: 'Record a voice message' }).count() === 0, 'with features.voiceLines taken out of its info (an old node): no microphone, and voice messages still play');
        check(await g.page.getByTestId('voice-cant-record').count() === 0, 'and no line about the browser either');
        await g.context.close();
        console.log(`  (community info answers with features.voiceLines taken out: ${infoChanged})`);
        check(otherHosts.size === 0, `no request left this machine (${[...otherHosts].join(', ') || 'none'})`);
    } finally {
        for (const b of browsers) await b.close().catch(() => {});
        if (node) {
            if (failures.length) console.error(node.log.slice(-40).join('\n'));
            await node.stop();
        }
        fs.rmSync(root, { recursive: true, force: true });
    }
    if (failures.length) {
        console.error(`\n${failures.length} check(s) failed`);
        process.exit(1);
    }
    console.log('\nAll voice checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
