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
import { PRIVATE_PREVIEW_MESSAGE, VISITOR_OPEN_ROUTES, PRIVATE_PREVIEW_BOOT_LINE, privatePreviewAtBoot } from './config/private-preview.js';
import { setMemberPhoto } from '@beanpool/engine';
import * as se from './state-engine.js';
import { mirrorNodeProfileAtBoot } from './config/node-profile.js';

const RED_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4IScHAAK2AQU0pnWqAAAAAElFTkSuQmCC';
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';

/** An image fetched as the apps fetch it: unsigned, no headers. */
async function image(urlPath: string): Promise<{ status: number; type: string; body: any }> {
    const res = await fetch(BASE + urlPath);
    const type = res.headers.get('content-type') ?? '';
    const text = type.startsWith('image/') ? '' : await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, type, body };
}

/** The first URL in a read's JSON matching `re`. */
function urlIn(body: unknown, re: RegExp): string | null {
    const m = JSON.stringify(body ?? null).match(re);
    return m ? m[0].replace(/\\u0026/g, '&') : null;
}

function withKey(url: string, k: string | null): string {
    const u = new URL(url, 'https://x');
    if (k === null) u.searchParams.delete('k'); else u.searchParams.set('k', k);
    return u.pathname + u.search;
}

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

    // ── 4b. members' images load unsigned with their own key, and only with it (fix round 1, B1) ──
    setMemberPhoto(db, damo.pk, RED_PNG);
    setMemberPhoto(db, marty.pk, TINY_PNG);
    const AT = { lat: -28.55, lng: 153.5 };
    const listing = se.createPost('offer', 'food', 'Preview soup', 'Soup, described', 0, 'fixed', damo.pk, AT.lat, AT.lng, [RED_PNG], false, undefined, false, {})!;
    const event = se.createPost('event', 'community', 'Preview picnic', 'A picnic, described', 0, 'fixed', marty.pk, AT.lat, AT.lng, [TINY_PNG], false, undefined, false,
        { eventStartAt: new Date(Date.now() + 7 * 86_400_000).toISOString() } as any)!;
    const group = se.createGroup({ name: 'Preview club', createdBy: marty.pk, joinPolicy: 'open', avatarUrl: RED_PNG });
    const membersRead = await call('GET', marty, '/api/community/members');
    const postsRead = await call('GET', marty, '/api/marketplace/posts');
    const groupRead = await call('GET', marty, `/api/groups/${group.id}`);
    const eventRead = await call('GET', marty, '/api/marketplace/posts?type=event');
    const urls = {
        damoFace: urlIn(membersRead.body, new RegExp(`/api/avatar/${damo.pk}\\?[^"]*`)),
        martyFace: urlIn(membersRead.body, new RegExp(`/api/avatar/${marty.pk}\\?[^"]*`)),
        listingPhoto: urlIn(postsRead.body, new RegExp(`/api/marketplace/posts/${listing.id}/photos/0\\?[^"]*`)),
        eventPhoto: urlIn(eventRead.body, new RegExp(`/api/marketplace/posts/${event.id}/photos/0\\?[^"]*`)),
        groupPicture: urlIn(groupRead.body, new RegExp(`/api/groups/${group.id}/picture\\?[^"]*`)),
    };
    for (const [what, url] of Object.entries(urls)) {
        assert(!!url && new URL(url, 'https://x').searchParams.get('k')?.length === 22, `a member's read hands out ${what} with its own key (${url})`);
        if (!url) continue;
        const keyed = await image(url);
        assert(keyed.status === 200 && keyed.type.startsWith('image/'), `${what}: the keyed URL loads unsigned, as the apps load it (${keyed.status} ${keyed.type} ${JSON.stringify(keyed.body)})`);
        for (const [how, k] of [['no k', null], ['a wrong k', 'B'.repeat(22)], ['a short k', 'abc']] as const) {
            const r = await image(withKey(url, k));
            assert(r.status === 403 && r.body?.code === 'private_preview', `${what} with ${how}: refused with the preview's sentence (${r.status} ${JSON.stringify(r.body)})`);
        }
    }
    // A key leaked from one image opens only that image.
    const kOf = (url: string | null) => (url ? new URL(url, 'https://x').searchParams.get('k') : null);
    for (const [what, url, other] of [
        ['Marty\'s face with Damo\'s face key', urls.martyFace, kOf(urls.damoFace)],
        ['the event photo with the listing photo\'s key', urls.eventPhoto, kOf(urls.listingPhoto)],
        ['the group picture with Damo\'s face key', urls.groupPicture, kOf(urls.damoFace)],
        ['Damo\'s face with the group picture\'s key', urls.damoFace, kOf(urls.groupPicture)],
        ['the listing photo #1 (none) with photo #0\'s key', urls.listingPhoto?.replace('/photos/0', '/photos/1') ?? null, kOf(urls.listingPhoto)],
    ] as const) {
        if (!url || !other) { assert(false, `${what}: URLs to try`); continue; }
        const r = await image(withKey(url, other));
        assert(r.status === 403 && r.body?.code === 'private_preview', `${what}: refused (${r.status})`);
    }
    // A keyed image is GET or HEAD only; a write to its path is refused like any visitor's.
    if (urls.damoFace) {
        const post = await fetch(BASE + urls.damoFace, { method: 'POST' });
        assert(post.status === 403, `POST to a keyed face URL: refused (${post.status})`);
    }
    // The phone map's unsigned read of the service area: the area alone, none of the other settings.
    const cfgVisitor = await call('GET', null, '/api/node/config');
    assert(cfgVisitor.status === 200 && Object.keys(cfgVisitor.body ?? {}).join(',') === 'serviceRadius',
        `unsigned /api/node/config: the service area alone (${show(cfgVisitor)})`);
    const cfgMember = await call('GET', marty, '/api/node/config');
    assert(cfgMember.status === 200 && 'door' in (cfgMember.body ?? {}) && 'publishMembers' in (cfgMember.body ?? {}), `a member's /api/node/config: the whole public config (${show(cfgMember)})`);

    // ── 4c. the invite check vouches for no code the preview refuses (fix round 1, N2) ──
    db.prepare('INSERT INTO invite_codes (code, created_by, created_at) VALUES (?, ?, ?)').run('PREVIEWOLD2', damo.pk, new Date().toISOString());
    const chkMember = await call('GET', null, '/api/invite/check?code=PREVIEWOLD2');
    assert(chkMember.status === 200 && chkMember.body?.valid === false && chkMember.body?.error === PRIVATE_PREVIEW_MESSAGE
        && !('inviterCallsign' in chkMember.body) && !JSON.stringify(chkMember.body).includes('Damo'),
        `invite/check, a member's code: valid false, the preview's sentence, no inviter (${show(chkMember)})`);
    const adminCode = await call('POST', marty, '/api/invite/generate', { publicKey: marty.pk });
    const chkAdmin = await call('GET', null, `/api/invite/check?code=${encodeURIComponent(adminCode.body?.invite?.code ?? '')}`);
    assert(chkAdmin.status === 200 && chkAdmin.body?.valid === true && chkAdmin.body?.inviterCallsign === 'Marty', `invite/check, an admin's code: valid (${show(chkAdmin)})`);

    // ── 4d. the boot's word on the setting (fix round 1, N1) ──
    for (const v of ['1', 'true', 'TRUE', ' yes ', 'On']) {
        assert(privatePreviewAtBoot({ PRIVATE_PREVIEW: v }) === PRIVATE_PREVIEW_BOOT_LINE, `boot: PRIVATE_PREVIEW=${JSON.stringify(v)} says the preview is ON`);
    }
    assert(PRIVATE_PREVIEW_BOOT_LINE.includes('Private preview: ON (only owner/admin invites join; visitors see nothing)'), 'boot line says it plainly');
    for (const v of [undefined, '', '0', 'false', 'no', 'OFF']) {
        assert(privatePreviewAtBoot({ PRIVATE_PREVIEW: v }) === null, `boot: PRIVATE_PREVIEW=${JSON.stringify(v)} is off, no line`);
    }
    for (const v of ['y', 'enabled', '2', '"1"', "'1'"]) {
        let err = '';
        try { privatePreviewAtBoot({ PRIVATE_PREVIEW: v }); } catch (e) { err = (e as Error).message; }
        assert(err.includes('will not start') && err.includes('PRIVATE_PREVIEW=1') && err.includes('0 (or false, no, off'),
            `boot: PRIVATE_PREVIEW=${JSON.stringify(v)} stops the boot naming the accepted values (${err.slice(0, 60)})`);
    }
    {
        const logs: string[] = [];
        const log = console.log, warn = console.warn;
        console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
        console.warn = (...a: unknown[]) => { logs.push(a.join(' ')); };
        try { mirrorNodeProfileAtBoot('primary'); } finally { console.log = log; console.warn = warn; }
        assert(logs.some((l) => l.startsWith('🔒 Private preview: ON')), `boot log: the preview line (${logs.length} lines)`);
        assert(!logs.some((l) => l.includes('open door is open') || l.includes('Invites are off')), `boot log: no open-door or invites-off line while it is on (${logs.filter((l) => /door|Invites/.test(l)).join(' | ')})`);
    }

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
