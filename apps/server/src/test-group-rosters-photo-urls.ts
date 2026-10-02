/**
 * Big groups' rosters send photo URLs, not photos (#1478, found by #1475's deciding review).
 *
 * #1475 moved members' photos out of their rows and made the member list send each photo's URL. A group's roster still
 * handed every member's photo out as stored (~27 KB of base64 each): on the real server held to a 256 MB heap, one open
 * group of 6,402 members with photos and `GET /api/groups/:id/members` as its convenor ended the process (FATAL ERROR,
 * heap out of memory). On the global node anyone can join an open group and every member who opens it reads the roster,
 * so one big group crash-loops the node. The roster, the convenor and inviter in a group's card and in the list of groups,
 * the enterprises' list and map, an enterprise's deals, the escrow disputes and the crowdfund list now read each row's
 * avatar_ref and send avatarUrlOf(key, ref), as the member list does.
 *
 * Every server here is the real one, in a process of its own (this file, run as a child), so running out of heap ends the
 * child, not the suite:
 *   1. The heap. One open group of 6,400 members with a 20 KB photo each (by the profile route's own writer), on the
 *      global profile (faces keyed), held to a 256 MB heap: the convenor's roster, a member's roster, the group's card and
 *      the list of groups answer, with URLs and no photo, and the heap's peak stays under a bound. On origin/main the
 *      convenor's roster ends the process.
 *   2. Who gets what, on the global profile: the convenor sees requests and invitations, a member the active roster, an
 *      outsider an open group's roster and nothing of an invite-only one, a stranger, a visitor and a signed non-member
 *      nothing; no answer carries a photo, each URL is the member list's for that member, opens their face and only
 *      with its key; a shipped picture stays its name; a removed photo leaves no URL and its old URL opens nothing.
 *   3. The local profile's lists: the enterprises' list and map pins, an enterprise's open deals as its keeper sees them,
 *      the crowdfund list and the escrow disputes carry each photo's URL and no photo; the one enterprise's own page
 *      still hands its photo out as stored (a read of one, as #1475 left the profile page).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-group-rosters-photo-urls.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
// The orchestrator's own environment only: each child is given its profile (child(), below).
if (!process.argv[2]) delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_READ_AUTH;
// Never the real communities directory: nothing here starts the mirror, and a stray fetch would go nowhere.
process.env.DIRECTORY_MIRROR_URL = 'http://127.0.0.1:1/rest/v1/directory_nodes?select=*';

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);

/** A JPEG the photo rules take (its structure walks), about `size` bytes: what a phone sends, as a data URL. */
function jpeg(size: number, seed = 1): Buffer {
    const head = Buffer.from([
        0xff, 0xd8,
        0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
        0xff, 0xdb, 0x00, 0x43, 0x00, ...Array(64).fill(0x08),
        0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0x00, 0x02, 0x00, 0x01, 0x01, 0x11, 0x00,
        0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ...Array(12).fill(0x01),
        0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    ]);
    const body = Buffer.alloc(Math.max(0, size - head.length - 2));
    for (let i = 0; i < body.length; i++) body[i] = ((i * 7 + seed) % 254) + 1; // never 0xFF: no marker inside
    return Buffer.concat([head, body, Buffer.from([0xff, 0xd9])]);
}
const dataUrl = (b: Buffer, mime = 'image/jpeg') => `data:${mime};base64,${b.toString('base64')}`;

type Key = { pk: string; priv: string };
function newKey(): Key {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
}

/** A member's signed GET or POST, as the apps send one (the older request format, which every node still takes). */
async function call(base: string, method: 'GET' | 'POST', route: string, key: Key | null, body?: unknown): Promise<{ status: number; text: string; headers: Headers; bytes: Buffer }> {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = raw ? { 'Content-Type': 'application/json' } : {};
    if (key) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const priv = crypto.createPrivateKey({ key: Buffer.from(key.priv, 'base64'), format: 'der', type: 'pkcs8' });
        Object.assign(headers, {
            'X-Public-Key': key.pk,
            'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${route.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), priv).toString('base64'),
            'X-Timestamp': String(ts), 'X-Nonce': nonce,
        });
    }
    const res = await fetch(`${base}${route}`, { method, headers, body: raw || undefined, signal: AbortSignal.timeout(120_000) });
    const bytes = Buffer.from(await res.arrayBuffer());
    return { status: res.status, text: bytes.toString('utf8'), headers: res.headers, bytes };
}

