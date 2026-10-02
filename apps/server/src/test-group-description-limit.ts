/**
 * Group descriptions get a size limit, and so does the other free text a list sends for every row (#1493, global launch).
 *
 * A group's description was bounded by nothing but the 2 MB request body, and every group read sent it whole. #1490's
 * deciding review measured it on NODE_PROFILE=global under a 256 MB heap: 100 open groups with a 1.9 MB description each
 * made the list of groups a 90 MB answer, and a page of 200 ran the node out of memory. Now a new description is held to
 * 2,000 characters (6,000 bytes in any script) when it is written; a list of groups and a group_created / group_updated
 * broadcast send at most a 300-character preview of one, marked `descriptionTruncated`; the group's card sends it whole;
 * and a description stored before the limit is kept as it is, on this node and in a standby's copy.
 *
 * Every server here is the real one, in a process of its own (this file, run as a child), so running out of heap ends the
 * child, not the suite:
 *   1. The heap, on the global profile, held to 256 MB. 100 open groups whose descriptions were stored before the limit at
 *      1.9 MB each (the newest), and 1,000 at the new limit (2,000 Chinese characters, 6,000 bytes), one convenor, a member
 *      in 200 of them: the list of groups (a page of 50, and of 200), a search that matches the end of an old description,
 *      a group's card (all 1.9 MB of it), "your groups", eight lists at once, and the group_updated a member's live feed
 *      hears. Each answers, bounded, and the heap's peak stays under a bound. On origin/main the page of 200 ends the process.
 *   2. Writes on the global profile, as the apps send them: a description at the limit in Latin, Chinese and emoji is
 *      taken, one past it (and one of 1.9 MB) is refused in the words both apps show and nothing is written; a description
 *      that is not text is refused as such; an edit past the limit is refused; a description stored before the limit
 *      survives a rename, its own text sent back and the list's preview sent back. The other text the global profile's
 *      lists send: a listing's title, description and category, and a member's contact.
 *   3. Writes on the local profile (Beans, enterprises and Decisions are off on global): an enterprise's name and purpose,
 *      a crowdfund's, the note with Beans and with a pledge, a Decision's title and description.
 *   4. A standby's copy: a description stored before the limit, one at it and one in emoji are copied byte for byte and
 *      hash as the main node's; no row is dropped, not even one whose description is not text; the copy's list sends the
 *      preview and its card the whole text.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) TMPDIR=$(mktemp -d) node --import tsx src/test-group-description-limit.ts
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

// What the apps are told, written out here so this suite runs (and fails) on a tree without them.
const DESCRIPTION_TOO_LONG = "A group's description can be at most 2,000 characters. Please shorten it.";
const DESCRIPTION_NOT_TEXT = "A group's description must be text.";
const tooLong = (what: string, chars: number) => `${what} can be at most ${chars.toLocaleString('en-US')} characters. Please shorten it.`;

const MAX = 2_000;
const PREVIEW = 300;
/** A description stored before the limit, as #1490's review measured: 1.9 MB. */
const OLD_BYTES = 1_900_000;
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
/** When every member here joined: a month before the run. */
const JOINED = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

type Key = { pk: string; priv: string };
function newKey(): Key {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
}

type Res = { status: number; text: string; bytes: number; body: any };
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
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, bytes: buf.length, body: parsed };
}

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const short = (s: unknown) => String(s ?? '').slice(0, 140);

