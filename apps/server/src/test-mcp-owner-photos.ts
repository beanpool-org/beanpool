/**
 * MCP owner S4 (design §2.4; Marty, 31 Oct: "URL + upload + 0 Beans"): an owner's assistant's photos by address (photo_urls,
 * fetched by the node through ssrfSafeFetch) and by upload (POST /mcp/photos, then photo_ids), and an enterprise listing's
 * price only where Beans are on. End to end with the official TypeScript MCP SDK client over REAL HTTPS through the real Koa
 * middleware. No real internet: every "public" image is a server this file starts on 127.0.0.1, reached through
 * ssrfSafeFetch's own test hook (BEANPOOL_SSRF_TEST_HOOK=1) with a resolver that pins ONE stand-in name
 * (images.photos.test) to it and answers every other name from a table through the production checks
 * (pulse-resolver.ts pinnedHostResolver); a literal private address and localhost are also tried through the production
 * resolver itself, which refuses them before any connection.
 *
 *   1. photo_urls refused in words: not http(s), or a user and password in it (nothing fetched or counted); a private address
 *      (10/8, loopback, ::1, the link-local metadata address); a name resolving to loopback or a private address, and
 *      localhost; a redirect to one (loopback, private, metadata, a name resolving to loopback); more than 5 redirects; over
 *      5 MB (declared, and streamed with no length); not an image (HTML with an image type, a text/html type, no type, a 404,
 *      a GIF); a timeout. The image server is never reached for a refused address. None made a post or counted a create;
 *      each address fetched counted against the day's photos.
 *   2. Good fetches: a 1600 × 1200 JPEG with EXIF → an 800 × 600 photo with no metadata; a PNG with transparency → an 800 px
 *      JPEG on white; a WebP stays a WebP; base64 and an address in one post, in that order; more than 4 refused; the AGENT
 *      log names the host, never the path; an event and an enterprise listing take photo_urls; update_post replaces photos
 *      from an address, and a refused one leaves them.
 *   3. The day's 200, shared: past it a create with addresses is refused before anything is fetched, and an upload 429.
 *   4. Upload: no token, a made-up one, a reads-only grant's, an admin's → refused, nothing kept; another site's page, a GET,
 *      the switch off → refused; a wrong Content-Type, a JSON body → 415; a declared 6 MB → 413 while only 10 bytes of it
 *      were sent; 6 MB streamed with no length → 413, nothing kept; HTML as image/jpeg → 400; a good one → 201 with exactly
 *      { photoId, expiresAt, photosToday, photosPerDay }, kept at 800 px with no metadata, posted by photo_ids, its file then
 *      gone; used again → refused; another grant's → refused in the same words, and still the uploader's; twice in one call →
 *      refused; a create refused after the id was taken leaves it usable; 24 hours on, swept and refused; a PNG upload is
 *      stored as a JPEG; revoked, a grant's unused uploads and their folder are gone; bodies still arriving fill the server's
 *      places (one more → 503, uncounted), and their clients going frees them at once; so does a client gone while the JSON
 *      reader in front of every route had its body (the route meets a request already closed). connection_info says the two
 *      ways.
 *   5. Beans: create_enterprise_listing asks a price above 0 where Beans are on (0 and absent refused in words). Where they are
 *      off its schema asks none and neither 0 nor absent is refused for its price; the call is still refused, because Beans
 *      off turns enterprises off (config/node-profile.ts lockToLedger), so with Beans off nothing is made.
 *   6. Every answer (tools, refusals, uploads) is swept: no member's or enterprise's key, no path on this server, no address
 *      the server resolved, no resolver message.
 *   7. The ledger audit is the same after as before.
 *
 * Run: SERVER_SUITES_ONLY=test-mcp-owner-photos TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
// ssrfSafeFetch's test hook (engine/pulse-resolver.ts): the only way a fetch here reaches the image server this file starts.
process.env.BEANPOOL_SSRF_TEST_HOOK = '1';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { setMemberPhoto, clearEnterpriseFloorCache } from '@beanpool/engine';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, runLedgerAudit } from './state-engine.js';
import { updateLocalConfig, getLocalConfig } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { grantNodeRole, revokeNodeRole } from './engine/node-roles.js';
import { getProfileSwitches, setSwitchOverride } from './config/node-profile.js';
import { ownerPhoneSessionHeaders } from './admin-auth-test-harness.js';
import { db } from './db/db.js';
import { getImageStore, readObject } from './storage/image-store.js';
import { imageSize } from './storage/image-metadata.js';
import { admitAgentPhoto, agentCreatesToday, agentPhotosToday, AGENT_PHOTOS_PER_DAY } from './agent/limits.js';
import { pinnedHostResolver, type HostResolver } from './engine/pulse-resolver.js';
import { __usePhotoFetchResolverForTests, PHOTO_UPLOAD_KEEP_MS, sweepUploadedPhotos, uploadedPhotosWaiting } from './agent/owner-photos.js';
import { enterpriseRef } from './agent/owner-posts.js';

let BASE = '';
let PORT = 0;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

/** Every answer an assistant or an upload got, swept at the end (6). */
const answers: string[] = [];

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
const show = (r: Reply) => `${r.status} ${r.text.slice(0, 160)}`;
const asSession = (id: string | null): Record<string, string> => ({ 'X-Admin-Session': id ?? '' });
const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });

/** POST /mcp/photos with `body` as the whole request body; its answer is swept. */
async function upload(token: string | null, body: Buffer | string, type = 'image/jpeg', headers: Record<string, string> = {}, method = 'POST'): Promise<Reply> {
    const r = await call(method, '/mcp/photos', { raw: method === 'GET' ? undefined : body, type, headers: { ...(token ? bearer(token) : {}), ...headers } });
    answers.push(r.text);
    return r;
}

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

/** A token an owner makes from the phone's Manage, ticked "May post for me" unless `canPost` is false. */
async function makeToken(owner: Key, name: string, canPost = true): Promise<{ token: string; id: string }> {
    const made = await call('POST', '/api/local/admin/agent/grants', { headers: ownerPhoneSessionHeaders(owner.pub), body: { name, canPost } });
    if (made.status !== 201) throw new Error(`could not make a token: ${show(made)}`);
    return { token: made.body.token, id: made.body.grant.id };
}

async function connect(token: string): Promise<Client> {
    const client = new Client({ name: 'beanpool-photo-test-assistant', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: bearer(token) } }));
    return client;
}

