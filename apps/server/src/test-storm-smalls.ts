/**
 * The security storm's smaller server items (scratch/reviews/SECURITY-STORM-2026-10-01.md, queue additions 9 and 10, and
 * queue item 9's crypto F3), over REAL HTTPS through the real signature middleware wherever a route is involved:
 *
 *  1. zip215 (FABLE-sec-crypto F3): a signature whose R is the identity point in a non-canonical encoding passes noble's
 *     default (ZIP-215) check and no strict one. The identity-epoch statement check, the registrar name watch's
 *     attestation check and the phone's push-notice check refuse it, and still take a real signature; and every
 *     noble verifier in the server, the vault and the packages names `zip215: false`.
 *  2. LIKE (FABLE-sec-sql LOW): `%` and `_` in a search are those characters, not wildcards: the pricing guide (a
 *     visitor's read) and the groups list. `?q=a&q=b` is answered, not thrown on.
 *  3. Admin thresholds (FABLE-sec-input LOW F3): a negative, an Infinity (`1e999`), a fraction of a day is refused 400
 *     and nothing is saved; a value in range is saved; a bad value already in the config reads as its default.
 *  4. TOTP (FABLE-sec-races LOW-1): a code signs in once. The same code again, at the password sign-in and inline on an
 *     admin route, is refused; the next step's code works once; an earlier step's after it is refused.
 *  5. Conversations (FABLE-sec-events-chat F2): a pruned enterprise's discussion can't be read by its id; a group chat's
 *     read hands no one else's read cursor (nor the enterprise thread's own route); a DM keeps both, its read ticks.
 *  6. Error text (FABLE-sec-errors M3, L1): a member route whose database call fails answers its own words, not the
 *     database's; the net under every member route turns a server fault's text into fixed words, 500, and leaves the
 *     operator's routes their detail; a refused address names no address.
 *  7. The retired fleet manager's /api/manager/backups routes are gone: the password gets nothing there.
 *
 * Already fixed on main before this suite (no check here, evidence in the PR): a Decision removing an admin (#1394),
 * escrow pushes carrying the amount (#1398, every push is fixed words per kind).
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-storm-smalls.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_READ_AUTH;
const PW = 'StormSmallsPass123!';
process.env.ADMIN_PASSWORD = PW;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import Koa from 'koa';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519.js';
import { pushNoticeBytes, pushCommunityTag, verifyPushNotice, PUSH_NOTICE_VERSION } from '@beanpool/core';
import { initTls } from './services/tls.js';
import {
    initStateEngine, seedGenesisMember, createGroup, joinGroup, createTreasury, ensureEnterpriseThread,
    postEnterpriseThreadMessage,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword, getLocalConfig, updateLocalConfig } from './config/local-config.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { resetPasswordBrake } from './password-brake.js';
import { ownerTokenHeaders } from './admin-auth-test-harness.js';
import { generateTotpSecret, generateTotpCode } from './totp.js';
import { savePricingGuideItem } from './db/pricing-guide-db.js';
import { verifyEpochStatement } from './services/identity-epoch.js';
import { attestMessage } from './services/registrar-client.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

let BASE = '';

// ── members and signed requests ─────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
let owner: Id;
function member(name: string): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_visitor)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'TEST', 'active', 0)`).run(id.pk, name, owner.pk);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    return id;
}

interface Res { status: number; body: any; text: string }
async function call(method: 'GET' | 'POST', id: Id | null, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : typeof body === 'string' ? body : JSON.stringify(body ?? {});
    const h: Record<string, string> = method === 'GET' ? { ...headers } : { 'Content-Type': 'application/json', ...headers };
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        h['X-Public-Key'] = id.pk;
        h['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${route.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        h['X-Timestamp'] = String(ts);
        h['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${route}`, { method, headers: h, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, text };
}
const show = (r: Res) => `${r.status} ${r.text.slice(0, 160)}`;

// ── a signature only ZIP-215 takes ──────────────────────────────────────────────────────────────
// R is the identity point encoded with y = p + 1 (non-canonical: RFC 8032 refuses any y >= p). With R = O the equation
// [8][S]B = [8]R + [8][k]A holds for S = k·a, k = H(enc(R) || A || M) over R's canonical encoding (noble re-encodes R).
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const leToBig = (b: Uint8Array) => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };
const bigToLe32 = (v: bigint) => { const out = new Uint8Array(32); let n = v; for (let i = 0; i < 32; i++) { out[i] = Number(n & 0xffn); n >>= 8n; } return out; };
function zip215OnlySignature(message: Uint8Array, seed: Uint8Array): Uint8Array {
    const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(seed);
    const canonicalIdentity = new Uint8Array(32); canonicalIdentity[0] = 1;
    const nonCanonicalIdentity = new Uint8Array(32).fill(0xff); nonCanonicalIdentity[0] = 0xee; nonCanonicalIdentity[31] = 0x7f;
    const k = leToBig(crypto.createHash('sha512').update(Buffer.concat([canonicalIdentity, pointBytes, message])).digest()) % L;
    return new Uint8Array([...nonCanonicalIdentity, ...bigToLe32((k * scalar) % L)]);
}

async function zip215(): Promise<void> {
    console.log('\n── 1. zip215: strict RFC 8032 everywhere ──');
    const seed = crypto.randomBytes(32);
    const msg = new TextEncoder().encode('storm-smalls');
    const forged = zip215OnlySignature(msg, seed);
    const pub = ed25519.getPublicKey(seed);
    assert(ed25519.verify(forged, msg, pub) && !ed25519.verify(forged, msg, pub, { zip215: false }),
        'control: the crafted signature passes noble\'s default (ZIP-215) check and not the strict one');

    // The identity-epoch statement: "is this signed by OUR node key?"
    const identity = { seed: new Uint8Array(seed), peerId: '12D3KooWStormSmallsPeer' };
    const statement = { v: 1 as const, peerId: identity.peerId, communityId: null, epoch: 3, since: null };
    const bytes = new TextEncoder().encode('beanpool-identity-epoch-v1\n' + JSON.stringify(statement));
    const real = verifyEpochStatement({ statement, sig: Buffer.from(ed25519.sign(bytes, seed)).toString('base64') }, identity as any);
    assert(real.ok, `identity epoch: a real signature by the node key is taken (${JSON.stringify(real)})`);
    const lax = verifyEpochStatement({ statement, sig: Buffer.from(zip215OnlySignature(bytes, seed)).toString('base64') }, identity as any);
    assert(!lax.ok, `identity epoch: the ZIP-215-only signature is refused (${JSON.stringify(lax)})`);

    // The registrar name watch's attestation check (exported for this check).
    const watch: any = await import('./services/registrar-name-watch.js');
    const attestationOf = watch.attestationOf as ((body: unknown, nonce: string) => { pubkey: string; valid: boolean } | null) | undefined;
    const nonce = crypto.randomBytes(16).toString('hex');
    const ts = Date.now();
    const att = new TextEncoder().encode(attestMessage('v1', nonce, ts));
    const pubHex = Buffer.from(pub).toString('hex');
    const goodAtt = attestationOf?.({ pubkey: pubHex, nonce, timestamp: ts, proto: 'v1', signature: Buffer.from(ed25519.sign(att, seed)).toString('hex') }, nonce);
    assert(goodAtt?.valid === true, `name watch: a real attestation is valid (${JSON.stringify(goodAtt)})`);
    const laxAtt = attestationOf?.({ pubkey: pubHex, nonce, timestamp: ts, proto: 'v1', signature: Buffer.from(zip215OnlySignature(att, seed)).toString('hex') }, nonce);
    assert(laxAtt?.valid === false, `name watch: the ZIP-215-only attestation is not valid (${JSON.stringify(laxAtt)})`);

    // The phone's push-notice check (@beanpool/core).
    const recipient = crypto.randomBytes(32).toString('hex');
    const fields = { c: pushCommunityTag(pubHex), k: 'trade.update' as const, i: crypto.randomBytes(16).toString('hex'), t: Math.floor(Date.now() / 1000) };
    const noticeBytes = pushNoticeBytes(fields, recipient);
    const goodNotice = verifyPushNotice({ bp: PUSH_NOTICE_VERSION, ...fields, s: Buffer.from(ed25519.sign(noticeBytes, seed)).toString('hex') }, { recipient, pushKey: pubHex });
    assert(goodNotice.ok, `push notice: a real signature is taken (${JSON.stringify(goodNotice)})`);
    const laxNotice = verifyPushNotice({ bp: PUSH_NOTICE_VERSION, ...fields, s: Buffer.from(zip215OnlySignature(noticeBytes, seed)).toString('hex') }, { recipient, pushKey: pubHex });
    assert(!laxNotice.ok && (laxNotice as any).reason === 'bad-signature', `push notice: the ZIP-215-only signature is refused (${JSON.stringify(laxNotice)})`);

    // Every noble verifier in the code that ships: strict, so a later one copied from any of them is strict too.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repo = path.resolve(here, '../../..');
    const lax2: string[] = [];
    let seen = 0;
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { if (!['node_modules', 'dist', '__tests__'].includes(e.name)) walk(p); continue; }
            if (!/\.tsx?$/.test(e.name) || /^test-|\.test\.tsx?$/.test(e.name)) continue;
            const lines = fs.readFileSync(p, 'utf8').split('\n');
            lines.forEach((line, i) => {
                if (!/ed25519\.verify\(/.test(line)) return;
                seen++;
                // The call can run onto the next line; its options end it.
                if (!/zip215:\s*false/.test(line + (lines[i + 1] ?? ''))) lax2.push(`${path.relative(repo, p)}:${i + 1}`);
            });
        }
    };
    for (const d of ['apps/server/src', 'apps/vault/src', 'packages/beanpool-core/src', 'packages/beanpool-engine/src', 'packages/beanpool-signin/src', 'apps/native/utils']) {
        if (fs.existsSync(path.join(repo, d))) walk(path.join(repo, d));
    }
    assert(seen >= 8 && lax2.length === 0, `every one of the ${seen} noble verifiers that ships names zip215: false${lax2.length ? ` — not: ${lax2.join(', ')}` : ''}`);
}

async function likeWildcards(ann: Id): Promise<void> {
    console.log('\n── 2. LIKE: a % or _ someone types is that character ──');
    savePricingGuideItem({ category: 'food', emoji: '🍞', name: 'Sourdough 50% rye', description: 'a loaf', priceBeans: 8 });
    savePricingGuideItem({ category: 'food', emoji: '🥖', name: 'Plain loaf', description: 'white', priceBeans: 5 });
    const all = await call('GET', null, '/api/pricing-guide');
    const total = all.body?.items?.length ?? 0;
    const pct = await call('GET', null, '/api/pricing-guide?q=%25');
    const pctItems: any[] = pct.body?.items ?? [];
    assert(pct.status === 200 && total > 2 && pctItems.length >= 1 && pctItems.length < total
        && pctItems.every(i => `${i.name} ${i.description}`.includes('%')),
        `pricing guide: q=% finds only what holds a "%" (${pctItems.length} of ${total})`);
    const under = await call('GET', null, '/api/pricing-guide?q=_');
    const underItems: any[] = under.body?.items ?? [];
    assert(under.status === 200 && underItems.every(i => `${i.name} ${i.description}`.includes('_')) && underItems.length < total,
        `pricing guide: q=_ finds only what holds a "_" (${underItems.length} of ${total})`);
    const word = await call('GET', null, '/api/pricing-guide?q=50%25%20rye');
    assert(word.body?.items?.some((i: any) => i.name === 'Sourdough 50% rye'), 'pricing guide: a search with a % in it still finds the item');
    const twice = await call('GET', null, '/api/pricing-guide?q=loaf&q=rye');
    assert(twice.status === 200, `pricing guide: ?q=a&q=b is answered, not thrown on (${twice.status})`);

    createGroup({ name: 'Garden 100%', description: 'veg', createdBy: ann.pk, joinPolicy: 'open' } as any);
    createGroup({ name: 'Knitting circle', description: 'wool', createdBy: ann.pk, joinPolicy: 'open' } as any);
    const groups = await call('GET', ann, '/api/groups?q=%25');
    const names: string[] = (Array.isArray(groups.body) ? groups.body : groups.body?.groups ?? []).map((g: any) => g.name);
    assert(groups.status === 200 && names.includes('Garden 100%') && !names.includes('Knitting circle'),
        `groups: q=% lists only the group with a "%" in it (${JSON.stringify(names)})`);
    const gTwice = await call('GET', ann, '/api/groups?q=a&q=b');
    assert(gTwice.status === 200, `groups: ?q=a&q=b is answered, not thrown on (${gTwice.status})`);
}

async function thresholds(): Promise<void> {
    console.log('\n── 3. Admin thresholds: finite, in range ──');
    resetAdminAuthTarpit();
    const before = getLocalConfig().thresholds?.inactiveMemberDays;
    // Step 7c: the password alone opens no admin route with 2FA off: these go under an owner's automation token.
    const admin = ownerTokenHeaders('admin');
    const post = (raw: string) => call('POST', null, '/api/admin/thresholds', raw, admin);
    for (const [what, raw] of [
        ['a negative number of days', `{"inactiveMemberDays":-5}`],
        ['Infinity (1e999)', `{"inactiveMemberDays":1e999}`],
        ['half a day', `{"inactiveMemberDays":7.5}`],
        ['a rate over 1', `{"circulationRate":3}`],
    ] as const) {
        const r = await post(raw);
        assert(r.status === 400 && typeof r.body?.error === 'string' && getLocalConfig().thresholds?.inactiveMemberDays === before
            && getLocalConfig().thresholds?.circulationRate !== 3,
            `${what} is refused, 400, and nothing saved (${show(r)})`);
    }
    const ok = await post(`{"inactiveMemberDays":45,"circulationRate":0.01}`);
    assert(ok.status === 200 && ok.body?.thresholds?.inactiveMemberDays === 45 && getLocalConfig().thresholds?.inactiveMemberDays === 45,
        `a value in range is saved (${show(ok)})`);
    const skipped = await post(`{"inactiveMemberDays":null}`);
    assert(skipped.status === 200 && skipped.body?.thresholds?.inactiveMemberDays === 45, `an emptied field (null) is left out, as before (${show(skipped)})`);

    // What a config file holds after an Infinity was saved before the limits: `null`. And a negative.
    updateLocalConfig({ thresholds: { ...(getLocalConfig().thresholds as any), inactiveMemberDays: null, sybilFunnelWindowDays: -3 } } as any);
    const got = await call('POST', null, '/api/admin/thresholds/get', {}, admin);
    assert(got.status === 200 && got.body?.thresholds?.inactiveMemberDays === 30 && got.body?.thresholds?.sybilFunnelWindowDays === 30,
        `a bad value already saved reads as its default (${JSON.stringify({ inactive: got.body?.thresholds?.inactiveMemberDays, window: got.body?.thresholds?.sybilFunnelWindowDays })})`);
}

async function totpOnce(): Promise<void> {
    console.log('\n── 4. TOTP: a code works once ──');
    const secret = generateTotpSecret();
    updateLocalConfig({ totpEnabled: true, totpSecret: secret } as any);
    const fresh = () => { resetAdminAuthTarpit(); resetPasswordBrake(); };

    fresh();
    const code = generateTotpCode(secret);
    const first = await call('POST', null, '/api/local/verify-password', { password: PW, totpCode: code });
    assert(first.status === 200 && first.body?.success === true, `the password and a current code sign in (${show(first)})`);
    fresh();
    const again = await call('POST', null, '/api/local/verify-password', { password: PW, totpCode: code });
    assert(again.status === 401 && again.body?.totpRequired === true && /already used/.test(again.body?.error ?? ''),
        `the same code again is refused, saying so (${show(again)})`);
    fresh();
    const inline = await call('POST', null, '/api/admin/thresholds/get', {}, { 'X-Admin-Password': PW, 'X-Admin-TOTP': code });
    assert(inline.status === 401 && inline.body?.thresholds === undefined, `…and inline on an admin route (${show(inline)})`);
    fresh();
    const next = generateTotpCode(secret, 1);
    const nextOk = await call('POST', null, '/api/admin/thresholds/get', {}, { 'X-Admin-Password': PW, 'X-Admin-TOTP': next });
    assert(nextOk.status === 200 && nextOk.body?.thresholds !== undefined, `the next step's code works (${nextOk.status})`);
    fresh();
    const nextAgain = await call('POST', null, '/api/local/verify-password', { password: PW, totpCode: next });
    assert(nextAgain.status === 401, `…once (${show(nextAgain)})`);
    fresh();
    const earlier = await call('POST', null, '/api/local/verify-password', { password: PW, totpCode: generateTotpCode(secret, -1) });
    assert(earlier.status === 401, `and a code for a step before the one accepted is refused too (${show(earlier)})`);
    updateLocalConfig({ totpEnabled: false, totpSecret: null } as any);
    fresh();
}

async function conversations(ann: Id, bo: Id): Promise<void> {
    console.log('\n── 5. Conversations: a gone enterprise\'s thread, and read cursors ──');
    const { publicKey: bakery } = createTreasury('Bakery', 'data:image/png;base64,iVBORw0KGgo=', 100, { leadKeeperPubkey: ann.pk } as any) as any;
    ensureEnterpriseThread(bakery);
    postEnterpriseThreadMessage(bakery, bo.pk, 'Who has the flour?');
    const live = await call('GET', bo, `/api/messages/${bakery}`);
    assert(live.status === 200 && (live.body?.messages ?? []).length === 1, `a live enterprise's thread reads by its id (${show(live)})`);
    const viaRoute = await call('GET', bo, `/api/treasury/${bakery}/thread`);
    assert(viaRoute.status === 200 && viaRoute.body?.conversation?.readCursors === undefined,
        `its own route hands no read cursors (${JSON.stringify(viaRoute.body?.conversation?.readCursors)})`);
    for (const status of ['pruned', 'deleted']) {
        db.prepare('UPDATE members SET status = ? WHERE public_key = ?').run(status, bakery);
        const own = await call('GET', bo, `/api/treasury/${bakery}/thread`);
        const byId = await call('GET', bo, `/api/messages/${bakery}`);
        assert(own.status === 404 && byId.status === 404 && byId.body?.messages === undefined,
            `a ${status} enterprise's thread is gone by its id as on its own route (${own.status}; ${show(byId)})`);
    }

    const group = createGroup({ name: 'Choir', description: 'singing', createdBy: ann.pk, joinPolicy: 'open' } as any) as any;
    joinGroup(group.id, bo.pk);
    await call('POST', bo, '/api/messages/mark-read', { conversationId: group.id });
    const g = await call('GET', ann, `/api/messages/${group.id}`);
    const cursors: any[] | undefined = g.body?.conversation?.readCursors;
    assert(g.status === 200 && !(cursors ?? []).some(c => c.publicKey === bo.pk),
        `a group chat's read hands Ann no read cursor of Bo's (${JSON.stringify(cursors?.map(c => c.publicKey.slice(0, 6)))})`);

    const dm = await call('POST', ann, '/api/messages/conversation', { type: 'dm', participants: [ann.pk, bo.pk], createdBy: ann.pk });
    const dmId: string = dm.body?.conversation?.id;
    const d = await call('GET', ann, `/api/messages/${dmId}`);
    const dmCursors: any[] = d.body?.conversation?.readCursors ?? [];
    assert(d.status === 200 && dmCursors.length === 2 && dmCursors.some(c => c.publicKey === bo.pk),
        `a DM keeps both read cursors, its read ticks (${dmCursors.length})`);
}

async function errorText(ann: Id): Promise<void> {
    console.log('\n── 6. Error text: the member is told in their words, never the database\'s ──');
    // A database failure under a member route: the table a group create writes is gone.
    db.exec('ALTER TABLE groups RENAME TO groups_gone_for_this_check');
    let made: Res;
    try {
        made = await call('POST', ann, '/api/groups', { name: 'Never made', description: 'x', joinPolicy: 'open' });
    } finally {
        db.exec('ALTER TABLE groups_gone_for_this_check RENAME TO groups');
    }
    assert(made.status >= 400 && !/no such table|groups_gone|SQLITE/i.test(made.text) && typeof made.body?.error === 'string',
        `a group create whose database call fails answers in its own words (${show(made)})`);

    // A refused address names no address (the guard's own message names the private address the name resolved to).
    for (const url of ['http://10.0.0.1/internal', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/']) {
        const r = await call('POST', ann, '/api/member/pulse/preview', { url });
        const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
        assert(r.status === 400 && r.body?.error === 'ssrf_blocked' && !r.text.includes(host),
            `a refused address (${url}) is refused without naming it (${show(r)})`);
    }

    // The public thumbnail route (a visitor, no signature) over the real HTTPS server: a pulse item whose thumbnail URL
    // is a private address, IPv4 or IPv6, is refused in fixed words naming no address.
    const chan = 'chan_' + crypto.randomBytes(6).toString('hex');
    db.prepare(`INSERT INTO creator_channels (id, owner_pubkey, platform, url, category, created_at, updated_at)
        VALUES (?, ?, 'rss', 'https://blog.example.org/feed', 'art', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(chan, ann.pk);
    const addThumbItem = (url: string): string => {
        const id = 'item_' + crypto.randomBytes(8).toString('hex');
        db.prepare(`INSERT INTO pulse_items (id, channel_id, owner_pubkey, platform, url, external_id, title, thumbnail_url, category, source, created_at, updated_at)
            VALUES (?, ?, ?, 'rss', 'https://blog.example.org/a-post', NULL, 'A post', ?, 'art', 'autolist', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(id, chan, ann.pk, url);
        return id;
    };
    const thumbCases: Array<[string, RegExp]> = [
        ['http://10.1.2.3/x.png', /10\.1\.2\.3/],
        ['http://[fd12:3456:789a::1]/x.png', /fd12|3456|789a|ULA|RFC/i],
        ['http://[fe80::1]/x.png', /fe80|link-local|RFC/i],
    ];
    let firstThumbItem = '';
    for (const [url, leak] of thumbCases) {
        const id = addThumbItem(url);
        firstThumbItem ||= id;
        const r = await call('GET', null, `/api/pulse/items/${id}/thumbnail`);
        assert(r.status >= 400 && typeof r.body?.error === 'string' && !leak.test(r.text) && !/RFC|blocked|Resolved/i.test(r.text),
            `the public thumbnail route refuses ${url} without naming an address (${show(r)})`);
        const again = await call('GET', null, `/api/pulse/items/${id}/thumbnail`);
        assert(again.status >= 400 && !leak.test(again.text) && !/RFC|blocked|Resolved/i.test(again.text),
            `and so does its cached refusal (${show(again)})`);
    }
    // The net as the node mounts it (https-server.ts app.use(scrubServerFaults())): a persisted backoff row written by an
    // older build holds the guard's own text with the address in it; the route serves it back, and only the net keeps it in.
    const oldRow = addThumbItem('http://10.1.2.3/x.png');
    db.prepare(`INSERT INTO pulse_thumbnail_backoff (item_id, thumbnail_url, failure_count, status, error, last_failed_at, retry_after)
        VALUES (?, 'http://10.1.2.3/x.png', 1, 400, ?, ?, ?)`).run(
        oldRow, 'SSRF_BLOCKED: Resolved IP 10.1.2.3 is blocked (Private-Use RFC 1918 (10.0.0.0/8))',
        new Date().toISOString(), new Date(Date.now() + 3600_000).toISOString());
    {
        const r = await call('GET', null, `/api/pulse/items/${oldRow}/thumbnail`);
        assert(r.status === 500 && !r.text.includes('10.1.2.3') && r.text.includes('Something went wrong on the server'),
            `net, as mounted on the real server: a stored refusal that names 10.1.2.3 is answered in fixed words, 500 (${show(r)})`);
    }

    // The net under every member route: a server fault's text from anywhere becomes fixed words, 500; the operator's
    // routes keep theirs. Over HTTP, on a Koa app with the very middleware the node mounts first.
    const mod: any = await import('./routes/member-error-text.js').catch(() => null);
    if (!mod?.scrubServerFaults) {
        assert(false, 'the server-fault net exists (routes/member-error-text.ts scrubServerFaults)');
        return;
    }
    const app = new Koa();
    app.use(mod.scrubServerFaults());
    app.use(async (ctx) => {
        if (ctx.path.endsWith('/refusal')) { ctx.status = 400; ctx.body = { error: 'Group not found' }; return; }
        if (ctx.path.endsWith('/network')) { ctx.status = 502; ctx.body = { error: 'bad', message: 'connect ECONNREFUSED 10.1.2.3:443' }; return; }
        ctx.status = 400;
        ctx.body = { error: 'SQLITE_CONSTRAINT: UNIQUE constraint failed: groups.slug' };
    });
    const server = http.createServer(app.callback()).listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', () => r()));
    const at = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
        const get = async (p: string) => { const r = await fetch(at + p); return { status: r.status, text: await r.text() }; };
        const sql = await get('/api/groups/x');
        assert(sql.status === 500 && !/SQLITE|constraint|groups\.slug/.test(sql.text) && sql.text.includes(mod.SERVER_FAULT_TEXT),
            `net: a member route answering the database's text answers fixed words, 500 (${sql.status} ${sql.text})`);
        const net = await get('/api/member/x/network');
        assert(net.status === 500 && !net.text.includes('10.1.2.3') && !net.text.includes('ECONNREFUSED'),
            `net: and a network error's address (${net.status} ${net.text})`);
        const refusal = await get('/api/groups/refusal');
        assert(refusal.status === 400 && refusal.text.includes('Group not found'), `net: a refusal meant for the member is untouched (${refusal.text})`);
        const operator = await get('/api/local/admin/x');
        assert(operator.status === 400 && operator.text.includes('groups.slug'), `net: the operator's route keeps its detail (${operator.text})`);
    } finally {
        server.close();
    }
    assert(mod.isServerFault(new TypeError("Cannot read properties of undefined (reading 'x')")) && !mod.isServerFault(new Error('Group not found'))
        && mod.memberErrorText(Object.assign(new Error('UNIQUE constraint failed: members.callsign'), { code: 'SQLITE_CONSTRAINT_UNIQUE' }), 'Could not join') === 'Could not join'
        && mod.memberErrorText(new Error('Only a convenor can do that'), 'x') === 'Only a convenor can do that',
        'memberErrorText: a refusal keeps its words; the database\'s and a bug\'s get the route\'s own');
}

async function managerBackupsGone(): Promise<void> {
    console.log('\n── 7. The fleet manager\'s backup routes are gone ──');
    resetAdminAuthTarpit();
    const status = await call('GET', null, '/api/manager/backups/status', undefined, { 'X-Admin-Password': PW });
    assert(status.status >= 400 && status.status < 500 && status.body?.nodes === undefined, `GET status: nothing there for the password (${show(status)})`);
    resetAdminAuthTarpit();
    const trigger = await call('POST', null, '/api/manager/backups/trigger', { nodeId: 'x', url: 'https://127.0.0.1:1', adminPassword: 'x' }, { 'X-Admin-Password': PW });
    assert(trigger.status >= 400 && trigger.status < 500 && trigger.body?.success !== true, `POST trigger (a caller's URL and password): nothing there (${show(trigger)})`);
    resetAdminAuthTarpit();
    const dl = await call('GET', null, '/api/manager/backups/download-db?nodeId=local', undefined, { 'X-Admin-Password': PW });
    assert(dl.status >= 400 && dl.status < 500 && !dl.text.includes('SQLite format'), `GET download-db: no database (${dl.status})`);
    // No longer on the signature bypass either: a signed member's request reaches no route there.
    const signed = await call('GET', owner, '/api/manager/backups/status');
    assert(signed.status === 404, `a signed request finds no route there (${show(signed)})`);
}

async function main(): Promise<void> {
    console.log('\n=== The security storm\'s smaller server items ===');
    initAdminPassword();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const ann = member('Ann');
    const bo = member('Bo');

    const steps: [string, () => Promise<void>][] = [
        ['zip215', zip215],
        ['LIKE', () => likeWildcards(ann)],
        ['thresholds', thresholds],
        ['TOTP', totpOnce],
        ['conversations', () => conversations(ann, bo)],
        ['error text', () => errorText(ann)],
        ['manager backups', managerBackupsGone],
    ];
    for (const [name, step] of steps) {
        try {
            await step();
        } catch (e: any) {
            assert(false, `${name}: ran to the end (threw: ${e?.stack ?? e})`);
        }
    }
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌', e?.message ?? e);
    process.exit(1);
});
