/**
 * The last lists that sent picture bytes (#1486, found by #1484's deciding review): groups' own pictures and crowdfunds.
 *
 * A group's own picture sat in its row and went out as stored in every group read, list and broadcast, unbounded: 100 open
 * groups with a 1.84 MB picture each ran a 256 MB heap out of memory on one read of the list of groups. Every crowdfund the
 * apps make has a projects row holding its photo, and the crowdfund list sent that photo for each one, and read every
 * projects row, photos and all, on every list. Now a group's picture is in group_pictures, its row keeps the reference, and
 * every read sends its URL (`/api/groups/:id/picture`, keyed on every node); the crowdfund list sends the enterprise's
 * photo as its URL and reads only the rows it lists, never their photos.
 *
 * Every server here is the real one, in a process of its own (this file, run as a child), so running out of heap ends the
 * child, not the suite:
 *   1. The heap. 2,000 groups with a 20 KB picture each and 120 with a 1.4 MB one (the newest), all led by one convenor,
 *      and 2,000 crowdfunds made as the apps make them (an enterprise and a projects row, each holding a 20 KB photo), on a
 *      server held to a 256 MB heap: the list of groups (a page of 50, and of 200), a group's card, "your groups", the
 *      group's chat, the picture itself, the crowdfund list and one crowdfund each answer, with URLs and no picture, and the
 *      heap's peak stays under a bound; then eight lists of 200 groups and eight crowdfund lists at once. On origin/main the
 *      first list of groups ends the process.
 *   2. Who gets what, on the global profile: the convenor, a member, an outsider, an invitee, a stranger, a visitor and an
 *      unsigned reader. Every group read and broadcast carries the picture's keyed URL and never the picture; the URL opens
 *      the picture's bytes as the web app and the phone ask for it, and only with its key; an invite-only group's URL goes
 *      to nobody outside it; a changed or removed picture's old URL opens nothing; an old app sending the URL back changes
 *      nothing; a picture past the member photo cap is refused.
 *   3. The local profile's crowdfunds, made as the phone (POST /api/enterprise) and the web app (POST /api/treasury) make
 *      them, and by POST /api/crowdfund/projects with three photos: the list gives each its enterprise's photo as its URL and
 *      no photo, to its maker and to another member; the one project's read still hands every photo out as stored.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-group-pictures-crowdfund-urls.ts
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
import WebSocket from 'ws';
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

type Res = { status: number; text: string; headers: Headers; bytes: Buffer; body: any };
/** A member's signed request, as the apps send one (the older request format, which every node still takes). */
async function call(base: string, method: 'GET' | 'POST' | 'PATCH', route: string, key: Key | null, body?: unknown): Promise<Res> {
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
    const text = bytes.toString('utf8');
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, headers: res.headers, bytes, body: parsed };
}

/** A picture's bytes anywhere in a body: a data URL, or a run of base64 as long as any picture's. */
const carriesPicture = (text: string) => /data:image\//i.test(text) || /[A-Za-z0-9+/]{2000}/.test(text);
/** A group's own picture as every group read hands it out: its route, its version and its key (keyed on every node). */
const GROUP_URL = (id: string) => new RegExp(`^/api/groups/${id}/picture\\?v=[0-9a-f]{8}&k=[A-Za-z0-9_-]{22}$`);
const PLAIN_AVATAR_URL = (pk: string) => new RegExp(`^/api/avatar/${pk}\\?size=thumb&v=[0-9a-f]{8}$`);

// ── The children ──────────────────────────────────────────────────────────────────────────────────────────────────────

const SMALL_GROUPS = 2_000, BIG_GROUPS = 120, CROWDFUNDS = 2_000;
const SMALL_BYTES = 20_000, BIG_BYTES = 1_400_000;

/**
 * 1's community, by the state engine's own writers: one convenor's 2,000 groups with a 20 KB picture and 120 with a
 * 1.4 MB one (made last, so the newest), a member in the newest, and one keeper's 2,000 crowdfunds made as
 * createEnterpriseHandler makes one (routes/treasury.ts: the enterprise, and a projects row holding its photo).
 */
