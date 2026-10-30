/**
 * MCP-OWNER-POSTS (Marty, 30 Oct): an owner's AI assistant posts Offers, Needs, events and enterprise listings itself through
 * /mcp (agent/owner-posts.ts). End to end with the official TypeScript MCP SDK client over REAL HTTPS through the real Koa
 * middleware; nothing here contacts anything but the server it starts.
 *
 *   1. An owner's assistant makes each kind: the row (its author, `created_via = 'assistant:<grant id>'`), its photo stored at
 *      most 800 px whatever size it was sent, the search index finds it, the listings' version moves (the phones' sync mark),
 *      the standby copy's payload carries created_via, the AGENT log names the post, and the answer carries no key.
 *   1b. Its photos go through the node's own image store (storage/image-store.ts) exactly as an upload's do, never a file
 *      written beside it or a link: on disk (the default), and on the S3-compatible store a node like global keeps in R2
 *      (IMAGE_S3_*; here the in-process stand-in, fake-s3-test-harness.ts): each photo an object at posts/<post id>/…, the
 *      row holding its key and no bytes.
 *   2. Refusals in words, none counted against the day: no photo, a PNG, a photo over the per-photo cap, a JPEG cut off halfway
 *      (its header still whole), an event's time with no offset (or a date with no time), an enterprise the owner does not keep
 *      (or a made-up ref), a title longer than the forms take, a listing with neither a pin nor use_my_area. Every field the phone's and the web's composer require for
 *      each kind (Marty, 30 Oct: "all the mandatory fields should be mandatory even if seeding through MCP") is in the tool's
 *      input schema and, left out or empty, refused by the server in words that name it; a price only where Beans are on.
 *   2c. "May post for me" (design Q1): a token made without the tick lists no posting tool, is refused if it calls one, and
 *      says so in connection_info; the list shows the tick. "Assistant posts a day", an owners' setting: 100 by default (the
 *      101st refused); set to 1,000 the 1,001st is refused; set back to 100 it holds at once; out of range, or from an admin,
 *      refused; each change alerts the owners (sec.agent) and is shown on the list and in connection_info.
 *   3. An admin's assistant has none of the tools (and is refused if it calls one); its maker no longer an owner or admin → 401;
 *      a body over 64 KiB from anyone but an owner's assistant → 413; the owner switch off → 404; the grant revoked → 401.
 *   4. The ledger audit is the same after as before: posting moves no Bean.
 *
 * Run: SERVER_SUITES_ONLY=test-mcp-owner-posts TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { setMemberPhoto, clearEnterpriseFloorCache } from '@beanpool/engine';
import { PRICING_CATEGORIES } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, runLedgerAudit, getPosts, getPostsVersion, exportSyncState } from './state-engine.js';
import { updateLocalConfig, getLocalConfig } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { grantNodeRole, revokeNodeRole } from './engine/node-roles.js';
import { getProfileSwitches, setSwitchOverride } from './config/node-profile.js';
import { db } from './db/db.js';
import { configuredImageStoreKind, getImageStore, readObject, resetImageStoreForTests } from './storage/image-store.js';
import { S3ImageStore } from './storage/s3-image-store.js';
import { startFakeS3 } from './fake-s3-test-harness.js';
import { imageSize } from './storage/image-metadata.js';
import { admitAgentCreate, agentCreatesToday, AGENT_POSTS_PER_DAY_DEFAULT } from './agent/limits.js';
import { getAlertsStatus } from './services/alerts.js';
import { OWNER_POST_TOOLS, enterpriseRef } from './agent/owner-posts.js';
import type { AgentGrant } from './agent/tools.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

interface Reply { status: number; body: any; text: string }
async function call(method: string, p: string, opts: { body?: unknown; raw?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
    const res = await fetch(`${BASE}${p}`, {
        method,
        headers: { ...(opts.body !== undefined || opts.raw !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
        body: opts.raw !== undefined ? opts.raw : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        redirect: 'manual',
    });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, body, text };
}
const show = (r: Reply) => `${r.status} ${r.text.slice(0, 160)}`;
const asSession = (id: string | null): Record<string, string> => ({ 'X-Admin-Session': id ?? '' });
const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };
const rpc = (method: string, id = 1, params: unknown = {}) => ({ jsonrpc: '2.0', id, method, params });

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

async function connect(token: string): Promise<Client> {
    const client = new Client({ name: 'beanpool-test-assistant', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: bearer(token) } }));
    return client;
}

/** Whether create_offer and create_need ask a price (their schema is made each time the tools are listed). */
const listedRequiresBeans = (tools: typeof OWNER_POST_TOOLS): boolean =>
    ['create_offer', 'create_need'].every(n => (((tools.find(t => t.name === n)?.inputSchema as any)?.required ?? []) as string[]).includes('beans'));
const structured = (r: any): any => r?.structuredContent ?? null;
const errorText = (r: any): string => (r?.content as any)?.[0]?.text ?? '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const DAY = 86_400_000;

