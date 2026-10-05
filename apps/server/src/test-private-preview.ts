/**
 * test-private-preview.ts — a global-profile node with PRIVATE_PREVIEW=1 (config/private-preview.ts), over HTTP and
 * /ws through the real middleware (startHttpsServer).
 *
 *   1. /api/community/info says so: privatePreview true, no open door, no words door, invites on.
 *   2. Every join that isn't an owner's or admin's invite is refused with the one sentence (403 private_preview): the
 *      open door (join, its work, its sign-in nonce), a knock, the old register route, a member's code (made before the
 *      preview, as a row) and a member making one (admins_only).
 *   3. An owner's invite (password-issued seed invite) and an admin's own code redeem.
 *   4. A member signs in and reads as usual; recovery by a sign-in still reaches its routes.
 *   5. A visitor (unsigned, or signed by a non-member key) is refused every read but the listed open routes, and its
 *      /ws upgrade is refused 403; a member's socket opens.
 *   6. With the setting off again, the same node answers as before: no privatePreview in the info, the door's own
 *      answer to a join, the guest view to a visitor.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestAdminPass123!';
process.env.NODE_PROFILE = 'global';
process.env.PRIVATE_PREVIEW = '1';

import crypto from 'node:crypto';
import WebSocket from 'ws';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { db } from './db/db.js';
import { turnOn2faForTests } from './admin-auth-test-harness.js';
import { grantNodeRole } from './engine/node-roles.js';
import { PRIVATE_PREVIEW_MESSAGE, VISITOR_OPEN_ROUTES } from './config/private-preview.js';

let BASE = '';
let WS_BASE = '';
const PW = 'TestAdminPass123!';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

interface Id { pk: string; priv: crypto.KeyObject }
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}

type Method = 'GET' | 'POST';
async function call(method: Method, id: Id | null, urlPath: string, body?: unknown): Promise<{ status: number; body: any }> {
    const bodiless = method === 'GET';
    const raw = bodiless ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (!bodiless) headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: bodiless ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed };
}

const isPreviewRefusal = (r: { status: number; body: any }) =>
    r.status === 403 && r.body?.code === 'private_preview' && r.body?.error === PRIVATE_PREVIEW_MESSAGE;
const show = (r: { status: number; body: any }) => `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`;

function signedWsQuery(id: Id): string {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.priv).toString('base64');
    return `pubkey=${id.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
}
/** 'open', or the HTTP status the upgrade was refused with. */
function trySocket(url: string): Promise<'open' | number> {
    return new Promise((resolve) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const timer = setTimeout(() => { ws.terminate(); resolve(-1); }, 4000);
        ws.on('open', () => { clearTimeout(timer); ws.close(); resolve('open'); });
        ws.on('unexpected-response', (_req, res) => { clearTimeout(timer); resolve(res.statusCode ?? -1); ws.terminate(); });
        ws.on('error', () => { /* answered by unexpected-response or the timer */ });
    });
}

async function redeem(id: Id, code: string, callsign: string) {
    return call('POST', id, '/api/invite/redeem', { code, publicKey: id.pk, callsign });
}