const structured = (r: any): any => r?.structuredContent ?? null;
const errorText = (r: any): string => (r?.content as any)?.[0]?.text ?? '';
/** A tool call whose answer is swept. */
async function tool(c: Client, name: string, args: Record<string, unknown>): Promise<any> {
    const r = await c.callTool({ name, arguments: args });
    answers.push(JSON.stringify(r.structuredContent ?? r.content));
    return r;
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const DAY = 86_400_000;
const MB = 1024 * 1024;
const EXIF_MARK = 'MARKED-BY-OLIVE-CAMERA';

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

/** What a stored photo is: its format, size, and whether any metadata or the camera's mark survived. */
async function photoFacts(b: Buffer | undefined): Promise<{ format?: string; width?: number; height?: number; exif: boolean; icc: boolean; mark: boolean }> {
    if (!b) return { exif: false, icc: false, mark: false };
    const m = await sharp(b).metadata();
    return { format: m.format, width: m.width, height: m.height, exif: !!m.exif, icc: !!m.icc, mark: b.includes(EXIF_MARK) };
}

// ── The image server: the "public" host's stand-in, on 127.0.0.1 ─────────────────────────────────
const hits = new Map<string, number>();
const hitsOf = (p: string): number => hits.get(p) ?? 0;
const totalHits = (): number => [...hits.values()].reduce((a, b) => a + b, 0);

interface Images { goodJpg: Buffer; alphaPng: Buffer; smallWebp: Buffer; gif: Buffer }

function startImageServer(img: Images): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        res.on('error', () => {});
        const p = (req.url ?? '').split('?')[0];
        hits.set(p, hitsOf(p) + 1);
        const send = (type: string | null, body: Buffer) => {
            res.writeHead(200, { ...(type ? { 'Content-Type': type } : {}), 'Content-Length': String(body.length) });
            res.end(body);
        };
        const redirect = (to: string) => { res.writeHead(302, { Location: to }); res.end(); };
        switch (p) {
            case '/good.jpg': return send('image/jpeg', img.goodJpg);
            case '/alpha.png': return send('image/png', img.alphaPng);
            case '/small.webp': return send('image/webp', img.smallWebp);
            case '/fake.jpg': return send('image/jpeg', Buffer.from('<!doctype html><title>not a photo</title><p>hello</p>'));
            case '/page.jpg': return send('text/html; charset=utf-8', Buffer.from('<!doctype html><title>a page</title>'));
            case '/no-type.jpg': return send(null, img.goodJpg);
            case '/anim.gif': return send('image/gif', img.gif);
            case '/missing.jpg': res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not here'); return;
            case '/big-declared.jpg':
                // Says 6 MB, sends a little and waits: refused on the header, never read.
                res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': String(6 * MB) });
                res.write(img.goodJpg.subarray(0, 1000));
                return;
            case '/big-chunked.jpg': {
                // No length: 6 MB streamed, refused once 5 MB have come.
                res.writeHead(200, { 'Content-Type': 'image/jpeg' });
                const chunk = Buffer.alloc(64 * 1024, 0xab);
                let sent = 0;
                const pump = (): void => {
                    while (sent < 6 * MB) {
                        sent += chunk.length;
                        if (!res.write(chunk)) { res.once('drain', pump); return; }
                    }
                    res.end();
                };
                pump();
                return;
            }
            case '/slowish.jpg':
                // The whole photo, but only after 700 ms (inside the deadline): time for a disconnect while it is fetched.
                setTimeout(() => send('image/jpeg', img.goodJpg), 700);
                return;
            case '/slow.jpg':
                // The headers and a little, then nothing: the fetch's deadline must end it.
                res.writeHead(200, { 'Content-Type': 'image/jpeg' });
                res.write(img.goodJpg.subarray(0, 100));
                return;
            case '/to-loopback': return redirect(`http://127.0.0.1:${PORT_IMG}/good.jpg`);
            case '/to-private': return redirect('http://10.11.12.13/good.jpg');
            case '/to-metadata': return redirect('http://169.254.169.254/latest/meta-data/');
            case '/to-rebind': return redirect(`http://rebind.photos.test:${PORT_IMG}/good.jpg`);
            case '/loop': return redirect('/loop');
            default: res.writeHead(404); res.end();
        }
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}
let PORT_IMG = 0;

/** The stand-in public host, and a DNS table every other name is answered from, through the production checks. */
const PUBLIC_HOST = 'images.photos.test';
const DNS_TABLE: Record<string, string> = { 'rebind.photos.test': '127.0.0.1', 'intranet.photos.test': '10.0.0.5', 'v6.photos.test': '::1' };
const tableChecks = pinnedHostResolver(async (host) => {
    const ip = DNS_TABLE[host];
    if (!ip) throw new Error('ENOTFOUND');
    return [{ address: ip, family: net.isIPv6(ip) ? 6 : 4 }];
});
const resolver: HostResolver = async (host) => (host === PUBLIC_HOST ? { pinnedIp: '127.0.0.1', family: 4 } : tableChecks(host));
const FETCH_TIMEOUT_MS = 1500;
const img = (p: string): string => `http://${PUBLIC_HOST}:${PORT_IMG}${p}`;