/** A photo's bytes anywhere in a body: a data URL, or a run of base64 as long as any photo's. */
const carriesPhoto = (text: string) => /data:image\//i.test(text) || /[A-Za-z0-9+/]{2000}/.test(text);
/** What a keyed node (the global profile) hands out for a member with a photo: the member list's URL, with its key. */
const KEYED_URL = (pk: string) => new RegExp(`^/api/avatar/${pk}\\?size=thumb&v=[0-9a-f]{8}&k=[A-Za-z0-9_-]{22}$`);
const PLAIN_URL = (pk: string) => new RegExp(`^/api/avatar/${pk}\\?size=thumb&v=[0-9a-f]{8}$`);

// ── The children ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** One open group of `n` members with a photo each (by the profile route's own writer), led by `convenor`. */
async function seedBig(a: { n: number; convenor: string; member: string }): Promise<void> {
    const se = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const engine = await import('@beanpool/engine');
    se.initStateEngine();
    const insert = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invite_code, status) VALUES (?, ?, ?, ?, 'active')`);
    const photo = dataUrl(jpeg(20_000));
    insert.run(a.convenor, 'Convenor', '2026-01-01T00:00:00.000Z', 'INV-CONVENOR');
    insert.run(a.member, 'Member', '2026-01-01T00:00:00.000Z', 'INV-MEMBER');
    se.updateProfile(a.convenor, { avatar: dataUrl(jpeg(20_000, 2)) });
    const group = se.createGroup({ name: 'Big', createdBy: a.convenor, joinPolicy: 'open' });
    engine.joinGroup(db, group.id, a.member);
    for (let i = 0; i < a.n; i++) {
        const pk = crypto.createHash('sha256').update(`roster member ${i}`).digest('hex');
        insert.run(pk, `Roster${i}`, new Date(Date.UTC(2026, 0, 2) + i * 1000).toISOString(), `INV-${i}`);
        se.updateProfile(pk, { avatar: photo });
        engine.joinGroup(db, group.id, pk);
    }
    db.pragma('wal_checkpoint(TRUNCATE)');
    process.stdout.write(`@@ ${JSON.stringify({ groupId: group.id })}\n`);
}

/** The real server, on port 0, reporting its heap's peak (sampled every 5 ms) when asked on stdin. */
async function serve(): Promise<void> {
    const { initTls } = await import('./services/tls.js');
    const { initAdminPassword } = await import('./config/local-config.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    initAdminPassword();
    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    let peak = 0;
    setInterval(() => { const h = process.memoryUsage().heapUsed; if (h > peak) peak = h; }, 5).unref();
    const say = (m: unknown) => process.stdout.write(`@@ ${JSON.stringify(m)}\n`);
    say({ ready: true, port });
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
        if (line === 'peak') { say({ peak }); peak = process.memoryUsage().heapUsed; }
        if (line === 'exit') process.exit(0);
    });
}

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    // A photo a message quotes (a failing run's answer) is cut to its start.
    const said = msg.replace(/(data:image\/[a-z]+;base64,[A-Za-z0-9+/]{24})[A-Za-z0-9+/=]+/gi, '$1…');
    if (cond) { passed++; console.log(`✓ ${said}`); } else console.error(`✗ ${said}`);
}

/** The server in this process, for the sections that check answers rather than the heap. */
async function inProcessServer(): Promise<{ base: string; se: typeof import('./state-engine.js'); db: typeof import('./db/db.js')['db']; core: typeof import('@beanpool/core'); engine: typeof import('@beanpool/engine') }> {
    const { initTls } = await import('./services/tls.js');
    const { initAdminPassword } = await import('./config/local-config.js');
    const se = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { startHttpsServer } = await import('./https-server.js');
    initAdminPassword();
    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    return { base: `https://localhost:${port}`, se, db, core: await import('@beanpool/core'), engine: await import('@beanpool/engine') };
}