async function main() {
    console.log('--- TEST: private preview (PRIVATE_PREVIEW=1 on a global-profile node) ---');
    initAdminPassword();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    WS_BASE = `wss://localhost:${port}`;

    // ── 1. the info the apps read ──
    const info = await call('GET', null, '/api/community/info');
    const f = info.body?.features ?? {};
    assert(info.status === 200 && f.privatePreview === true, `info: features.privatePreview true (${show(info)})`);
    assert(f.openJoin === false && f.wordsDoor === false, 'info: the open door and the words door are reported shut');
    assert(f.invites === true && f.knocks === false, 'info: invites on (an owner\'s or admin\'s), no knocks');
    assert(f.door === 'admins', `info: door is admins (got ${f.door})`);

    // ── 3a. an owner's invite: the password-issued seed invite (fresh node: it seeds the genesis member too) ──
    const tfa = turnOn2faForTests(PW);
    const seed = await call('POST', null, '/api/admin/seed-invite', { password: PW, totpCode: tfa.code(), type: 'standard' });
    assert(seed.status === 200 && typeof seed.body.code === 'string', `owner makes a seed invite on a global node in preview (${show(seed)})`);
    const marty = newId();
    const martyIn = await redeem(marty, seed.body.code, 'Marty');
    assert(martyIn.status === 200 && martyIn.body.success === true, `an owner's seed invite redeems (${show(martyIn)})`);
    grantNodeRole(marty.pk, 'admin', 'owner:password');

    // ── 3b. an admin's own code redeems ──
    const gen = await call('POST', marty, '/api/invite/generate', { publicKey: marty.pk });
    assert(gen.status === 200 && gen.body.invite?.code, `an admin makes a code (${show(gen)})`);
    const damo = newId();
    const damoIn = await redeem(damo, gen.body.invite.code, 'Damo');
    assert(damoIn.status === 200 && damoIn.body.success === true, `an admin's code redeems (${show(damoIn)})`);

    // ── 2. every other join is refused with the one sentence ──
    const stranger = newId();
    for (const [path, body] of [
        ['/api/join', { publicKey: stranger.pk, callsign: 'Stranger', door: 'words' }],
        ['/api/join/work', {}],
        ['/api/join/sso-nonce', {}],
        ['/api/join/knock', { message: 'hi' }],
        ['/api/community/register', { publicKey: stranger.pk, callsign: 'Stranger' }],
    ] as const) {
        const unsigned = await call('POST', null, path, body);
        const signed = await call('POST', stranger, path, body);
        assert(isPreviewRefusal(unsigned) && isPreviewRefusal(signed), `join ${path}: refused 403 private_preview, unsigned and signed (${show(signed)})`);
    }
    const memberJoin = await call('POST', damo, '/api/join', { publicKey: damo.pk, callsign: 'Again' });
    assert(isPreviewRefusal(memberJoin), 'a member signing the open door is refused too');

    // A member's own code: refused to make (admins only), and one made before the preview doesn't redeem.
    const damoGen = await call('POST', damo, '/api/invite/generate', { publicKey: damo.pk });
    assert(damoGen.status === 403 && damoGen.body.code === 'admins_only', `a member (no role) can't make an invite (${show(damoGen)})`);
    db.prepare('INSERT INTO invite_codes (code, created_by, created_at) VALUES (?, ?, ?)').run('PREVIEWOLD1', damo.pk, new Date().toISOString());
    const oldCode = await redeem(stranger, 'PREVIEWOLD1', 'Stranger');
    assert(oldCode.status !== 200 && oldCode.body.error === PRIVATE_PREVIEW_MESSAGE, `a member's code made before the preview: refused with the sentence (${show(oldCode)})`);
    assert(!(db.prepare('SELECT 1 FROM members WHERE public_key = ?').get(stranger.pk)), 'the stranger is no member');

    // ── 4. members as usual ──
    const me = await call('GET', damo, '/api/community/me');
    assert(me.status === 200, `a member reads their own account (${show(me)})`);
    const posts = await call('GET', damo, '/api/marketplace/posts');
    assert(posts.status === 200, `a member reads the listings (${show(posts)})`);
    const members = await call('GET', damo, '/api/community/members');
    assert(members.status === 200 && Array.isArray(members.body), `a member reads the members (${show(members)})`);
    const ssoNonce = await call('POST', newId(), '/api/recovery/sso-nonce', {});
    assert(!isPreviewRefusal(ssoNonce), `recovery by a sign-in still reaches its route (${show(ssoNonce)})`);
    const reEnroll = await call('POST', newId(), '/api/member/re-enroll', {});
    assert(!isPreviewRefusal(reEnroll), `re-enrol (a member's new key) still reaches its route (${show(reEnroll)})`);

    // ── 5. visitors get nothing but the listed routes ──
    for (const path of [
        '/api/marketplace/posts', '/api/community/members', '/api/map/pins', '/api/commons/decisions',
        '/api/global/landing', '/api/pulse/feed', `/api/members/${damo.pk}`, '/api/activity', '/api/community/directory',
    ]) {
        const unsigned = await call('GET', null, path);
        const signed = await call('GET', stranger, path);
        assert(isPreviewRefusal(unsigned) && isPreviewRefusal(signed), `visitor GET ${path}: 403 private_preview (${show(unsigned)})`);
    }
    for (const path of ['/api/community/info', '/api/version', '/api/node/info', '/api/attest']) {
        const r = await call('GET', null, path);
        assert(!isPreviewRefusal(r), `visitor GET ${path}: still answered (${r.status})`);
    }
    assert(VISITOR_OPEN_ROUTES.every((r) => r.why.length > 10), 'every open route says why');
    const wsVisitor = await trySocket(`${WS_BASE}/ws`);
    assert(wsVisitor === 403, `visitor /ws, unsigned: refused 403 (got ${wsVisitor})`);
    const wsStranger = await trySocket(`${WS_BASE}/ws?${signedWsQuery(stranger)}`);
    assert(wsStranger === 403, `visitor /ws, signed by a non-member: refused 403 (got ${wsStranger})`);
    const wsMember = await trySocket(`${WS_BASE}/ws?${signedWsQuery(damo)}`);
    assert(wsMember === 'open', `a member's /ws opens (got ${wsMember})`);

    // ── 6. the setting off: as before ──
    process.env.PRIVATE_PREVIEW = '';
    const offInfo = await call('GET', null, '/api/community/info');
    assert(offInfo.status === 200 && !('privatePreview' in (offInfo.body.features ?? {})), 'off: no privatePreview in the info');
    assert(offInfo.body.features?.openJoin === true && offInfo.body.features?.invites === false && offInfo.body.features?.door === 'open',
        `off: the global profile's own door again (${JSON.stringify(offInfo.body.features)})`);
    const offJoin = await call('POST', null, '/api/join/work', {});
    assert(!isPreviewRefusal(offJoin), `off: the door's own answer to a join (${show(offJoin)})`);
    const offPosts = await call('GET', null, '/api/marketplace/posts');
    assert(offPosts.status === 200, `off: a visitor gets the guest view (${show(offPosts)})`);
    const offWs = await trySocket(`${WS_BASE}/ws`);
    assert(offWs !== 403, `off: a visitor's /ws is not refused by the preview (got ${offWs})`);
    const offGen = await call('POST', marty, '/api/invite/generate', { publicKey: marty.pk });
    assert(offGen.status === 404 && offGen.body.code === 'feature_off', `off: invites are off on the global profile again (${show(offGen)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