async function seedHeap(a: { convenor: string; member: string; keeper: string }): Promise<void> {
    const se = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    se.initStateEngine();
    const insert = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invite_code, status) VALUES (?, ?, ?, ?, 'active')`);
    insert.run(a.convenor, 'Convenor', '2026-01-01T00:00:00.000Z', 'INV-CONVENOR');
    insert.run(a.member, 'Member', '2026-01-01T00:00:00.000Z', 'INV-MEMBER');
    insert.run(a.keeper, 'Keeper', '2026-01-01T00:00:00.000Z', 'INV-KEEPER');
    db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(a.keeper);
    const small = [1, 2, 3, 4].map((s) => dataUrl(jpeg(SMALL_BYTES, s)));
    db.transaction(() => {
        for (let i = 0; i < SMALL_GROUPS; i++) se.createGroup({ name: `Small ${i}`, createdBy: a.convenor, joinPolicy: 'open', avatarUrl: small[i % 4] });
    })();
    let newest = '';
    for (let i = 0; i < BIG_GROUPS; i++) {
        db.transaction(() => {
            newest = se.createGroup({ name: `Big ${i}`, createdBy: a.convenor, joinPolicy: 'open', avatarUrl: dataUrl(jpeg(BIG_BYTES, i)) }).id;
        })();
    }
    se.joinGroup(newest, a.member);
    const photo = dataUrl(jpeg(SMALL_BYTES, 9));
    const project = db.prepare(`INSERT OR IGNORE INTO projects (id, creator_pubkey, title, description, photos, goal_amount, deadline_at, status, migrated_at, enterprise_pubkey, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 500, NULL, 'ACTIVE', strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
    let lastFund = '';
    db.transaction(() => {
        for (let i = 0; i < CROWDFUNDS; i++) {
            const name = `Fund ${i}`;
            const res = se.createTreasury(name, photo, 0, { purpose: `Fund ${i}'s purpose`, lifecycle: 'bounded', goalAmount: 500, leadKeeperPubkey: a.keeper });
            project.run(res.publicKey, a.keeper, name, `Fund ${i}'s purpose`, JSON.stringify([photo]), res.publicKey);
            lastFund = res.publicKey;
        }
    })();
    db.pragma('wal_checkpoint(TRUNCATE)');
    process.stdout.write(`@@ ${JSON.stringify({ newest, lastFund })}\n`);
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
    // A picture a message quotes (a failing run's answer) is cut to its start.
    const said = msg.replace(/(data:image\/[a-z]+;base64,[A-Za-z0-9+/]{24})[A-Za-z0-9+/=]+/gi, '$1…');
    if (cond) { passed++; console.log(`✓ ${said}`); } else console.error(`✗ ${said}`);
}

/** The server in this process, for the sections that check answers rather than the heap. */
async function inProcessServer() {
    const { initTls } = await import('./services/tls.js');
    const { initAdminPassword } = await import('./config/local-config.js');
    const se = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { startHttpsServer } = await import('./https-server.js');
    initAdminPassword();
    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    return { base: `https://localhost:${port}`, se, db };
}