async function jpeg(width: number, height: number, quality = 80): Promise<string> {
    const buf = await sharp({ create: { width, height, channels: 3, background: { r: 180, g: 120, b: 60 } } })
        .composite([{ input: Buffer.from(`<svg width="${width}" height="${height}"><circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 3}" fill="#2a6"/></svg>`) }])
        .jpeg({ quality }).toBuffer();
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

/** A JPEG of noise, which does not compress: a body of a known size. */
async function noisyJpeg(width: number, height: number): Promise<string> {
    const buf = await sharp(crypto.randomBytes(width * height * 3), { raw: { width, height, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

/** The bytes of a post's stored photo, wherever it was kept (the image store, or its row). */
async function storedPhoto(postId: string): Promise<Buffer | null> {
    const row = db.prepare('SELECT photo_data, storage_key FROM post_photos WHERE post_id = ? ORDER BY order_num LIMIT 1').get(postId) as
        { photo_data: string | null; storage_key: string | null } | undefined;
    if (!row) return null;
    if (row.storage_key) return readObject(getImageStore(), row.storage_key);
    const m = /^data:[^;]+;base64,(.*)$/s.exec(row.photo_data ?? '');
    return m ? Buffer.from(m[1], 'base64') : null;
}

async function main(): Promise<void> {
    console.log('\n=== An owner\'s assistant posts through /mcp (MCP-OWNER-POSTS) ===\n');
    const tmp = path.resolve(os.tmpdir());
    const webRoot = fs.mkdtempSync(path.join(tmp, 'bp-mcp-posts-'));
    fs.mkdirSync(path.join(webRoot, 'public'), { recursive: true });
    fs.writeFileSync(path.join(webRoot, 'public', 'index.html'), '<!doctype html><title>BeanPool</title>');
    process.chdir(webRoot);

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
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const auditBefore = runLedgerAudit();

    try {
        resetAdminAuthTarpit();
        const ownerS = await keySignIn(owner);
        const owner2S = await keySignIn(owner2);
        assert(!!ownerS && !!owner2S, 'two owners sign in with their keys');
        const made = await call('POST', '/api/local/admin/agent/grants', { headers: asSession(ownerS), body: { name: 'Olive\'s Claude', canPost: true } });
        assert(made.status === 201 && typeof made.body?.token === 'string', `an owner makes an agent token (${made.status})`);
        const TOKEN: string = made.body.token;
        const grantId: string = made.body.grant.id;
        const client = await connect(TOKEN);

        // ── 1. Each kind ──────────────────────────────────────────────────────────────────────────
        console.log('── 1. An owner\'s assistant posts each kind ──');
        const names = (await client.listTools()).tools.map(t => t.name);
        assert(['create_offer', 'create_need', 'create_event', 'create_enterprise_listing', 'my_enterprises'].every(n => names.includes(n)),
            `an owner's assistant lists the four creates and my_enterprises (${names.join(', ')})`);
        const big = await jpeg(1600, 1200);
        const small = await jpeg(640, 480);
        const versionBefore = getPostsVersion();
        // A pin to the metre, as an assistant may send it: stored rounded to about 100 m, as both apps round it before sending.
        const offer = await client.callTool({ name: 'create_offer', arguments: {
            title: 'Quincefield sourdough loaves', description: 'Baked Saturday morning, collect from the hall.', category: 'food', beans: 6,
            lat: -28.551234, lng: 153.509876, photos: [big, small],
        } });
        const o = structured(offer);
        assert(!offer.isError && typeof o?.postId === 'string' && o.kind === 'offer' && o.asEnterprise === false && o.link === `/?post=${encodeURIComponent(o.postId)}`
            && o.postsToday === 1 && o.postsPerDay === AGENT_POSTS_PER_DAY_DEFAULT && AGENT_POSTS_PER_DAY_DEFAULT === 100, `create_offer posts an Offer and answers its id, its link and the day's count (${JSON.stringify(o ?? offer.content)})`);
        const row = db.prepare('SELECT author_pubkey, created_by, created_via, type, status, updated_at, title, lat, lng FROM posts WHERE id = ?').get(o?.postId) as any;
        assert(row?.lat === -28.551 && row?.lng === 153.51, `its pin is stored rounded to 3 decimals, as the apps send it (${row?.lat}, ${row?.lng})`);
        assert(row?.author_pubkey === owner.pub && row.created_by === null && row.created_via === `assistant:${grantId}` && row.type === 'offer' && row.status === 'active' && !!row.updated_at,
            `the row is the owner's own, live, with created_via = assistant:<grant id> (${JSON.stringify(row)})`);
        const photoCount = (db.prepare('SELECT COUNT(*) AS c FROM post_photos WHERE post_id = ?').get(o?.postId) as any).c;
        const stored = await storedPhoto(o?.postId);
        const size = stored ? imageSize(stored) : null;
        assert(photoCount === 2 && !!size && Math.max(size.width, size.height) === 800 && size.width === 800 && size.height === 600,
            `both photos are stored, the 1600 × 1200 one made 800 × 600 as the apps send (${photoCount} rows, ${JSON.stringify(size)})`);
        const fts = db.prepare(`SELECT p.id FROM posts_fts JOIN posts p ON p.rowid = posts_fts.rowid WHERE posts_fts MATCH ?`).all('Quincefield') as Array<{ id: string }>;
        assert(fts.some(r => r.id === o?.postId), `the search index finds it (${fts.length})`);
        assert(getPostsVersion() !== versionBefore, `the listings' version moved, so phones sync it (${versionBefore} → ${getPostsVersion()})`);
        const payload = await exportSyncState('mcp-owner-posts-suite') as any;
        const copied = (payload?.posts ?? []).find((p: any) => p.id === o?.postId);
        assert(copied?.createdVia === `assistant:${grantId}` && (payload?.posts ?? []).filter((p: any) => p.createdVia).length === 1,
            `the standby copy's payload carries created_via for it, and for no other post (${copied?.createdVia})`);
        const asRead = JSON.stringify(getPosts({ id: o?.postId, viewerPubkey: owner.pub }));
        assert(asRead.includes('Quincefield') && !/created_?via|assistant:/i.test(asRead), 'the listings an app reads never carry it');

        // ── 1b. Through the node's own image store, disk and S3 ─────────────────────────────────────
        type PhotoRow = { storage_key: string | null; photo_data: string | null };
        const photoRowsOf = (postId: string) => db.prepare('SELECT storage_key, photo_data FROM post_photos WHERE post_id = ? ORDER BY order_num').all(postId) as PhotoRow[];
        const diskRows = photoRowsOf(o?.postId);
        const diskObjects = await Promise.all(diskRows.map(r => (r.storage_key ? readObject(getImageStore(), r.storage_key) : Promise.resolve(null))));
        assert(configuredImageStoreKind() === 'disk' && diskRows.length === 2
            && diskRows.every(r => r.photo_data === null && !!r.storage_key && r.storage_key.startsWith(`posts/${o?.postId}/`))
            && diskObjects.every(b => !!b && !!imageSize(b)), `on disk, each photo is an object in the image store under the post, the row holding its key and no bytes (${diskRows.map(r => r.storage_key).join(', ')})`);
        const fakeS3 = await startFakeS3();
        const s3Store = new S3ImageStore(fakeS3.config());
        resetImageStoreForTests(s3Store);
        try {
            // A ticked grant of its own, so the door's 60 a minute holds for the main one; disconnected after.
            const bucketT = await call('POST', '/api/local/admin/agent/grants', { headers: asSession(ownerS), body: { name: 'Olive\'s bucket check', canPost: true } });
            const bc = await connect(bucketT.body?.token);
            const viaS3 = await bc.callTool({ name: 'create_offer', arguments: {
                title: 'Bucket-kept marmalade', description: 'Seville oranges, last winter.', category: 'food', beans: 2, lat: -28.55, lng: 153.5, photos: [big],
            } });
            const s3Rows = photoRowsOf(structured(viaS3)?.postId ?? '');
            const objects = await fakeS3.objects();
            const kept = s3Rows[0]?.storage_key ? objects.get(s3Rows[0].storage_key) : undefined;
            const keptSize = kept ? imageSize(kept.bytes) : null;
            const signedOk = (await fakeS3.log()).filter(e => e.method === 'PUT').every(e => e.authOk && !e.error);
            assert(!viaS3.isError && s3Rows.length === 1 && s3Rows[0].photo_data === null && s3Rows[0].storage_key?.startsWith(`posts/${structured(viaS3)?.postId}/`)
                && !!kept && kept.mime === 'image/jpeg' && !!keptSize && keptSize.width === 800 && keptSize.height === 600 && signedOk,
                `on the S3-compatible store (global's R2), the photo is put in the bucket, signed, made 800 × 600; the row holds its key (${errorText(viaS3) || s3Rows[0]?.storage_key}; ${JSON.stringify(keptSize)})`);
            await bc.close().catch(() => {});
            await call('POST', `/api/local/admin/agent/grants/${encodeURIComponent(bucketT.body?.grant?.id ?? '')}/revoke`, { headers: asSession(ownerS), body: {} });
        } finally {
            resetImageStoreForTests();
            await s3Store.close();
            await fakeS3.stop();
        }

        const need = await client.callTool({ name: 'create_need', arguments: {
            title: 'Someone to mend a fence', description: 'Three panels blew down; I have the timber.', category: 'labour', beans: 10, lat: -28.56, lng: 153.51, photos: [small],
        } });
        const n = structured(need);
        assert(!need.isError && n?.kind === 'need' && (db.prepare('SELECT author_pubkey, created_via FROM posts WHERE id = ?').get(n?.postId) as any)?.created_via === `assistant:${grantId}`,
            `create_need posts a Need as the owner (${JSON.stringify(n ?? need.content)})`);

        const at50 = await client.callTool({ name: 'create_offer', arguments: {
            title: 'y'.repeat(50), description: 'A title as long as the form takes.', category: 'food', beans: 1, lat: -28.55, lng: 153.5, photos: [small],
        } });
        assert(!at50.isError, `a title of exactly 50, the form's most, is taken (${errorText(at50) || 'posted'})`);
        // use_my_area said out loud: no pin asked and none sent, so the engine gives it the owner's own area as a listing without one gets.
        const myArea = await client.callTool({ name: 'create_offer', arguments: {
            title: 'Spare jars', description: 'A box of them.', category: 'food', beans: 1, use_my_area: true, photos: [small],
        } });
        const myAreaRow = db.prepare('SELECT lat, lng, author_pubkey FROM posts WHERE id = ?').get(structured(myArea)?.postId) as any;
        assert(!myArea.isError && myAreaRow?.author_pubkey === owner.pub, `use_my_area: true posts with no pin asked (${JSON.stringify(myAreaRow ?? myArea.content)})`);

        const startAt = new Date(Date.now() + 7 * DAY).toISOString();
        const event = await client.callTool({ name: 'create_event', arguments: {
            title: 'Seed swap at the hall', description: 'Bring seeds, take seeds.', start_at: startAt, end_at: new Date(Date.now() + 7 * DAY + 2 * 3600_000).toISOString(),
            timezone: 'Australia/Brisbane', place_name: 'The hall', lat: -28.554321, lng: 153.500456, photos: [small],
        } });
        const e = structured(event);
        const eRow = db.prepare('SELECT type, author_pubkey, created_via, event_start_at, lat, lng FROM posts WHERE id = ?').get(e?.postId) as any;
        assert(eRow?.lat === -28.554 && eRow?.lng === 153.5, `an event's pin is rounded the same (${eRow?.lat}, ${eRow?.lng})`);
        assert(!event.isError && e?.kind === 'event' && eRow?.type === 'event' && eRow.author_pubkey === owner.pub && eRow.created_via === `assistant:${grantId}`
            && Date.parse(eRow.event_start_at) === Date.parse(startAt), `create_event posts an event as the owner (${JSON.stringify(e ?? event.content)})`);
        // The answer says when it starts and ends as members see it (the clock in the event's zone), so the assistant can check it.
        const clockIn = (iso: string, tz: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)).replace(' ', 'T');
        const clockRow = db.prepare('SELECT event_start_local, event_end_local, event_tz FROM posts WHERE id = ?').get(e?.postId) as any;
        assert(typeof e?.timezone === 'string' && e.timezone === clockRow?.event_tz && e.startsLocal === clockRow.event_start_local && e.endsLocal === clockRow.event_end_local
            && e.startsLocal === clockIn(startAt, e.timezone), `the answer carries the start and end members see, in the event's zone (${e?.startsLocal} → ${e?.endsLocal}, ${e?.timezone})`);
        const online = await client.callTool({ name: 'create_event', arguments: {
            title: 'Seed-saving talk', description: 'An hour on keeping seed true.', start_at: startAt, timezone: 'Australia/Brisbane', online: true,
            link: 'https://meet.example.org/seeds', photos: [small],
        } });
        const onRow = db.prepare('SELECT event_online, lat, lng, event_place_name, created_via FROM posts WHERE id = ?').get(structured(online)?.postId) as any;
        assert(!online.isError && onRow?.event_online === 1 && onRow.lat === null && onRow.lng === null && onRow.event_place_name === null && onRow.created_via === `assistant:${grantId}`,
            `an event online needs no place: none is asked, none stored (${JSON.stringify(structured(online) ?? online.content)} ${JSON.stringify(onRow)})`);

        const mine = await client.callTool({ name: 'my_enterprises', arguments: {} });
        const kept = structured(mine)?.enterprises ?? [];
        assert(!mine.isError && kept.length === 1 && kept[0].ref === enterpriseRef(bakery) && kept[0].name?.untrusted === true && /Olive Bakery Co-op/.test(kept[0].name?.text ?? '')
            && !JSON.stringify(structured(mine)).includes(bakery), `my_enterprises names the one enterprise the owner keeps, by a ref, never its key, its name fenced (${JSON.stringify(kept)})`);
        const ent = await client.callTool({ name: 'create_enterprise_listing', arguments: {
            kind: 'offer', as_enterprise: kept[0]?.ref, title: 'Day-old bread, half price', category: 'food', beans: 2, photos: [small],
        } });
        const en = structured(ent);
        const enRow = db.prepare('SELECT author_pubkey, created_by, created_via, repeatable FROM posts WHERE id = ?').get(en?.postId) as any;
        assert(!ent.isError && en?.asEnterprise === true && enRow?.author_pubkey === bakery && enRow.created_by === owner.pub && enRow.created_via === `assistant:${grantId}` && enRow.repeatable === 1,
            `create_enterprise_listing posts the enterprise's Offer, the owner as the keeper who made it (${JSON.stringify(en ?? ent.content)} ${JSON.stringify(enRow)})`);
        const answers = JSON.stringify([offer, need, event, mine, ent]);
        assert(!/[0-9a-f]{64}/i.test(answers) && !/https?:/i.test(answers) && !answers.includes(TOKEN), 'no answer carries a key, an address or the token');
        const wrote = (db.prepare("SELECT metadata FROM system_logs WHERE category = 'AGENT' AND message = 'Assistant wrote'").all() as Array<{ metadata: string }>)
            .map(r => JSON.parse(r.metadata));
        assert([o?.postId, n?.postId, e?.postId, en?.postId].every(id => wrote.some(m => m.post === id && m.ok === true)) && !wrote.some(m => /Quincefield|sourdough/.test(JSON.stringify(m))),
            `each create is in the AGENT log with its post id, and no member text (${wrote.length} lines)`);

        // ── 2. Refusals in words, none counted ──────────────────────────────────────────────────────
        console.log('── 2. Refused in words, and not counted ──');
        const countBefore = agentCreatesToday(grantId);
        const postsBefore = (db.prepare('SELECT COUNT(*) AS c FROM posts').get() as any).c;
        // Every field but the one each refusal is about (2b goes through every field).
        const offerArgs = { title: 'Plum jam', description: 'Six jars from last summer.', category: 'food', beans: 4, lat: -28.55, lng: 153.5, photos: [small] };
        const needArgs = { title: 'A ride to the station', description: 'Tuesday, early.', category: 'transport', beans: 3, lat: -28.55, lng: 153.5, photos: [small] };
        const eventArgs = { title: 'Working bee', description: 'Weeding and mulch.', start_at: startAt, timezone: 'Australia/Brisbane', place_name: 'The community garden', lat: -28.55, lng: 153.5, photos: [small] };
        const entArgs = { kind: 'offer', as_enterprise: kept[0]?.ref, title: 'Rye loaves', category: 'food', beans: 5, photos: [small] };
        const { photos: _noPhotos, ...offerNoPhotos } = offerArgs;
        const noPhoto = await client.callTool({ name: 'create_offer', arguments: offerNoPhotos });
        const emptyPhotos = await client.callTool({ name: 'create_need', arguments: { ...needArgs, photos: [] } });
        assert(noPhoto.isError === true && /^photos is required: add 1 to 4 photos first/.test(errorText(noPhoto))
            && emptyPhotos.isError === true && /^photos is required/.test(errorText(emptyPhotos)), `no photo → refused in words naming the field (${errorText(noPhoto)})`);
        const png = `data:image/png;base64,${(await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } }).png().toBuffer()).toString('base64')}`;
        const asPng = await client.callTool({ name: 'create_offer', arguments: { ...offerArgs, photos: [png] } });
        assert(asPng.isError === true && /JPEG or WebP/.test(errorText(asPng)), `a PNG → refused: JPEG or WebP (${errorText(asPng)})`);
        const huge = `data:image/jpeg;base64,${'A'.repeat(600_001)}`;
        const tooBig = await client.callTool({ name: 'create_offer', arguments: { ...offerArgs, photos: [huge] } });
        assert(tooBig.isError === true && /too large/.test(errorText(tooBig)), `a photo over the per-photo cap → refused (${errorText(tooBig)})`);
        // Cut off halfway, its header still reads 640 × 480: the server can't read the rest, so it is refused, never stored as sent.
        const smallBytes = Buffer.from(small.slice(small.indexOf(',') + 1), 'base64');
        const halfPhoto = `data:image/jpeg;base64,${smallBytes.subarray(0, smallBytes.length >> 1).toString('base64')}`;
        const cutShort = await client.callTool({ name: 'create_offer', arguments: { ...offerArgs, photos: [halfPhoto] } });
        assert(cutShort.isError === true && /^Photo 1 could not be read/.test(errorText(cutShort)),
            `a JPEG cut off halfway (its header still ${JSON.stringify(imageSize(Buffer.from(halfPhoto.slice(23), 'base64')))}) → refused, never stored as sent (${errorText(cutShort)})`);
        const otherRef = await client.callTool({ name: 'create_enterprise_listing', arguments: { ...entArgs, as_enterprise: enterpriseRef(notOurs), category: 'tools' } });
        const madeUp = await client.callTool({ name: 'create_event', arguments: { ...eventArgs, as_enterprise: 'ffffffffffffffff' } });
        assert(otherRef.isError === true && /not an enterprise you keep/.test(errorText(otherRef)) && madeUp.isError === true && /not an enterprise you keep/.test(errorText(madeUp)),
            `an enterprise the owner does not keep, or a made-up ref → refused (${errorText(otherRef)})`);
        // A time with no offset would be read in this server's own zone (on a UTC host a Melbourne 10:00 is shown at 21:00), and a
        // date alone as UTC midnight: each is refused naming its field, the same on every host.
        const noOffset = await client.callTool({ name: 'create_event', arguments: { ...eventArgs, start_at: startAt.slice(0, 19), timezone: 'Australia/Melbourne' } });
        const endNoOffset = await client.callTool({ name: 'create_event', arguments: { ...eventArgs, end_at: new Date(Date.parse(startAt) + 2 * 3600_000).toISOString().slice(0, 16) } });
        const dateOnly = await client.callTool({ name: 'create_event', arguments: { ...eventArgs, start_at: startAt.slice(0, 10) } });
        assert(noOffset.isError === true && /^start_at must carry its offset/.test(errorText(noOffset)) && endNoOffset.isError === true && /^end_at must carry its offset/.test(errorText(endNoOffset))
            && dateOnly.isError === true && /^start_at must carry its offset/.test(errorText(dateOnly)),
            `a start or an end with no offset, or a date with no time → refused naming the field (${errorText(noOffset)} | ${errorText(endNoOffset).slice(0, 40)} | ${errorText(dateOnly).slice(0, 40)})`);
        const engineRefusal = await client.callTool({ name: 'create_event', arguments: { ...eventArgs, start_at: new Date(Date.now() - DAY).toISOString() } });
        const badCategory = await client.callTool({ name: 'create_offer', arguments: { ...offerArgs, category: 'trades' } });
        const freeEnterprise = await client.callTool({ name: 'create_enterprise_listing', arguments: { ...entArgs, beans: 0 } });
        const badKind = await client.callTool({ name: 'create_enterprise_listing', arguments: { ...entArgs, kind: 'barter' } });
        const offered = ((await client.listTools()).tools.find(t => t.name === 'create_offer')?.inputSchema as any)?.properties?.category?.enum ?? [];
        assert(badCategory.isError === true && /^category must be one of food, services/.test(errorText(badCategory))
            && JSON.stringify(offered) === JSON.stringify(PRICING_CATEGORIES.map(c => c.id)) && !offered.includes('other'),
            `a category no app offers → refused, naming the ones they do; the schema offers the Market's ${offered.length} (${errorText(badCategory).slice(0, 60)}…)`);
        assert(freeEnterprise.isError === true && /^beans must be more than 0/.test(errorText(freeEnterprise)) && badKind.isError === true && /^kind must be offer or need/.test(errorText(badKind)),
            `an enterprise's listing at 0 Beans, or a kind that is neither → refused as its form would (${errorText(freeEnterprise)} | ${errorText(badKind)})`);
        assert(engineRefusal.isError === true && /future/.test(errorText(engineRefusal)), `the engine's own rules answer, in its words (${errorText(engineRefusal)})`);
        // The composers' title lengths: 50 for a listing, 140 for an event (the engine's own 200 is wider than any app sends).
        const longOffer = await client.callTool({ name: 'create_offer', arguments: { ...offerArgs, title: 'x'.repeat(51) } });
        const longNeed = await client.callTool({ name: 'create_need', arguments: { ...needArgs, title: 'x'.repeat(51) } });
        const longEnt = await client.callTool({ name: 'create_enterprise_listing', arguments: { ...entArgs, title: 'x'.repeat(51) } });
        const longEvent = await client.callTool({ name: 'create_event', arguments: { ...eventArgs, title: 'x'.repeat(141) } });
        const listedTools = (await client.listTools()).tools;
        const maxOf = (n: string) => (listedTools.find(t => t.name === n)?.inputSchema as any)?.properties?.title?.maxLength;
        assert([longOffer, longNeed, longEnt].every(r => r.isError === true && /^title is at most 50 characters/.test(errorText(r)))
            && longEvent.isError === true && /^title is at most 140 characters/.test(errorText(longEvent))
            && maxOf('create_offer') === 50 && maxOf('create_need') === 50 && maxOf('create_enterprise_listing') === 50 && maxOf('create_event') === 140,
            `a listing's title over 50, an event's over 140 → refused naming the field; the schemas say so (${errorText(longOffer)} | ${errorText(longEvent)})`);
        const { lat: _lat, lng: _lng, ...offerNoPin } = offerArgs;
        const noPin = await client.callTool({ name: 'create_offer', arguments: offerNoPin });
        assert(noPin.isError === true && /^lat is required: .*use_my_area: true/.test(errorText(noPin)),
            `neither a pin nor use_my_area → refused naming lat, and saying use_my_area (${errorText(noPin)})`);

        const postsAfter = (db.prepare('SELECT COUNT(*) AS c FROM posts').get() as any).c;
        assert(agentCreatesToday(grantId) === countBefore && postsAfter === postsBefore, `no refused call made a post or counted against the day (${countBefore} → ${agentCreatesToday(grantId)})`);

        // ── 2b. Every field the apps require ────────────────────────────────────────────────────────
        console.log('── 2b. Every field both apps\' composers require, left out or empty, is refused in words naming it ──');
        const sorted = (a: readonly string[]) => [...a].sort().join(',');
        const emptyOf = (v: unknown): unknown => Array.isArray(v) ? [] : typeof v === 'number' ? '' : '   ';
        const KINDS: Array<{ tool: string; args: Record<string, unknown>; required: string[]; schema?: string[] }> = [
            // The pin unless use_my_area: JSON Schema's `required` cannot say "unless", so the schema lists the ones always needed.
            { tool: 'create_offer', args: offerArgs, required: ['title', 'description', 'category', 'beans', 'lat', 'lng', 'photos'], schema: ['title', 'description', 'category', 'beans', 'photos'] },
            { tool: 'create_need', args: needArgs, required: ['title', 'description', 'category', 'beans', 'lat', 'lng', 'photos'], schema: ['title', 'description', 'category', 'beans', 'photos'] },
            // In person, its place too: the same "unless online".
            { tool: 'create_event', args: eventArgs, required: ['title', 'description', 'start_at', 'timezone', 'photos', 'place_name', 'lat', 'lng'],
                schema: ['title', 'description', 'start_at', 'timezone', 'photos'] },
            { tool: 'create_enterprise_listing', args: entArgs, required: ['kind', 'as_enterprise', 'title', 'category', 'beans', 'photos'] },
        ];
        const postsBefore2b = (db.prepare('SELECT COUNT(*) AS c FROM posts').get() as any).c;
        const kindGrants: string[] = [];
        for (const k of KINDS) {
            // A token of its own for each kind: two calls a field stay inside the door's 60 a minute.
            const t = await call('POST', '/api/local/admin/agent/grants', { headers: asSession(ownerS), body: { name: `Olive's ${k.tool} check`, canPost: true } });
            kindGrants.push(t.body?.grant?.id);
            const kc = await connect(t.body?.token);
            const listed = (await kc.listTools()).tools.find(x => x.name === k.tool);
            const schemaRequired = ((listed?.inputSchema as any)?.required ?? []) as string[];
            assert(t.status === 201 && sorted(schemaRequired) === sorted(k.schema ?? k.required),
                `${k.tool}'s input schema requires ${(k.schema ?? k.required).join(', ')} (${schemaRequired.join(', ')})`);
            const wrong: string[] = [];
            for (const field of k.required) {
                const leftOut: Record<string, unknown> = { ...k.args };
                delete leftOut[field];
                for (const [how, args] of [['left out', leftOut], ['empty', { ...k.args, [field]: emptyOf(k.args[field]) }]] as const) {
                    const r = await kc.callTool({ name: k.tool, arguments: args });
                    if (!(r.isError === true && errorText(r).startsWith(`${field} is required: `))) wrong.push(`${field} ${how} → ${errorText(r).slice(0, 80) || 'made a post'}`);
                }
            }
            assert(wrong.length === 0, `${k.tool}: each of ${k.required.join(', ')}, left out and then empty, is refused naming it${wrong.length ? ` (${wrong.join('; ')})` : ''}`);
            await kc.close().catch(() => {});
        }
        assert((db.prepare('SELECT COUNT(*) AS c FROM posts').get() as any).c === postsBefore2b && kindGrants.every(g => !!g && agentCreatesToday(g) === 0),
            'none of them made a post or counted against a day');
        // Where the node has no Beans neither app asks a price, and nor does create_offer.
        setSwitchOverride('beans', false);
        const beansOff = getProfileSwitches().beans === false;
        const offRequired = ((await client.listTools()).tools.find(x => x.name === 'create_offer')?.inputSchema as any)?.required ?? [];
        const { beans: _beans, ...offerNoPrice } = offerArgs;
        const noPrice = await client.callTool({ name: 'create_offer', arguments: { ...offerNoPrice, photos: [] } });
        // Beans off turns enterprises off too (config/node-profile.ts lockToLedger), and the enterprise routes answer 404 feature_off
        // before their handler (routes/profile-feature-gate.ts), a gate /mcp never meets: the tools ask it themselves.
        const postsWhileOff = (db.prepare('SELECT COUNT(*) AS c FROM posts').get() as any).c;
        const countWhileOff = agentCreatesToday(grantId);
        const enterprisesOff = getProfileSwitches().enterprises === false;
        const keptWhileOff = structured(await client.callTool({ name: 'my_enterprises', arguments: {} }))?.enterprises;
        const eventAsEnterprise = await client.callTool({ name: 'create_event', arguments: { ...eventArgs, as_enterprise: kept[0]?.ref } });
        const listingAsEnterprise = await client.callTool({ name: 'create_enterprise_listing', arguments: entArgs });
        const madeWhileOff = (db.prepare('SELECT COUNT(*) AS c FROM posts').get() as any).c - postsWhileOff;
        setSwitchOverride('beans', true);
        assert(beansOff && !offRequired.includes('beans') && offRequired.includes('title') && /^photos is required/.test(errorText(noPrice))
            && getProfileSwitches().beans === true && listedRequiresBeans(OWNER_POST_TOOLS),
            `with Beans off, create_offer asks no price (schema: ${offRequired.join(', ')}; ${errorText(noPrice).slice(0, 40)}), and asks one again when they are on`);
        const keptAgain = structured(await client.callTool({ name: 'my_enterprises', arguments: {} }))?.enterprises ?? [];
        assert(enterprisesOff && Array.isArray(keptWhileOff) && keptWhileOff.length === 0
            && eventAsEnterprise.isError === true && errorText(eventAsEnterprise) === 'Enterprises are switched off on this node.'
            && listingAsEnterprise.isError === true && errorText(listingAsEnterprise) === 'Enterprises are switched off on this node.'
            && madeWhileOff === 0 && agentCreatesToday(grantId) === countWhileOff && keptAgain.length === 1,
            `with enterprises off, my_enterprises lists none and posting as one is refused in its routes' words, nothing made or counted; on again, it is listed (${JSON.stringify(keptWhileOff)}; ${errorText(eventAsEnterprise) || JSON.stringify(structured(eventAsEnterprise))} | ${errorText(listingAsEnterprise)})`);

        // ── 2c. "May post for me", and the owners' "Assistant posts a day" ───────────────────────────
        console.log('── 2c. "May post for me" is ticked or the assistant cannot post; "Assistant posts a day" is the owners\' ──');
        // The four per-kind check grants go first: a member holds at most 5 assistants.
        for (const g of kindGrants) await call('POST', `/api/local/admin/agent/grants/${encodeURIComponent(g)}/revoke`, { headers: asSession(ownerS), body: {} });
        const unticked = await call('POST', '/api/local/admin/agent/grants', { headers: asSession(ownerS), body: { name: 'Olive\'s reader' } });
        const uc = await connect(unticked.body?.token);
        const readerTools = (await uc.listTools()).tools.map(t => t.name);
        const readerCall = await uc.callTool({ name: 'create_offer', arguments: offerArgs });
        const readerInfo = structured(await uc.callTool({ name: 'connection_info', arguments: {} }));
        const ownInfo = structured(await client.callTool({ name: 'connection_info', arguments: {} }));
        assert(unticked.status === 201 && unticked.body?.grant?.canPost === false && readerTools.includes('take_backup')
            && !readerTools.some(t => t.startsWith('create_') || t === 'my_enterprises') && readerCall.isError === true && /no tool "create_offer"/.test(errorText(readerCall))
            && readerInfo?.canPost === false && readerInfo?.posts === undefined && ownInfo?.canPost === true && ownInfo?.posts?.perDay === 100,
            `a token made without "May post for me" lists no posting tool and is refused one; connection_info says which (${readerTools.length} tools; ${errorText(readerCall)})`);
        await uc.close().catch(() => {});
        const notTicked = await OWNER_POST_TOOLS.find(t => t.name === 'create_offer')!.run({ id: 'y', name: 'y', member: owner.pub, role: 'owner', via: 'token', createdAt: 0, expiresAt: null, canPost: false } as AgentGrant, offerArgs, 'b0b0b0b0');
        assert(!notTicked.ok && /without "May post for me"/.test(notTicked.ok ? '' : notTicked.error), `an owner's grant not ticked is refused by the tool itself (${notTicked.ok ? '' : notTicked.error})`);
        const listed = await call('GET', '/api/local/admin/agent/grants', { headers: asSession(ownerS) });
        const rowOf = (id: string) => (listed.body?.grants ?? []).find((g: any) => g.id === id);
        assert(rowOf(grantId)?.canPost === true && rowOf(unticked.body?.grant?.id)?.canPost === false && typeof rowOf(grantId)?.postsToday === 'number'
            && listed.body?.postsPerDay === 100 && listed.body?.postsPerDayMin === 1 && listed.body?.postsPerDayMax === 1000,
            `the list shows each assistant's tick and posts today, and "Assistant posts a day" (${listed.body?.postsPerDay}, ${listed.body?.postsPerDayMin}–${listed.body?.postsPerDayMax})`);

        // A ticked grant of its own for the day's count, so the door's 60 a minute holds for the rest.
        const capT = await call('POST', '/api/local/admin/agent/grants', { headers: asSession(ownerS), body: { name: 'Olive\'s seeder', canPost: true } });
        const capId: string = capT.body?.grant?.id;
        const cc = await connect(capT.body?.token);
        // Default 100: the 101st is refused.
        while (agentCreatesToday(capId) < 100) admitAgentCreate(capId);
        const hundredFirst = await cc.callTool({ name: 'create_offer', arguments: { ...offerArgs, title: 'One too many' } });
        assert(hundredFirst.isError === true && /made 100 posts today, the most a day this community's owners allow/.test(errorText(hundredFirst))
            && (db.prepare('SELECT COUNT(*) AS c FROM posts').get() as any).c === postsAfter, `by default the 101st post in a day → refused, nothing made (${errorText(hundredFirst)})`);
        // An owner sets 1,000 (Marty, 30 Oct: seeding the global node): it takes effect at once, and the 1,001st is refused.
        // As the second owner: the first has used their hour's security lines connecting and disconnecting (alerts.ts raiseBounded).
        const set1000 = await call('POST', '/api/local/admin/agent/posts-per-day', { headers: asSession(owner2S), body: { perDay: 1000 } });
        const after1000 = await cc.callTool({ name: 'create_offer', arguments: { ...offerArgs, title: 'Seeding day' } });
        const told = getAlertsStatus().history.filter(e => e.key === 'sec.agent').map(e => e.detail);
        assert(set1000.status === 200 && set1000.body?.postsPerDay === 1000 && !after1000.isError && structured(after1000)?.postsPerDay === 1000 && structured(after1000)?.postsToday === 101
            && told.some(d => /changed how many posts each owner's AI assistant may make a day, from 100 to 1,000/.test(d)),
            `an owner sets 1,000: the 101st is taken at once, and the owners are told (${set1000.status}; ${errorText(after1000) || structured(after1000)?.postsToday}; ${told.join(' | ')})`);
        while (agentCreatesToday(capId) < 1000) admitAgentCreate(capId);
        const thousandFirst = await cc.callTool({ name: 'create_offer', arguments: { ...offerArgs, title: 'Past a thousand' } });
        const info1000 = structured(await cc.callTool({ name: 'connection_info', arguments: {} }));
        const listed1000 = await call('GET', '/api/local/admin/agent/grants', { headers: asSession(owner2S) });
        assert(thousandFirst.isError === true && /made 1000 posts today/.test(errorText(thousandFirst)) && info1000?.posts?.perDay === 1000 && info1000?.posts?.today === 1000
            && listed1000.body?.postsPerDay === 1000, `set to 1,000, the 1,001st is refused; connection_info and the list say 1,000 (${errorText(thousandFirst)})`);
        // Back to 100: it holds at once, for a grant already past it.
        const set100 = await call('POST', '/api/local/admin/agent/posts-per-day', { headers: asSession(owner2S), body: { perDay: 100 } });
        const after100 = await cc.callTool({ name: 'create_offer', arguments: { ...offerArgs, title: 'Back to a hundred' } });
        const toldBack = getAlertsStatus().history.filter(e => e.key === 'sec.agent').map(e => e.detail);
        assert(set100.status === 200 && after100.isError === true && /made 100 posts today/.test(errorText(after100))
            && toldBack.some(d => /from 1,000 to 100/.test(d)), `set back to 100, the next post is refused at once (${errorText(after100)})`);
        await cc.close().catch(() => {});
        const outOfRange = await Promise.all([0, 1001, 1.5, '50', null].map(perDay => call('POST', '/api/local/admin/agent/posts-per-day', { headers: asSession(ownerS), body: { perDay } })));
        assert(outOfRange.every(r => r.status === 400 && /whole number from 1 to 1,000/.test(r.body?.error ?? '')),
            `0, 1,001, 1.5, a string or nothing → 400 in words (${outOfRange.map(r => r.status).join(', ')})`);
        grantNodeRole(keeper.pub, 'admin', 'SYSTEM');
        const keeperAdminS = await keySignIn(keeper);
        const byAdmin = await call('POST', '/api/local/admin/agent/posts-per-day', { headers: asSession(keeperAdminS), body: { perDay: 500 } });
        const byToken = await call('POST', '/api/local/admin/agent/posts-per-day', { headers: bearer(TOKEN), body: { perDay: 500 } });
        revokeNodeRole(keeper.pub, 'admin', owner.pub);
        assert(byAdmin.status === 403 && byToken.status >= 400 && byToken.status < 500 && (await call('GET', '/api/local/admin/agent/grants', { headers: asSession(ownerS) })).body?.postsPerDay === 100,
            `an admin, or a token, cannot change it (${byAdmin.status}, ${byToken.status})`);

        // ── 3. Who may, and the door ────────────────────────────────────────────────────────────────
        console.log('── 3. Only an owner\'s assistant; the door still decides ──');
        const ownerOnlyRun = OWNER_POST_TOOLS.find(t => t.name === 'create_offer')!;
        const asAdmin = await ownerOnlyRun.run({ id: 'x', name: 'x', member: owner2.pub, role: 'admin', via: 'token', createdAt: 0, expiresAt: null, canPost: true } as AgentGrant,
            { title: 'x', photos: [small] }, 'b0b0b0b0');
        assert(!asAdmin.ok && /Only an owner's assistant can post/.test(asAdmin.ok ? '' : asAdmin.error), 'a grant whose role is admin is refused by the tool itself, in words');
        const made2 = await call('POST', '/api/local/admin/agent/grants', { headers: asSession(owner2S), body: { name: 'Ottilie\'s assistant', canPost: true } });
        assert(made2.status === 201, `a second owner makes an agent token (${made2.status})`);
        grantNodeRole(owner2.pub, 'admin', 'SYSTEM');
        const c2 = await connect(made2.body.token);
        const adminTools = (await c2.listTools()).tools.map(t => t.name);
        const adminCall = await c2.callTool({ name: 'create_offer', arguments: { title: 'As an admin', category: 'food', photos: [small] } });
        assert(!adminTools.some(t => t.startsWith('create_') || t === 'my_enterprises') && adminCall.isError === true && /no tool "create_offer"/.test(errorText(adminCall)),
            `its maker now an admin, the assistant has no create tool, and calling one is refused (${adminTools.length} tools; ${errorText(adminCall)})`);
        const bigBody = JSON.stringify(rpc('tools/call', 9, { name: 'create_offer', arguments: { title: 'Big', photos: [await noisyJpeg(320, 240)] } }));
        assert(bigBody.length > 64 * 1024, `(a create with one photo is over 64 KiB: ${bigBody.length} bytes)`);
        const adminBig = await call('POST', '/mcp', { raw: bigBody, headers: { ...bearer(made2.body.token), ...MCP_HEADERS } });
        const anonBig = await call('POST', '/mcp', { raw: bigBody, headers: MCP_HEADERS });
        assert(adminBig.status === 413 && anonBig.status === 413, `a body over 64 KiB from an admin's assistant or from nobody → 413, unread (${adminBig.status}, ${anonBig.status})`);
        await c2.close();
        revokeNodeRole(owner2.pub, 'admin', owner.pub);
        const asMember = await call('POST', '/mcp', { body: rpc('tools/call', 3, { name: 'create_offer', arguments: { title: 'As a member', photos: [small] } }), headers: { ...bearer(made2.body.token), ...MCP_HEADERS } });
        assert(asMember.status === 401, `its maker now a member: 401 at the door (${show(asMember)})`);

        const off = await call('POST', '/api/local/admin/agent/switch', { headers: asSession(ownerS), body: { allowed: false } });
        const whileOff = await call('POST', '/mcp', { body: rpc('tools/call', 4, { name: 'create_offer', arguments: { title: 'While off', photos: [small] } }), headers: { ...bearer(TOKEN), ...MCP_HEADERS } });
        assert(off.status === 200 && whileOff.status === 404, `the owner switch off → 404 (${off.status}, ${whileOff.status})`);
        const on = await call('POST', '/api/local/admin/agent/switch', { headers: asSession(ownerS), body: { allowed: true } });
        assert(on.status === 200, `turned on again (${on.status})`);
        const revoked = await call('POST', `/api/local/admin/agent/grants/${encodeURIComponent(grantId)}/revoke`, { headers: asSession(ownerS), body: {} });
        const afterRevoke = await call('POST', '/mcp', { body: rpc('tools/call', 5, { name: 'create_offer', arguments: { title: 'After revoke', photos: [small] } }), headers: { ...bearer(TOKEN), ...MCP_HEADERS } });
        assert(revoked.status === 200 && afterRevoke.status === 401, `the grant revoked → 401 (${revoked.status}, ${afterRevoke.status})`);
        const stays = db.prepare('SELECT status FROM posts WHERE id = ?').get(o?.postId) as any;
        assert(stays?.status === 'active', 'the posts it made stay');
        await client.close().catch(() => {});

        // ── 4. No Bean moved ────────────────────────────────────────────────────────────────────────
        const auditAfter = runLedgerAudit();
        assert(auditAfter.ok === auditBefore.ok && auditAfter.sumBalances === auditBefore.sumBalances && auditAfter.drift === auditBefore.drift
            && auditAfter.strandedEscrows === auditBefore.strandedEscrows, `the ledger audit is the same after as before (${JSON.stringify(auditBefore)} → ${JSON.stringify(auditAfter)})`);
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