/** 2. Who gets what, on the global profile (faces keyed). Runs in its own process: the profile is decided at boot. */
async function rulesOnGlobal(): Promise<void> {
    const { base, se, db, core, engine } = await inProcessServer();
    const insert = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invite_code, status) VALUES (?, ?, ?, ?, 'active')`);
    const [C, M, B, Z, P, I, O] = Array.from({ length: 7 }, newKey);
    const visitor = newKey(), stranger = newKey();
    const photos = new Map<string, string>();
    [[C, 'Cleo'], [M, 'Mira'], [B, 'Bundy'], [Z, 'Zed'], [P, 'Pia'], [I, 'Ivo'], [O, 'Otto']].forEach(([k, name], i) => {
        insert.run((k as Key).pk, name as string, '2026-01-01T00:00:00.000Z', `INV-R${i}`);
    });
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, is_visitor) VALUES (?, 'Vee', '2026-01-01T00:00:00.000Z', 'active', 1)`).run(visitor.pk);
    for (const [k, seed] of [[C, 3], [M, 5], [P, 7], [I, 9], [O, 11]] as [Key, number][]) {
        const photo = dataUrl(jpeg(6_000, seed));
        photos.set(k.pk, photo);
        se.updateProfile(k.pk, { avatar: photo });
    }
    se.updateProfile(B.pk, { avatar: 'bundled://leaf' });

    const open = se.createGroup({ name: 'Open', createdBy: C.pk, joinPolicy: 'open' });
    const ask = se.createGroup({ name: 'Ask', createdBy: C.pk, joinPolicy: 'request_to_join' });
    const quiet = se.createGroup({ name: 'Quiet', createdBy: C.pk, joinPolicy: 'invite_only' });
    for (const k of [M, B, Z]) engine.joinGroup(db, open.id, k.pk);
    engine.joinGroup(db, ask.id, M.pk);
    engine.approveGroupMember(db, ask.id, C.pk, M.pk);
    engine.joinGroup(db, ask.id, P.pk); // asks to join: pending
    engine.inviteGroupMember(db, quiet.id, C.pk, M.pk, 'member');
    engine.joinGroup(db, quiet.id, M.pk);
    engine.inviteGroupMember(db, quiet.id, C.pk, I.pk, 'member'); // invited, not yet in

    const urlOf = (pk: string) => core.avatarUrlOf(pk, (db.prepare('SELECT avatar_ref FROM members WHERE public_key = ?').get(pk) as any)?.avatar_ref) ?? undefined;
    const rosterOf = async (who: Key | null, groupId: string, query = '') => {
        const r = await call(base, 'GET', `/api/groups/${groupId}/members${query}`, who);
        return { ...r, rows: r.status === 200 ? JSON.parse(r.text) as any[] : [] };
    };
    const rowsRight = (rows: any[]) => rows.every(r => r.avatarUrl === urlOf(r.memberPubkey));

    console.log('\n— 2. who gets what, on the global profile —');
    const byConvenor = await rosterOf(C, ask.id);
    assert(byConvenor.status === 200 && byConvenor.rows.some(r => r.memberPubkey === P.pk && r.status === 'pending_approval')
        && rowsRight(byConvenor.rows) && !carriesPhoto(byConvenor.text),
        `the convenor's roster lists the request too, each photo as the member's URL and none as a photo (${byConvenor.status}, ${byConvenor.rows.length} rows)`);
    const pRow = byConvenor.rows.find(r => r.memberPubkey === P.pk);
    assert(KEYED_URL(P.pk).test(pRow?.avatarUrl ?? ''), `a request's face is its keyed URL (${pRow?.avatarUrl})`);
    const quietByConvenor = await rosterOf(C, quiet.id);
    const iRow = quietByConvenor.rows.find(r => r.memberPubkey === I.pk);
    assert(iRow?.status === 'invited' && KEYED_URL(I.pk).test(iRow?.avatarUrl ?? '') && !carriesPhoto(quietByConvenor.text),
        `an invitation in the convenor's roster: its face is its keyed URL (${iRow?.status}, ${iRow?.avatarUrl})`);

    const byMember = await rosterOf(M, ask.id);
    assert(byMember.status === 200 && byMember.rows.length === 2 && byMember.rows.every(r => r.status === 'active')
        && rowsRight(byMember.rows) && !carriesPhoto(byMember.text),
        `a member's roster is the active members, as before, with URLs (${byMember.rows.map(r => r.callsign).join(', ')})`);
    const pendingByMember = await rosterOf(M, ask.id, '?status=pending_approval');
    assert(pendingByMember.status === 403 && !pendingByMember.text.includes('/api/avatar/'), `a member is refused who asked to join (${pendingByMember.status})`);

    const openByOutsider = await rosterOf(O, open.id);
    const bRow = openByOutsider.rows.find(r => r.memberPubkey === B.pk);
    const zRow = openByOutsider.rows.find(r => r.memberPubkey === Z.pk);
    assert(openByOutsider.status === 200 && openByOutsider.rows.length === 4 && rowsRight(openByOutsider.rows) && !carriesPhoto(openByOutsider.text),
        `any member of the node reads an open group's roster, with URLs (${openByOutsider.status}, ${openByOutsider.rows.length} rows)`);
    assert(bRow?.avatarUrl === 'bundled://leaf', `a shipped picture is its name, as in the member list (${bRow?.avatarUrl})`);
    assert(zRow !== undefined && !('avatarUrl' in zRow), 'a member with no photo has no avatarUrl, as before');
    const quietByOutsider = await rosterOf(O, quiet.id);
    assert(quietByOutsider.status === 404 && !quietByOutsider.text.includes('/api/avatar/'), `an outsider gets nothing of an invite-only group (${quietByOutsider.status})`);
    const quietByInvitee = await rosterOf(I, quiet.id);
    assert(quietByInvitee.status === 403 && !quietByInvitee.text.includes('/api/avatar/'), `the invitee is told only members see who is in it (${quietByInvitee.status})`);

    for (const [label, who] of [['a reader who does not sign', null], ['a visitor', visitor], ['a key that is no member here', stranger]] as [string, Key | null][]) {
        const r = await rosterOf(who, open.id);
        assert(r.status >= 400 && !r.text.includes('/api/avatar/') && !carriesPhoto(r.text), `${label} gets no roster (${r.status})`);
        const card = await call(base, 'GET', `/api/groups/${open.id}`, who);
        const list = await call(base, 'GET', '/api/groups', who);
        assert(card.status >= 400 && list.status >= 400 && !card.text.includes('/api/avatar/') && !list.text.includes('/api/avatar/'),
            `${label} gets no group card and no list of groups (${card.status}, ${list.status})`);
    }

    const card = await call(base, 'GET', `/api/groups/${open.id}`, M);
    const cardBody = JSON.parse(card.text);
    assert(card.status === 200 && cardBody.convenorAvatarUrl === urlOf(C.pk) && KEYED_URL(C.pk).test(cardBody.convenorAvatarUrl) && !carriesPhoto(card.text),
        `the group's card gives its convenor's face as their URL (${cardBody.convenorAvatarUrl})`);
    const list = await call(base, 'GET', '/api/groups', M);
    const listed = JSON.parse(list.text) as any[];
    assert(list.status === 200 && listed.length >= 2 && listed.every(g => g.convenorAvatarUrl === urlOf(C.pk)) && !carriesPhoto(list.text),
        `the list of groups gives each convenor's face as their URL (${listed.length} groups)`);
    const landing = await call(base, 'GET', `/api/groups/${quiet.id}`, I);
    const landingBody = JSON.parse(landing.text);
    assert(landing.status === 200 && landingBody.viewerInvitedBy?.pubkey === C.pk && landingBody.viewerInvitedBy?.avatarUrl === urlOf(C.pk) && !carriesPhoto(landing.text),
        `the invite landing gives who invited them as their URL (${landingBody.viewerInvitedBy?.avatarUrl})`);

    const joined = await call(base, 'POST', `/api/groups/${open.id}/join`, O, {});
    const joinedBody = JSON.parse(joined.text);
    assert(joined.status === 200 && joinedBody.member?.avatarUrl === urlOf(O.pk) && !carriesPhoto(joined.text),
        `a join answers with the member's roster row, its face as their URL (${joinedBody.member?.avatarUrl})`);

    // Each URL opens the face it names, and only with its key (the member list's rule, engine/avatar-keys.ts).
    for (const [name, k] of [['the convenor', C], ['a request', P], ['an invitation', I]] as [string, Key][]) {
        const url = urlOf(k.pk)!;
        const photo = Buffer.from(photos.get(k.pk)!.split(',')[1], 'base64');
        const face = await call(base, 'GET', url, null);
        // What the phone asks for: the same URL with its own cache-buster after it (apps/native utils/image-processing.ts avatarUri).
        const phone = await call(base, 'GET', `${url}&_v=${k.pk.slice(0, 8)}`, null);
        const keyless = await call(base, 'GET', url.replace(/&k=[^&]+$/, ''), null);
        assert(face.status === 200 && face.bytes.equals(photo) && phone.status === 200 && phone.bytes.equals(photo) && keyless.status === 404,
            `${name}'s URL opens their photo, as the web app and the phone ask for it (${face.status}, ${phone.status}, ${face.bytes.length} bytes), and without its key nothing (${keyless.status})`);
    }

    // A photo removed: the roster has no URL for it, and the old URL opens nothing.
    const before = urlOf(M.pk)!;
    const removed = await call(base, 'POST', '/api/profile/update', M, { avatar: null });
    const after = await rosterOf(C, open.id);
    const mRow = after.rows.find(r => r.memberPubkey === M.pk);
    const oldUrl = await call(base, 'GET', before, null);
    assert(removed.status === 200 && mRow !== undefined && !('avatarUrl' in mRow) && oldUrl.status === 404,
        `a photo removed leaves no URL in the roster, and its old URL opens nothing (${removed.status}, ${mRow?.avatarUrl}, ${oldUrl.status})`);

    console.log(`@@ ${JSON.stringify({ run, passed })}`);
    process.exit(0);
}