/** A member's signed socket (the live feed), collecting what it is sent. */
function socket(base: string, key: Key): Promise<{ ws: WebSocket; events: any[]; raw: string[] }> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const priv = crypto.createPrivateKey({ key: Buffer.from(key.priv, 'base64'), format: 'der', type: 'pkcs8' });
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), priv).toString('base64');
    const url = `${base.replace('https', 'wss')}/ws?pubkey=${key.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false, maxPayload: 64 * 1024 * 1024 });
        const s = { ws, events: [] as any[], raw: [] as string[] };
        ws.on('message', (d) => { const t = d.toString(); s.raw.push(t); try { s.events.push(JSON.parse(t)); } catch { /* not JSON */ } });
        ws.on('open', () => resolve(s));
        ws.on('error', reject);
    });
}

// ── The children ──────────────────────────────────────────────────────────────────────────────────────────────────────

const OLD_GROUPS = 100, AT_MAX_GROUPS = 1_000;
const AT_MAX_TEXT = (i: number) => `${i}`.padEnd(MAX, '组');

/**
 * 1's community, by the state engine's own writers: one convenor's 1,000 groups at the new limit, then 100 whose
 * descriptions were stored before it, at 1.9 MB (the newest: the touch trigger stamps the rewrite), written into their rows
 * in SQLite as a node that took them holds them. A member is in all 100 old ones and the 100 newest at the limit.
 */
async function seedHeap(a: { convenor: string; member: string }): Promise<void> {
    const se = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    se.initStateEngine();
    const insert = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invite_code, status) VALUES (?, ?, ?, ?, 'active')`);
    insert.run(a.convenor, 'Convenor', JOINED, 'INV-CONVENOR');
    insert.run(a.member, 'Member', JOINED, 'INV-MEMBER');
    const atMax: string[] = [];
    db.transaction(() => {
        for (let i = 0; i < AT_MAX_GROUPS; i++) atMax.push(se.createGroup({ name: `At the limit ${i}`, createdBy: a.convenor, joinPolicy: 'open', description: AT_MAX_TEXT(i) }).id);
    })();
    const old: string[] = [];
    const stored = db.prepare(`UPDATE groups SET description = ? || hex(zeroblob(?)) || ? WHERE id = ?`);
    for (let i = 0; i < OLD_GROUPS; i++) {
        db.transaction(() => {
            const g = se.createGroup({ name: `Old ${i}`, createdBy: a.convenor, joinPolicy: 'open', description: 'Short for now' });
            stored.run(`Old ${i}: `, (OLD_BYTES - 40) / 2, ` tailword${i}`, g.id);
            old.push(g.id);
        })();
    }
    for (const id of [...old, ...atMax.slice(-100)]) se.joinGroup(id, a.member);
    const first = db.prepare('SELECT description FROM groups WHERE id = ?').get(old[OLD_GROUPS - 1]) as { description: string };
    db.pragma('wal_checkpoint(TRUNCATE)');
    process.stdout.write(`@@ ${JSON.stringify({ newestOld: old[OLD_GROUPS - 1], newestOldSha: sha(first.description), newestOldLength: first.description.length, atMax: atMax[AT_MAX_GROUPS - 1] })}\n`);
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
    const insert = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invite_code, status) VALUES (?, ?, ?, ?, 'active')`);
    const member = (name: string): Key => { const k = newKey(); insert.run(k.pk, name, JOINED, `INV-${name}`); return k; };
    return { base: `https://localhost:${port}`, se, db, member };
}

