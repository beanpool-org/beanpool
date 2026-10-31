/**
 * A photo link (the director, 31 Oct, for seeding: an assistant such as Claude Code runs commands but never sees its bearer, so
 * POST /mcp/photos is no use to it, and a photo in the call is 49,000 to 192,000 characters): `photo_upload_link` makes
 * /mcp/photos/u/<token>, which takes images for an hour with no header. End to end with the official TypeScript MCP SDK client
 * over REAL HTTPS through the real Koa middleware, and once with the real curl line the manual gives. No image server and no
 * network: the photos are made here.
 *
 *   1. Who gets it: an owner's assistant ticked "May post for me"; an admin's and an unticked one neither list nor run it, in
 *      words; a Settings preview never makes one. The answer is exactly url, expiresAt, photosLeftToday, on this node, for an
 *      hour; connection_info and the tool's description give the flow.
 *   2. The flow: three files in a row through one link give three ids, each id makes a post at 800 px with no metadata; PUT
 *      and the manual's curl line work; another grant can't spend an id; the answer is /mcp/photos's own, no-referrer, no-store, no CORS.
 *   3. Upload only: a GET, HEAD, DELETE or PATCH reads nothing and says nothing about the token; the web app is never served
 *      there; a wrong token is answered as a dead link, to the byte; a wrong case of the route is 404.
 *   4. Through the same path as /mcp/photos: too small, not an image, a wrong type, JSON, over 5 MB (declared, while 10 bytes
 *      of it were sent; and streamed), another site's page, a disk at its floor: refused, nothing kept.
 *   5. It dies: past its hour, a grant's days ending first, revoked (a token's, during an upload, and an OAuth grant's), unticked,
 *      a demoted owner, the owners' switch, and a fourth link replaces the oldest. Each stays dead when what killed it is undone.
 *   6. Photos a day are 4 × the owners' setting, read through its function: 2 → 8, the 9th refused by every door in words that
 *      name 8; 1,000 → 4,000, and uploads don't end at the 2,000 calls; the door's 60 a minute and the server's two
 *      places at once are shared with /mcp/photos.
 *   7. The admin IP allowlist guards it; the gateway's limit answers it, with its headers.
 *   8. The secret: the token is in no system_logs line, nothing the process printed, no record and no file under the data
 *      folder; only its SHA-256 is kept; a request's path a fault line writes, and sanitizeMessage, say /mcp/photos/u/….
 *
 * Run: SERVER_SUITES_ONLY=test-mcp-photo-link TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { setMemberPhoto } from '@beanpool/engine';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { updateLocalConfig, getLocalConfig } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { resetAutomationTokenUseThrottle } from './automation-tokens.js';
import { grantNodeRole } from './engine/node-roles.js';
import { ownerPhoneSessionHeaders } from './admin-auth-test-harness.js';
import { db } from './db/db.js';
import { setSimulatedFreeDiskBytesForTests, STORAGE_NEARLY_FULL_MESSAGE } from './engine/photo-upload-budget.js';
import { getImageStore, readObject } from './storage/image-store.js';
import {
    admitAgentCall, admitAgentPhoto, agentCallsToday, agentPhotosPerDay, agentPhotosToday, AGENT_CALLS_PER_DAY, setAgentPostsPerDay,
} from './agent/limits.js';
import {
    issuePhotoLink, photoLinkHashesForTests, photoLinksHeld, PHOTO_LINK_KEEP_MS, PHOTO_LINK_LOG_PATH, PHOTO_LINK_PATH, uploadedPhotosWaiting,
} from './agent/owner-photos.js';
import { OWNER_POST_TOOLS } from './agent/owner-posts.js';
import { revokeOAuthGrant } from './agent/oauth.js';
import type { AgentGrant } from './agent/tools.js';
import { AGENT_LOG_KEEP_ROWS } from './logger.js';
import { sanitizeMessage } from './sanitize-message.js';
import { scrubServerFaults } from './routes/member-error-text.js';

let BASE = '';
let PORT = 0;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

/** Everything this process wrote, for the sweep in 8: what the logger's console line and any console.error said. */
const printed: string[] = [];
for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (...a: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => { printed.push(String(chunk)); return write(chunk, ...rest); }) as typeof stream.write;
}

/** Every token this suite saw: none may be anywhere when it ends. */
const tokens: string[] = [];

interface Reply { status: number; body: any; text: string; headers: Headers }
async function call(method: string, p: string, opts: { body?: unknown; raw?: string | Buffer; type?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
    const type = opts.type ?? (opts.body !== undefined || typeof opts.raw === 'string' ? 'application/json' : undefined);
    const res = await fetch(`${BASE}${p}`, {
        method,
        headers: { ...(type ? { 'Content-Type': type } : {}), ...(opts.headers || {}) },
        body: opts.raw !== undefined ? (typeof opts.raw === 'string' ? opts.raw : new Uint8Array(opts.raw)) : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        redirect: 'manual',
    });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body, text, headers: res.headers };
}
const show = (r: Reply) => `${r.status} ${r.text.slice(0, 120)}`;
const asSession = (id: string | null): Record<string, string> => ({ 'X-Admin-Session': id ?? '' });
const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });

interface Key { pub: string; priv: crypto.KeyObject }
function keypair(): Key {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}
async function keySignIn(k: Key): Promise<string | null> {
    const chal = await call('POST', '/api/local/admin/auth/challenge', { body: {} });
    const solved = await call('POST', '/api/local/admin/auth/verify-challenge', {
        body: { challengeId: chal.body?.challengeId, memberPubkey: k.pub, signature: crypto.sign(null, Buffer.from(chal.body?.challenge ?? ''), k.priv).toString('hex') },
    });
    const res = await fetch(`${BASE}/api/local/admin/auth/exchange`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: solved.body?.handshakeToken }),
    });
    const cookie = res.headers.getSetCookie().find(c => c.startsWith('admin_session=')) ?? '';
    return cookie.match(/^admin_session=([0-9a-f]{64})/)?.[1] ?? null;
}