/** 3. The local profile's lists (Beans on: enterprises, deals, crowdfunds, disputes). */
async function listsOnLocal(): Promise<void> {
    const { base, se, db, core, engine } = await inProcessServer();
    const insert = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invite_code, status) VALUES (?, ?, ?, ?, 'active')`);
    const keeper = newKey(), buyer = newKey(), reader = newKey();
    insert.run(keeper.pk, 'Kip', '2026-01-01T00:00:00.000Z', 'INV-L1');
    insert.run(buyer.pk, 'Bea', '2026-01-01T00:00:00.000Z', 'INV-L2');
    insert.run(reader.pk, 'Rue', '2026-01-01T00:00:00.000Z', 'INV-L3');
    const buyerPhoto = dataUrl(jpeg(6_000, 21));
    se.updateProfile(buyer.pk, { avatar: buyerPhoto });

    // An ongoing enterprise with a place (the list and the map) and a crowdfund (bounded) with no photos of its own, each
    // with a photo, written as every enterprise's is (setMemberPhoto).
    const shop = crypto.createHash('sha256').update('local shop').digest('hex');
    const fund = crypto.createHash('sha256').update('local fund').digest('hex');
    const shopPhoto = dataUrl(jpeg(6_000, 23)), fundPhoto = dataUrl(jpeg(6_000, 25));
    const ent = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, is_treasury, earned_credit, earned_surplus, purpose, lifecycle, goal_amount, lat, lng, paused)
                            VALUES (?, ?, '2026-01-01T00:00:00.000Z', 'active', 1, 0, 0, ?, ?, ?, ?, ?, 0)`);
    ent.run(shop, 'Shop', 'Bread', 'ongoing', null, -28.55, 153.5);
    ent.run(fund, 'Fund', 'A roof', 'bounded', 500, null, null);
    for (const [pk, photo] of [[shop, shopPhoto], [fund, fundPhoto]]) {
        engine.setMemberPhoto(db, pk, photo);
        db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
        db.prepare(`INSERT INTO treasury_operators (treasury_pubkey, member_pubkey, role, granted_by) VALUES (?, ?, 'lead', 'creator')`).run(pk, keeper.pk);
    }
    db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(keeper.pk);

    // Two deals with the shop: one asked for (a bid), one in escrow (an active deal, and a dispute for the admins).
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, status)
                VALUES ('shop-post', 'offer', 'food', 'Loaf', 'A loaf', 5, ?, '2026-01-01T00:00:00.000Z', 'active')`).run(shop);
    const deal = db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at)
                             VALUES (?, 'shop-post', ?, ?, 5, ?, '2026-01-01T00:00:00.000Z')`);
    deal.run('deal-bid', buyer.pk, shop, 'requested');
    deal.run('deal-escrow', buyer.pk, shop, 'pending');

    const urlOf = (pk: string) => core.avatarUrlOf(pk, (db.prepare('SELECT avatar_ref FROM members WHERE public_key = ?').get(pk) as any)?.avatar_ref);

    console.log('\n— 3. the local profile\'s lists —');
    for (const route of ['/api/enterprises?includeBounded=true', '/api/treasuries?includeBounded=true']) {
        const r = await call(base, 'GET', route, reader);
        const rows = r.status === 200 ? JSON.parse(r.text).treasuries as any[] : [];
        const shopRow = rows.find(t => t.publicKey === shop), fundRow = rows.find(t => t.publicKey === fund);
        assert(r.status === 200 && !!shopRow && !!fundRow && rows.every(t => t.avatarUrl === urlOf(t.publicKey) && t.avatar === t.avatarUrl)
            && PLAIN_URL(shop).test(shopRow.avatarUrl) && !carriesPhoto(r.text),
            `${route.split('?')[0]}: each enterprise's avatarUrl is its URL, as its avatar is, and no photo (${shopRow?.avatarUrl})`);
    }
    for (const route of ['/api/enterprises/map', '/api/map/enterprises', '/api/treasuries/map']) {
        const r = await call(base, 'GET', route, reader);
        const pin = r.status === 200 ? (JSON.parse(r.text).enterprises as any[]).find(e => e.publicKey === shop) : null;
        assert(!!pin && pin.avatarUrl === urlOf(shop) && pin.avatar === pin.avatarUrl && !carriesPhoto(r.text),
            `${route}: the pin's avatarUrl is its URL, as its avatar is, and no photo (${pin?.avatarUrl})`);
    }
    const page = await call(base, 'GET', `/api/enterprise/${shop}`, keeper);
    const pageBody = page.status === 200 ? JSON.parse(page.text) : {};
    const bid = (pageBody.pendingBids ?? []).find((d: any) => d.id === 'deal-bid');
    const active = (pageBody.activeDeals ?? []).find((d: any) => d.id === 'deal-escrow');
    assert(bid?.peer_avatar === urlOf(buyer.pk) && active?.peer_avatar === urlOf(buyer.pk) && PLAIN_URL(buyer.pk).test(bid?.peer_avatar ?? '')
        && !('peer_avatar_ref' in (bid ?? {})) && Object.keys(active ?? {}).join() === 'id,post_id,buyer_pubkey,seller_pubkey,credits,hours,status,created_at,post_title,post_type,price_type,peer_callsign,peer_avatar,action_required',
        `the keeper's page gives each deal's other party as their URL, the row's fields as before (${bid?.peer_avatar})`);
    assert(pageBody.avatarUrl === shopPhoto && pageBody.avatar === urlOf(shop),
        'the one enterprise\'s own page still hands its photo out as stored (a read of one, as #1475 left it)');
    const pageWithoutPhotos = page.text.replace(shopPhoto, '');
    assert(!carriesPhoto(pageWithoutPhotos), 'and nothing else on it is a photo');

    const projects = await call(base, 'GET', '/api/crowdfund/projects', reader);
    const project = projects.status === 200 ? (JSON.parse(projects.text).projects as any[]).find(p => p.id === fund) : null;
    assert(!!project && JSON.parse(project.photos)[0] === urlOf(fund) && PLAIN_URL(fund).test(JSON.parse(project.photos)[0]) && !carriesPhoto(projects.text),
        `the crowdfund list gives a project its enterprise's photo as its URL (${project?.photos})`);
    const one = await call(base, 'GET', `/api/crowdfund/projects/${fund}`, reader);
    assert(one.status === 200 && JSON.parse(JSON.parse(one.text).project.photos)[0] === fundPhoto,
        'the one project\'s own read still hands it out as stored (a read of one)');

    const disputes = se.getEscrowDisputes(0, 50, 0, 'all');
    const dispute = disputes.find(d => d.id === 'deal-escrow');
    const single = se.getEscrowDispute('deal-escrow');
    assert(dispute?.parties.buyer.avatarUrl === urlOf(buyer.pk) && dispute?.parties.seller.avatarUrl === urlOf(shop)
        && single?.parties.buyer.avatarUrl === urlOf(buyer.pk) && !carriesPhoto(JSON.stringify(disputes)) && !carriesPhoto(JSON.stringify(single)),
        `the escrow disputes give both parties as their URLs (${dispute?.parties.buyer.avatarUrl}, ${dispute?.parties.seller.avatarUrl})`);

    console.log(`@@ ${JSON.stringify({ run, passed })}`);
    process.exit(0);
}