/** A raw POST to /mcp/photos that declares `declared` bytes and sends only `send`: an answer can only come before the body. */
function declaredButShort(token: string, declared: number, send: number): Promise<{ status: number; ms: number }> {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        let done = false;
        const req = https.request({
            host: 'localhost', port: PORT, path: '/mcp/photos', method: 'POST', rejectUnauthorized: false,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'Content-Length': String(declared) },
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

/** A raw POST to /mcp/photos streaming `total` bytes with no length (chunked). */
function streamedNoLength(token: string, total: number): Promise<{ status: number; text: string }> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (status: number, text: string) => { if (!done) { done = true; resolve({ status, text }); } };
        const req = https.request({
            host: 'localhost', port: PORT, path: '/mcp/photos', method: 'POST', rejectUnauthorized: false,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'Transfer-Encoding': 'chunked' },
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

/** A raw POST to /mcp/photos that declares 1 MB and sends 10 bytes of it: its body is still arriving until `leave()`. */
function stillSending(token: string): { leave: () => void } {
    const req = https.request({
        host: 'localhost', port: PORT, path: '/mcp/photos', method: 'POST', rejectUnauthorized: false,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg', 'Content-Length': String(MB) },
    }, (res) => res.resume());
    req.on('error', () => { /* its client went, and the connection with it */ });
    req.write(Buffer.alloc(10, 1));
    return { leave: () => req.destroy() };
}

/**
 * A raw POST to /mcp/photos whose Content-Type names json, so the JSON reader in front of every route (https-server.ts)
 * starts on its body: it declares 1,000 bytes, sends 10, and its client goes. That reader stops on the closed request and
 * passes it on, so the upload route meets a request that has already closed and will emit nothing more.
 */
function goneWhileTheJsonReaderHadIt(token: string): Promise<void> {
    return new Promise((resolve) => {
        const req = https.request({
            host: 'localhost', port: PORT, path: '/mcp/photos', method: 'POST', rejectUnauthorized: false,
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg; profile=json', 'Content-Length': '1000' },
        }, (res) => res.resume());
        req.on('error', () => { /* its client went, and the connection with it */ });
        req.write(Buffer.alloc(10, 1), () => setTimeout(() => { req.destroy(); resolve(); }, 200));
    });
}

async function main(): Promise<void> {
    console.log('\n=== An owner\'s assistant\'s photos by address and by upload; an enterprise listing\'s price (MCP owner S4) ===\n');
    const tmp = path.resolve(os.tmpdir());
    const webRoot = fs.mkdtempSync(path.join(tmp, 'bp-mcp-photos-'));
    fs.mkdirSync(path.join(webRoot, 'public'), { recursive: true });
    fs.writeFileSync(path.join(webRoot, 'public', 'index.html'), '<!doctype html><title>BeanPool</title>');
    process.chdir(webRoot);
    const dataDir = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
    const uploadsRoot = path.join(dataDir, 'assistant-photos');

    // The images the stand-in host serves.
    const goodJpg = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: { r: 180, g: 120, b: 60 } } })
        .composite([{ input: Buffer.from('<svg width="1600" height="1200"><circle cx="800" cy="600" r="400" fill="#2a6"/></svg>') }])
        .withExif({ IFD0: { Copyright: EXIF_MARK, Artist: EXIF_MARK } }).jpeg({ quality: 85 }).toBuffer();
    const alphaPng = await sharp({ create: { width: 1200, height: 900, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: Buffer.from('<svg width="1200" height="900"><circle cx="600" cy="450" r="300" fill="#c33"/></svg>') }]).png().toBuffer();
    const smallWebp = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 40, g: 90, b: 160 } } }).webp({ quality: 80 }).toBuffer();
    const gif = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#888' } }).gif().toBuffer();
    const sourceFacts = await photoFacts(goodJpg);
    assert(sourceFacts.exif && sourceFacts.mark && sourceFacts.width === 1600, `(the source JPEG carries EXIF with the camera's mark, 1600 px: ${JSON.stringify(sourceFacts)})`);
    const smallB64 = `data:image/jpeg;base64,${(await sharp({ create: { width: 640, height: 480, channels: 3, background: '#a53' } }).jpeg().toBuffer()).toString('base64')}`;

    const imageServer = await startImageServer({ goodJpg, alphaPng, smallWebp, gif });
    PORT_IMG = (imageServer.address() as net.AddressInfo).port;
    __usePhotoFetchResolverForTests(resolver, FETCH_TIMEOUT_MS);

    await initTls();
    initStateEngine();
    const owner = keypair(), owner2 = keypair(), keeper = keypair();
    seedGenesisMember(owner.pub, 'Olive');
    const longAgo = new Date(Date.now() - 60 * DAY).toISOString();
    db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(longAgo, owner.pub);
    setMemberPhoto(db, owner.pub, AVATAR);
    const addMember = (k: Key, callsign: string) => {
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                    VALUES (?, ?, 'active', ?, ?, 'inv-test')`).run(k.pub, callsign, longAgo, owner.pub);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(k.pub);
        setMemberPhoto(db, k.pub, AVATAR);
    };
    addMember(owner2, 'Ottilie');
    addMember(keeper, 'Kit Keeper');
    grantNodeRole(owner2.pub, 'owner', 'SYSTEM');
    const makeEnterprise = (name: string, keepers: Key[]): string => {
        const pk = keypair().pub;
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_treasury)
                    VALUES (?, ?, ?, ?, 'inv-test', 'active', 1)`).run(pk, name, longAgo, owner.pub);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(pk);
        setMemberPhoto(db, pk, AVATAR);
        for (const k of keepers) {
            db.prepare('INSERT INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)').run(pk, k.pub);
            db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(k.pub);
        }
        clearEnterpriseFloorCache(db);
        return pk;
    };
    const bakery = makeEnterprise('Olive Bakery Co-op', [owner]);
    const notOurs = makeEnterprise('Kit Tools', [keeper]);
    updateLocalConfig({ gateway: { ...(getLocalConfig().gateway ?? {}), rateLimiting: { enabled: true, maxRequestsPerMinute: 100000 } } as any });

    const { startHttpsServer } = await import('./https-server.js');
    PORT = await startHttpsServer(0);
    BASE = `https://localhost:${PORT}`;
    // The upload route's own numbers, from the module the server loaded.
    const { PHOTO_UPLOAD_READ_MS, PHOTO_UPLOADS_AT_ONCE } = await import('./agent/photo-upload-route.js');
    const auditBefore = runLedgerAudit();
    const postsCount = (): number => (db.prepare('SELECT COUNT(*) AS c FROM posts').get() as any).c;

    try {
        resetAdminAuthTarpit();
        const ownerS = await keySignIn(owner);
        assert(!!ownerS, 'the owner signs in with their key');
        const offerArgs = { title: 'Quince paste', description: 'Six jars.', category: 'food', beans: 4, lat: -28.55, lng: 153.5 };

        // ── 1. Addresses refused ─────────────────────────────────────────────────────────────────
        console.log('── 1. photo_urls refused in words, the image server never reached for a refused address ──');
        const U = await makeToken(owner, 'Olive\'s refusals check');
        const u = await connect(U.token);
        const listed = (await u.listTools()).tools;
        const offerSchema = listed.find(t => t.name === 'create_offer')?.inputSchema as any;
        assert(!!offerSchema?.properties?.photo_urls && !!offerSchema?.properties?.photo_ids && !!offerSchema?.properties?.photos
            && !(offerSchema.required as string[]).includes('photos') && /1 to 4 photos are required, from photo_urls, photo_ids and photos together/.test(offerSchema.properties.photo_urls.description),
            `create_offer takes photo_urls, photo_ids and photos; its schema requires none of the three alone and says one is needed (${(offerSchema?.required ?? []).join(', ')})`);
        const postsBefore = postsCount();
        const hitsBefore = totalHits();
        const badShapes = ['ftp://images.photos.test/good.jpg', 'file:///etc/passwd', 'javascript:alert(1)', 'not an address', `http://olive:secret@${PUBLIC_HOST}:${PORT_IMG}/good.jpg`];
        const shapeWrong: string[] = [];
        for (const bad of badShapes) {
            const r = await tool(u, 'create_offer', { ...offerArgs, photo_urls: [bad] });
            if (!(r.isError === true && /^photo_urls #1 must be a public http or https address/.test(errorText(r)))) shapeWrong.push(`${bad} → ${errorText(r).slice(0, 80) || 'made'}`);
        }
        assert(shapeWrong.length === 0 && totalHits() === hitsBefore && agentPhotosToday(U.id) === 0,
            `not http(s), or a user and password in it → refused in words, nothing fetched or counted${shapeWrong.length ? ` (${shapeWrong.join('; ')})` : ''}`);

        const PRIVATE = 'is a private address, or leads to one: this server fetches only public addresses.';
        const privateCases: Array<[string, string]> = [
            ['10/8', 'http://10.11.12.13/good.jpg'],
            ['loopback, the image server itself', `http://127.0.0.1:${PORT_IMG}/good.jpg`],
            ['::1', `http://[::1]:${PORT_IMG}/good.jpg`],
            ['the link-local metadata address', 'http://169.254.169.254/latest/meta-data/'],
            ['a name resolving to loopback', `http://rebind.photos.test:${PORT_IMG}/good.jpg`],
            ['a name resolving to 10/8', 'http://intranet.photos.test/good.jpg'],
            ['a name resolving to ::1', `http://v6.photos.test:${PORT_IMG}/good.jpg`],
            ['localhost', `http://localhost:${PORT_IMG}/good.jpg`],
            ['a redirect to loopback', img('/to-loopback')],
            ['a redirect to 10/8', img('/to-private')],
            ['a redirect to the metadata address', img('/to-metadata')],
            ['a redirect to a name resolving to loopback', img('/to-rebind')],
        ];
        const goodHitsBefore = hitsOf('/good.jpg');
        const privateWrong: string[] = [];
        for (const [what, address] of privateCases) {
            const r = await tool(u, 'create_offer', { ...offerArgs, photo_urls: [address] });
            if (!(r.isError === true && errorText(r) === `photo_urls #1 ${PRIVATE}`)) privateWrong.push(`${what} → ${errorText(r).slice(0, 90) || 'made'}`);
        }
        assert(privateWrong.length === 0, `a private address, a name resolving to one, localhost, or a redirect to one → "${PRIVATE}"${privateWrong.length ? ` (${privateWrong.join('; ')})` : ''}`);
        assert(hitsOf('/good.jpg') === goodHitsBefore && hitsOf('/to-loopback') === 1 && hitsOf('/to-rebind') === 1,
            `the image itself was never fetched through any of them; only each redirect's first hop was (${hitsOf('/good.jpg')} fetches of it)`);

        const loop = await tool(u, 'create_offer', { ...offerArgs, photo_urls: [img('/loop')] });
        const nowhere = await tool(u, 'create_offer', { ...offerArgs, photo_urls: ['http://nowhere.photos.test/x.jpg'] });
        assert(loop.isError === true && /^photo_urls #1 redirects more than 5 times, or nowhere/.test(errorText(loop)) && hitsOf('/loop') === 6
            && nowhere.isError === true && /^photo_urls #1 could not be found/.test(errorText(nowhere)),
            `more than 5 redirects → refused after 6 requests (${hitsOf('/loop')}); a name that resolves to nothing → "could not be found" (${errorText(loop).slice(0, 50)} | ${errorText(nowhere)})`);

        const tooBig = await tool(u, 'create_offer', { ...offerArgs, photo_urls: [img('/big-declared.jpg')] });
        const tooBigStreamed = await tool(u, 'create_offer', { ...offerArgs, photo_urls: [img('/big-chunked.jpg')] });
        assert([tooBig, tooBigStreamed].every(r => r.isError === true && /^photo_urls #1 is too big: at most 5 MB/.test(errorText(r))),
            `over 5 MB, declared or streamed with no length → "too big" (${errorText(tooBig)} | ${errorText(tooBigStreamed).slice(0, 40)})`);

        const notImages: Array<[string, string, RegExp]> = [
            ['HTML bytes served as image/jpeg', '/fake.jpg', /^photo_urls #1 is not an image: the address must give a JPEG, WebP or PNG\.$/],
            ['a text/html type', '/page.jpg', /^photo_urls #1 is not an image \(its address answered something else\)/],
            ['no type at all', '/no-type.jpg', /^photo_urls #1 is not an image \(its address did not say it is one\)/],
            ['a 404', '/missing.jpg', /^photo_urls #1 is not an image \(its address answered 404\)/],
            ['a GIF', '/anim.gif', /^photo_urls #1 is not an image \(its address answered something else\)/],
        ];
        const imageWrong: string[] = [];
        for (const [what, p, want] of notImages) {
            const r = await tool(u, 'create_offer', { ...offerArgs, photo_urls: [img(p)] });
            if (!(r.isError === true && want.test(errorText(r)))) imageWrong.push(`${what} → ${errorText(r).slice(0, 90) || 'made'}`);
        }
        assert(imageWrong.length === 0, `not an image (HTML with an image type and extension, text/html, no type, a 404, a GIF) → "not an image"${imageWrong.length ? ` (${imageWrong.join('; ')})` : ''}`);

        const t0 = Date.now();
        const slow = await tool(u, 'create_offer', { ...offerArgs, photo_urls: [img('/slow.jpg')] });
        const slowMs = Date.now() - t0;
        assert(slow.isError === true && /^photo_urls #1 timed out/.test(errorText(slow)) && slowMs < FETCH_TIMEOUT_MS * 4,
            `an image that never finishes → "timed out" in ${slowMs} ms (deadline ${FETCH_TIMEOUT_MS} ms here, 8 s on a server)`);

        // The production resolver (no test hook): a literal loopback address and localhost are refused before any connection.
        __usePhotoFetchResolverForTests(null);
        const hitsBeforeProd = totalHits();
        const prodLoop = await tool(u, 'create_offer', { ...offerArgs, photo_urls: [`http://127.0.0.1:${PORT_IMG}/good.jpg`] });
        const prodLocal = await tool(u, 'create_offer', { ...offerArgs, photo_urls: [`http://localhost:${PORT_IMG}/good.jpg`] });
        __usePhotoFetchResolverForTests(resolver, FETCH_TIMEOUT_MS);
        assert([prodLoop, prodLocal].every(r => r.isError === true && errorText(r) === `photo_urls #1 ${PRIVATE}`) && totalHits() === hitsBeforeProd,
            `through the production resolver itself, the image server on 127.0.0.1 and localhost → refused, never reached (${errorText(prodLoop).slice(0, 40)})`);

        const fetchedTried = privateCases.length + 2 + 2 + notImages.length + 1 + 2;
        assert(postsCount() === postsBefore && agentCreatesToday(U.id) === 0 && agentPhotosToday(U.id) === fetchedTried,
            `none of them made a post or counted a create; each address tried counted against the day's photos (${agentPhotosToday(U.id)} of ${fetchedTried})`);
        const refusedLines = (db.prepare("SELECT level, metadata FROM system_logs WHERE category = 'AGENT' AND message = 'Assistant photo fetch refused'").all() as Array<{ level: string; metadata: string }>);
        const privateLines = refusedLines.filter(l => /a private address/.test(l.metadata));
        assert(privateLines.length >= privateCases.length && privateLines.every(l => /warn/i.test(l.level) && !/good\.jpg|meta-data/.test(l.metadata)),
            `each refused fetch is an AGENT line naming its host and why, a private address as a warning, never the path (${privateLines.length} lines)`);
        await u.close().catch(() => {});
        // A member has at most 5 assistants connected: each section's goes when it is done.
        const revoke = async (id: string): Promise<number> =>
            (await call('POST', `/api/local/admin/agent/grants/${encodeURIComponent(id)}/revoke`, { headers: asSession(ownerS), body: {} })).status;
        assert(await revoke(U.id) === 200, 'the refusals check is disconnected');

        // ── 2. Good fetches ──────────────────────────────────────────────────────────────────────
        console.log('── 2. Good addresses: made what the apps send, no metadata ──');
        const G = await makeToken(owner, 'Olive\'s seeding');
        const g = await connect(G.token);
        const viaUrl = await tool(g, 'create_offer', { ...offerArgs, title: 'Quince paste, fetched', photo_urls: [img('/good.jpg')] });
        const viaUrlId = structured(viaUrl)?.postId as string;
        const [fetched] = await storedPhotos(viaUrlId);
        const fetchedFacts = await photoFacts(fetched);
        assert(!viaUrl.isError && !!viaUrlId && fetchedFacts.format === 'jpeg' && fetchedFacts.width === 800 && fetchedFacts.height === 600
            && !fetchedFacts.exif && !fetchedFacts.mark,
            `a 1600 × 1200 JPEG with EXIF at a public address → posted, stored 800 × 600 with no metadata (${errorText(viaUrl) || JSON.stringify(fetchedFacts)})`);
        // Every fetch that brought bytes is a line (in 1, HTML served as a JPEG was fetched, then refused as not an image).
        const fetchedLines = (db.prepare("SELECT metadata FROM system_logs WHERE category = 'AGENT' AND message = 'Assistant photo fetched'").all() as Array<{ metadata: string }>);
        const thisGrants = fetchedLines.filter(l => l.metadata.includes(G.id));
        assert(thisGrants.length === 1 && fetchedLines.every(l => l.metadata.includes(PUBLIC_HOST) && !/good\.jpg|fake\.jpg|\//.test(l.metadata)),
            `each fetch is an AGENT line with the grant and the host, never the path (${fetchedLines.map(l => l.metadata).join(' | ')})`);

        const alphaEvent = await tool(g, 'create_event', {
            title: 'Quince picking', description: 'Bring a bag.', start_at: new Date(Date.now() + 7 * DAY).toISOString(), timezone: 'Australia/Brisbane',
            place_name: 'The orchard', lat: -28.55, lng: 153.5, photo_urls: [img('/alpha.png')],
        });
        const [pngStored] = await storedPhotos(structured(alphaEvent)?.postId ?? '');
        const pngFacts = await photoFacts(pngStored);
        const corner = pngStored ? (await sharp(pngStored).extract({ left: 2, top: 2, width: 1, height: 1 }).raw().toBuffer()) : Buffer.alloc(0);
        assert(!alphaEvent.isError && pngFacts.format === 'jpeg' && pngFacts.width === 800 && pngFacts.height === 600 && corner.length >= 3
            && corner[0] > 240 && corner[1] > 240 && corner[2] > 240,
            `a PNG with transparency → an event's photo stored as an 800 × 600 JPEG, its clear corner white (${errorText(alphaEvent) || JSON.stringify(pngFacts)}; corner ${[...corner].join(',')})`);

        const kept = structured(await tool(g, 'my_enterprises', {}))?.enterprises ?? [];
        const entListing = await tool(g, 'create_enterprise_listing', { kind: 'offer', as_enterprise: enterpriseRef(bakery), title: 'Rye loaves', category: 'food', beans: 5, photo_urls: [img('/small.webp')] });
        const [webpStored] = await storedPhotos(structured(entListing)?.postId ?? '');
        const webpFacts = await photoFacts(webpStored);
        assert(kept.length === 1 && !entListing.isError && webpFacts.format === 'webp' && webpFacts.width === 640 && webpFacts.height === 480,
            `an enterprise's listing takes photo_urls; a WebP stays a WebP, 640 × 480 kept as it is (${errorText(entListing) || JSON.stringify(webpFacts)})`);

        const mixed = await tool(g, 'create_offer', { ...offerArgs, title: 'Quince paste, two photos', photos: [smallB64], photo_urls: [img('/good.jpg')] });
        const mixedStored = await storedPhotos(structured(mixed)?.postId ?? '');
        const mixedSizes = mixedStored.map(b => imageSize(b));
        assert(!mixed.isError && mixedStored.length === 2 && mixedSizes[0]?.width === 640 && mixedSizes[1]?.width === 800,
            `base64 and an address in one post → both, base64 first (${errorText(mixed) || JSON.stringify(mixedSizes)})`);
        const five = await tool(g, 'create_offer', { ...offerArgs, photos: [smallB64, smallB64], photo_urls: [img('/good.jpg'), img('/good.jpg')], photo_ids: [`ph_${'a'.repeat(32)}`] });
        const notList = await tool(g, 'create_offer', { ...offerArgs, photo_urls: img('/good.jpg') });
        assert(five.isError === true && /^At most 4 photos a post, photos, photo_urls and photo_ids together/.test(errorText(five))
            && notList.isError === true && errorText(notList) === 'photo_urls is a list.',
            `five photos across the three fields → refused; an address not in a list → refused (${errorText(five)} | ${errorText(notList)})`);
        const noneAtAll = await tool(g, 'create_offer', { ...offerArgs, photos: [], photo_urls: [] });
        assert(noneAtAll.isError === true && /^photos is required: add 1 to 4 photos first: photo_urls/.test(errorText(noneAtAll)),
            `no photo from any field → "photos is required", naming the three ways (${errorText(noneAtAll)})`);

        const replaced = await tool(g, 'update_post', { post_id: viaUrlId, photo_urls: [img('/small.webp')] });
        const [afterEdit] = await storedPhotos(viaUrlId);
        const refusedEdit = await tool(g, 'update_post', { post_id: viaUrlId, photo_urls: [img('/fake.jpg')] });
        const [afterRefused] = await storedPhotos(viaUrlId);
        assert(!replaced.isError && imageSize(afterEdit)?.width === 640 && refusedEdit.isError === true && /not an image/.test(errorText(refusedEdit))
            && !!afterRefused && afterRefused.equals(afterEdit),
            `update_post replaces a post's photos from an address; a refused one leaves them as they were (${errorText(replaced) || 'replaced'} | ${errorText(refusedEdit).slice(0, 50)})`);
        await g.close().catch(() => {});
        assert(await revoke(G.id) === 200, 'the seeding check is disconnected');

        // Disconnecting while the photos are still being fetched or uploaded stops it (the manual: "Disconnecting stops it at once").
        const V = await makeToken(owner, 'Olive\'s late line');
        const v = await connect(V.token);
        const beforeLate = postsCount();
        const late = tool(v, 'create_offer', { ...offerArgs, title: 'Late quince', photo_urls: [img('/slowish.jpg')] });
        await new Promise(r => setTimeout(r, 250));
        const revokedMid = await revoke(V.id);
        const lateR = await late;
        assert(revokedMid === 200 && lateR.isError === true && /disconnected, or may no longer post/.test(errorText(lateR)) && postsCount() === beforeLate,
            `disconnected while its photo_urls are fetched → nothing posted (${errorText(lateR).slice(0, 70) || 'made'})`);
        await v.close().catch(() => {});
        const W = await makeToken(owner, 'Olive\'s late upload');
        const midUpload = await new Promise<number>((resolve) => {
            const req = https.request({
                host: 'localhost', port: PORT, path: '/mcp/photos', method: 'POST', rejectUnauthorized: false,
                headers: { Authorization: `Bearer ${W.token}`, 'Content-Type': 'image/jpeg', 'Content-Length': String(goodJpg.length) },
            }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
            req.on('error', () => resolve(-1));
            const half = Math.floor(goodJpg.length / 2);
            req.write(goodJpg.subarray(0, half), () => setTimeout(async () => {
                await revoke(W.id);
                req.end(goodJpg.subarray(half));
            }, 150));
        });
        assert(midUpload === 401 && uploadedPhotosWaiting(W.id) === 0,
            `disconnected while an upload is still arriving → 401, nothing kept for it (${midUpload}, ${uploadedPhotosWaiting(W.id)} waiting)`);

        // ── 3. The day's 200, shared ─────────────────────────────────────────────────────────────
        console.log('── 3. 200 photos a day, fetched and uploaded together ──');
        const C = await makeToken(owner, 'Olive\'s busy day');
        const c = await connect(C.token);
        for (let i = 0; i < AGENT_PHOTOS_PER_DAY - 1; i++) admitAgentPhoto(C.id);
        const hitsAt199 = totalHits();
        const twoOver = await tool(c, 'create_offer', { ...offerArgs, photo_urls: [img('/good.jpg'), img('/small.webp')] });
        assert(twoOver.isError === true && /^This assistant has had 199 photos fetched or uploaded today, and 200 a day is the most: try again tomorrow \(UTC\)\.$/.test(errorText(twoOver))
            && totalHits() === hitsAt199 && agentPhotosToday(C.id) === 199,
            `199 used, a post with two addresses → refused before anything is fetched (${errorText(twoOver)})`);
        const the200th = await tool(c, 'create_offer', { ...offerArgs, title: 'The 200th photo', photo_urls: [img('/small.webp')] });
        const upload201 = await upload(C.token, goodJpg);
        const fetch201 = await tool(c, 'create_offer', { ...offerArgs, photo_urls: [img('/small.webp')] });
        assert(!the200th.isError && agentPhotosToday(C.id) === 200 && upload201.status === 429 && /200 a day is the most/.test(upload201.body?.error ?? '')
            && fetch201.isError === true && /200 a day is the most/.test(errorText(fetch201)) && uploadedPhotosWaiting(C.id) === 0,
            `the 200th is fetched; then an upload → 429 and an address → refused, by the same count (${upload201.status} ${upload201.body?.error?.slice(0, 50)})`);
        await c.close().catch(() => {});
        assert(await revoke(C.id) === 200, 'the busy day\'s check is disconnected');

        // ── 4. Upload ────────────────────────────────────────────────────────────────────────────
        console.log('── 4. POST /mcp/photos: the narrow second door ──');
        const A = await makeToken(owner, 'Olive\'s Claude Code');
        const B = await makeToken(owner, 'Olive\'s other script');
        const R = await makeToken(owner, 'Olive\'s reader', false);
        const owner2S = await keySignIn(owner2);
        const made2 = await call('POST', '/api/local/admin/agent/grants', { headers: ownerPhoneSessionHeaders(owner2.pub), body: { name: 'Ottilie\'s assistant', canPost: true } });
        assert(!!owner2S && made2.status === 201, `a second owner makes a ticked token (${made2.status})`);
        grantNodeRole(owner2.pub, 'admin', 'SYSTEM');
        const noToken = await upload(null, goodJpg);
        const madeUp = await upload(`bp_${'0'.repeat(64)}`, goodJpg);
        const readsOnly = await upload(R.token, goodJpg);
        const adminUp = await upload(made2.body.token, goodJpg);
        assert(noToken.status === 401 && madeUp.status === 401 && readsOnly.status === 403 && /without "May post for me"/.test(readsOnly.body?.error ?? '')
            && adminUp.status === 403 && /Only an owner's assistant can upload photos/.test(adminUp.body?.error ?? '')
            && uploadedPhotosWaiting(R.id) === 0 && uploadedPhotosWaiting(made2.body.grant.id) === 0 && agentPhotosToday(R.id) === 0,
            `no token, a made-up one → 401; a reads-only grant's, an admin's → 403 in words; nothing kept or counted (${noToken.status}, ${madeUp.status}, ${show(readsOnly)}, ${show(adminUp)})`);
        revokeNodeRole(owner2.pub, 'admin', owner.pub);
        const demoted = await upload(made2.body.token, goodJpg);
        assert(demoted.status === 401, `its maker now a member → 401 (${demoted.status})`);

        const fromPage = await upload(A.token, goodJpg, 'image/jpeg', { Origin: 'https://evil.example' });
        const asGet = await upload(A.token, '', 'image/jpeg', {}, 'GET');
        const textType = await upload(A.token, goodJpg, 'text/plain');
        const asJson = await upload(A.token, JSON.stringify({ photo: 'x' }), 'application/json');
        assert(fromPage.status === 403 && asGet.status === 405 && textType.status === 415 && asJson.status === 415
            && /Content-Type image\/jpeg, image\/webp, image\/png/.test(textType.body?.error ?? '') && agentPhotosToday(A.id) === 0,
            `another site's page → 403; a GET → 405; text/plain or JSON → 415, naming the types; none counted (${fromPage.status}, ${asGet.status}, ${show(textType)}, ${asJson.status})`);

        const short = await declaredButShort(A.token, 6 * MB, 10);
        assert(short.status === 413 && agentPhotosToday(A.id) === 0,
            `a Content-Length of 6 MB → 413 in ${short.ms} ms, while only 10 bytes of it were sent: refused before it is buffered, not counted`);
        const streamed = await streamedNoLength(A.token, 6 * MB);
        assert(streamed.status === 413 && /too big: at most 5 MB/.test(streamed.text) && uploadedPhotosWaiting(A.id) === 0,
            `6 MB streamed with no length → 413 once 5 MB had come, nothing kept (${streamed.status} ${streamed.text.slice(0, 80)})`);
        const htmlAsJpeg = await upload(A.token, Buffer.from('<!doctype html><p>not a photo</p>'));
        assert(htmlAsJpeg.status === 400 && htmlAsJpeg.body?.error === 'The upload is not an image: send a JPEG, WebP or PNG.' && uploadedPhotosWaiting(A.id) === 0,
            `HTML sent as image/jpeg → 400 "not an image", nothing kept (${show(htmlAsJpeg)})`);

        const photosBefore = agentPhotosToday(A.id);
        const good = await upload(A.token, goodJpg);
        const id1: string = good.body?.photoId ?? '';
        const files = fs.existsSync(path.join(uploadsRoot, A.id)) ? fs.readdirSync(path.join(uploadsRoot, A.id)) : [];
        const keptBytes = files.length ? fs.readFileSync(path.join(uploadsRoot, A.id, files[0])) : undefined;
        const keptFacts = await photoFacts(keptBytes);
        const expires = Date.parse(good.body?.expiresAt ?? '');
        assert(good.status === 201 && JSON.stringify(Object.keys(good.body ?? {}).sort()) === JSON.stringify(['expiresAt', 'photoId', 'photosPerDay', 'photosToday'])
            && /^ph_[0-9a-f]{32}$/.test(id1) && Math.abs(expires - (Date.now() + PHOTO_UPLOAD_KEEP_MS)) < 60_000
            && good.body.photosToday === photosBefore + 1 && good.body.photosPerDay === 200,
            `a good upload → 201 with exactly photoId, expiresAt (24 hours on), photosToday and photosPerDay (${show(good)})`);
        assert(files.length === 1 && keptFacts.format === 'jpeg' && keptFacts.width === 800 && keptFacts.height === 600 && !keptFacts.exif && !keptFacts.mark,
            `kept made what the apps send: 800 × 600, no metadata (${JSON.stringify(keptFacts)})`);
        const upLines = db.prepare("SELECT metadata FROM system_logs WHERE category = 'AGENT' AND message = 'Assistant uploaded a photo'").all() as Array<{ metadata: string }>;
        assert(upLines.some(l => l.metadata.includes(id1) && l.metadata.includes(A.id)), `the upload is an AGENT line with the grant and the photo's id (${upLines.length})`);

        const a = await connect(A.token);
        const NOT_YOURS = /^photo_ids #1 is not a photo this assistant uploaded and has not used yet: an id is used once, by the assistant that uploaded it, within 24 hours\. Upload it again\.$/;
        const b = await connect(B.token);
        const byOther = await tool(b, 'create_offer', { ...offerArgs, title: 'Not mine to post', photo_ids: [id1] });
        const neverWas = await tool(b, 'create_offer', { ...offerArgs, photo_ids: [`ph_${'f'.repeat(32)}`] });
        const malformed = await tool(b, 'create_offer', { ...offerArgs, photo_ids: ['../../state.db'] });
        assert(byOther.isError === true && NOT_YOURS.test(errorText(byOther)) && neverWas.isError === true && errorText(neverWas) === errorText(byOther)
            && malformed.isError === true && /^photo_ids #1 is not a photo id/.test(errorText(malformed)) && uploadedPhotosWaiting(A.id) === 1,
            `another grant's id → refused in the same words as one that never was; a path-shaped id → "not a photo id"; the upload is still there (${errorText(byOther).slice(0, 60)})`);
        const twiceInOne = await tool(a, 'create_offer', { ...offerArgs, photo_ids: [id1, id1] });
        assert(twiceInOne.isError === true && /^photo_ids #2 is not a photo this assistant uploaded/.test(errorText(twiceInOne)) && uploadedPhotosWaiting(A.id) === 1,
            `the same id twice in one call → refused, and the upload is still there (${errorText(twiceInOne).slice(0, 40)})`);
        // Refused after the id was taken (the engine refuses an event in the past): it can be used again.
        const pastEvent = await tool(a, 'create_event', {
            title: 'Yesterday\'s market', description: 'Already over.', start_at: new Date(Date.now() - DAY).toISOString(), timezone: 'Australia/Brisbane',
            place_name: 'The hall', lat: -28.55, lng: 153.5, photo_ids: [id1],
        });
        assert(pastEvent.isError === true && /future/.test(errorText(pastEvent)) && uploadedPhotosWaiting(A.id) === 1,
            `a create the engine refuses after taking the id → the id stays usable (${errorText(pastEvent).slice(0, 60)})`);
        const byId = await tool(a, 'create_offer', { ...offerArgs, title: 'Quince paste, uploaded', photo_ids: [id1] });
        const [fromUpload] = await storedPhotos(structured(byId)?.postId ?? '');
        const fromUploadFacts = await photoFacts(fromUpload);
        assert(!byId.isError && fromUploadFacts.width === 800 && fromUploadFacts.height === 600 && !fromUploadFacts.exif && uploadedPhotosWaiting(A.id) === 0
            && !fs.existsSync(path.join(uploadsRoot, A.id, files[0] ?? 'none')),
            `posted by photo_ids → its photo stored 800 × 600 with no metadata, and the upload's file gone (${errorText(byId) || structured(byId)?.postId})`);
        const again = await tool(a, 'create_offer', { ...offerArgs, title: 'Again', photo_ids: [id1] });
        assert(again.isError === true && NOT_YOURS.test(errorText(again)), `the same id used again → refused (${errorText(again).slice(0, 60)})`);

        const png = await upload(A.token, alphaPng, 'image/png');
        const pngId: string = png.body?.photoId ?? '';
        const pngPost = await tool(a, 'create_need', { ...offerArgs, title: 'Jars for quince paste', category: 'food', photo_ids: [pngId] });
        const [pngUp] = await storedPhotos(structured(pngPost)?.postId ?? '');
        assert(png.status === 201 && !pngPost.isError && (await photoFacts(pngUp)).format === 'jpeg' && imageSize(pngUp)?.width === 800,
            `a PNG upload → kept and posted as an 800 px JPEG (${show(png)} | ${errorText(pngPost) || 'posted'})`);

        const stale = await upload(A.token, goodJpg);
        const staleId: string = stale.body?.photoId ?? '';
        const swept = sweepUploadedPhotos(Date.now() + PHOTO_UPLOAD_KEEP_MS + 60_000);
        const afterDay = await tool(a, 'create_offer', { ...offerArgs, photo_ids: [staleId] });
        assert(stale.status === 201 && swept === 1 && uploadedPhotosWaiting(A.id) === 0 && !fs.existsSync(path.join(uploadsRoot, A.id))
            && afterDay.isError === true && NOT_YOURS.test(errorText(afterDay)),
            `24 hours on, an unused upload is swept, its folder with it, and its id refused (${swept} swept; ${errorText(afterDay).slice(0, 40)})`);

        const info = structured(await tool(a, 'connection_info', {}));
        const readerClient = await connect(R.token);
        const readerInfo = structured(await tool(readerClient, 'connection_info', {}));
        assert(info?.photos?.perDay === 200 && info.photos.uploadPath === '/mcp/photos' && typeof info.photos.today === 'number'
            && /photo_urls: public addresses of images this server fetches itself/.test(info.photos.ways) && /POST one image as the whole body to \/mcp\/photos/.test(info.photos.ways)
            && readerInfo && readerInfo.photos === undefined,
            `connection_info says the photos today against 200, where an upload goes and the two ways; a reads-only grant's has none (${JSON.stringify(info?.photos)})`);
        await readerClient.close().catch(() => {});

        const D = await makeToken(owner, 'Olive\'s old laptop');
        const d1 = await upload(D.token, goodJpg);
        const d2 = await upload(D.token, smallWebp, 'image/webp');
        const waitingBefore = uploadedPhotosWaiting(D.id);
        const revoked = await call('POST', `/api/local/admin/agent/grants/${encodeURIComponent(D.id)}/revoke`, { headers: asSession(ownerS), body: {} });
        assert(d1.status === 201 && d2.status === 201 && waitingBefore === 2 && revoked.status === 200 && uploadedPhotosWaiting(D.id) === 0
            && !fs.existsSync(path.join(uploadsRoot, D.id)),
            `revoked, a grant's 2 unused uploads and their folder are gone (${waitingBefore} → ${uploadedPhotosWaiting(D.id)})`);
        const afterRevoke = await upload(D.token, goodJpg);
        assert(afterRevoke.status === 401, `a revoked grant's upload → 401 (${afterRevoke.status})`);

        // Bodies still arriving fill the server's places: one more is told to wait, uncounted. Their clients go before the
        // bodies end, and the places are free at once, not at the read deadline.
        const S = await makeToken(owner, 'Olive\'s slow line');
        const stillArriving = Array.from({ length: PHOTO_UPLOADS_AT_ONCE }, () => stillSending(S.token));
        let busy: Reply | null = null;
        let busyCounted = true;
        for (let i = 0; i < 20 && busy?.status !== 503; i++) {
            await new Promise(r => setTimeout(r, 150));
            const before = agentPhotosToday(S.id);
            busy = await upload(S.token, smallWebp, 'image/webp');
            busyCounted = agentPhotosToday(S.id) !== before;
        }
        assert(busy?.status === 503 && busy.headers.get('retry-after') === '5' && !busyCounted
            && busy.body?.error === 'This server is taking other photos now: send it again in a few seconds.',
            `${PHOTO_UPLOADS_AT_ONCE} bodies still arriving → one more upload 503 with Retry-After 5, in words, not counted (${busy ? show(busy) : 'no answer'})`);
        const left = Date.now();
        stillArriving.forEach(s => s.leave());
        let afterLeft: Reply | null = null;
        for (let i = 0; i < 16 && afterLeft?.status !== 201; i++) {
            await new Promise(r => setTimeout(r, 250));
            afterLeft = await upload(S.token, smallWebp, 'image/webp');
        }
        const freedMs = Date.now() - left;
        assert(afterLeft?.status === 201 && freedMs < 5_000,
            `their clients gone before the bodies ended → an upload is read ${freedMs} ms later, not at the ${PHOTO_UPLOAD_READ_MS / 1000} s deadline (${afterLeft ? show(afterLeft) : 'no answer'})`);
        assert(await revoke(S.id) === 200 && uploadedPhotosWaiting(S.id) === 0, 'the slow line\'s check is disconnected, its upload gone');

        // A client gone while a reader in front of the route had its body: the route meets a request that has already closed
        // and will emit nothing more. Each is refused at once (counted, as any upload that got as far as its body), and holds
        // no place until the read deadline.
        const L = await makeToken(owner, 'Olive\'s dropped line');
        const leftBefore = agentPhotosToday(L.id);
        await Promise.all(Array.from({ length: PHOTO_UPLOADS_AT_ONCE }, () => goneWhileTheJsonReaderHadIt(L.token)));
        for (let i = 0; i < 20 && agentPhotosToday(L.id) - leftBefore < PHOTO_UPLOADS_AT_ONCE; i++) await new Promise(r => setTimeout(r, 100));
        const reachedRead = agentPhotosToday(L.id) - leftBefore;
        const dropped = Date.now();
        let afterDropped: Reply | null = null;
        for (let i = 0; i < 16 && afterDropped?.status !== 201; i++) {
            if (i > 0) await new Promise(r => setTimeout(r, 250));
            afterDropped = await upload(L.token, smallWebp, 'image/webp');
        }
        const droppedFreedMs = Date.now() - dropped;
        assert(reachedRead === PHOTO_UPLOADS_AT_ONCE && afterDropped?.status === 201 && droppedFreedMs < 5_000,
            `${PHOTO_UPLOADS_AT_ONCE} clients gone while the JSON reader had their bodies (${reachedRead} reached the read) → an upload is read ${droppedFreedMs} ms later, not at the ${PHOTO_UPLOAD_READ_MS / 1000} s deadline (${afterDropped ? show(afterDropped) : 'no answer'})`);
        assert(await revoke(L.id) === 200 && uploadedPhotosWaiting(L.id) === 0, 'the dropped line\'s check is disconnected, its upload gone');

        const off = await call('POST', '/api/local/admin/agent/switch', { headers: asSession(ownerS), body: { allowed: false } });
        const whileOff = await upload(A.token, goodJpg);
        const on = await call('POST', '/api/local/admin/agent/switch', { headers: asSession(ownerS), body: { allowed: true } });
        assert(off.status === 200 && whileOff.status === 404 && on.status === 200, `AI assistants turned off → the upload is 404, as /mcp (${whileOff.status})`);
        await a.close().catch(() => {});
        await b.close().catch(() => {});

        // ── 5. Beans ─────────────────────────────────────────────────────────────────────────────
        console.log('── 5. An enterprise listing\'s price follows the Beans switch ──');
        const E = await makeToken(owner, 'Olive\'s enterprise check');
        const e = await connect(E.token);
        const entArgs = { kind: 'offer', as_enterprise: enterpriseRef(bakery), title: 'Sourdough', category: 'food', photos: [smallB64] };
        const entSchema = async () => ((await e.listTools()).tools.find(t => t.name === 'create_enterprise_listing')?.inputSchema as any);
        const onSchema = await entSchema();
        const atZero = await tool(e, 'create_enterprise_listing', { ...entArgs, beans: 0 });
        const absent = await tool(e, 'create_enterprise_listing', entArgs);
        assert(getProfileSwitches().beans === true && (onSchema?.required ?? []).includes('beans') && onSchema?.properties?.beans?.exclusiveMinimum === 0
            && atZero.isError === true && /^beans must be more than 0/.test(errorText(atZero)) && absent.isError === true && /^beans is required: the price in Beans/.test(errorText(absent)),
            `Beans on: the schema asks a price above 0; 0 and absent are refused in words (${errorText(atZero)} | ${errorText(absent)})`);
        setSwitchOverride('beans', false);
        const offSchema = await entSchema();
        const postsWhileOff = postsCount();
        const offZero = await tool(e, 'create_enterprise_listing', { ...entArgs, beans: 0 });
        const offAbsent = await tool(e, 'create_enterprise_listing', entArgs);
        const enterprisesOffToo = getProfileSwitches().enterprises === false;
        setSwitchOverride('beans', true);
        assert(!(offSchema?.required ?? []).includes('beans') && offSchema?.properties?.beans?.exclusiveMinimum === undefined
            && [offZero, offAbsent].every(r => r.isError === true && !/beans/.test(errorText(r))),
            `Beans off: the schema asks no price, and neither 0 nor absent is refused for its price (${(offSchema?.required ?? []).join(', ')})`);
        assert(enterprisesOffToo && [offZero, offAbsent].every(r => errorText(r) === 'Enterprises are switched off on this node.') && postsCount() === postsWhileOff
            && agentCreatesToday(E.id) === 0,
            `…but Beans off turns enterprises off too (node-profile.ts lockToLedger), so the call is refused for that and nothing is made: no enterprise listing exists at 0 Beans (${errorText(offZero)})`);
        await e.close().catch(() => {});

        // ── 6. Every answer swept ────────────────────────────────────────────────────────────────
        console.log('── 6. Every answer: no key, no path, no resolved address ──');
        const all = answers.join('\n');
        const forbidden: Array<[string, string]> = [
            ['the owner\'s key', owner.pub], ['another owner\'s key', owner2.pub], ['a member\'s key', keeper.pub],
            ['an enterprise\'s key', bakery], ['another enterprise\'s key', notOurs],
            ['the data folder', dataDir], ['the uploads folder', 'assistant-photos'], ['the web root', webRoot],
            ['an address the server resolved (10.0.0.5)', '10.0.0.5'], ['the resolver\'s own words', 'SSRF_BLOCKED'], ['the resolver\'s own words', 'Resolved IP'],
            ['the resolver\'s own words', 'DNS resolution'], ['a stack', 'node_modules'], ['a source file', '.ts:'],
        ];
        const leaked = forbidden.filter(([, s]) => all.includes(s)).map(([what]) => what);
        assert(answers.length > 60 && leaked.length === 0, `${answers.length} answers swept: no key, path, resolved address or resolver message${leaked.length ? ` (LEAKED: ${leaked.join(', ')})` : ''}`);

        // ── 7. No Bean moved ─────────────────────────────────────────────────────────────────────
        const auditAfter = runLedgerAudit();
        assert(auditAfter.ok === auditBefore.ok && auditAfter.sumBalances === auditBefore.sumBalances && auditAfter.drift === auditBefore.drift,
            `the ledger audit is the same after as before (${JSON.stringify(auditBefore)} → ${JSON.stringify(auditAfter)})`);
    } catch (e) {
        // A throw is a failure, never a quiet end: the count would otherwise stop short and the exit say 0.
        console.error(e);
        process.exitCode = 1;
    } finally {
        imageServer.closeAllConnections();
        imageServer.close();
        console.log(`\n${passed}/${run} passed`);
        process.exit(process.exitCode ?? 0);
    }
}

main().catch((e) => { console.error(e); console.log(`\n${passed}/${run} passed`); process.exit(1); });