async function makeToken(owner: Key, name: string, canPost = true): Promise<{ token: string; id: string }> {
    const made = await call('POST', '/api/local/admin/agent/grants', { headers: ownerPhoneSessionHeaders(owner.pub), body: { name, canPost } });
    if (made.status !== 201) throw new Error(`could not make a token: ${show(made)}`);
    return { token: made.body.token, id: made.body.grant.id };
}

async function connect(token: string): Promise<Client> {
    const client = new Client({ name: 'beanpool-photo-link-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: bearer(token) } }));
    return client;
}

const structured = (r: any): any => r?.structuredContent ?? null;
const errorText = (r: any): string => (r?.content as any)?.[0]?.text ?? '';

interface Link { url: string; path: string; token: string; expiresAt: string; photosLeftToday: number }
/** A new link from the tool: its token is noted for the sweep, and never printed. */
async function newLink(c: Client): Promise<Link> {
    const r = await c.callTool({ name: 'photo_upload_link', arguments: {} });
    const s = structured(r);
    if (r.isError || !s?.url) throw new Error(`no link: ${errorText(r)}`);
    const u = new URL(s.url);
    const token = u.pathname.split('/').pop() ?? '';
    tokens.push(token);
    return { url: s.url, path: u.pathname, token, expiresAt: s.expiresAt, photosLeftToday: s.photosLeftToday };
}
const post = (p: string, body: Buffer | string, type = 'image/jpeg', method = 'POST', headers: Record<string, string> = {}): Promise<Reply> =>
    call(method, p, { raw: body, type, headers });

/** The bytes of each of a post's stored photos, in order. */
async function storedPhotos(postId: string): Promise<Buffer[]> {
    const rows = db.prepare('SELECT photo_data, storage_key FROM post_photos WHERE post_id = ? ORDER BY order_num').all(postId) as
        Array<{ photo_data: string | null; storage_key: string | null }>;
    const out: Buffer[] = [];
    for (const row of rows) {
        if (row.storage_key) {
            const b = await readObject(getImageStore(), row.storage_key);
            if (b) out.push(b);
        } else {
            const m = /^data:[^;]+;base64,(.*)$/s.exec(row.photo_data ?? '');
            if (m) out.push(Buffer.from(m[1], 'base64'));
        }
    }
    return out;
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const DAY = 86_400_000;
const MB = 1024 * 1024;
const EXIF_MARK = 'MARKED-BY-OLIVE-CAMERA';

/** A raw POST that declares `declared` bytes and sends only `send`: an answer can only come before the body. */
function declaredButShort(p: string, declared: number, send: number): Promise<{ status: number; ms: number }> {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        let done = false;
        const req = https.request({
            host: 'localhost', port: PORT, path: p, method: 'POST', rejectUnauthorized: false,
            headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(declared) },
        }, (res) => {
            res.resume();
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ status: res.statusCode ?? 0, ms: Date.now() - started });
            req.destroy();
        });
        req.on('error', () => { /* closed by the server after its answer */ });
        req.write(Buffer.alloc(send, 1));
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            req.destroy();
            reject(new Error('no answer within 5 s: the server waited for the body'));
        }, 5000);
    });
}

/** A raw POST streaming `total` bytes with no length (chunked). */
function streamedNoLength(p: string, total: number): Promise<{ status: number; text: string }> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (status: number, text: string) => { if (!done) { done = true; resolve({ status, text }); } };
        const req = https.request({
            host: 'localhost', port: PORT, path: p, method: 'POST', rejectUnauthorized: false,
            headers: { 'Content-Type': 'image/jpeg', 'Transfer-Encoding': 'chunked' },
        }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => finish(res.statusCode ?? 0, text));
            res.on('error', () => finish(res.statusCode ?? 0, text));
        });
        req.on('error', () => setTimeout(() => finish(-1, ''), 2000));
        const chunk = Buffer.alloc(64 * 1024, 0x5a);
        let sent = 0;
        const pump = (): void => {
            while (sent < total) {
                if (done || req.destroyed) return;
                sent += chunk.length;
                if (!req.write(chunk)) { req.once('drain', pump); return; }
            }
            req.end();
        };
        pump();
    });
}

/** A raw POST that declares 1 MB and sends 10 bytes of it: its body is still arriving until `leave()`. */
function stillSending(p: string): { leave: () => void } {
    const req = https.request({
        host: 'localhost', port: PORT, path: p, method: 'POST', rejectUnauthorized: false,
        headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(MB) },
    }, (res) => res.resume());
    req.on('error', () => { /* its client went, and the connection with it */ });
    req.write(Buffer.alloc(10, 1));
    return { leave: () => req.destroy() };
}

/** Every file under `dir`. */
function filesUnder(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...filesUnder(p));
        else if (e.isFile()) out.push(p);
    }
    return out;
}