/** 2. Writes on the global profile. Runs in its own process: the profile is decided at boot. */
async function rulesOnGlobal(): Promise<void> {
    const { base, db, member } = await inProcessServer();
    const [C, D, E, F, M] = ['Cleo', 'Dara', 'Eli', 'Fen', 'Mira'].map(member);
    // The marketplace asks for a profile photo before a member's first listing.
    const { setMemberPhoto } = await import('@beanpool/engine');
    setMemberPhoto(db, M.pk, TINY_PNG);
    const sockM = await socket(base, M);
    const storedDescription = (id: string) => (db.prepare('SELECT description FROM groups WHERE id = ?').get(id) as { description: string | null } | undefined)?.description ?? null;
    const groupsNamed = (name: string) => (db.prepare('SELECT COUNT(*) AS n FROM groups WHERE name = ?').get(name) as { n: number }).n;

    console.log('\n— 2. writes on the global profile, as the apps send them —');
    const latin = 'a'.repeat(MAX), chinese = '组'.repeat(MAX), emoji = '🌱'.repeat(MAX / 2);
    const made: Record<string, any> = {};
    for (const [who, label, text] of [[C, 'Latin', latin], [D, 'Chinese (6,000 bytes)', chinese], [E, 'emoji', emoji]] as const) {
        const r = await call(base, 'POST', '/api/groups', who, { name: `At the limit, ${label}`, joinPolicy: 'open', description: text });
        made[label] = r.body;
        const card = await call(base, 'GET', `/api/groups/${r.body?.id}`, M);
        assert(r.status === 201 && card.body?.description === text && card.body?.descriptionTruncated === undefined,
            `a description at the limit in ${label} is taken, and the group's card sends all of it (${r.status} ${card.body?.description?.length})`);
    }
    await settle();
    const created = sockM.events.filter((e) => e.type === 'group_created' && e.group?.id === made.Latin?.id);
    assert(created.length === 1 && created[0].group.description === `${'a'.repeat(PREVIEW)}…` && created[0].group.descriptionTruncated === true
        && sockM.raw.every((t) => Buffer.byteLength(t) < 8_000),
        `a member's live feed hears group_created with the description's 300-character preview, marked (${created[0]?.group?.description?.length}, largest frame ${Math.max(...sockM.raw.map((t) => Buffer.byteLength(t)))} B)`);
    const list = await call(base, 'GET', '/api/groups', M);
    const listed = (id: string) => ((list.body ?? []) as any[]).find((g) => g.id === id);
    assert(list.status === 200 && listed(made.Latin?.id)?.description === `${'a'.repeat(PREVIEW)}…` && listed(made.Latin?.id)?.descriptionTruncated === true
        && listed(made['Chinese (6,000 bytes)']?.id)?.description === `${'组'.repeat(PREVIEW)}…` && listed(made.emoji?.id)?.description === `${'🌱'.repeat(PREVIEW / 2)}…`,
        `the list of groups sends each one's preview, marked, never half an emoji (${short(listed(made.emoji?.id)?.description?.length)})`);
    const form = await call(base, 'POST', '/api/groups', F, { name: 'As the form sends it', joinPolicy: 'open', description: 'f'.repeat(PREVIEW) });
    const formListed = ((await call(base, 'GET', '/api/groups', M)).body as any[] ?? []).find((g) => g.id === form.body?.id);
    assert(form.status === 201 && formListed?.description === 'f'.repeat(PREVIEW) && formListed?.descriptionTruncated === undefined,
        'a description as long as either app\'s form takes (300) is sent whole by the list, unmarked');

    // Past the limit: refused in the words both apps show, and nothing written.
    const over = await call(base, 'POST', '/api/groups', C, { name: 'One too many', joinPolicy: 'open', description: 'b'.repeat(MAX + 1) });
    assert(over.status === 400 && over.body?.error === DESCRIPTION_TOO_LONG && groupsNamed('One too many') === 0,
        `2,001 characters: 400 "${short(over.body?.error)}", and no group (${over.status})`);
    const overChinese = await call(base, 'POST', '/api/groups', C, { name: 'One too many, Chinese', joinPolicy: 'open', description: '组'.repeat(MAX + 1) });
    assert(overChinese.status === 400 && overChinese.body?.error === DESCRIPTION_TOO_LONG, `2,001 Chinese characters (6,003 bytes): refused (${overChinese.status})`);
    const huge = await call(base, 'POST', '/api/groups', D, { name: 'The old size', joinPolicy: 'open', description: 'c'.repeat(OLD_BYTES) });
    assert(huge.status === 400 && huge.body?.error === DESCRIPTION_TOO_LONG && groupsNamed('The old size') === 0,
        `1.9 MB, as #1490's review sent: 400, and no group (${huge.status} ${short(huge.body?.error)})`);
    const notText = await call(base, 'POST', '/api/groups', E, { name: 'Not words', joinPolicy: 'open', description: { a: 1 } });
    assert(notText.status === 400 && notText.body?.error === DESCRIPTION_NOT_TEXT, `a description that is not text: 400 "${short(notText.body?.error)}"`);

    // An edit past the limit is refused and changes nothing; one at it is taken.
    const g = made.Latin;
    const editOver = await call(base, 'PATCH', `/api/groups/${g?.id}`, C, { name: 'Renamed too', description: 'd'.repeat(MAX + 1) });
    const after = await call(base, 'GET', `/api/groups/${g?.id}`, C);
    assert(editOver.status === 400 && editOver.body?.error === DESCRIPTION_TOO_LONG && after.body?.description === latin && after.body?.name === 'At the limit, Latin',
        `an edit to 2,001 characters: 400, and the name and description are as they were (${editOver.status})`);
    const editAt = await call(base, 'PATCH', `/api/groups/${g?.id}`, C, { description: 'e'.repeat(MAX) });
    assert(editAt.status === 200 && editAt.body?.group?.description === 'e'.repeat(MAX), `an edit to 2,000 characters is taken (${editAt.status})`);

    // A description stored before the limit: kept through a rename, its own text sent back, and the list's preview sent back.
    const oldOne = await call(base, 'POST', '/api/groups', F, { name: 'Stored before', joinPolicy: 'open', description: 'For now' });
    const oldText = `Before the limit. ${'z'.repeat(OLD_BYTES - 30)} The end.`;
    db.prepare('UPDATE groups SET description = ? WHERE id = ?').run(oldText, oldOne.body?.id);
    const oldListed = ((await call(base, 'GET', '/api/groups', M)).body as any[] ?? []).find((x) => x.id === oldOne.body?.id);
    const oldCard = await call(base, 'GET', `/api/groups/${oldOne.body?.id}`, M);
    assert(oldListed?.description?.length <= PREVIEW + 1 && oldListed?.descriptionTruncated === true && oldCard.body?.description === oldText,
        `the list sends its preview (${oldListed?.description?.length} characters), its card all ${oldCard.body?.description?.length}`);
    for (const [label, body] of [
        ['a rename alone', { name: 'Stored before, renamed' }],
        ['a rename with its whole text sent back', { name: 'Stored before, again', description: oldText }],
        ["the list's preview sent back, as an app that read the list would", { description: oldListed?.description }],
    ] as const) {
        const r = await call(base, 'PATCH', `/api/groups/${oldOne.body?.id}`, F, body);
        assert(r.status === 200 && storedDescription(oldOne.body?.id) === oldText, `${label}: 200, and the stored description is as it was (${r.status} ${short(r.body?.error)})`);
    }
    const grown = await call(base, 'PATCH', `/api/groups/${oldOne.body?.id}`, F, { description: `${oldText} More.` });
    assert(grown.status === 400 && grown.body?.error === DESCRIPTION_TOO_LONG && storedDescription(oldOne.body?.id) === oldText,
        `a changed description is a new one, held to the limit: 400 (${grown.status})`);

    // The other free text the global profile's lists send for every row: a listing's, and a member's contact.
    console.log('\n— 2b. the other text the global profile\'s lists send —');
    const listing = (who: Key, fields: Record<string, unknown>) => call(base, 'POST', '/api/marketplace/posts', who, {
        type: 'offer', category: 'food', title: 'Spare apples', description: 'A box', credits: 0, authorPublicKey: who.pk,
        lat: -28.6, lng: 153.6, photos: [TINY_PNG], ...fields,
    });
    const atLimits = await listing(M, { title: 't'.repeat(200), description: 'u'.repeat(5_000), category: 'k'.repeat(50) });
    assert(atLimits.status === 200 || atLimits.status === 201, `a listing with a 200-character title, a 5,000-character description and a 50-character category is taken (${atLimits.status} ${short(atLimits.body?.error)})`);
    for (const [label, fields, words] of [
        ['a 201-character title', { title: 't'.repeat(201) }, tooLong("A listing's title", 200)],
        ['a 5,001-character description', { description: 'u'.repeat(5_001) }, tooLong("A listing's description", 5_000)],
        ['a 51-character category', { category: 'k'.repeat(51) }, tooLong("A listing's category", 50)],
        ['a 1.9 MB description', { description: 'u'.repeat(OLD_BYTES) }, tooLong("A listing's description", 5_000)],
    ] as const) {
        const r = await listing(M, { ...fields, title: (fields as any).title ?? `Refused ${label}` });
        const written = (db.prepare('SELECT COUNT(*) AS n FROM posts WHERE title = ?').get((fields as any).title ?? `Refused ${label}`) as { n: number }).n;
        assert(r.status === 400 && r.body?.error === words && written === 0, `a listing with ${label}: 400 "${short(r.body?.error)}", nothing written (${r.status})`);
    }
    const mine = await listing(M, { title: 'Pears', description: 'A bag' });
    const postId = mine.body?.id ?? mine.body?.post?.id;
    const edit = (fields: Record<string, unknown>) => call(base, 'POST', '/api/marketplace/posts/update', M, { id: postId, authorPublicKey: M.pk, ...fields });
    const editLong = await edit({ title: 'p'.repeat(201) });
    assert(editLong.status === 400 && editLong.body?.error === tooLong("A listing's title", 200), `an edit to a 201-character title: 400 (${editLong.status} ${short(editLong.body?.error)})`);
    const storedTitle = `Stored before the limit ${'q'.repeat(400)}`;
    db.prepare('UPDATE posts SET title = ? WHERE id = ?').run(storedTitle, postId);
    const sentBack = await edit({ title: storedTitle, description: 'A bigger bag' });
    const postNow = db.prepare('SELECT title, description FROM posts WHERE id = ?').get(postId) as { title: string; description: string };
    assert(sentBack.status === 200 && postNow.title === storedTitle && postNow.description === 'A bigger bag',
        `a listing stored before the limit can still be edited: its own title sent back with a new description is taken, the title kept (${sentBack.status} ${short(sentBack.body?.error)})`);

    const contact = (value: string) => call(base, 'POST', '/api/profile/update', M, { contact: { value, visibility: 'community' } });
    const contactAt = await contact('c'.repeat(200));
    const contactOver = await contact('c'.repeat(201));
    const storedContact = (db.prepare('SELECT contact_value FROM members WHERE public_key = ?').get(M.pk) as { contact_value: string }).contact_value;
    assert(contactAt.status === 200 && contactOver.status === 400 && contactOver.body?.error === 'contact_too_long'
        && contactOver.body?.message === tooLong('How to reach you', 200) && storedContact === 'c'.repeat(200),
        `a member's contact: 200 characters taken, 201 refused "${short(contactOver.body?.message)}", the stored one kept (${contactAt.status}, ${contactOver.status})`);

    sockM.ws.close();
    console.log(`@@ ${JSON.stringify({ run, passed })}`);
    process.exit(0);
}