/** A member's signed socket (the live feed), collecting what it is sent. */
function socket(base: string, key: Key): Promise<{ ws: WebSocket; events: any[]; raw: string[] }> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const priv = crypto.createPrivateKey({ key: Buffer.from(key.priv, 'base64'), format: 'der', type: 'pkcs8' });
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), priv).toString('base64');
    const url = `${base.replace('https', 'wss')}/ws?pubkey=${key.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const s = { ws, events: [] as any[], raw: [] as string[] };
        ws.on('message', (d) => { const t = d.toString(); s.raw.push(t); try { s.events.push(JSON.parse(t)); } catch { /* not JSON */ } });
        ws.on('open', () => resolve(s));
        ws.on('error', reject);
    });
}
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

/** 2. Who gets what, on the global profile. Runs in its own process: the profile is decided at boot. */
async function rulesOnGlobal(): Promise<void> {
    const { base, se, db } = await inProcessServer();
    const insert = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invite_code, status) VALUES (?, ?, ?, ?, 'active')`);
    const [C, M, O, I] = Array.from({ length: 4 }, newKey);
    const visitor = newKey(), stranger = newKey();
    [[C, 'Cleo'], [M, 'Mira'], [O, 'Otto'], [I, 'Ivo']].forEach(([k, name], i) => insert.run((k as Key).pk, name as string, '2026-01-01T00:00:00.000Z', `INV-G${i}`));
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, is_visitor) VALUES (?, 'Vee', '2026-01-01T00:00:00.000Z', 'active', 1)`).run(visitor.pk);

    console.log('\n— 2. who gets what, on the global profile —');
    const sockM = await socket(base, M);
    const pictures = [3, 5, 7].map((s) => dataUrl(jpeg(6_000, s)));
    const made: Record<string, any> = {};
    for (const [name, joinPolicy, picture] of [['Open', 'open', pictures[0]], ['Ask', 'request_to_join', pictures[1]], ['Quiet', 'invite_only', pictures[2]]] as const) {
        const r = await call(base, 'POST', '/api/groups', C, { name, joinPolicy, avatarUrl: picture });
        made[name] = r.body;
        assert(r.status === 201 && GROUP_URL(r.body?.id).test(r.body?.avatarUrl ?? '') && !carriesPicture(r.text),
            `POST /api/groups (${joinPolicy}) answers with its picture's keyed URL and no picture (${r.status} ${r.body?.avatarUrl ?? r.text.slice(0, 120)})`);
    }
    const open = made.Open, ask = made.Ask, quiet = made.Quiet;
    const shipped = se.createGroup({ name: 'Shipped', createdBy: C.pk, joinPolicy: 'open', avatarUrl: 'bundled://leaf' });
    const plain = se.createGroup({ name: 'Plain', createdBy: C.pk, joinPolicy: 'open' });
    for (const g of [open, shipped, plain]) se.joinGroup(g.id, M.pk);
    se.joinGroup(ask.id, M.pk);
    se.approveGroupMember(ask.id, C.pk, M.pk);
    se.inviteGroupMember(quiet.id, C.pk, M.pk, 'member');
    se.joinGroup(quiet.id, M.pk);
    se.inviteGroupMember(quiet.id, C.pk, I.pk, 'member');
    await settle();
    const created = sockM.events.filter((e) => e.type === 'group_created' && e.group?.id === open.id);
    assert(created.length === 1 && GROUP_URL(open.id).test(created[0].group.avatarUrl ?? '') && !sockM.raw.some(carriesPicture),
        `a member's live feed hears group_created with the picture's keyed URL, and nothing it is sent carries a picture (${created[0]?.group?.avatarUrl})`);

    // Where the picture is held: group_pictures, or (origin/main, which this suite also runs on) the group's own row.
    const hasTable = !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'group_pictures'`).get();
    const stored = (id: string) => (hasTable
        ? db.prepare('SELECT picture FROM group_pictures WHERE group_id = ?').get(id) as { picture: string } | undefined
        : db.prepare('SELECT avatar_url AS picture FROM groups WHERE id = ? AND avatar_url IS NOT NULL').get(id) as { picture: string } | undefined)?.picture ?? null;
    const bytesOf = (picture: string) => Buffer.from(picture.slice(picture.indexOf(',') + 1), 'base64');
    assert(!!stored(open.id) && bytesOf(stored(open.id)!).subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
        && !(db.prepare(`SELECT 1 FROM pragma_table_info('groups') WHERE name = 'avatar_url'`).get()),
        'the picture is kept in group_pictures, out of the group\'s row (which has no avatar_url)');

    // Every read a member makes: URLs, never the picture.
    const want: Record<string, (u: unknown) => boolean> = {
        [open.id]: (u) => GROUP_URL(open.id).test(String(u)), [ask.id]: (u) => GROUP_URL(ask.id).test(String(u)),
        [quiet.id]: (u) => GROUP_URL(quiet.id).test(String(u)), [shipped.id]: (u) => u === 'bundled://leaf', [plain.id]: (u) => u === undefined || u === null,
    };
    const list = await call(base, 'GET', '/api/groups', M);
    const listed = (list.body ?? []) as any[];
    assert(list.status === 200 && Object.keys(want).every((id) => listed.some((g) => g.id === id && want[id](g.avatarUrl))) && !carriesPicture(list.text),
        `a member's list of groups: each picture its keyed URL, a shipped one its name, none none, and no picture (${listed.map((g) => g.avatarUrl ?? '—').join(', ')})`);
    for (const id of Object.keys(want)) {
        const card = await call(base, 'GET', `/api/groups/${id}`, M);
        assert(card.status === 200 && want[id](card.body?.avatarUrl) && !carriesPicture(card.text), `a member's read of ${card.body?.name}: ${card.body?.avatarUrl ?? 'no picture'}, no bytes`);
    }
    const yours = await call(base, 'GET', '/api/your-groups', M);
    const yourGroups = ((yours.body?.items ?? yours.body ?? []) as any[]).filter((x) => x.kind === 'group');
    assert(yours.status === 200 && Object.keys(want).every((id) => yourGroups.some((g) => g.id === id && want[id](g.avatarUrl ?? undefined))) && !carriesPicture(yours.text),
        `"your groups": each picture its keyed URL, and no picture (${yourGroups.map((g) => g.avatarUrl ?? '—').join(', ')})`);
    const chat = await call(base, 'GET', `/api/groups/${open.id}/chat`, M);
    assert(chat.status === 200 && GROUP_URL(open.id).test(chat.body?.group?.avatarUrl ?? '') && !carriesPicture(chat.text),
        `the group's chat names its picture by its keyed URL (${chat.body?.group?.avatarUrl})`);

    // The URL opens the picture, as the web app asks for it and as the phone does (its &_v= after the key).
    const url: string = open.avatarUrl;
    const asWeb = await call(base, 'GET', url, null);
    const asPhone = await call(base, 'GET', `${url}&_v=1767225600000`, null);
    const want0 = bytesOf(stored(open.id)!);
    assert(asWeb.status === 200 && asWeb.bytes.equals(want0) && asWeb.headers.get('content-type') === 'image/jpeg'
        && asWeb.headers.get('x-content-type-options') === 'nosniff' && /private/.test(asWeb.headers.get('cache-control') ?? ''),
        `the URL opens the picture's bytes, as a JPEG, nosniff, kept by no shared cache (${asWeb.status}, ${asWeb.bytes.length} B, ${asWeb.headers.get('cache-control')})`);
    assert(asPhone.status === 200 && asPhone.bytes.equals(want0), `and as the phone asks for it, with its &_v= after the key (${asPhone.status})`);
    const etag = asWeb.headers.get('etag');
    const again = await fetch(`${base}${url}`, { headers: { 'If-None-Match': etag ?? '' } });
    assert(!!etag && again.status === 304, `asked again with its ETag: 304 (${again.status})`);

    // Only with its key: none, a wrong one, another group's, a key for an id no group has: each answers as no picture.
    const noKey = url.replace(/&k=[^&]+/, '');
    const askKey = /&k=([^&]+)/.exec(ask.avatarUrl)![1];
    const refusals = await Promise.all([
        call(base, 'GET', noKey, null), call(base, 'GET', noKey, M), call(base, 'GET', url.replace(/&k=[^&]+/, '&k=AAAAAAAAAAAAAAAAAAAAAA'), null),
        call(base, 'GET', `${noKey}&k=${askKey}`, null), call(base, 'GET', `/api/groups/${crypto.randomUUID()}/picture?v=00000000&k=${askKey}`, null),
        call(base, 'GET', `/api/groups/${plain.id}/picture?v=00000000&k=${askKey}`, null),
    ]);
    assert(refusals.every((r) => r.status === 404 && r.text === refusals[0].text) && refusals.every((r) => !r.bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))),
        `without its key, with a wrong one or another group's, for no such group and for a group with none: 404 alike (${refusals.map((r) => r.status).join(', ')})`);

    // Who may see the group is who gets the URL: an invite-only group's goes to nobody outside it.
    const outsiderList = await call(base, 'GET', '/api/groups', O);
    const outsiderCard = await call(base, 'GET', `/api/groups/${quiet.id}`, O);
    assert(outsiderList.status === 200 && !outsiderList.text.includes(quiet.id) && !outsiderList.text.includes(`/api/groups/${quiet.id}/picture`)
        && outsiderCard.status === 404 && !outsiderCard.text.includes('/picture'),
        `an outsider's list leaves the invite-only group out and its card is 404: no URL for its picture (${outsiderCard.status})`);
    const outsiderOpen = await call(base, 'GET', `/api/groups/${open.id}`, O);
    assert(outsiderOpen.status === 200 && GROUP_URL(open.id).test(outsiderOpen.body?.avatarUrl ?? ''), 'an outsider sees an open group\'s card, its picture by its URL, as before');
    const invitee = await call(base, 'GET', `/api/groups/${quiet.id}`, I);
    assert(invitee.status === 200 && GROUP_URL(quiet.id).test(invitee.body?.avatarUrl ?? '') && !carriesPicture(invitee.text),
        `its invitee sees its card (the invite landing), the picture by its URL (${invitee.body?.avatarUrl})`);
    const nobody = await Promise.all([call(base, 'GET', '/api/groups', null), call(base, 'GET', '/api/groups', visitor), call(base, 'GET', '/api/groups', stranger),
        call(base, 'GET', `/api/groups/${open.id}`, null), call(base, 'GET', `/api/groups/${open.id}`, visitor), call(base, 'GET', `/api/groups/${open.id}`, stranger)]);
    assert(nobody.every((r) => r.status === 401 || r.status === 403) && nobody.every((r) => !r.text.includes('/picture')),
        `an unsigned reader, a visitor and a signed stranger read no group at all, so get no URL (${nobody.map((r) => r.status).join(', ')})`);

    // An old app sends the URL back (an edit that read the group): unchanged. A new picture is a new URL; the old one opens nothing.
    const before = stored(open.id);
    const sentBack = await call(base, 'PATCH', `/api/groups/${open.id}`, C, { name: 'Open again', avatarUrl: `${base}${url}&_v=1767225600000` });
    assert(sentBack.status === 200 && sentBack.body?.group?.name === 'Open again' && sentBack.body?.group?.avatarUrl === url && stored(open.id) === before,
        `its own URL sent back with a new name, as an old app might, leaves the picture as it was (${sentBack.status} ${sentBack.body?.group?.avatarUrl})`);
    sockM.events.length = 0;
    sockM.raw.length = 0;
    const changed = await call(base, 'PATCH', `/api/groups/${open.id}`, C, { avatarUrl: dataUrl(jpeg(7_000, 11)) });
    const newUrl: string = changed.body?.group?.avatarUrl ?? '';
    await settle();
    const updated = sockM.events.filter((e) => e.type === 'group_updated' && e.group?.id === open.id);
    assert(changed.status === 200 && GROUP_URL(open.id).test(newUrl) && newUrl !== url && stored(open.id) !== before && !carriesPicture(changed.text),
        `a new picture: a new keyed URL in the answer, no picture (${newUrl})`);
    assert(updated.length >= 1 && updated.every((e) => e.group.avatarUrl === newUrl) && !sockM.raw.some(carriesPicture),
        `and group_updated carries the new URL to the members' live feeds, never the picture (${updated.length} heard)`);
    const oldNow = await call(base, 'GET', url, null);
    const newNow = await call(base, 'GET', newUrl, null);
    assert(oldNow.status === 404 && newNow.status === 200 && newNow.bytes.equals(bytesOf(stored(open.id)!)), `the old URL opens nothing (${oldNow.status}); the new one opens the new picture (${newNow.status})`);
    const removed = await call(base, 'PATCH', `/api/groups/${open.id}`, C, { avatarUrl: '' });
    const afterRemoval = await call(base, 'GET', newUrl, null);
    const cardNow = await call(base, 'GET', `/api/groups/${open.id}`, M);
    assert(removed.status === 200 && removed.body?.group?.avatarUrl === undefined && stored(open.id) === null && afterRemoval.status === 404
        && cardNow.body?.avatarUrl === undefined,
        `a removed picture: no URL in any read, no row left, and its last URL opens nothing (${afterRemoval.status})`);

    // The cap on the way in: a member's photo cap, 2 MB of image bytes. (Over HTTP the 2 MB body cap comes first.)
    const fits = dataUrl(jpeg(1_000_000, 13));
    const big = await call(base, 'PATCH', `/api/groups/${ask.id}`, C, { avatarUrl: fits });
    assert(big.status === 200 && GROUP_URL(ask.id).test(big.body?.group?.avatarUrl ?? '') && (stored(ask.id)?.length ?? 0) > 1_300_000,
        `a 1 MB picture, under the cap, is taken (${big.status})`);
    let refused = '';
    try { se.updateGroup(ask.id, C.pk, { avatarUrl: dataUrl(jpeg(2 * 1024 * 1024 + 1, 15)) }); } catch (e: any) { refused = String(e?.message); }
    assert(/too large/.test(refused) && GROUP_URL(ask.id).test(se.getGroup(ask.id)?.avatarUrl ?? ''), `one past 2 MB of image bytes is refused, and the group keeps its picture (${refused})`);

    sockM.ws.close();
    console.log(`@@ ${JSON.stringify({ run, passed })}`);
    process.exit(0);
}