async function main(): Promise<void> {
    console.log('\n=== A photo link: an assistant that runs commands but never sees its bearer uploads its photos ===\n');
    const tmp = path.resolve(os.tmpdir());
    const webRoot = fs.mkdtempSync(path.join(tmp, 'bp-mcp-photo-link-'));
    fs.mkdirSync(path.join(webRoot, 'public'), { recursive: true });
    fs.writeFileSync(path.join(webRoot, 'public', 'index.html'), '<!doctype html><title>BeanPool web app</title>');
    process.chdir(webRoot);
    const dataDir = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
    const uploadsRoot = path.join(dataDir, 'assistant-photos');

    const goodJpg = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 180, g: 120, b: 60 } } })
        .composite([{ input: Buffer.from('<svg width="1600" height="1200"><circle cx="800" cy="600" r="400" fill="#2a6"/></svg>') }])
        .withExif({ IFD0: { Copyright: EXIF_MARK } }).jpeg({ quality: 85 }).toBuffer();
    const smallWebp = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 40, g: 90, b: 160 } } }).webp({ quality: 80 }).toBuffer();
    const alphaPng = await sharp({ create: { width: 1200, height: 900, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: Buffer.from('<svg width="1200" height="900"><circle cx="600" cy="450" r="300" fill="#c33"/></svg>') }]).png().toBuffer();
    const tinyJpg = await sharp({ create: { width: 120, height: 90, channels: 3, background: '#666' } }).jpeg().toBuffer();
    // Over a megabyte, so curl sends its Expect: 100-continue as it would for a real photo.
    const noisy = await sharp(crypto.randomBytes(1300 * 1300 * 3), { raw: { width: 1300, height: 1300, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
    assert(noisy.length > MB && noisy.length < 5 * MB, `(the big photo is ${Math.round(noisy.length / 1024)} KB)`);
    const facts = async (b: Buffer | undefined) => {
        if (!b) return null;
        const m = await sharp(b).metadata();
        return { format: m.format, width: m.width, height: m.height, exif: !!m.exif, mark: b.includes(EXIF_MARK) };
    };

    await initTls();
    initStateEngine();
    const owner = keypair(), owner2 = keypair();
    seedGenesisMember(owner.pub, 'Olive');
    const longAgo = new Date(Date.now() - 60 * DAY).toISOString();
    db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(longAgo, owner.pub);
    setMemberPhoto(db, owner.pub, AVATAR);
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, 'Ottilie', 'active', ?, ?, 'inv-test')`).run(owner2.pub, longAgo, owner.pub);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(owner2.pub);
    setMemberPhoto(db, owner2.pub, AVATAR);
    grantNodeRole(owner2.pub, 'owner', 'SYSTEM');
    const setGateway = (over: Record<string, unknown>) => updateLocalConfig({ gateway: { ...(getLocalConfig().gateway ?? {}), ...over } as any });
    setGateway({ rateLimiting: { enabled: true, maxRequestsPerMinute: 100000 } });

    const { startHttpsServer, isAdminSurfacePath } = await import('./https-server.js');
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;
    const { PHOTO_UPLOADS_AT_ONCE } = await import('./agent/photo-upload-route.js');

    try {
        resetAdminAuthTarpit();
        const ownerS = await keySignIn(owner);
        assert(!!ownerS, 'the owner signs in with their key');
        const offerArgs = { title: 'Quince paste', description: 'Six jars.', category: 'food', beans: 4, lat: -28.55, lng: 153.5 };
        const revoke = async (id: string): Promise<number> =>
            (await call('POST', `/api/local/admin/agent/grants/${encodeURIComponent(id)}/revoke`, { headers: asSession(ownerS), body: {} })).status;
        const refusalLines = () => db.prepare("SELECT message, metadata FROM system_logs WHERE category = 'AGENT' AND message LIKE 'Assistant refused%'").all() as Array<{ message: string; metadata: string }>;

        // ── 1. Who gets it ───────────────────────────────────────────────────────────────────────
        console.log('── 1. An owner\'s assistant ticked "May post for me", and no other ──');
        const A = await makeToken(owner, 'Olive\'s Claude Code');
        const a = await connect(A.token);
        const listed = (await a.listTools()).tools.find(t => t.name === 'photo_upload_link');
        assert(!!listed && /curl --data-binary @photo\.jpg -H 'Content-Type: image\/jpeg' <url>/.test(listed.description ?? '') && /photo_ids/.test(listed.description ?? '')
            && listed.annotations?.readOnlyHint === false,
            `the owner's assistant has the tool, and its description gives the flow: photo_upload_link, curl, photo_ids (${(listed?.description ?? '').slice(0, 100)}…)`);
        const info = structured(await a.callTool({ name: 'connection_info', arguments: {} }));
        assert(/photo_upload_link/.test(info?.photos?.ways ?? '') && /curl --data-binary @photo\.jpg -H 'Content-Type: image\/jpeg' <url>/.test(info?.photos?.ways ?? '') && /create_\*.*photo_ids/.test(info?.photos?.ways ?? '')
            && (info?.tools as string[]).includes('photo_upload_link'),
            `connection_info gives the same flow (${(info?.photos?.ways ?? '').slice(-160)})`);

        const R = await makeToken(owner, 'Olive\'s reader', false);
        const reader = await connect(R.token);
        const readerTools = (await reader.listTools()).tools.map(t => t.name);
        const readerCall = await reader.callTool({ name: 'photo_upload_link', arguments: {} });
        const made2 = await call('POST', '/api/local/admin/agent/grants', { headers: ownerPhoneSessionHeaders(owner2.pub), body: { name: 'Ottilie\'s assistant', canPost: true } });
        grantNodeRole(owner2.pub, 'admin', 'SYSTEM');
        const adminC = await connect(made2.body.token);
        const adminTools = (await adminC.listTools()).tools.map(t => t.name);
        const adminCall = await adminC.callTool({ name: 'photo_upload_link', arguments: {} });
        assert(!readerTools.includes('photo_upload_link') && !adminTools.includes('photo_upload_link')
            && readerCall.isError === true && adminCall.isError === true && /no tool "photo_upload_link"/.test(errorText(readerCall)) && /no tool "photo_upload_link"/.test(errorText(adminCall))
            && photoLinksHeld(R.id) === 0 && photoLinksHeld(made2.body.grant.id) === 0,
            `an unticked grant and an admin's neither list it nor run it, in words (${errorText(readerCall)} | ${errorText(adminCall)})`);
        const row = OWNER_POST_TOOLS.find(t => t.name === 'photo_upload_link')!;
        const asGrant = (over: Partial<AgentGrant>): AgentGrant => ({ id: 'y', name: 'y', member: owner.pub, role: 'owner', via: 'token', createdAt: 0, expiresAt: null, canPost: true, ...over });
        const runUnticked = await row.run(asGrant({ canPost: false }), {}, 'b0b0b0b0', BASE);
        const runAdmin = await row.run(asGrant({ role: 'admin' }), {}, 'b0b0b0b0', BASE);
        const runNoAddress = await row.run(asGrant({}), {}, 'b0b0b0b0', 'this server');
        assert(!runUnticked.ok && /without "May post for me"/.test(runUnticked.error) && !runAdmin.ok && /Only an owner's assistant can upload photos/.test(runAdmin.error)
            && !runNoAddress.ok && /photo_urls/.test(runNoAddress.error) && photoLinksHeld('y') === 0,
            `the row itself refuses them too, as the create tools' do, and a node that can't name its own address makes none (${!runUnticked.ok && runUnticked.error} | ${!runAdmin.ok && runAdmin.error})`);
        const preview = await call('POST', '/api/local/admin/agent/preview', { headers: asSession(ownerS), body: { tool: 'photo_upload_link' } });
        assert(preview.status === 400 && /never writes/.test(preview.body?.error ?? ''), `Settings' preview never makes one (${show(preview)})`);
        // A member has at most 5 assistants connected: each section's goes when it is done.
        assert(await revoke(R.id) === 200, 'the reader is disconnected');

        const first = await newLink(a);
        assert(first.url === `${BASE}${PHOTO_LINK_PATH}/${first.token}` && /^[A-Za-z0-9_-]{43,}$/.test(first.token) && Buffer.from(first.token, 'base64url').length >= 32
            && Math.abs(Date.parse(first.expiresAt) - (Date.now() + PHOTO_LINK_KEEP_MS)) < 60_000 && first.photosLeftToday === 400,
            `the answer: this node's /mcp/photos/u/<at least 32 random bytes, base64url> (${first.token.length} characters), an hour on, ${first.photosLeftToday} photos left`);
        const rawAnswer = structured(await a.callTool({ name: 'photo_upload_link', arguments: {} }));
        tokens.push(new URL(rawAnswer.url).pathname.split('/').pop() ?? '');
        assert(JSON.stringify(Object.keys(rawAnswer).sort()) === JSON.stringify(['expiresAt', 'photosLeftToday', 'url']), `and exactly url, expiresAt and photosLeftToday (${Object.keys(rawAnswer).join(', ')})`);

        // ── 2. The flow ──────────────────────────────────────────────────────────────────────────
        console.log('── 2. Three files in a row, one link, three posts ──');
        const before = agentPhotosToday(A.id);
        const three = [await post(first.path, goodJpg), await post(first.path, smallWebp, 'image/webp'), await post(first.path, alphaPng, 'image/png')];
        const ids = three.map(r => r.body?.photoId as string);
        assert(three.every(r => r.status === 201) && new Set(ids).size === 3 && ids.every(id => /^ph_[0-9a-f]{32}$/.test(id)) && uploadedPhotosWaiting(A.id) === 3,
            `one link takes three files in a row, three ids (${three.map(r => r.status).join(', ')})`);
        const shape = three[0];
        assert(JSON.stringify(Object.keys(shape.body ?? {}).sort()) === JSON.stringify(['expiresAt', 'photoId', 'photosPerDay', 'photosToday'])
            && shape.body.photosToday === before + 1 && shape.body.photosPerDay === 400 && Math.abs(Date.parse(shape.body.expiresAt) - (Date.now() + DAY)) < 60_000,
            `the answer is /mcp/photos's own: photoId, expiresAt (24 hours on), photosToday and photosPerDay (${show(shape)})`);
        assert(three.every(r => r.headers.get('referrer-policy') === 'no-referrer' && r.headers.get('cache-control') === 'no-store' && !r.headers.get('access-control-allow-origin')),
            `no-referrer and no-store, and no CORS (${shape.headers.get('referrer-policy')}, ${shape.headers.get('cache-control')})`);
        const made: string[] = [];
        for (const [i, id] of ids.entries()) {
            const r = await a.callTool({ name: 'create_offer', arguments: { ...offerArgs, title: `Quince paste ${i + 1}`, photo_ids: [id] } });
            made.push(r.isError ? errorText(r) : structured(r)?.postId);
        }
        const firstPhoto = await facts((await storedPhotos(made[0]))[0]);
        assert(made.every(id => typeof id === 'string' && id.length > 8 && !/ /.test(id)) && firstPhoto?.width === 800 && firstPhoto.height === 600 && !firstPhoto.exif && !firstPhoto.mark
            && uploadedPhotosWaiting(A.id) === 0,
            `each id makes a post; the first is stored 800 × 600 with no metadata, and no upload is left (${JSON.stringify(firstPhoto)})`);

        const putIt = await post(first.path, goodJpg, 'image/jpeg', 'PUT');
        assert(putIt.status === 201 && /^ph_/.test(putIt.body?.photoId ?? ''), `a PUT of one image is the same (${show(putIt)})`);
        const curlOut = execFileSync('curl', ['-sk', '--max-time', '30', '--data-binary', '@/dev/stdin', '-H', 'Content-Type: image/jpeg', first.url], { input: noisy }).toString();
        const curled = JSON.parse(curlOut);
        assert(/^ph_[0-9a-f]{32}$/.test(curled.photoId ?? ''), `the manual's curl line, with a ${Math.round(noisy.length / MB * 10) / 10} MB photo and no other header → an id (${curlOut.slice(0, 60)})`);
        const O = await makeToken(owner, 'Olive\'s other script');
        const o = await connect(O.token);
        const otherGrant = await o.callTool({ name: 'create_offer', arguments: { ...offerArgs, photo_ids: [putIt.body.photoId] } });
        assert(otherGrant.isError === true && /is not a photo this assistant uploaded/.test(errorText(otherGrant)) && uploadedPhotosWaiting(A.id) === 2,
            `the ids are the link's grant's: another assistant's call is refused, and the upload is still there (${errorText(otherGrant).slice(0, 70)})`);
        assert(await revoke(O.id) === 200, 'the other script is disconnected');

        // ── 3. Upload only ───────────────────────────────────────────────────────────────────────
        console.log('── 3. It takes uploads and reads nothing ──');
        const wrongToken = `${PHOTO_LINK_PATH}/${crypto.randomBytes(32).toString('base64url')}`;
        const wrong = await post(wrongToken, goodJpg);
        assert(wrong.status === 401 && /no longer good/.test(wrong.body?.error ?? '') && wrong.headers.get('referrer-policy') === 'no-referrer' && wrong.headers.get('cache-control') === 'no-store',
            `a wrong token → 401 in words, with the same headers (${show(wrong)})`);
        const reads: string[] = [];
        for (const method of ['GET', 'HEAD', 'DELETE', 'PATCH']) {
            for (const p of [first.path, wrongToken]) {
                const r = await call(method, p);
                if (r.status !== 405 || r.headers.get('referrer-policy') !== 'no-referrer' || r.headers.get('cache-control') !== 'no-store'
                    || /BeanPool web app|ph_[0-9a-f]{32}/.test(r.text) || r.headers.get('content-security-policy')) reads.push(`${method} ${p === wrongToken ? 'wrong' : 'good'} → ${show(r)}`);
            }
        }
        const getGood = await call('GET', first.path), getWrong = await call('GET', wrongToken);
        assert(reads.length === 0 && getGood.text === getWrong.text && getGood.headers.get('allow') === 'POST, PUT',
            `GET, HEAD, DELETE and PATCH on a good link or a wrong one → 405, no-referrer, no-store, no web app, no list: nothing to tell them apart (${show(getGood)})${reads.length ? ` — ${reads.join(' | ')}` : ''}`);
        const preflight = await call('OPTIONS', first.path, { headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
        assert(!preflight.headers.get('access-control-allow-origin') && !preflight.headers.get('access-control-allow-methods') && preflight.headers.get('referrer-policy') === 'no-referrer',
            `a preflight from elsewhere gets no CORS (${preflight.status})`);
        const upperRoute = await post(`/MCP/photos/u/${first.token}`, goodJpg);
        const emptyToken = await post(`${PHOTO_LINK_PATH}/`, goodJpg);
        const dotted = await post(`${PHOTO_LINK_PATH}/..%2f..%2fstate.db`, goodJpg);
        assert(upperRoute.status === 404 && emptyToken.status === 404 && dotted.status === 401 && dotted.text === wrong.text,
            `the route in another case, no token, and a path-shaped token: nothing there (${upperRoute.status}, ${emptyToken.status}, ${dotted.status})`);

        // ── 4. The same path ─────────────────────────────────────────────────────────────────────
        console.log('── 4. Through the same path as /mcp/photos ──');
        const L = await makeToken(owner, 'Olive\'s refusals');
        const l = await connect(L.token);
        const refusals = await newLink(l);
        const tooSmall = await post(refusals.path, tinyJpg);
        const notImage = await post(refusals.path, Buffer.from('<!doctype html><p>not a photo</p>'));
        const textType = await post(refusals.path, goodJpg, 'text/plain');
        const asJson = await post(refusals.path, JSON.stringify({ photo: 'x' }), 'application/json');
        const fromPage = await post(refusals.path, goodJpg, 'image/jpeg', 'POST', { Origin: 'https://evil.example' });
        const wrongFromPage = await post(wrongToken, goodJpg, 'image/jpeg', 'POST', { Origin: 'https://evil.example' });
        assert(tooSmall.status === 400 && tooSmall.body?.error === 'The upload is too small: send one at least 200 pixels on its shorter side.'
            && notImage.status === 400 && notImage.body?.error === 'The upload is not an image: send a JPEG, WebP or PNG.'
            && textType.status === 415 && asJson.status === 415 && fromPage.status === 403 && wrongFromPage.text === fromPage.text && uploadedPhotosWaiting(L.id) === 0,
            `too small and not an image → 400 in /mcp/photos's words; text/plain or JSON → 415; another site's page → 403, good token or not; nothing kept (${tooSmall.status}, ${notImage.status}, ${textType.status}, ${asJson.status}, ${fromPage.status})`);
        const short = await declaredButShort(refusals.path, 6 * MB, 10);
        const streamed = await streamedNoLength(refusals.path, 6 * MB);
        assert(short.status === 413 && streamed.status === 413 && /too big: at most 5 MB/.test(streamed.text) && uploadedPhotosWaiting(L.id) === 0,
            `a declared 6 MB → 413 in ${short.ms} ms with 10 bytes of it sent; 6 MB streamed → 413 once 5 MB had come; nothing kept (${streamed.text.slice(0, 70)})`);
        // A body the 64 KiB the door reads for JSON would stop, not the 2 MB of every other route.
        const bigJson = await post(refusals.path, JSON.stringify({ photo: 'x'.repeat(70 * 1024) }), 'application/json');
        assert(bigJson.status === 413, `a JSON body past the door's 64 KiB is refused before it is parsed (${bigJson.status})`);
        const photosBeforeFloor = agentPhotosToday(L.id);
        setSimulatedFreeDiskBytesForTests(1);
        const atFloor = await post(refusals.path, goodJpg);
        const atFloorDoor = await call('POST', '/mcp/photos', { raw: goodJpg, type: 'image/jpeg', headers: bearer(L.token) });
        setSimulatedFreeDiskBytesForTests(null);
        assert(atFloor.status === 507 && atFloor.body?.error === STORAGE_NEARLY_FULL_MESSAGE && atFloorDoor.status === 507 && agentPhotosToday(L.id) === photosBeforeFloor && uploadedPhotosWaiting(L.id) === 0,
            `a disk at the floor every stored photo keeps to → 507 in words by either door, nothing counted or kept (${show(atFloor)})`);
        assert(await revoke(L.id) === 200, 'the refusals check is disconnected');

        // ── 5. It dies ───────────────────────────────────────────────────────────────────────────
        console.log('── 5. It dies, and stays dead ──');
        const grantOf = (T: { id: string }): AgentGrant => asGrant({ id: T.id, name: 'test' });
        const pastItsHour = issuePhotoLink(grantOf(A), Date.now() - PHOTO_LINK_KEEP_MS - 1000);
        tokens.push(pastItsHour.token);
        const expired = await post(`${PHOTO_LINK_PATH}/${pastItsHour.token}`, goodJpg);
        assert(expired.status === wrong.status && expired.text === wrong.text, `past its hour → the same answer as a wrong token, to the byte (${show(expired)})`);
        const soon = Date.now() + 5_000;
        const shortGrant = issuePhotoLink(asGrant({ id: 'short', expiresAt: soon }));
        tokens.push(shortGrant.token);
        assert(shortGrant.expiresAt === new Date(soon).toISOString(), 'a grant whose days end within the hour takes the link with it');

        const K = await makeToken(owner, 'Olive\'s old laptop');
        const k = await connect(K.token);
        const kLink = await newLink(k);
        const kBefore = await post(kLink.path, smallWebp, 'image/webp');
        assert(await revoke(K.id) === 200, 'the old laptop is disconnected');
        const kAfter = await post(kLink.path, goodJpg);
        assert(kBefore.status === 201 && kAfter.status === 401 && kAfter.text === wrong.text && photoLinksHeld(K.id) === 0 && uploadedPhotosWaiting(K.id) === 0,
            `revoked → dead at once, the same answer, and its links go with its uploads (${kBefore.status} → ${kAfter.status})`);

        // During an upload: the grant is read again after the resize.
        const M = await makeToken(owner, 'Olive\'s mid-upload');
        const m = await connect(M.token);
        const mLink = await newLink(m);
        const midUpload = await new Promise<number>((resolve) => {
            const req = https.request({
                host: 'localhost', port: PORT, path: mLink.path, method: 'POST', rejectUnauthorized: false,
                headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(goodJpg.length) },
            }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
            req.on('error', () => resolve(-1));
            const half = Math.floor(goodJpg.length / 2);
            req.write(goodJpg.subarray(0, half), () => setTimeout(async () => {
                await revoke(M.id);
                req.end(goodJpg.subarray(half));
            }, 150));
        });
        assert(midUpload === 401 && uploadedPhotosWaiting(M.id) === 0, `revoked while a photo is arriving through a link → 401, nothing kept (${midUpload})`);

        // An OAuth grant, the way Claude Code connects: its link is read through its record, so a grant gone is a link dead.
        const now = Date.now();
        updateLocalConfig({
            agentOAuthGrants: [{
                id: 'oa0123456789', clientId: 'bpc_test', clientName: 'Claude Code', redirectUri: 'https://claude.ai/cb', resource: `${BASE}/mcp`, member: owner.pub,
                createdAt: now, lastUsedAt: null, refreshIssuedAt: now, refreshHash: 'none', spentRefresh: [], canPost: true,
            }],
        });
        const viaOAuth = issuePhotoLink(asGrant({ id: 'oa0123456789', name: 'Claude Code', via: 'oauth' }));
        tokens.push(viaOAuth.token);
        const oauthUp = await post(`${PHOTO_LINK_PATH}/${viaOAuth.token}`, smallWebp, 'image/webp');
        revokeOAuthGrant('oa0123456789');
        const oauthGone = await post(`${PHOTO_LINK_PATH}/${viaOAuth.token}`, smallWebp, 'image/webp');
        assert(oauthUp.status === 201 && oauthGone.status === 401 && oauthGone.text === wrong.text && photoLinksHeld('oa0123456789') === 0,
            `an OAuth grant's link works, and dies with the grant (${oauthUp.status} → ${oauthGone.status})`);

        const setTick = (id: string, canPost: boolean) => updateLocalConfig({
            automationTokens: (getLocalConfig().automationTokens ?? []).map(t => (t.id === id ? { ...t, canPost } : t)),
        });
        const U = await makeToken(owner, 'Olive\'s ticked one');
        const u = await connect(U.token);
        const uLink = await newLink(u);
        setTick(U.id, false);
        const unticked = await post(uLink.path, goodJpg);
        setTick(U.id, true);
        const reticked = await post(uLink.path, goodJpg);
        assert(unticked.status === 401 && unticked.text === wrong.text && reticked.status === 401 && uploadedPhotosWaiting(U.id) === 0 && photoLinksHeld(U.id) === 0,
            `unticked → dead, the same answer; ticked again it stays dead (${unticked.status}, ${reticked.status})`);
        assert(await revoke(U.id) === 200, 'the ticked one is disconnected');

        // Ottilie is an admin since section 1: an owner again, to make the grant a demotion ends.
        grantNodeRole(owner2.pub, 'owner', 'SYSTEM');
        const Z = await makeToken(owner2, 'Ottilie\'s seeding');
        const z = await connect(Z.token);
        const zLink = await newLink(z);
        grantNodeRole(owner2.pub, 'admin', 'SYSTEM');
        const demoted = await post(zLink.path, goodJpg);
        grantNodeRole(owner2.pub, 'owner', 'SYSTEM');
        const promoted = await post(zLink.path, goodJpg);
        assert(demoted.status === 401 && demoted.text === wrong.text && promoted.status === 401, `its owner made an admin → dead, the same answer; an owner again it stays dead (${demoted.status}, ${promoted.status})`);

        const S = await makeToken(owner, 'Olive\'s switch');
        const s = await connect(S.token);
        const sLink = await newLink(s);
        const offIt = await call('POST', '/api/local/admin/agent/switch', { headers: asSession(ownerS), body: { allowed: false } });
        const whileOff = await post(sLink.path, goodJpg);
        const heldWhileOff = photoLinksHeld(S.id);
        const onIt = await call('POST', '/api/local/admin/agent/switch', { headers: asSession(ownerS), body: { allowed: true } });
        const afterOn = await post(sLink.path, goodJpg);
        assert(offIt.status === 200 && whileOff.status === 404 && heldWhileOff === 0 && onIt.status === 200 && afterOn.status === 401 && afterOn.text === wrong.text,
            `the owners' switch off → 404, as /mcp; every link dropped then; turned on again they stay dead (${whileOff.status}, ${heldWhileOff} held, ${afterOn.status})`);
        assert(await revoke(S.id) === 200, 'the switch check is disconnected');

        const F = await makeToken(owner, 'Olive\'s four');
        const f = await connect(F.token);
        const four = [await newLink(f), await newLink(f), await newLink(f), await newLink(f)];
        const fourth = await Promise.all(four.map(x => post(x.path, smallWebp, 'image/webp')));
        assert(photoLinksHeld(F.id) === 3 && fourth[0].status === 401 && fourth[0].text === wrong.text && fourth.slice(1).every(r => r.status === 201),
            `a fourth link replaces the oldest: the first is dead, the other three work (${fourth.map(r => r.status).join(', ')})`);
        assert(await revoke(F.id) === 200, 'the four links\' check is disconnected');

        // ── 6. The day ───────────────────────────────────────────────────────────────────────────
        console.log('── 6. Photos a day: 4 × the owners\' setting, one count ──');
        const D = await makeToken(owner, 'Olive\'s busy day');
        const d = await connect(D.token);
        setAgentPostsPerDay(2);
        const dLink = await newLink(d);
        assert(agentPhotosPerDay() === 8 && dLink.photosLeftToday === 8, `the setting at 2 → 8 photos a day, and the link says so (${dLink.photosLeftToday})`);
        const eight: number[] = [];
        for (let i = 0; i < 4; i++) eight.push((await post(dLink.path, smallWebp, 'image/webp')).status);
        for (let i = 0; i < 4; i++) eight.push((await call('POST', '/mcp/photos', { raw: smallWebp, type: 'image/webp', headers: bearer(D.token) })).status);
        const ninthLink = await post(dLink.path, smallWebp, 'image/webp');
        const ninthDoor = await call('POST', '/mcp/photos', { raw: smallWebp, type: 'image/webp', headers: bearer(D.token) });
        const ninthUrl = await d.callTool({ name: 'create_offer', arguments: { ...offerArgs, photo_urls: ['http://images.photos.test/good.jpg'] } });
        const dayWords = /^This assistant has had 8 photos fetched or uploaded today, and 8 a day is the most: try again tomorrow \(UTC\)\.$/;
        const leftNow = structured(await d.callTool({ name: 'photo_upload_link', arguments: {} }));
        tokens.push(new URL(leftNow.url).pathname.split('/').pop() ?? '');
        assert(eight.every(c => c === 201) && ninthLink.status === 429 && dayWords.test(ninthLink.body?.error ?? '') && ninthDoor.status === 429 && dayWords.test(ninthDoor.body?.error ?? '')
            && ninthUrl.isError === true && dayWords.test(errorText(ninthUrl)) && agentPhotosToday(D.id) === 8 && leftNow.photosLeftToday === 0,
            `4 by link and 4 by /mcp/photos are the 8; the 9th is refused by each door and by photo_urls, in words that name 8 (${ninthLink.body?.error})`);
        await d.close().catch(() => {});
        assert(await revoke(D.id) === 200, 'the busy day\'s check is disconnected');

        const T = await makeToken(owner, 'Olive\'s seeding day');
        const t = await connect(T.token);
        setAgentPostsPerDay(1000);
        const tInfo = structured(await t.callTool({ name: 'connection_info', arguments: {} }));
        for (let i = 0; i < 3999; i++) admitAgentPhoto(T.id);
        const tLink = await newLink(t);
        const callsBefore = agentCallsToday(T.id);
        const the4000th = await post(tLink.path, smallWebp, 'image/webp');
        const callsAfter = agentCallsToday(T.id);
        const the4001st = await post(tLink.path, smallWebp, 'image/webp');
        assert(agentPhotosPerDay() === 4000 && tInfo?.photos?.perDay === 4000 && the4000th.status === 201 && the4000th.body?.photosToday === 4000 && the4000th.body?.photosPerDay === 4000
            && the4001st.status === 429 && /and 4,000 a day is the most/.test(the4001st.body?.error ?? ''),
            `the setting at 1,000 → 4,000: the 4,000th is taken, the next refused naming it (${the4000th.status}, ${show(the4001st)})`);
        assert(callsAfter === callsBefore && agentCallsToday(T.id) === callsBefore + 1,
            `a taken upload leaves the day's ${AGENT_CALLS_PER_DAY.toLocaleString('en')} calls alone, so the 4,000 can be reached; one refused counts (${callsBefore} → ${callsAfter} → ${agentCallsToday(T.id)})`);
        setAgentPostsPerDay(100);
        assert(agentPhotosPerDay() === 400 && AGENT_LOG_KEEP_ROWS >= AGENT_CALLS_PER_DAY + 4000,
            `back at 100 → 400; and the assistants' log ring holds a full day of the most calls and the most uploads (${AGENT_LOG_KEEP_ROWS.toLocaleString('en')} lines)`);
        assert(await revoke(T.id) === 200, 'the seeding day\'s check is disconnected');

        const G = await makeToken(owner, 'Olive\'s quick one');
        const g = await connect(G.token);
        const gLink = await newLink(g);
        while (admitAgentCall(G.id).ok) { /* this minute's 60 */ }
        const overLink = await post(gLink.path, smallWebp, 'image/webp');
        const overDoor = await call('POST', '/mcp/photos', { raw: smallWebp, type: 'image/webp', headers: bearer(G.token) });
        assert(overLink.status === 429 && /calls in a minute/.test(overLink.body?.error ?? '') && Number(overLink.headers.get('retry-after')) > 0 && overDoor.status === 429 && agentPhotosToday(G.id) === 0
            && refusalLines().some(x => x.message === 'Assistant refused: over its limit' && x.metadata.includes(`"route":"${PHOTO_LINK_LOG_PATH}"`)),
            `rate-limited like /mcp: past the minute's 60, shared with its bearer, → 429 in words, nothing counted (${show(overLink)})`);
        assert(await revoke(G.id) === 200, 'the quick one is disconnected');

        const P = await makeToken(owner, 'Olive\'s slow line');
        const p = await connect(P.token);
        const pLink = await newLink(p);
        const arriving = Array.from({ length: PHOTO_UPLOADS_AT_ONCE }, () => stillSending(pLink.path));
        let busy: Reply | null = null;
        for (let i = 0; i < 20 && busy?.status !== 503; i++) {
            await new Promise(r => setTimeout(r, 150));
            busy = await call('POST', '/mcp/photos', { raw: smallWebp, type: 'image/webp', headers: bearer(P.token) });
        }
        arriving.forEach(x => x.leave());
        assert(busy?.status === 503 && busy.headers.get('retry-after') === '5',
            `${PHOTO_UPLOADS_AT_ONCE} bodies arriving through a link fill the server's places: one more by /mcp/photos → 503 (${busy ? show(busy) : 'no answer'})`);
        assert(await revoke(P.id) === 200, 'the slow line is disconnected');

        // ── 7. The doors in front ────────────────────────────────────────────────────────────────
        console.log('── 7. The gateway in front of it ──');
        assert(isAdminSurfacePath(first.path) && isAdminSurfacePath('/mcp/photos') && !isAdminSurfacePath('/mcp/photosx/u/a'), 'the link is on the admin surface, as /mcp/photos is');
        setGateway({ adminIpAllowlist: ['10.9.8.7'] });
        const elsewhere = await post(first.path, smallWebp, 'image/webp');
        setGateway({ adminIpAllowlist: [] });
        assert(elsewhere.status === 403 && /allowlist/.test(elsewhere.body?.error ?? '') && elsewhere.headers.get('referrer-policy') === 'no-referrer',
            `the admin IP allowlist guards it, and the refusal keeps its headers (${show(elsewhere)})`);
        setGateway({ rateLimiting: { enabled: true, maxRequestsPerMinute: 1 } });
        let limited: Reply | null = null;
        for (let i = 0; i < 6 && limited?.status !== 429; i++) limited = await post(first.path, smallWebp, 'image/webp');
        setGateway({ rateLimiting: { enabled: true, maxRequestsPerMinute: 100000 } });
        assert(limited?.status === 429 && limited.headers.get('referrer-policy') === 'no-referrer' && limited.headers.get('cache-control') === 'no-store',
            `the gateway's own limit answers it, with its headers (${limited ? show(limited) : 'no answer'})`);

        // ── 8. The secret ────────────────────────────────────────────────────────────────────────
        console.log('── 8. The token is written nowhere ──');
        // A fault's line, written by the net over every route, for a request to a link.
        const faulted: any = { method: 'POST', path: `${PHOTO_LINK_PATH}/${first.token}`, status: 500, body: { error: 'connect ECONNREFUSED 10.1.2.3:443' } };
        await scrubServerFaults()(faulted, async () => {});
        assert(faulted.body.error !== 'connect ECONNREFUSED 10.1.2.3:443' && printed.some(l => l.includes(`[MemberRoute] POST ${PHOTO_LINK_LOG_PATH} answered a server fault`)),
            'a server fault on a link writes its route as /mcp/photos/u/…');

        const cases: Array<[string, string]> = [
            [`POST /mcp/photos/u/${first.token}`, 'POST /mcp/photos/u/…'],
            [`https://node.example/mcp/photos/u/${first.token}?x=1`, 'https://node.example/mcp/photos/u/…?x=1'],
            [JSON.stringify({ route: `/mcp/photos/u/${first.token}` }), '{"route":"/mcp/photos/u/…"}'],
            [`GET /MCP/PHOTOS/U/${first.token} failed`, 'GET /mcp/photos/u/… failed'],
            ['/mcp/photos/u/…', '/mcp/photos/u/…'],
        ];
        const notMasked = cases.filter(([from, to]) => sanitizeMessage(from) !== to).map(([, to]) => to);
        assert(notMasked.length === 0 && sanitizeMessage('POST /mcp/photos') === 'POST /mcp/photos',
            `every log line takes it out, in a path, a URL, JSON and any case, and leaves /mcp/photos as it is${notMasked.length ? ` — ${notMasked.join(' | ')}` : ''}`);

        const allLines = db.prepare('SELECT message, metadata FROM system_logs').all() as Array<{ message: string; metadata: string | null }>;
        const inLines = allLines.filter(x => tokens.some(tok => x.message.includes(tok) || (x.metadata ?? '').includes(tok)));
        const linkTool = allLines.filter(x => x.message === 'Assistant wrote' && (x.metadata ?? '').includes('"tool":"photo_upload_link"'));
        const linkRefusal = refusalLines().filter(x => x.metadata.includes(`"route":"${PHOTO_LINK_LOG_PATH}"`));
        assert(tokens.length >= 15 && allLines.length > 50 && inLines.length === 0 && linkTool.length >= 15 && linkTool.every(x => !/url/.test(x.metadata ?? '')) && linkRefusal.length > 0,
            `none of the ${tokens.length} tokens is in any of the ${allLines.length} system_logs lines; each link made is an AGENT line, ${linkRefusal.length} refused lines name the route with no token`);
        const inPrinted = printed.filter(line => tokens.some(tok => line.includes(tok)));
        assert(inPrinted.length === 0, `nor in anything this process printed, ${printed.length} writes${inPrinted.length ? ` — ${inPrinted.length} carry one` : ''}`);
        const live = await newLink(a);
        resetAutomationTokenUseThrottle();
        await post(live.path, smallWebp, 'image/webp');
        const record = (getLocalConfig().automationTokens ?? []).find(x => x.id === A.id);
        assert(record?.lastUsedRoute === 'POST /mcp/photos/u/…', `the grant's "last used" names the route with no token (${record?.lastUsedRoute})`);
        const hashes = photoLinkHashesForTests();
        const liveHash = crypto.createHash('sha256').update(live.token).digest('hex');
        assert(hashes.includes(liveHash) && hashes.every(h => /^[0-9a-f]{64}$/.test(h)) && !hashes.some(h => tokens.includes(h)), `what is kept for a link is its SHA-256 (${hashes.length} kept)`);
        const needles = tokens.map(tok => Buffer.from(tok));
        const files = filesUnder(dataDir);
        const inFiles = files.filter((file) => {
            const bytes = fs.readFileSync(file);
            return needles.some(n => bytes.includes(n));
        });
        assert(files.length > 2 && inFiles.length === 0, `no token in any of the ${files.length} files under the data folder (the database and its write-ahead log, local-config.json)${inFiles.length ? ` — ${inFiles.map(x => path.basename(x)).join(', ')}` : ''}`);
        assert(!fs.existsSync(path.join(uploadsRoot, 'u')), 'a link leaves nothing of its own on disk');

        await reader.close().catch(() => {});
        await adminC.close().catch(() => {});
    } catch (e) {
        // A throw is a failure, never a quiet end: the count would otherwise stop short and the exit say 0.
        console.error(e);
        process.exitCode = 1;
    } finally {
        console.log(`\n${passed}/${run} passed`);
        process.exit(process.exitCode ?? 0);
    }
}

main().catch((e) => { console.error(e); console.log(`\n${passed}/${run} passed`); process.exit(1); });