const role = process.argv[2];
if (role === 'seed-big' || role === 'serve' || role === 'rules-global' || role === 'lists-local') {
    const args = process.argv[3] ? JSON.parse(process.argv[3]) : null;
    const work = role === 'seed-big' ? seedBig(args) : role === 'serve' ? serve() : role === 'rules-global' ? rulesOnGlobal() : listsOnLocal();
    work.then(
        () => { if (role === 'seed-big') process.exit(0); },
        (e) => { console.error(e); process.exit(1); },
    );
} else {
    main().catch((e) => { console.error(e); process.exit(1); });
}

// ── The orchestrator ─────────────────────────────────────────────────────────────────────────────────────────────────

/** This file again, as a child: `role`, its args, on `dataDir`, under `profile`; the node flags it runs with (tsx's) and `nodeFlags`. */
function child(role: string, dataDir: string, profile: 'global' | 'local', args: unknown, nodeFlags: string[] = []): ChildProcess {
    const env: NodeJS.ProcessEnv = { ...process.env, BEANPOOL_DATA_DIR: dataDir };
    if (profile === 'global') env.NODE_PROFILE = 'global'; else delete env.NODE_PROFILE;
    return spawn(process.execPath, [...nodeFlags, ...process.execArgv, HERE, role, ...(args === null ? [] : [JSON.stringify(args)])], {
        cwd: path.dirname(path.dirname(HERE)),
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
    });
}