/** 3. The local profile's crowdfunds, made as the apps make them. */
async function crowdfundsOnLocal(): Promise<void> {
    const { base, db } = await inProcessServer();
    const insert = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invite_code, status) VALUES (?, ?, ?, ?, 'active')`);
    const K = newKey(), R = newKey(), visitor = newKey();
    insert.run(K.pk, 'Kit', '2026-01-01T00:00:00.000Z', 'INV-K');
    insert.run(R.pk, 'Rue', '2026-01-01T00:00:00.000Z', 'INV-R');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, is_visitor) VALUES (?, 'Vee', '2026-01-01T00:00:00.000Z', 'active', 1)`).run(visitor.pk);

    console.log('\n— 3. the local profile\'s crowdfunds, made as the apps make them —');
    const [p1, p2, p3] = [21, 22, 23].map((s) => dataUrl(jpeg(8_000, s)));
    // The phone (propose-project.tsx → createEnterpriseApi): its photos, the first as the avatar, to POST /api/enterprise.
    const phone = await call(base, 'POST', '/api/enterprise', K, { name: 'Phone fund', purpose: 'A roof', lifecycle: 'bounded', goalAmount: 500, photos: [p1, p2], avatar: p1 });
    // The web app (ProjectsPage → createEnterprise): one photo, as photos and avatar, to POST /api/treasury.
    const web = await call(base, 'POST', '/api/treasury', K, { name: 'Web fund', purpose: 'A well', lifecycle: 'bounded', goalAmount: 300, photos: [p2], avatar: p2 });
    // No app, but a route: up to ten photos of its own.
    const direct = await call(base, 'POST', '/api/crowdfund/projects', K, { creatorPubkey: K.pk, title: 'Route fund', description: 'A bridge', photos: [p3, p1, p2], goalAmount: 900 });
    const ids = [phone.body?.publicKey, web.body?.publicKey, direct.body?.project?.id].filter(Boolean) as string[];
    assert(phone.status === 200 && web.status === 200 && direct.status < 300 && ids.length === 3,
        `three crowdfunds made: by the phone's route, the web app's and the crowdfund route (${phone.status}, ${web.status}, ${direct.status} ${direct.text.slice(0, 80)})`);
    const projectsPhotos = (db.prepare(`SELECT id, photos FROM projects WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as { id: string; photos: string }[]);
    assert(projectsPhotos.length === 3 && projectsPhotos.every((p) => carriesPicture(p.photos)), 'each has a projects row holding its photos themselves, as the apps\' crowdfunds do');

    const urlOf = (pk: string) => {
        const ref = (db.prepare('SELECT avatar_ref FROM members WHERE public_key = ?').get(pk) as any)?.avatar_ref;
        return ref ? `/api/avatar/${pk}?size=thumb&v=${ref}` : null;
    };
    for (const [who, key] of [['its maker', K], ['another member', R]] as const) {
        const list = await call(base, 'GET', '/api/crowdfund/projects', key);
        const rows = (list.body?.projects ?? []) as any[];
        const ours = ids.map((id) => rows.find((p) => p.id === id));
        assert(list.status === 200 && ours.every((p, i) => !!p && p.photos === JSON.stringify([urlOf(ids[i])]) && PLAIN_AVATAR_URL(ids[i]).test(urlOf(ids[i]) ?? ''))
            && !carriesPicture(list.text),
            `the crowdfund list, read by ${who}: each one's photos is its enterprise's photo as its URL, and no photo (${ours.map((p) => p?.photos).join(' ')})`);
    }
    const shut = await Promise.all([call(base, 'GET', '/api/crowdfund/projects', null), call(base, 'GET', '/api/crowdfund/projects', visitor)]);
    assert(shut.every((r) => r.status === 401 || r.status === 403), `an unsigned reader and a visitor read no crowdfund (${shut.map((r) => r.status).join(', ')})`);
    const opened = await call(base, 'GET', urlOf(ids[0])!, null);
    const avatarStored = (db.prepare('SELECT photo FROM member_photos WHERE public_key = ?').get(ids[0]) as { photo: string }).photo;
    assert(opened.status === 200 && opened.bytes.equals(Buffer.from(avatarStored.slice(avatarStored.indexOf(',') + 1), 'base64')),
        `that URL opens the crowdfund's photo (${opened.status})`);
    for (const [i, label] of [[0, 'the phone\'s'], [2, 'the route\'s, with three photos']] as const) {
        const one = await call(base, 'GET', `/api/crowdfund/projects/${ids[i]}`, R);
        const held = JSON.parse(projectsPhotos.find((p) => p.id === ids[i])!.photos);
        assert(one.status === 200 && one.body?.project?.photos === JSON.stringify(held), `${label} own read still hands out every photo as stored (${held.length}): a read of one`);
    }

    console.log(`@@ ${JSON.stringify({ run, passed })}`);
    process.exit(0);
}

/** A section that throws part way (on origin/main, a picture with no URL to open) counts as one more failed check. */
async function counted(section: () => Promise<void>): Promise<void> {
    try {
        await section();
    } catch (e: any) {
        assert(false, `the section stopped: ${String(e?.message ?? e).slice(0, 200)}`);
        console.log(`@@ ${JSON.stringify({ run, passed })}`);
        process.exit(1);
    }
}

const role = process.argv[2];
if (role === 'seed-heap' || role === 'serve' || role === 'rules-global' || role === 'crowdfunds-local') {
    const args = process.argv[3] ? JSON.parse(process.argv[3]) : null;
    const work = role === 'seed-heap' ? seedHeap(args) : role === 'serve' ? serve() : role === 'rules-global' ? counted(rulesOnGlobal) : counted(crowdfundsOnLocal);
    work.then(
        () => { if (role === 'seed-heap') process.exit(0); },
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
        ask: (line) => new Promise((r) => { if (dead) { r({ peak: NaN }); return; } replies.push(r); p.stdin!.write(line + '\n'); }),
        output: () => out,
        exited: () => dead,
        stop: async () => { if (!dead) { p.stdin!.write('exit\n'); await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]); if (!dead) p.kill('SIGKILL'); } },
    };
}