/** 3. Writes on the local profile: enterprises, crowdfunds, the notes with Beans, Decisions. */
async function rulesOnLocal(): Promise<void> {
    const { base, db, member } = await inProcessServer();
    const [K, P, Q, R] = ['Kit', 'Pia', 'Quin', 'Ros'].map(member);
    console.log('\n— 3. writes on the local profile —');

    const enterprise = (name: string, purpose: string) => call(base, 'POST', '/api/enterprise', K, { name, purpose, lifecycle: 'ongoing' });
    const namedOver = await enterprise('n'.repeat(101), 'Bread');
    const purposeOver = await enterprise('Long purpose bakery', 'p'.repeat(2_001));
    const atLimits = await enterprise('n'.repeat(100), 'p'.repeat(2_000));
    const enterprisesNamed = (prefix: string) => (db.prepare('SELECT COUNT(*) AS n FROM members WHERE is_treasury = 1 AND callsign LIKE ?').get(`${prefix}%`) as { n: number }).n;
    assert(namedOver.status === 400 && namedOver.body?.error === tooLong("An enterprise's name", 100), `an enterprise named in 101 characters: 400 "${short(namedOver.body?.error)}"`);
    assert(purposeOver.status === 400 && purposeOver.body?.error === tooLong("An enterprise's purpose", 2_000) && enterprisesNamed('Long purpose') === 0,
        `an enterprise with a 2,001-character purpose: 400, none made (${purposeOver.status})`);
    assert(atLimits.status === 200 && atLimits.body?.purpose === 'p'.repeat(2_000), `a 100-character name and a 2,000-character purpose are taken (${atLimits.status} ${short(atLimits.body?.error)})`);

    const crowdfund = (title: string, description: string) => call(base, 'POST', '/api/crowdfund/projects', P, { creatorPubkey: P.pk, title, description, goalAmount: 500 });
    const cfOver = await crowdfund('c'.repeat(101), 'A roof');
    const cfPurposeOver = await crowdfund('A long roof', 'r'.repeat(2_001));
    const cf = await crowdfund('A new roof', 'Tiles and labour');
    assert(cfOver.status === 400 && cfOver.body?.error === tooLong("An enterprise's name", 100) && cfPurposeOver.status === 400
        && cfPurposeOver.body?.error === tooLong("An enterprise's purpose", 2_000) && cf.status === 200,
        `a crowdfund's title past 100 and description past 2,000: 400 each; one within them is made (${cfOver.status}, ${cfPurposeOver.status}, ${cf.status})`);
    const cfId = cf.body?.project?.id;
    const cfEdit = (description: string) => call(base, 'POST', '/api/crowdfund/projects/update', P, { id: cfId, creatorPubkey: P.pk, title: 'A new roof', description, goalAmount: 500 });
    const cfEditOver = await cfEdit('s'.repeat(2_001));
    // Stored where a crowdfund's create puts it (db.ts createCrowdfundProject): its enterprise's purpose and bio, and its projects row.
    const storedPurpose = `Stored before the limit ${'v'.repeat(3_000)}`;
    db.prepare('UPDATE projects SET description = ? WHERE id = ?').run(storedPurpose, cfId);
    db.prepare('UPDATE members SET purpose = ?, bio = ? WHERE public_key = ?').run(storedPurpose, storedPurpose, cfId);
    const cfSentBack = await cfEdit(storedPurpose);
    assert(cfEditOver.status === 400 && cfSentBack.status === 200,
        `a crowdfund edit to 2,001 characters: 400; its own description from before the limit sent back: 200 (${cfEditOver.status}, ${cfSentBack.status} ${short(cfSentBack.body?.error)})`);

    const note501 = 'm'.repeat(501);
    const send = await call(base, 'POST', '/api/ledger/transfer', Q, { from: Q.pk, to: R.pk, amount: 1, memo: note501 });
    const send500 = await call(base, 'POST', '/api/ledger/transfer', Q, { from: Q.pk, to: R.pk, amount: 1, memo: 'm'.repeat(500) });
    const pledge = await call(base, 'POST', `/api/crowdfund/projects/${cfId}/pledge`, Q, { fromPubkey: Q.pk, amount: 1, memo: note501 });
    const notes = (db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE memo = ?').get(note501) as { n: number }).n;
    const noteWords = tooLong('A note with Beans', 500);
    assert(send.status === 400 && send.body?.error === noteWords && pledge.status === 400 && pledge.body?.error === noteWords && notes === 0,
        `a 501-character note with Beans, and with a pledge: 400 "${short(send.body?.error)}", nothing moved (${send.status}, ${pledge.status})`);
    assert(send500.body?.error !== noteWords, `a 500-character note passes the note's limit (${send500.status} ${short(send500.body?.error)})`);

    db.prepare('UPDATE members SET earned_credit = 10 WHERE public_key = ?').run(R.pk);
    const propose = (title: string, description: string) => call(base, 'POST', '/api/commons/decisions', R, { title, description, touches: 'member', effect: 'grant_voucher', subject: Q.pk });
    const titleOver = await propose('t'.repeat(201), 'Ten or more characters of reasons');
    const descOver = await propose('A voucher for Quin', 'd'.repeat(5_001));
    const decisions = (db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE author_pubkey = ?').get(R.pk) as { n: number }).n;
    const ok = await propose('t'.repeat(200), 'd'.repeat(5_000));
    assert(titleOver.status === 400 && titleOver.body?.error === tooLong("A Decision's title", 200) && descOver.status === 400
        && descOver.body?.error === tooLong("A Decision's description", 5_000) && decisions === 0 && ok.status === 200,
        `a Decision's title past 200 and description past 5,000: 400 each, none opened; one at both limits opens (${titleOver.status}, ${descOver.status}, ${ok.status} ${short(ok.body?.error)})`);

    console.log(`@@ ${JSON.stringify({ run, passed })}`);
    process.exit(0);
}

/** 4. A standby's copy: export and import as a standby's import does (test-groups-sync-and-removal's way). */
async function standbyCopy(): Promise<void> {
    const se = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { startP2P } = await import('./p2p.js');
    const { addConnector } = await import('./connector-manager.js');
    const { emptyCopiedTables } = await import('./engine/copied-tables.js');
    const { getStateHash } = await import('@beanpool/engine');
    se.initStateEngine();
    const p2p = await startP2P(0, 0);
    addConnector(`/ip4/127.0.0.1/tcp/4091/p2p/${p2p.peerId.toString()}`, 'mirror', 'description-limit-self');
    console.log('\n— 4. a standby\'s copy —');

    const insert = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invite_code, status, updated_at) VALUES (?, ?, ?, ?, 'active', ?)`);
    const C = newKey();
    insert.run(C.pk, 'Cleo', JOINED, 'INV-C', JOINED);
    const old = se.createGroup({ name: 'Stored before', createdBy: C.pk, joinPolicy: 'open', description: 'For now' });
    const oldText = `Before the limit. ${'z'.repeat(OLD_BYTES - 30)} The end.`;
    db.prepare('UPDATE groups SET description = ? WHERE id = ?').run(oldText, old.id);
    const atMax = se.createGroup({ name: 'At the limit', createdBy: C.pk, joinPolicy: 'open', description: '组'.repeat(MAX) });
    const emoji = se.createGroup({ name: 'Emoji', createdBy: C.pk, joinPolicy: 'open', description: '🌱'.repeat(MAX / 2) });
    const none = se.createGroup({ name: 'No words', createdBy: C.pk, joinPolicy: 'open' });
    const rows = () => db.prepare('SELECT id, name, description FROM groups ORDER BY id').all() as { id: string; name: string; description: string | null }[];
    const before = rows().map((r) => `${r.id}|${r.description === null ? 'null' : sha(r.description)}`);
    const hash = getStateHash(db);

    const payload: any = await se.exportSyncState(p2p.peerId.toString());
    const exported = (payload.groups ?? []).find((g: any) => g.id === old.id);
    assert(exported?.description === oldText, `the export carries the stored description whole (${exported?.description?.length} characters), not a preview`);

    emptyCopiedTables(db);
    db.prepare('DELETE FROM group_members').run();
    db.prepare('DELETE FROM groups').run();
    se.setNodeRole('backup');
    let failed = '';
    try { await se.importRemoteState(payload); } catch (e: any) { failed = String(e?.message ?? e); }
    se.setNodeRole('primary');
    const after = rows().map((r) => `${r.id}|${r.description === null ? 'null' : sha(r.description)}`);
    assert(!failed && JSON.stringify(after) === JSON.stringify(before),
        `the copy holds every group, each description byte for byte, the one from before the limit (1.9 MB) included (${after.length} of ${before.length}${failed ? `, threw: ${failed}` : ''})`);
    assert(getStateHash(db) === hash, 'and its state hash is the main node\'s');
    const listed = se.listGroups({}, C.pk);
    const listedOld = listed.find((g) => g.id === old.id);
    assert(listedOld?.description?.length === PREVIEW + 1 && (listedOld as any)?.descriptionTruncated === true && se.getGroup(old.id, C.pk)?.description === oldText,
        `the copy's list sends the old one's preview, and its card all of it (${listedOld?.description?.length})`);
    assert(se.getGroup(atMax.id, C.pk)?.description === '组'.repeat(MAX) && se.getGroup(emoji.id, C.pk)?.description === '🌱'.repeat(MAX / 2) && se.getGroup(none.id, C.pk)?.description === undefined,
        'the copy\'s cards: 2,000 Chinese characters, 1,000 emoji and none, as on the main node');

    // A copy whose description is not text (no node stores one): the row is kept, without it, and the copy goes on.
    const odd = { ...(payload.groups ?? []).find((g: any) => g.id === none.id), id: crypto.randomUUID(), slug: `odd-${Date.now()}`, name: 'Odd copy',
        description: { not: 'text' }, updatedAt: new Date(Date.now() + 1000).toISOString() };
    const { signature: _s, publicKey: _p, ...unsigned } = payload;
    const next = { ...unsigned, groups: [odd, { ...exported, name: 'Stored before, renamed', updatedAt: new Date(Date.now() + 1000).toISOString() }] };
    let threw = '';
    se.setNodeRole('backup');
    try { await se.importRemoteState(await se.signSyncPayload(next)); } catch (e: any) { threw = String(e?.message ?? e); }
    se.setNodeRole('primary');
    const oddRow = db.prepare('SELECT name, description FROM groups WHERE id = ?').get(odd.id) as { name: string; description: string | null } | undefined;
    const renamed = db.prepare('SELECT name, description FROM groups WHERE id = ?').get(old.id) as { name: string; description: string };
    assert(!threw && oddRow?.name === 'Odd copy' && oddRow.description === null && renamed.name === 'Stored before, renamed' && renamed.description === oldText,
        `a copied row whose description is not text is kept, without one, and the rest of the copy lands (${threw || `${oddRow?.name}, ${renamed.name}`})`);

    console.log(`@@ ${JSON.stringify({ run, passed })}`);
    process.exit(0);
}

/** A section that throws part way counts as one more failed check. */
async function counted(section: () => Promise<void>): Promise<void> {
    try {
        await section();
    } catch (e: any) {
        run++;
        console.error(`✗ the section threw: ${e?.stack ?? e}`);
        console.log(`@@ ${JSON.stringify({ run, passed })}`);
        process.exit(1);
    }
}

const role = process.argv[2];
const ROLES: Record<string, (args: any) => Promise<void>> = {
    'seed-heap': seedHeap, serve: () => serve(),
    'rules-global': () => counted(rulesOnGlobal), 'rules-local': () => counted(rulesOnLocal), 'standby-copy': () => counted(standbyCopy),
};
if (role && ROLES[role]) {
    ROLES[role](process.argv[3] ? JSON.parse(process.argv[3]) : null).then(
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
        else if (echo && /^(✓|\n?—)/.test(line.trimStart())) console.log(line);
    });
    readline.createInterface({ input: p.stderr! }).on('line', (line) => {
        out += line + '\n';
        if (echo && line.startsWith('✗')) console.error(line);
    });
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
    // Gone: any question still waiting for its answer gets none.
    const exited = new Promise<void>((r) => p.on('exit', () => { dead = true; replies.splice(0).forEach((reply) => reply({ peak: NaN })); r(); }));
    readline.createInterface({ input: p.stdout! }).on('line', (line) => {
        out += line + '\n';
        if (!line.startsWith('@@ ')) return;
        const m = JSON.parse(line.slice(3));
        if (m.ready) readyResolve(m); else replies.shift()?.(m);
    });
    p.stderr!.on('data', (b) => { out += b; });
    // A server that ran out of heap is gone before its exit is heard: a write to it then fails (EPIPE), and the read that
    // asked reports the crash.
    p.stdin!.on('error', () => { dead = true; });
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
    const root = fs.mkdtempSync(path.join(process.env.BEANPOOL_DATA_DIR || os.tmpdir(), 'group-descriptions-'));

    // ── 1. The heap ──────────────────────────────────────────────────────────────────────────────────────────────────
    console.log(`\n— 1. ${OLD_GROUPS} groups with 1.9 MB descriptions from before the limit and ${AT_MAX_GROUPS} at it, read from a global node held to a 256 MB heap —`);
    const HEAP_MB = 256, BOUND_MB = 128, AT_ONCE = 8, AT_ONCE_BOUND_MB = 200;
    const convenor = newKey(), member = newKey();
    const heapDir = path.join(root, 'heap');
    fs.mkdirSync(heapDir, { recursive: true });
    const t0 = Date.now();
    const seeded = await runToEnd('seed-heap', heapDir, 'global', { convenor: convenor.pk, member: member.pk });
    if (seeded.code !== 0 || !seeded.said[0]?.newestOld) throw new Error(`seed-heap exited ${seeded.code}:\n${seeded.out.slice(-3000)}`);
    const seed = seeded.said[0] as { newestOld: string; newestOldSha: string; newestOldLength: number; atMax: string };
    console.log(`  (seeded in ${Date.now() - t0} ms; state.db ${(fs.statSync(path.join(heapDir, 'state.db')).size / 2 ** 20).toFixed(0)} MB)`);
    const server = await startServer(heapDir, 'global', HEAP_MB);
    let crashed = false;
    try {
        const read = async (label: string, who: Key | null, route: string, maxBytes: number, check: (r: Res) => [boolean, string]) => {
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
                `${label} answers (${res?.status ?? failed}, ${((res?.bytes ?? 0) / 2 ** 20).toFixed(2)} MB, ${ms.toFixed(0)} ms)${fatal ? `: ${fatal}` : ''}`);
            if (crashed || !res) return;
            assert(res.bytes <= maxBytes && peak < BOUND_MB, `  and it is bounded: ${res.bytes} B (at most ${maxBytes}), heap peak ${peak.toFixed(0)} MB (under ${BOUND_MB})`);
            const [ok, said] = check(res);
            assert(ok, `  ${said}`);
        };
        const previews = (n: number) => (r: Res): [boolean, string] => {
            const rows = (r.body ?? []) as any[];
            const old = rows.filter((g) => /^Old \d+$/.test(g.name));
            const atMax = rows.filter((g) => /^At the limit \d+$/.test(g.name));
            return [rows.length === n && rows.every((g) => (g.description ?? '').length <= PREVIEW + 1 && g.descriptionTruncated === true)
                && old.every((g) => g.description.startsWith(`Old `)) && atMax.every((g) => g.description.endsWith('组…')),
            `${rows.length} groups (${old.length} from before the limit, ${atMax.length} at it), each description its preview, marked`];
        };
        await read('the list of groups, a page of 50 (the 1.9 MB ones)', member, '/api/groups', 100_000, previews(50));
        if (!crashed) await read('the list of groups, a page of 200', member, '/api/groups?limit=200', 400_000, previews(200));
        if (!crashed) await read('a search that only the end of an old description matches', member, '/api/groups?q=tailword42', 10_000, (r) => {
            const rows = (r.body ?? []) as any[];
            return [rows.length === 1 && rows[0].name === 'Old 42' && rows[0].descriptionTruncated === true, `finds "Old 42" (${rows.map((g) => g.name).join(', ')}), by its preview`];
        });
        if (!crashed) await read("the newest old group's card", member, `/api/groups/${seed.newestOld}`, 2_000_000, (r) =>
            [sha(r.body?.description ?? '') === seed.newestOldSha && r.body?.descriptionTruncated === undefined, `all ${r.body?.description?.length} characters of its description, as stored (${seed.newestOldLength})`]);
        if (!crashed) await read('a card at the limit', member, `/api/groups/${seed.atMax}`, 10_000, (r) =>
            [r.body?.description === AT_MAX_TEXT(AT_MAX_GROUPS - 1), `its 2,000 characters (${Buffer.byteLength(r.body?.description ?? '')} bytes), whole`]);
        if (!crashed) await read('"your groups" (200 of them)', member, '/api/your-groups', 512_000, (r) => {
            const items = ((r.body?.items ?? r.body ?? []) as any[]).filter((x) => x.kind === 'group');
            return [items.length === 200 && items.every((g) => g.description === undefined), `${items.length} groups, no description in any`];
        });
        if (!crashed) {
            await server.ask('peak');
            const f0 = performance.now();
            const all = await Promise.all(Array.from({ length: AT_ONCE }, () => call(server.base, 'GET', '/api/groups', member).catch((e) => ({ status: 0, bytes: 0, text: String(e?.cause?.code || e) } as Res))));
            const ms = performance.now() - f0;
            crashed = server.exited();
            const peak = crashed ? NaN : (await server.ask('peak')).peak / 2 ** 20;
            assert(!crashed && all.every((r) => r.status === 200) && peak < AT_ONCE_BOUND_MB && all.every((r) => r.bytes <= 100_000),
                `${AT_ONCE} lists at once: ${all.map((r) => r.status).join(' ')}, ${(all.reduce((n, r) => n + r.bytes, 0) / 2 ** 20).toFixed(2)} MB in all, ${ms.toFixed(0)} ms, heap peak ${peak.toFixed(0)} MB (under ${AT_ONCE_BOUND_MB})`);
        }
        if (!crashed) {
            // An old group's policy changes: group_updated goes to its members' live feeds, with the preview.
            const sock = await socket(server.base, member);
            const changed = await call(server.base, 'PATCH', `/api/groups/${seed.newestOld}`, convenor, { joinPolicy: 'request_to_join' });
            await settle(500);
            const heard = sock.events.filter((e) => e.type === 'group_updated' && e.group?.id === seed.newestOld);
            const largest = Math.max(0, ...sock.raw.map((t) => Buffer.byteLength(t)));
            assert(changed.status === 200 && heard.length >= 1 && heard.every((e) => e.group.description.length <= PREVIEW + 1 && e.group.descriptionTruncated === true) && largest < 16_000,
                `an old group's policy change: its members' live feeds hear group_updated with the preview (${heard.length} heard, largest frame ${largest} B, not 1.9 MB)`);
            sock.ws.close();
            crashed = server.exited();
        }
    } finally {
        await server.stop();
    }
    // On origin/main the page of 200 ends the node here (its list sends every description whole); the sections below still
    // run, each on a node of its own, so a run there counts every rule it breaks.
    if (crashed) console.error('  (the heap section stopped where the node ran out of memory)');
    fs.rmSync(heapDir, { recursive: true, force: true });

    // ── 2, 3 and 4: each in a process of its own, on its own profile ──────────────────────────────────────────────────
    for (const [section, profile] of [['rules-global', 'global'], ['rules-local', 'local'], ['standby-copy', 'global']] as const) {
        const dir = path.join(root, section);
        fs.mkdirSync(dir, { recursive: true });
        const res = await runToEnd(section, dir, profile, null, true);
        const tally = res.said.find((m) => typeof m.run === 'number');
        if (!tally) {
            run++;
            console.error(`✗ ${section} ended with no count (exit ${res.code}):\n${res.out.slice(-3000)}`);
            continue;
        }
        run += tally.run;
        passed += tally.passed;
        if (res.code !== 0 && tally.passed === tally.run) { run++; console.error(`✗ ${section} exited ${res.code}`); }
        fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}