/** A child run to its end: its `@@` lines, and its other output echoed (a section's ✓ and ✗ lines). */
async function runToEnd(role: string, dataDir: string, profile: 'global' | 'local', args: unknown, echo = false): Promise<{ code: number | null; said: any[]; out: string }> {
    const p = child(role, dataDir, profile, args);
    let out = '';
    const said: any[] = [];
    readline.createInterface({ input: p.stdout! }).on('line', (line) => {
        out += line + '\n';
        if (line.startsWith('@@ ')) said.push(JSON.parse(line.slice(3)));
        else if (echo && /^(✓|✗|\n?—)/.test(line.trimStart())) console.log(line);
    });
    p.stderr!.on('data', (b) => { out += b; if (echo) process.stderr.write(b.toString().split('\n').filter((l: string) => l.startsWith('✗')).map((l: string) => l + '\n').join('')); });
    const code = await new Promise<number | null>((r) => p.on('exit', r));
    return { code, said, out };
}

interface Server { base: string; ask: (line: string) => Promise<any>; output: () => string; exited: () => boolean; stop: () => Promise<void> }

async function startServer(dataDir: string, profile: 'global' | 'local', heapMb: number): Promise<Server> {
    const p = child('serve', dataDir, profile, null, [`--max-old-space-size=${heapMb}`]);
    let out = '';
    let dead = false;
    const replies: ((m: any) => void)[] = [];
    let readyResolve!: (m: any) => void;
    const ready = new Promise<any>((r) => { readyResolve = r; });
    const exited = new Promise<void>((r) => p.on('exit', () => { dead = true; r(); }));
    readline.createInterface({ input: p.stdout! }).on('line', (line) => {
        out += line + '\n';
        if (!line.startsWith('@@ ')) return;
        const m = JSON.parse(line.slice(3));
        if (m.ready) readyResolve(m); else replies.shift()?.(m);
    });
    p.stderr!.on('data', (b) => { out += b; });
    const first = await Promise.race([ready, exited.then(() => null)]);
    if (!first) throw new Error(`the server exited before it was ready:\n${out.slice(-3000)}`);
    return {
        base: `https://localhost:${first.port}`,
        ask: (line) => new Promise((r) => { replies.push(r); p.stdin!.write(line + '\n'); }),
        output: () => out,
        exited: () => dead,
        stop: async () => { if (!dead) { p.stdin!.write('exit\n'); await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]); if (!dead) p.kill('SIGKILL'); } },
    };
}