async function main(): Promise<void> {
    const root = fs.mkdtempSync(path.join(process.env.BEANPOOL_DATA_DIR || os.tmpdir(), 'group-pictures-'));

    // ── 1. The heap ──────────────────────────────────────────────────────────────────────────────────────────────────
    console.log(`\n— 1. ${SMALL_GROUPS + BIG_GROUPS} groups and ${CROWDFUNDS} crowdfunds with full-size pictures, read from a server held to a 256 MB heap —`);
    const HEAP_MB = 256, BOUND_MB = 128, AT_ONCE = 8, AT_ONCE_BOUND_MB = 200;
    const convenor = newKey(), member = newKey(), keeper = newKey();
    const heapDir = path.join(root, 'heap');
    fs.mkdirSync(heapDir, { recursive: true });
    const t0 = Date.now();
    const seeded = await runToEnd('seed-heap', heapDir, 'local', { convenor: convenor.pk, member: member.pk, keeper: keeper.pk });
    if (seeded.code !== 0 || !seeded.said[0]?.newest) throw new Error(`seed-heap exited ${seeded.code}:\n${seeded.out.slice(-3000)}`);
    const { newest, lastFund } = seeded.said[0] as { newest: string; lastFund: string };
    console.log(`  (seeded in ${Date.now() - t0} ms; state.db ${(fs.statSync(path.join(heapDir, 'state.db')).size / 2 ** 20).toFixed(0)} MB)`);
    const server = await startServer(heapDir, 'local', HEAP_MB);
    let crashed = false;
    try {
        const read = async (label: string, who: Key | null, route: string, check: (r: Res) => [boolean, string]) => {
            await server.ask('peak');
            const f0 = performance.now();
            let res: Res | null = null;
            let failed = '';
            try { res = await call(server.base, 'GET', route, who); } catch (e: any) { failed = String(e?.cause?.code || e?.message || e); }
            const ms = performance.now() - f0;
            const peak = server.exited() ? NaN : (await server.ask('peak')).peak / 2 ** 20;
            const fatal = server.output().split('\n').filter((l) => /FATAL|heap out of memory/.test(l)).slice(0, 2).join(' | ');
            crashed = server.exited();
            assert(!crashed && res?.status === 200,
                `${label} answers (${res?.status ?? failed}, ${((res?.bytes.length ?? 0) / 2 ** 20).toFixed(2)} MB, ${ms.toFixed(0)} ms)${fatal ? `: ${fatal}` : ''}`);
            if (crashed || !res) return;
            const [ok, said] = check(res);
            assert(ok, `  ${said}`);
            assert(peak < BOUND_MB, `  and the heap peaks at ${peak.toFixed(0)} MB while it does, under ${BOUND_MB} MB of its ${HEAP_MB} MB`);
        };
        const noPicture = (r: Res): [boolean, string] => [!carriesPicture(r.text), 'no picture in it'];
        const groupsRight = (n: number) => (r: Res): [boolean, string] => {
            const rows = (r.body ?? []) as any[];
            return [rows.length === n && rows.every((g) => GROUP_URL(g.id).test(g.avatarUrl ?? '')) && !carriesPicture(r.text),
                `${rows.length} groups, each picture its keyed URL, no picture in it`];
        };
        await read('the list of groups, a page of 50 (the 1.4 MB pictures)', member, '/api/groups', groupsRight(50));
        if (!crashed) await read('the list of groups, a page of 200', member, '/api/groups?limit=200', groupsRight(200));
        if (!crashed) await read("the newest group's card", member, `/api/groups/${newest}`, (r) => [GROUP_URL(newest).test(r.body?.avatarUrl ?? '') && !carriesPicture(r.text), `its picture its URL (${r.body?.avatarUrl})`]);
        if (!crashed) await read(`the convenor's "your groups" (all ${SMALL_GROUPS + BIG_GROUPS} of them)`, convenor, '/api/your-groups', (r) => {
            const items = ((r.body?.items ?? r.body ?? []) as any[]).filter((x) => x.kind === 'group');
            return [items.length === SMALL_GROUPS + BIG_GROUPS && items.every((g) => GROUP_URL(g.id).test(g.avatarUrl ?? '')) && !carriesPicture(r.text), `${items.length} groups, each by its URL, no picture`];
        });
        if (!crashed) await read("the newest group's chat", member, `/api/groups/${newest}/chat`, (r) => [GROUP_URL(newest).test(r.body?.group?.avatarUrl ?? '') && !carriesPicture(r.text), 'its header names the picture by its URL']);
        if (!crashed) {
            const card = await call(server.base, 'GET', `/api/groups/${newest}`, member);
            await read('its 1.4 MB picture, by its URL', null, card.body?.avatarUrl ?? `/api/groups/${newest}/picture`, (r) =>
                [r.headers.get('content-type') === 'image/jpeg' && r.bytes.length > BIG_BYTES - 10_000 && r.bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), `the picture's ${r.bytes.length} bytes, as a JPEG`]);
        }
        if (!crashed) await read(`the crowdfund list (${CROWDFUNDS} made, 200 listed)`, member, '/api/crowdfund/projects', (r) => {
            const rows = (r.body?.projects ?? []) as any[];
            return [rows.length === 200 && rows.every((p) => { const ph = JSON.parse(p.photos); return ph.length === 1 && PLAIN_AVATAR_URL(p.id).test(ph[0]); }) && !carriesPicture(r.text),
                `${rows.length} crowdfunds, each one's photo its URL, no photo in it`];
        });
        if (!crashed) await read('one crowdfund (a read of one: its photo as stored)', member, `/api/crowdfund/projects/${lastFund}`, (r) => [JSON.parse(r.body?.project?.photos ?? '[]')[0]?.startsWith('data:image/jpeg') === true, 'its photo as stored']);
        for (const [label, route] of [['lists of 200 groups', '/api/groups?limit=200'], ['crowdfund lists', '/api/crowdfund/projects']] as const) {
            if (crashed) break;
            await server.ask('peak');
            const f0 = performance.now();
            const all = await Promise.all(Array.from({ length: AT_ONCE }, () => call(server.base, 'GET', route, member).catch((e) => ({ status: 0, text: String(e?.cause?.code || e) } as Res))));
            const ms = performance.now() - f0;
            crashed = server.exited();
            const peak = crashed ? NaN : (await server.ask('peak')).peak / 2 ** 20;
            assert(!crashed && all.every((r) => r.status === 200 && !carriesPicture(r.text)) && peak < AT_ONCE_BOUND_MB,
                `${AT_ONCE} ${label} at once: ${all.map((r) => r.status).join(' ')}, ${ms.toFixed(0)} ms, heap peak ${peak.toFixed(0)} MB (under ${AT_ONCE_BOUND_MB})`);
        }
    } finally {
        await server.stop();
    }
    if (crashed) {
        // Origin/main ends here: its list of groups sends every picture.
        console.log(`\n${passed}/${run} passed`);
        process.exit(1);
    }
    fs.rmSync(heapDir, { recursive: true, force: true });

    // ── 2 and 3: each in a process of its own, on its own profile ─────────────────────────────────────────────────────
    for (const [section, profile] of [['rules-global', 'global'], ['crowdfunds-local', 'local']] as const) {
        const dir = path.join(root, section);
        fs.mkdirSync(dir, { recursive: true });
        const res = await runToEnd(section, dir, profile, null, true);
        const tally = res.said.find((m) => typeof m.run === 'number');
        if (tally && res.code !== 0 && tally.passed === tally.run) {
            assert(false, `${section} ran to its end (exit ${res.code}):\n${res.out.slice(-3000)}`);
        }
        if (!tally) {
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
