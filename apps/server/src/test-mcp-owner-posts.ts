/**
 * MCP-OWNER-POSTS (Marty, 30 Oct): an owner's AI assistant posts Offers, Needs, events and enterprise listings itself through
 * /mcp (agent/owner-posts.ts). End to end with the official TypeScript MCP SDK client over REAL HTTPS through the real Koa
 * middleware; nothing here contacts anything but the server it starts.
 *
 *   1. An owner's assistant makes each kind: the row (its author, `created_via = 'assistant:<grant id>'`), its photo stored at
 *      most 800 px whatever size it was sent, the search index finds it, the listings' version moves (the phones' sync mark),
 *      the standby copy's payload carries created_via, the AGENT log names the post, and the answer carries no key.
 *   2. Refusals in words, none counted against the day: no photo, a PNG, a photo over the per-photo cap, an enterprise the owner
 *      does not keep (or a made-up ref), the 51st post in a UTC day.
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
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, runLedgerAudit, getPosts, getPostsVersion, exportSyncState } from './state-engine.js';
import { updateLocalConfig, getLocalConfig } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { grantNodeRole, revokeNodeRole } from './engine/node-roles.js';
import { db } from './db/db.js';
import { getImageStore, readObject } from './storage/image-store.js';
import { imageSize } from './storage/image-metadata.js';
import { admitAgentCreate, agentCreatesToday, AGENT_CREATES_PER_DAY } from './agent/limits.js';
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
        const made = await call('POST', '/api/local/admin/agent/grants', { headers: asSession(ownerS), body: { name: 'Olive\'s Claude' } });
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
        const offer = await client.callTool({ name: 'create_offer', arguments: {
            title: 'Quincefield sourdough loaves', description: 'Baked Saturday morning, collect from the hall.', category: 'food', beans: 6, photos: [big, small],
        } });
        const o = structured(offer);
        assert(!offer.isError && typeof o?.postId === 'string' && o.kind === 'offer' && o.asEnterprise === false && o.link === `/?post=${encodeURIComponent(o.postId)}`
            && o.postsToday === 1 && o.postsPerDay === AGENT_CREATES_PER_DAY, `create_offer posts an Offer and answers its id, its link and the day's count (${JSON.stringify(o ?? offer.content)})`);
        const row = db.prepare('SELECT author_pubkey, created_by, created_via, type, status, updated_at, title FROM posts WHERE id = ?').get(o?.postId) as any;
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

        const need = await client.callTool({ name: 'create_need', arguments: { title: 'Someone to mend a fence', category: 'trades', photos: [small] } });
        const n = structured(need);
        assert(!need.isError && n?.kind === 'need' && (db.prepare('SELECT author_pubkey, created_via FROM posts WHERE id = ?').get(n?.postId) as any)?.created_via === `assistant:${grantId}`,
            `create_need posts a Need as the owner (${JSON.stringify(n ?? need.content)})`);

        const startAt = new Date(Date.now() + 7 * DAY).toISOString();
        const event = await client.callTool({ name: 'create_event', arguments: {
            title: 'Seed swap at the hall', description: 'Bring seeds, take seeds.', start_at: startAt, end_at: new Date(Date.now() + 7 * DAY + 2 * 3600_000).toISOString(),
            place_name: 'The hall', lat: -28.55, lng: 153.5, photos: [small],
        } });
        const e = structured(event);
        const eRow = db.prepare('SELECT type, author_pubkey, created_via, event_start_at FROM posts WHERE id = ?').get(e?.postId) as any;
        assert(!event.isError && e?.kind === 'event' && eRow?.type === 'event' && eRow.author_pubkey === owner.pub && eRow.created_via === `assistant:${grantId}`
            && Date.parse(eRow.event_start_at) === Date.parse(startAt), `create_event posts an event as the owner (${JSON.stringify(e ?? event.content)})`);

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
        const noPhoto = await client.callTool({ name: 'create_offer', arguments: { title: 'No photo here', category: 'food' } });
        const emptyPhotos = await client.callTool({ name: 'create_need', arguments: { title: 'No photo either', category: 'food', photos: [] } });
        assert(noPhoto.isError === true && /Add a photo first/.test(errorText(noPhoto)) && emptyPhotos.isError === true && /Add a photo first/.test(errorText(emptyPhotos)),
            `no photo → refused in words (${errorText(noPhoto)})`);
        const png = `data:image/png;base64,${(await sharp({ create: { width: 64, height: 64, channels: 3, background: '#fff' } }).png().toBuffer()).toString('base64')}`;
        const asPng = await client.callTool({ name: 'create_offer', arguments: { title: 'A PNG', category: 'food', photos: [png] } });
        assert(asPng.isError === true && /JPEG or WebP/.test(errorText(asPng)), `a PNG → refused: JPEG or WebP (${errorText(asPng)})`);
        const huge = `data:image/jpeg;base64,${'A'.repeat(600_001)}`;
        const tooBig = await client.callTool({ name: 'create_offer', arguments: { title: 'Too big', category: 'food', photos: [huge] } });
        assert(tooBig.isError === true && /too large/.test(errorText(tooBig)), `a photo over the per-photo cap → refused (${errorText(tooBig)})`);
        const otherRef = await client.callTool({ name: 'create_enterprise_listing', arguments: { kind: 'offer', as_enterprise: enterpriseRef(notOurs), title: 'Not ours', category: 'tools', photos: [small] } });
        const madeUp = await client.callTool({ name: 'create_event', arguments: { title: 'As nobody', start_at: startAt, lat: -28.55, lng: 153.5, as_enterprise: 'ffffffffffffffff', photos: [small] } });
        assert(otherRef.isError === true && /not an enterprise you keep/.test(errorText(otherRef)) && madeUp.isError === true && /not an enterprise you keep/.test(errorText(madeUp)),
            `an enterprise the owner does not keep, or a made-up ref → refused (${errorText(otherRef)})`);
        const engineRefusal = await client.callTool({ name: 'create_event', arguments: { title: 'In the past', start_at: new Date(Date.now() - DAY).toISOString(), lat: -28.55, lng: 153.5, photos: [small] } });
        assert(engineRefusal.isError === true && /future/.test(errorText(engineRefusal)), `the engine's own rules answer, in its words (${errorText(engineRefusal)})`);
        const postsAfter = (db.prepare('SELECT COUNT(*) AS c FROM posts').get() as any).c;
        assert(agentCreatesToday(grantId) === countBefore && postsAfter === postsBefore, `no refused call made a post or counted against the day (${countBefore} → ${agentCreatesToday(grantId)})`);

        while (agentCreatesToday(grantId) < AGENT_CREATES_PER_DAY) admitAgentCreate(grantId);
        const fiftyFirst = await client.callTool({ name: 'create_offer', arguments: { title: 'One too many', category: 'food', photos: [small] } });
        assert(fiftyFirst.isError === true && new RegExp(`${AGENT_CREATES_PER_DAY} posts today`).test(errorText(fiftyFirst))
            && (db.prepare('SELECT COUNT(*) AS c FROM posts').get() as any).c === postsAfter, `the ${AGENT_CREATES_PER_DAY + 1}st post in a day → refused, nothing made (${errorText(fiftyFirst)})`);

        // ── 3. Who may, and the door ────────────────────────────────────────────────────────────────
        console.log('── 3. Only an owner\'s assistant; the door still decides ──');
        const ownerOnlyRun = OWNER_POST_TOOLS.find(t => t.name === 'create_offer')!;
        const asAdmin = await ownerOnlyRun.run({ id: 'x', name: 'x', member: owner2.pub, role: 'admin', via: 'token', createdAt: 0, expiresAt: null } as AgentGrant,
            { title: 'x', photos: [small] }, 'b0b0b0b0');
        assert(!asAdmin.ok && /Only an owner's assistant can post/.test(asAdmin.ok ? '' : asAdmin.error), 'a grant whose role is admin is refused by the tool itself, in words');
        const made2 = await call('POST', '/api/local/admin/agent/grants', { headers: asSession(owner2S), body: { name: 'Ottilie\'s assistant' } });
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