async function main(): Promise<void> {
    const root = fs.mkdtempSync(path.join(process.env.BEANPOOL_DATA_DIR || os.tmpdir(), 'group-rosters-'));

    // ── 1. The heap ──────────────────────────────────────────────────────────────────────────────────────────────────
    // 6,400 members with a 20 KB photo each (27 KB stored) in one open group, and a 256 MB heap: the deciding review of
    // #1475 measured 6,402 crash a server of this size with one convenor's roster (FATAL ERROR, heap out of memory).
    console.log('\n— 1. one open group of 6,400 members with photos, read from a server held to a 256 MB heap (global profile) —');
    const N = 6_400, HEAP_MB = 256, BOUND_MB = 160;
    const convenor = newKey(), member = newKey();
    const heapDir = path.join(root, 'heap');
    fs.mkdirSync(heapDir, { recursive: true });
    const t0 = Date.now();
    const seeded = await runToEnd('seed-big', heapDir, 'global', { n: N, convenor: convenor.pk, member: member.pk });
    if (seeded.code !== 0 || !seeded.said[0]?.groupId) throw new Error(`seed-big exited ${seeded.code}:\n${seeded.out.slice(-3000)}`);
    const groupId = seeded.said[0].groupId as string;
    console.log(`  (seeded ${N} photo members into one group in ${Date.now() - t0} ms; state.db ${(fs.statSync(path.join(heapDir, 'state.db')).size / 2 ** 20).toFixed(0)} MB)`);
    const heapServer = await startServer(heapDir, 'global', HEAP_MB);
    let crashed = false;
    try {
        const read = async (label: string, who: Key, route: string) => {
            await heapServer.ask('peak');
            const f0 = performance.now();
            let res: Awaited<ReturnType<typeof call>> | null = null;
            let failed = '';
            try { res = await call(heapServer.base, 'GET', route, who); } catch (e: any) { failed = String(e?.cause?.code || e?.message || e); }
            const ms = performance.now() - f0;
            const peak = heapServer.exited() ? NaN : (await heapServer.ask('peak')).peak / 2 ** 20;
            const fatal = heapServer.output().split('\n').filter((l) => /FATAL|heap out of memory/.test(l)).slice(0, 2).join(' | ');
            crashed = heapServer.exited();
            assert(!crashed && res?.status === 200,
                `${label} answers (${res?.status ?? failed}, ${((res?.bytes.length ?? 0) / 2 ** 20).toFixed(2)} MB, ${ms.toFixed(0)} ms)${fatal ? `: ${fatal}` : ''}`);
            if (!crashed) assert(peak < BOUND_MB, `and the heap peaks at ${peak.toFixed(0)} MB while it does, under ${BOUND_MB} MB of its ${HEAP_MB} MB`);
            return res;
        };
        const roster = await read("the convenor's roster", convenor, `/api/groups/${groupId}/members`);
        if (!crashed) {
            const rows = roster?.status === 200 ? JSON.parse(roster.text) as any[] : [];
            const photoRows = rows.filter((r) => /^Roster\d+$/.test(r.callsign));
            assert(rows.length === N + 2 && photoRows.length === N && rows.every((r) => KEYED_URL(r.memberPubkey).test(r.avatarUrl ?? '') || (r.memberPubkey === member.pk && !('avatarUrl' in r))),
                `every one of the ${N + 2} rows is there, each photo as its keyed URL (${rows.length} rows)`);
            assert(!carriesPhoto(roster!.text), 'and no row carries a photo');
        }
        if (!crashed) {
            const byMember = await read("a member's roster", member, `/api/groups/${groupId}/members`);
            if (byMember) assert(!carriesPhoto(byMember.text) && (JSON.parse(byMember.text) as any[]).length === N + 2, 'a member gets the same roster, with no photo in it');
        }
        if (!crashed) {
            const cardRes = await read("the group's card", member, `/api/groups/${groupId}`);
            const listRes = await read('the list of groups', member, '/api/groups');
            if (cardRes && listRes) {
                const cardBody = JSON.parse(cardRes.text), listBody = JSON.parse(listRes.text) as any[];
                assert(KEYED_URL(convenor.pk).test(cardBody.convenorAvatarUrl ?? '') && cardBody.memberCount === N + 2
                    && KEYED_URL(convenor.pk).test(listBody.find((g) => g.id === groupId)?.convenorAvatarUrl ?? '')
                    && !carriesPhoto(cardRes.text) && !carriesPhoto(listRes.text),
                    "the card and the list give the convenor's face as their keyed URL, and no photo");
            }
        }
    } finally {
        await heapServer.stop();
    }
    if (crashed) {
        // Origin/main ends here: its roster sends every photo.
        console.log(`\n${passed}/${run} passed`);
        process.exit(1);
    }

    // ── 2 and 3: each in a process of its own, on its own profile ─────────────────────────────────────────────────────
    for (const [section, profile] of [['rules-global', 'global'], ['lists-local', 'local']] as const) {
        const dir = path.join(root, section);
        fs.mkdirSync(dir, { recursive: true });
        const res = await runToEnd(section, dir, profile, null, true);
        const tally = res.said.find((m) => typeof m.run === 'number');
        if (res.code !== 0 || !tally) {
            assert(false, `${section} ran to its end (exit ${res.code}):\n${res.out.slice(-3000)}`);
            continue;
        }
        run += tally.run;
        passed += tally.passed;
    }

    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}
