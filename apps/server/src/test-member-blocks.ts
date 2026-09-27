/**
 * The community keeps a member's block list for the account (Marty's card web-blocklist-where, 2026-09-27): the web app
 * kept it in the browser, and signing out cleared it. Now the node keeps it (engine/member-blocks.ts), and only its
 * owner reads or changes it (routes/blocks.ts).
 *
 * Over REAL HTTPS through the real signature middleware, with signed member sockets:
 *
 *   1. the owner's own list: add, read, add again, remove, clear, block again; private, no-store; a change rings a bare
 *      doorbell on the owner's own sockets (every tab), on nobody else's; nothing goes in the activity feed; an unblock
 *      leaves a tombstone no earlier than the row, Unblock All one for the whole list, and a block made again is stamped
 *      after them
 *   2. nobody else reads or changes it: a query naming the owner, a body naming the owner (ownerPubkey, publicKey), the
 *      owner's key on another key's signature, no signature, a key with no row, a visitor's row (answered as the key with
 *      no row), a replayed request; another member's own clear touches only their own
 *   3. the blocked member learns nothing: what they read (the blocker's profile, the member list, their own list, and
 *      blocking the blocker themselves) is the same before and after they are blocked, and their socket hears nothing
 *   4. the bounds: a key in any other spelling, anything but a key, the owner's own, both fields or neither, a list too
 *      long, one bad key in a list (none of it written); a key with no row here may be blocked; at most 500, a list that
 *      would pass it is refused whole
 *   5. a standby answers the read and refuses a change, writing nothing
 *   6. a member's own Delete account takes their list (tombstoned), and leaves the lists that block them; a removal takes
 *      it; the removed member's Delete account after it is answered and finds nothing
 *   7. a re-key moves the owner's list to the new key and every block of the old key to the new one, rings each owner,
 *      and the old key reads nothing
 *   8. replication: the export carries every row, a delta the new ones and the tombstones; a standby importing a copy
 *      inserts, keeps a newer row of its own, keeps deleted a pair it holds a newer tombstone for, applies the copy's
 *      tombstones, keeps a block made again after its tombstone in the same copy, leaves out a row for nobody here and a
 *      malformed one without failing the copy; the first copy asks for one whole copy; an unblock and a block again in
 *      one millisecond still order; the replica audit counts the table (only when the copy carries it) and a
 *      force-resync clears it
 *   9. no member can flood the node (the deciding review of #1239: 500 tombstones every two requests, kept 30 days):
 *      rounds of "block 500 keys + Unblock All" and of "block + unblock" leave at most one tombstone per request and never
 *      more than the ceiling per owner, in the database and in a whole copy; past the ceiling an owner's tombstones fold
 *      into one and the blocks they hold are stamped after it; the one-time move skips a key with no row here and counts
 *      it, never refusing the rest; a block made again after Unblock All, in the same millisecond or after the clock
 *      stepped back, is stamped after it, and a later Unblock All never stamps earlier than the one before
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-member-blocks.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_READ_AUTH;
const PW = 'MemberBlocksPass123!';
process.env.ADMIN_PASSWORD = PW;

import crypto from 'node:crypto';
import WebSocket from 'ws';
import { initTls } from './services/tls.js';
import {
    initStateEngine, seedGenesisMember, adminPruneUser, exportSyncState, signSyncPayload, importRemoteState, setNodeRole, clearReplicatedTables,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { issueRekeyCode, completeRekey } from './engine/member-wizards.js';
import { startP2P } from './p2p.js';
import { addConnector } from './connector-manager.js';
import { getReplicaConsistency } from '@beanpool/engine';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
/** A step that throws on a tree without block lists (no such table, no such module) must fail its assertion, not abort the run. */
function attempt<T>(fn: () => T): T | undefined {
    try { return fn(); } catch (e: any) { console.error(`  (threw: ${e?.message})`); return undefined; }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let BASE = '';

// ── members and signed requests ─────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
const newKey = () => newId('k').pk;
let owner: Id;
function member(name: string, opts: { visitor?: boolean } = {}): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_visitor)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, 'active', ?)`)
        .run(id.pk, name, opts.visitor ? null : owner.pk, opts.visitor ? null : 'TEST', opts.visitor ? 1 : 0);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    return id;
}

interface Req { method: string; path: string; headers: Record<string, string>; body?: string }
interface Res { status: number; body: any; headers: Headers }
/** The app's signed request (the format before request binding, which every node still takes), ready to send or send again. */
function signed(method: 'GET' | 'POST', path: string, id: Id, body?: unknown, opts: { headerKey?: string } = {}): Req {
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
        'X-Public-Key': opts.headerKey ?? id.pk,
        'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    return { method, path, headers, body: method === 'GET' ? undefined : raw };
}
async function send(req: Req): Promise<Res> {
    resetGatewayRateLimit();
    const res = await fetch(`${BASE}${req.path}`, { method: req.method, headers: req.headers, body: req.body });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* empty or not JSON */ }
    return { status: res.status, body: parsed, headers: res.headers };
}
const call = (method: 'GET' | 'POST', id: Id, path: string, body?: unknown, opts: { headerKey?: string } = {}) => send(signed(method, path, id, body, opts));
async function unsigned(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Res> {
    return send({ method, path, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
}
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`;
const listed = (r: Res): string[] => Array.isArray(r.body?.blocked) ? r.body.blocked.map((b: any) => b.publicKey) : [];
const same = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);
/** The same keys in any order: keys blocked in one request share a stamp, and are then in key order. */
const sameSet = (a: string[], b: string[]) => a.length === b.length && b.every(k => a.includes(k));

// ── what is kept, read straight from the database ─────────────────────────────────────────────────
interface Row { owner_pubkey: string; blocked_pubkey: string; created_at: string; updated_at: string }
const rowsOf = (id: Id | string): Row[] => attempt(() => db.prepare('SELECT * FROM member_blocks WHERE owner_pubkey = ? ORDER BY created_at, blocked_pubkey')
    .all(typeof id === 'string' ? id : id.pk) as Row[]) ?? [];
const keysOf = (id: Id | string) => rowsOf(id).map(r => r.blocked_pubkey);
const rowOf = (o: string, b: string) => attempt(() => db.prepare('SELECT * FROM member_blocks WHERE owner_pubkey = ? AND blocked_pubkey = ?').get(o, b) as Row | undefined);
const tombOf = (o: string, b: string) => (db.prepare("SELECT deleted_at FROM tombstones WHERE table_name = 'member_blocks' AND row_key = ?").get(`${o}|${b}`) as { deleted_at: string } | undefined)?.deleted_at ?? null;
/** The tombstone of an owner's whole list (Unblock All, a prune, a self-deletion, a re-key's old key): `<owner>|*`. */
const listTombOf = (o: string) => tombOf(o, '*');
/** The stamp a standby deletes this pair by: its own tombstone's, or its owner's whole list's, whichever is later. */
const coverOf = (o: string, b: string): string | null => {
    const [pair, list] = [tombOf(o, b), listTombOf(o)];
    return pair === null ? list : list === null ? pair : pair > list ? pair : list;
};
/** Every `member_blocks` tombstone of this owner's, their whole list's included. */
const tombsOf = (o: string) => (db.prepare("SELECT COUNT(*) AS n FROM tombstones WHERE table_name = 'member_blocks' AND substr(row_key, 1, 65) = ?").get(`${o}|`) as { n: number }).n;
const everyRow = (): Row[] => attempt(() => db.prepare('SELECT * FROM member_blocks ORDER BY owner_pubkey, blocked_pubkey').all() as Row[]) ?? [];

// ── signed member sockets ───────────────────────────────────────────────────────────────────────
type Sock = { ws: WebSocket; events: any[] };
function socket(id: Id | null): Promise<Sock> {
    let url = `${BASE.replace('https', 'wss')}/ws`;
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.priv).toString('base64');
        url += `?pubkey=${id.pk}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
    }
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const s: Sock = { ws, events: [] };
        ws.on('message', (d) => { try { s.events.push(JSON.parse(d.toString())); } catch { /* */ } });
        ws.on('open', () => resolve(s));
        ws.on('error', reject);
    });
}
const doorbells = (s: Sock) => s.events.filter(e => e.type === 'blocklist_updated');
/** Anything on this socket about blocks: the doorbell, or an event naming a block list. */
const aboutBlocks = (s: Sock) => s.events.filter(e => e.type === 'blocklist_updated' || /block/i.test(JSON.stringify(e)));

async function main(): Promise<void> {
    console.log('\n=== A member\'s block list, kept by the community ===\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    // Absent on a tree without them: every check that needs one fails, and the rest still run.
    const blocks: any = await import('./engine/member-blocks.js').catch(() => null);

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const ann = member('Ann');
    const bo = member('Bo');
    const cy = member('Cy');
    const dee = member('Dee');
    const eve = member('Eve');
    const vera = member('Vera', { visitor: true });
    const nobody = newId('Nemo'); // a key that is no member here
    const feedCount = () => (db.prepare('SELECT COUNT(*) AS n FROM activity_feed').get() as { n: number }).n;

    const annTab1 = await socket(ann);
    const annTab2 = await socket(ann);
    const boSock = await socket(bo);
    const cySock = await socket(cy);
    const anonSock = await socket(null);
    await sleep(100);

    // ── 1. the owner's own list ─────────────────────────────────────────────────────────────────
    console.log('── 1. the owner\'s own list ──');
    const feedBefore = feedCount();
    const r0 = await call('GET', ann, '/api/blocks');
    assert(r0.status === 200 && Array.isArray(r0.body?.blocked) && r0.body.blocked.length === 0 && r0.body?.max === 500,
        `an empty list to start, and the most she may block (${show(r0)})`);
    assert((r0.headers.get('cache-control') ?? '').includes('no-store') && (r0.headers.get('cache-control') ?? '').includes('private'),
        `private, no-store (${r0.headers.get('cache-control')})`);
    const a1 = await call('POST', ann, '/api/blocks', { targetPubkey: bo.pk });
    assert(a1.status === 200 && a1.body?.success === true && same(a1.body?.added ?? [], [bo.pk]) && same(listed(a1), [bo.pk])
        && typeof a1.body?.blocked?.[0]?.blockedAt === 'string', `she blocks Bo; the answer is her list, with when (${show(a1)})`);
    const again = await call('POST', ann, '/api/blocks', { targetPubkey: bo.pk });
    assert(again.status === 200 && same(again.body?.added ?? ['x'], []) && same(listed(again), [bo.pk]) && rowsOf(ann).length === 1,
        `blocking him again changes nothing (${show(again)})`);
    await sleep(5); // a later millisecond, so "oldest first" has an order to show
    const a2 = await call('POST', ann, '/api/blocks', { targetPubkey: cy.pk });
    const read = await call('GET', ann, '/api/blocks');
    assert(same(listed(a2), [bo.pk, cy.pk]) && same(listed(read), [bo.pk, cy.pk]), `she blocks Cy; her list, oldest first (${show(read)})`);
    assert(same(keysOf(ann), [bo.pk, cy.pk]), 'the node holds exactly those two');
    await sleep(150);
    const bells = [doorbells(annTab1), doorbells(annTab2)];
    assert(bells.every(b => b.length === 2 && b.every(e => JSON.stringify(e) === '{"type":"blocklist_updated"}')),
        `each of her tabs hears a bare doorbell for each block that changed her list, and nothing else (${JSON.stringify(bells.map(b => b.length))})`);
    assert(aboutBlocks(boSock).length === 0 && aboutBlocks(cySock).length === 0 && aboutBlocks(anonSock).length === 0,
        `Bo, Cy and a socket with no member hear nothing about it (${aboutBlocks(boSock).length}, ${aboutBlocks(cySock).length}, ${aboutBlocks(anonSock).length})`);
    assert(feedCount() === feedBefore, `nothing goes in the activity feed (${feedBefore} → ${feedCount()})`);
    const boRow = rowOf(ann.pk, bo.pk);
    const rm = await call('POST', ann, '/api/blocks/remove', { targetPubkey: bo.pk });
    assert(rm.status === 200 && rm.body?.removed === true && same(listed(rm), [cy.pk]) && same(keysOf(ann), [cy.pk]), `she unblocks Bo (${show(rm)})`);
    const boTomb = tombOf(ann.pk, bo.pk);
    assert(!!boTomb && !!boRow && boTomb >= boRow.updated_at, `a tombstone for the pair, no earlier than the row (${boTomb} ≥ ${boRow?.updated_at})`);
    const rmAgain = await call('POST', ann, '/api/blocks/remove', { targetPubkey: bo.pk });
    assert(rmAgain.status === 200 && rmAgain.body?.removed === false, `unblocking him again says he wasn't blocked (${show(rmAgain)})`);
    const cyRow = rowOf(ann.pk, cy.pk);
    const cl = await call('POST', ann, '/api/blocks/clear', {});
    assert(cl.status === 200 && cl.body?.removed === 1 && listed(cl).length === 0 && rowsOf(ann).length === 0, `Unblock All empties her list (${show(cl)})`);
    assert(!!cyRow && !!coverOf(ann.pk, cy.pk) && coverOf(ann.pk, cy.pk)! >= cyRow.updated_at && !!listTombOf(ann.pk) && tombsOf(ann.pk) === 1,
        `and leaves one tombstone for her whole list, no earlier than any row it removed, in place of one for each (${tombsOf(ann.pk)} for her)`);
    const back = await call('POST', ann, '/api/blocks', { targetPubkey: bo.pk });
    const backRow = rowOf(ann.pk, bo.pk);
    assert(back.status === 200 && !!backRow && !!boTomb && backRow.updated_at > boTomb,
        `blocking Bo again is stamped after his tombstone, so a standby keeps it (${backRow?.updated_at} > ${boTomb})`);
    await call('POST', ann, '/api/blocks', { targetPubkey: cy.pk });

    // ── 2. nobody else reads or changes it ──────────────────────────────────────────────────────
    console.log('\n── 2. nobody else reads or changes it ──');
    const annList = () => keysOf(ann);
    const annHas = sameSet(annList(), [bo.pk, cy.pk]);
    assert(annHas, `Ann blocks Bo and Cy (${annList().length})`);
    const q = await call('GET', bo, `/api/blocks?publicKey=${ann.pk}&owner=${ann.pk}&pubkey=${ann.pk}&ownerPubkey=${ann.pk}`);
    assert(q.status === 200 && listed(q).length === 0 && !JSON.stringify(q.body).includes(ann.pk) && !JSON.stringify(q.body).includes(cy.pk),
        `Bo asking with Ann's key in the query reads his own list, empty, and nothing of hers (${show(q)})`);
    const spoofs: Array<[string, string, unknown]> = [
        ['block for her (ownerPubkey)', '/api/blocks', { targetPubkey: dee.pk, ownerPubkey: ann.pk }],
        ['block for her (publicKey)', '/api/blocks', { targetPubkey: dee.pk, publicKey: ann.pk }],
        ['unblock Cy for her', '/api/blocks/remove', { targetPubkey: cy.pk, ownerPubkey: ann.pk }],
        ['clear hers', '/api/blocks/clear', { publicKey: ann.pk }],
        ['clear hers (memberPubkey)', '/api/blocks/clear', { ownerPubkey: ann.pk, memberPubkey: ann.pk }],
    ];
    for (const [what, path, body] of spoofs) {
        const r = await call('POST', bo, path, body);
        assert(r.status >= 400 && r.status < 500 && sameSet(annList(), [bo.pk, cy.pk]) && keysOf(bo).length === 0,
            `Bo can't ${what} with a body naming her: ${r.status}, her list and his unchanged`);
    }
    const forged = [
        await call('GET', bo, '/api/blocks', undefined, { headerKey: ann.pk }),
        await call('POST', bo, '/api/blocks/clear', {}, { headerKey: ann.pk }),
        await call('POST', bo, '/api/blocks/remove', { targetPubkey: cy.pk }, { headerKey: ann.pk }),
    ];
    assert(forged.every(r => (r.status === 401 || r.status === 403) && !JSON.stringify(r.body).includes(cy.pk)) && sameSet(annList(), [bo.pk, cy.pk]),
        `her key on Bo's signature reads and changes nothing (${forged.map(r => r.status).join(', ')})`);
    const boClear = await call('POST', bo, '/api/blocks/clear', {});
    assert(boClear.status === 200 && boClear.body?.removed === 0 && sameSet(annList(), [bo.pk, cy.pk]), `Bo's own Unblock All touches only his (${show(boClear)})`);
    const u = [await unsigned('GET', '/api/blocks'), await unsigned('POST', '/api/blocks', { targetPubkey: dee.pk }),
        await unsigned('POST', '/api/blocks/remove', { targetPubkey: cy.pk }), await unsigned('POST', '/api/blocks/clear', {})];
    assert(u.every(r => r.status === 401) && sameSet(annList(), [bo.pk, cy.pk]), `unsigned: 401 every time, and nothing changes (${u.map(r => r.status).join(', ')})`);
    const nobodyAns = [await call('GET', nobody, '/api/blocks'), await call('POST', nobody, '/api/blocks', { targetPubkey: dee.pk }),
        await call('POST', nobody, '/api/blocks/remove', { targetPubkey: cy.pk }), await call('POST', nobody, '/api/blocks/clear', {})];
    assert(nobodyAns.every(r => r.status === 403) && nobodyAns.slice(1).every(r => r.body?.code === 'not_a_member')
        && everyRow().every(r => r.owner_pubkey !== nobody.pk) && sameSet(annList(), [bo.pk, cy.pk]),
        `a key with no row: 403 to the read and to every change, and nothing is written (${nobodyAns.map(show).join(' | ')})`);
    const veraAns = [await call('GET', vera, '/api/blocks'), await call('POST', vera, '/api/blocks', { targetPubkey: dee.pk }),
        await call('POST', vera, '/api/blocks/remove', { targetPubkey: cy.pk }), await call('POST', vera, '/api/blocks/clear', {})];
    assert(veraAns.every((r, i) => r.status === nobodyAns[i].status && JSON.stringify(r.body) === JSON.stringify(nobodyAns[i].body))
        && everyRow().every(r => r.owner_pubkey !== vera.pk) && sameSet(annList(), [bo.pk, cy.pk]),
        `a visitor's row is answered as the key with no row is, every time, and keeps no list (${veraAns.map(show).join(' | ')})`);
    // A request Ann signed, caught on the way and sent again later, after she blocked Cy again: refused, Cy stays blocked.
    const caught = signed('POST', '/api/blocks/remove', ann, { targetPubkey: cy.pk });
    const first = await send(caught);
    await call('POST', ann, '/api/blocks', { targetPubkey: cy.pk });
    const replay = await send(caught);
    assert(first.status === 200 && replay.status >= 400 && replay.status < 500 && sameSet(annList(), [bo.pk, cy.pk]),
        `her unblock, replayed after she blocked Cy again, is refused and Cy stays blocked (${first.status} then ${show(replay)})`);

    // ── 3. the blocked member learns nothing ────────────────────────────────────────────────────
    console.log('\n── 3. the blocked member learns nothing ──');
    await call('POST', ann, '/api/blocks/clear', {});
    /** Every value but the last-active stamp, which any signed write moves, blocking or not (the report a block sends today did too). */
    const strip = (v: any): any => Array.isArray(v) ? v.map(strip) : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'lastActiveAt' && k !== 'last_active_at' && k !== 'blockedAt').map(([k, x]) => [k, strip(x)])) : v;
    const viewOfBo = async () => {
        const profile = await call('GET', bo, `/api/profile/${ann.pk}`);
        const members = await call('GET', bo, '/api/members');
        const own = await call('GET', bo, '/api/blocks');
        const blocksHer = await call('POST', bo, '/api/blocks', { targetPubkey: ann.pk });
        const unblocksHer = await call('POST', bo, '/api/blocks/remove', { targetPubkey: ann.pk });
        return strip({ profile: [profile.status, profile.body], members: [members.status, members.body], own: [own.status, own.body],
            blocksHer: [blocksHer.status, blocksHer.body], unblocksHer: [unblocksHer.status, unblocksHer.body] });
    };
    const before = JSON.stringify(await viewOfBo());
    // His own block and unblock of her ring his own socket; only what arrives while she blocks him counts here.
    await sleep(150);
    const boEventsBefore = boSock.events.length;
    const blockedBo = await call('POST', ann, '/api/blocks', { targetPubkey: bo.pk });
    await sleep(150);
    const boHeard = boSock.events.slice(boEventsBefore);
    const after = JSON.stringify(await viewOfBo());
    assert(blockedBo.status === 200 && same(annList(), [bo.pk]), 'Ann blocks Bo');
    assert(before === after && before.length > 200,
        `everything Bo reads (her profile, the member list, his own list, blocking and unblocking her himself) is the same before and after (${before.length} characters)`);
    assert(boHeard.length === 0, `and his socket heard nothing at all while she blocked him (${JSON.stringify(boHeard).slice(0, 120)})`);

    // ── 4. the bounds ───────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. the bounds ──');
    await call('POST', ann, '/api/blocks/clear', {});
    const badKeys: unknown[] = [cy.pk.toUpperCase(), cy.pk.slice(0, 63), `${cy.pk}0`, ` ${cy.pk}`, 'zz'.repeat(32), 12345, '', null, [cy.pk], { k: cy.pk }];
    const badAnswers = [];
    for (const k of badKeys) badAnswers.push(await call('POST', ann, '/api/blocks', { targetPubkey: k }));
    assert(badAnswers.every(r => r.status === 400) && badAnswers.slice(0, 5).every(r => r.body?.code === 'bad_key') && rowsOf(ann).length === 0,
        `a key in any other spelling, or anything but a key, is refused 400 bad_key and nothing is written (${badAnswers.map(r => `${r.status}${r.body?.code ? ` ${r.body.code}` : ''}`).join(', ')})`);
    const badRemove = await call('POST', ann, '/api/blocks/remove', { targetPubkey: cy.pk.toUpperCase() });
    assert(badRemove.status === 400 && badRemove.body?.code === 'bad_key', `so is an unblock of one (${show(badRemove)})`);
    const self = await call('POST', ann, '/api/blocks', { targetPubkey: ann.pk });
    assert(self.status === 400 && self.body?.code === 'block_self' && rowsOf(ann).length === 0, `she can't block herself (${show(self)})`);
    const shapes = [
        await call('POST', ann, '/api/blocks', {}),
        await call('POST', ann, '/api/blocks', { targetPubkey: cy.pk, targetPubkeys: [dee.pk] }),
        await call('POST', ann, '/api/blocks', { targetPubkeys: [] }),
        await call('POST', ann, '/api/blocks', { targetPubkeys: Array.from({ length: 501 }, newKey) }),
        await call('POST', ann, '/api/blocks', { targetPubkeys: cy.pk }),
        await call('POST', ann, '/api/blocks', { targetPubkeys: [cy.pk, dee.pk.toUpperCase()] }),
        await call('POST', ann, '/api/blocks', { targetPubkeys: [cy.pk, ann.pk] }),
    ];
    assert(shapes.every(r => r.status === 400) && rowsOf(ann).length === 0,
        `neither field, both, an empty list, 501 keys, a list that isn't one, one bad key or her own in a list: 400, none of it written (${shapes.map(r => r.status).join(', ')})`);
    const stranger = await call('POST', ann, '/api/blocks', { targetPubkey: nobody.pk });
    assert(stranger.status === 200 && same(keysOf(ann), [nobody.pk]), `a key with no row here may be blocked: someone from another community (${show(stranger)})`);
    // The one-time move takes only keys this node has a row for (section 9): these 499 are visitors here.
    const bulk = Array.from({ length: 499 }, (_, i) => member(`Filler${i}`, { visitor: true }).pk);
    const fill = await call('POST', ann, '/api/blocks', { targetPubkeys: [...bulk, nobody.pk] });
    assert(fill.status === 200 && (fill.body?.added?.length ?? 0) === 499 && rowsOf(ann).length === 500 && listed(fill).length === 500,
        `a list of keys is blocked in one go, a key already blocked left as it is: 500 now (${fill.status}, ${fill.body?.added?.length} added, ${rowsOf(ann).length})`);
    const over = await call('POST', ann, '/api/blocks', { targetPubkey: cy.pk });
    assert(over.status === 409 && over.body?.code === 'block_limit' && rowsOf(ann).length === 500 && !rowOf(ann.pk, cy.pk),
        `the 501st is refused 409 block_limit, in plain words, and not written (${show(over)})`);
    await call('POST', ann, '/api/blocks/remove', { targetPubkey: bulk[0] });
    const twoForOne = await call('POST', ann, '/api/blocks', { targetPubkeys: [cy.pk, dee.pk] });
    assert(twoForOne.status === 409 && rowsOf(ann).length === 499 && !rowOf(ann.pk, cy.pk) && !rowOf(ann.pk, dee.pk),
        `with room for one, a list of two is refused whole (${show(twoForOne)})`);
    const oneForOne = await call('POST', ann, '/api/blocks', { targetPubkey: cy.pk });
    assert(oneForOne.status === 200 && rowsOf(ann).length === 500, `one more fits (${oneForOne.status})`);
    await call('POST', ann, '/api/blocks/clear', {});

    // ── 5. a standby ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. a standby answers the read and refuses a change ──');
    await call('POST', ann, '/api/blocks', { targetPubkey: bo.pk });
    setNodeRole('backup');
    const sRead = await call('GET', ann, '/api/blocks');
    const sChanges = [await call('POST', ann, '/api/blocks', { targetPubkey: cy.pk }), await call('POST', ann, '/api/blocks/remove', { targetPubkey: bo.pk }),
        await call('POST', ann, '/api/blocks/clear', {})];
    setNodeRole('primary');
    assert(sRead.status === 200 && same(listed(sRead), [bo.pk]), `the read, from its copy (${show(sRead)})`);
    assert(sChanges.every(r => r.status === 503 && r.body?.code === 'standby') && same(keysOf(ann), [bo.pk]),
        `a change: 503 standby, nothing written (${sChanges.map(r => r.status).join(', ')})`);

    // ── 6. Delete account, a removal ────────────────────────────────────────────────────────────
    console.log('\n── 6. Delete account and a removal take the list ──');
    await call('POST', cy, '/api/blocks', { targetPubkeys: [bo.pk, dee.pk] });
    await call('POST', bo, '/api/blocks', { targetPubkey: cy.pk });
    const cyRows = rowsOf(cy);
    const del = await call('POST', cy, '/api/member/purge', { action: 'purge_account' });
    assert(del.status === 200 && cyRows.length === 2 && rowsOf(cy).length === 0, `Cy deletes her account: her list goes (${show(del)}; ${cyRows.length} → ${rowsOf(cy).length})`);
    assert(cyRows.every(r => { const t = coverOf(cy.pk, r.blocked_pubkey); return !!t && t >= r.updated_at; }) && !!listTombOf(cy.pk) && tombsOf(cy.pk) === 1,
        `each under the one tombstone of her list, no earlier than it, so a standby deletes it too (${tombsOf(cy.pk)} for her)`);
    assert(same(keysOf(bo), [cy.pk]), "Bo's block of her is his and stays");
    await call('POST', dee, '/api/blocks', { targetPubkeys: [ann.pk, bo.pk] });
    const deeRows = rowsOf(dee);
    attempt(() => adminPruneUser(dee.pk, 'owner:password'));
    assert(deeRows.length === 2 && rowsOf(dee).length === 0 && deeRows.every(r => { const t = coverOf(dee.pk, r.blocked_pubkey); return !!t && t >= r.updated_at; })
        && !!listTombOf(dee.pk) && tombsOf(dee.pk) === 1,
        `a removal takes Dee's list, tombstoned with one for the list (${deeRows.length} → ${rowsOf(dee).length}, ${tombsOf(dee.pk)} tombstone)`);
    const deeReads = await call('GET', dee, '/api/blocks');
    assert(deeReads.status === 403 && deeReads.body?.code === 'account_closed', `her key reads nothing now (${show(deeReads)})`);
    const deeDeletes = await call('POST', dee, '/api/member/purge', { action: 'purge_account' });
    assert(deeDeletes.status === 200 && rowsOf(dee).length === 0, `her Delete account after the removal is answered and finds nothing to bring back (${show(deeDeletes)})`);

    // ── 7. a re-key ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── 7. a re-key moves the lists ──');
    await call('POST', ann, '/api/blocks/clear', {});
    await call('POST', ann, '/api/blocks', { targetPubkeys: [bo.pk, eve.pk] });
    await call('POST', bo, '/api/blocks/clear', {});
    await call('POST', bo, '/api/blocks', { targetPubkey: ann.pk });
    const annBefore = rowsOf(ann);
    const boBells = doorbells(boSock).length;
    const annNew = newId('AnnNew');
    const moved = attempt(() => { const code = issueRekeyCode(ann.pk, owner.pk).code; return completeRekey(ann.pk, annNew.pk, code, owner.pk); });
    assert(moved?.success === true, 'Ann is re-keyed');
    assert(rowsOf(ann).length === 0 && sameSet(keysOf(annNew), [bo.pk, eve.pk])
        && rowsOf(annNew).every(r => r.created_at === annBefore.find(b => b.blocked_pubkey === r.blocked_pubkey)?.created_at),
        `her list is hers on the new key, each with when she blocked them (${keysOf(annNew).length})`);
    assert(same(keysOf(bo), [annNew.pk]), "Bo's block of her names her new key: a re-key unblocks nobody");
    assert([`${ann.pk}|${bo.pk}`, `${ann.pk}|${eve.pk}`, `${bo.pk}|${ann.pk}`].every(k => { const [o, b] = k.split('|'); return !!coverOf(o, b); })
        && annBefore.every(r => (coverOf(ann.pk, r.blocked_pubkey) ?? '') >= r.updated_at) && !!listTombOf(ann.pk) && tombsOf(ann.pk) === 1
        && rowsOf(annNew).every(r => r.updated_at >= (coverOf(ann.pk, r.blocked_pubkey) ?? '')),
        `the old pairs are tombstoned (her own list with one for it) and the moved rows stamped, so a standby follows (${tombsOf(ann.pk)} for her old key)`);
    await sleep(150);
    assert(doorbells(boSock).length === boBells + 1, `Bo's socket hears a bare doorbell, his list having changed (${doorbells(boSock).length - boBells})`);
    const newRead = await call('GET', annNew, '/api/blocks');
    const oldRead = await call('GET', ann, '/api/blocks');
    assert(newRead.status === 200 && sameSet(listed(newRead), [bo.pk, eve.pk]), `she reads it on her new key (${show(newRead)})`);
    assert(oldRead.status === 403 && oldRead.body?.code === 'key_invalidated', `the old key reads nothing (${show(oldRead)})`);

    // ── 8. replication ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 8. replication: a standby holds every list ──');
    const p2p = await startP2P(0, 0);
    const nodeId = p2p.peerId.toString();
    addConnector(`/ip4/127.0.0.1/tcp/4283/p2p/${nodeId}`, 'mirror', 'self-test-peer');
    await call('POST', eve, '/api/blocks', { targetPubkeys: [bo.pk, annNew.pk, dee.pk] });
    const payload: any = await exportSyncState(nodeId);
    const exported: any[] = payload.memberBlocks ?? [];
    const all = everyRow();
    const exEve = exported.find(b => b.ownerPubkey === eve.pk && b.blockedPubkey === bo.pk);
    const eveBo = rowOf(eve.pk, bo.pk);
    assert(exported.length === all.length && all.length >= 6, `the export carries every row (${exported.length} of ${all.length})`);
    assert(!!exEve && exEve.createdAt === eveBo?.created_at && exEve.updatedAt === eveBo?.updated_at && Object.keys(exEve).sort().join() === 'blockedPubkey,createdAt,ownerPubkey,updatedAt',
        `each as the owner, the key, when, and its stamp, nothing more (${JSON.stringify(exEve)?.slice(0, 120)})`);
    const since = new Date().toISOString();
    await sleep(5);
    await call('POST', eve, '/api/blocks/remove', { targetPubkey: dee.pk });
    await call('POST', eve, '/api/blocks', { targetPubkey: cy.pk });
    const delta: any = await exportSyncState(nodeId, since);
    assert((delta.memberBlocks ?? []).length === 1 && delta.memberBlocks?.[0]?.blockedPubkey === cy.pk
        && (delta.tombstones ?? []).some((t: any) => t.tableName === 'member_blocks' && t.rowKey === `${eve.pk}|${dee.pk}`),
        `a delta carries the new block and the unblock's tombstone, and nothing older (${(delta.memberBlocks ?? []).length} rows)`);

    // The standby: one row it never had (insert), one it holds with an older stamp (taken), one it holds newer (kept), one
    // it holds a newer tombstone for (stays deleted); the copy carries a tombstone for a row it holds, a block made again
    // with its older tombstone, a row for nobody here and bad rows.
    const whole: any = await exportSyncState(nodeId);
    const ex = (o: Id, b: Id) => (whole.memberBlocks ?? []).find((r: any) => r.ownerPubkey === o.pk && r.blockedPubkey === b.pk);
    const [ins, older, newer, dead, doomed, again2] = [ex(eve, bo), ex(eve, annNew), ex(eve, cy), ex(annNew, bo), ex(annNew, eve), ex(bo, annNew)];
    assert(!!(ins && older && newer && dead && doomed && again2), 'the copy has the six rows this section needs');
    attempt(() => db.prepare('DELETE FROM member_blocks WHERE owner_pubkey = ? AND blocked_pubkey = ?').run(eve.pk, bo.pk));
    attempt(() => db.prepare("UPDATE member_blocks SET updated_at = '2000-01-01T00:00:00.000Z' WHERE owner_pubkey = ? AND blocked_pubkey = ?").run(eve.pk, annNew.pk));
    attempt(() => db.prepare("UPDATE member_blocks SET updated_at = '2999-01-01T00:00:00.000Z' WHERE owner_pubkey = ? AND blocked_pubkey = ?").run(eve.pk, cy.pk));
    attempt(() => db.prepare('DELETE FROM member_blocks WHERE owner_pubkey = ? AND blocked_pubkey = ?').run(annNew.pk, bo.pk));
    db.prepare("INSERT OR REPLACE INTO tombstones (table_name, row_key, deleted_at) VALUES ('member_blocks', ?, '2999-01-01T00:00:00.000Z')").run(`${annNew.pk}|${bo.pk}`);
    attempt(() => db.prepare('DELETE FROM member_blocks WHERE owner_pubkey = ? AND blocked_pubkey = ?').run(bo.pk, annNew.pk));
    const doomedAt = new Date(Date.parse(doomed?.updatedAt ?? since) + 60_000).toISOString();
    const againTomb = new Date(Date.parse(again2?.updatedAt ?? since) - 60_000).toISOString();
    const stray = newKey();
    whole.tombstones = [...(whole.tombstones ?? []),
        { tableName: 'member_blocks', rowKey: `${annNew.pk}|${eve.pk}`, deletedAt: doomedAt },
        { tableName: 'member_blocks', rowKey: `${bo.pk}|${annNew.pk}`, deletedAt: againTomb },
    ];
    whole.memberBlocks = [...(whole.memberBlocks ?? []),
        { ownerPubkey: stray, blockedPubkey: bo.pk, createdAt: since, updatedAt: since },
        { ownerPubkey: eve.pk.toUpperCase(), blockedPubkey: bo.pk, createdAt: since, updatedAt: since },
        { ownerPubkey: eve.pk, blockedPubkey: eve.pk, createdAt: since, updatedAt: since },
        { ownerPubkey: eve.pk, blockedPubkey: stray, createdAt: 'yesterday', updatedAt: 7 },
    ];
    const { signature: _s, publicKey: _k, ...unsignedCopy } = whole;
    const copy = await signSyncPayload(unsignedCopy);
    attempt(() => db.prepare("DELETE FROM node_config WHERE key = 'replicated_member_blocks_v1'").run());
    setNodeRole('backup');
    let importError = '';
    try { await importRemoteState(copy); } catch (e: any) { importError = e?.message || String(e); }
    setNodeRole('primary');
    assert(importError === '', `the copy imports, bad rows and all (${importError})`);
    assert(rowOf(eve.pk, bo.pk)?.updated_at === ins?.updatedAt && rowOf(eve.pk, bo.pk)?.created_at === ins?.createdAt, 'a row the standby never had is inserted, as the main server holds it');
    assert(rowOf(eve.pk, annNew.pk)?.updated_at === older?.updatedAt, 'an older copy of its own takes the main server\'s stamp');
    assert(rowOf(eve.pk, cy.pk)?.updated_at === '2999-01-01T00:00:00.000Z', 'a newer one of its own is kept');
    assert(rowOf(annNew.pk, bo.pk) === undefined, 'a pair it holds a newer tombstone for stays deleted: an unblock never comes back');
    assert(rowOf(annNew.pk, eve.pk) === undefined && tombOf(annNew.pk, eve.pk) === doomedAt, "the copy's tombstone deletes its row, and is recorded");
    assert(rowOf(bo.pk, annNew.pk)?.updated_at === again2?.updatedAt, 'a block made again after its tombstone, both in the copy, stays');
    assert(rowsOf(stray).length === 0 && rowsOf(eve.pk.toUpperCase()).length === 0 && !rowOf(eve.pk, eve.pk) && !rowOf(eve.pk, stray),
        'a row for nobody here and the malformed ones are left out');
    if (blocks?.mergeReplicatedBlocks) {
        const m = blocks.mergeReplicatedBlocks([{ ownerPubkey: 'bad' }, null, 'x', ins]);
        assert(m.invalid === 3 && m.kept === 1 && m.written === 0, `the merge counts what it left out, and a row it already has is kept (${JSON.stringify(m)})`);
    } else assert(false, 'the merge counts what it left out (no merge on this tree)');
    assert(blocks?.memberBlocksWantWholeCopy?.() === true, 'the first copy that carries block lists asks this standby for one whole copy');
    attempt(() => blocks.noteWholeCopyOfMemberBlocks());
    assert(blocks?.memberBlocksWantWholeCopy?.() === false, 'and once one has come, no more');

    // An unblock and a block again in the same millisecond still order.
    const T = Date.parse('2031-05-05T05:05:05.555Z');
    attempt(() => blocks.removeBlock(eve.pk, bo.pk, T));
    attempt(() => blocks.addBlocks(eve.pk, [bo.pk], T));
    const tieTomb = tombOf(eve.pk, bo.pk);
    const tieRow = rowOf(eve.pk, bo.pk);
    assert(!!tieTomb && !!tieRow && tieRow.updated_at > tieTomb, `an unblock and a block again in one millisecond: the block is stamped after (${tieRow?.updated_at} > ${tieTomb})`);
    attempt(() => blocks.removeBlock(eve.pk, bo.pk, T));
    const tieTomb2 = tombOf(eve.pk, bo.pk);
    assert(!rowOf(eve.pk, bo.pk) && !!tieTomb2 && !!tieRow && tieTomb2 >= tieRow.updated_at, `and unblocking it again then is stamped no earlier than it (${tieTomb2} ≥ ${tieRow?.updated_at})`);

    // The replica audit counts the table, and a force-resync clears it.
    const audit = attempt(() => getReplicaConsistency(db, { memberBlocks: exported } as any, 0));
    const auditRow = audit?.tables.find((t: any) => t.name === 'member_blocks');
    assert(!!auditRow && auditRow.primary === exported.length, `the replica audit counts member_blocks (${JSON.stringify(auditRow)})`);
    // A main server that predates block lists sends none, and this standby keeps its own: nothing to compare, so no drift.
    const held = attempt(() => (db.prepare('SELECT COUNT(*) AS n FROM member_blocks').get() as any).n) ?? 0;
    const olderAudit = attempt(() => getReplicaConsistency(db, {} as any, 0));
    assert(held > 0 && !!olderAudit && !olderAudit.tables.some((t: any) => t.name === 'member_blocks'),
        `a copy without block lists, from a main server that predates them, is not counted against the ${held} this standby holds (${JSON.stringify(olderAudit?.tables.find((t: any) => t.name === 'member_blocks') ?? null)})`);
    attempt(() => clearReplicatedTables());
    const cleared = attempt(() => (db.prepare('SELECT COUNT(*) AS n FROM member_blocks').get() as any).n);
    assert(cleared === 0, `a force-resync clears the table before the whole copy comes in (${cleared})`);

    // ── 9. no member can flood the node ─────────────────────────────────────────────────────────
    // The deciding review of #1239 (4114300128): 500 keys that needn't be anyone's, then Unblock All, wrote 500 tombstones
    // every two requests, each kept 30 days, and a whole copy carried them all. The force-resync above emptied the tables.
    console.log('\n── 9. no member can flood the node ──');
    const CEILING = blocks?.MEMBER_BLOCK_TOMBSTONES_MAX ?? 500;
    const fay = member('Fay');
    const gus = member('Gus');
    const hal = member('Hal');
    const known = Array.from({ length: 500 }, (_, i) => member(`Known${i}`, { visitor: true }).pk);

    // The one-time move takes only keys this node has a row for, and counts the rest: it never refuses them.
    const strangers = [newKey(), newKey(), newKey()];
    const mv = await call('POST', fay, '/api/blocks', { targetPubkeys: [gus.pk, ...strangers, hal.pk] });
    assert(mv.status === 200 && sameSet(mv.body?.added ?? [], [gus.pk, hal.pk]) && mv.body?.skipped === 3 && sameSet(keysOf(fay), [gus.pk, hal.pk]),
        `the one-time move takes the two keys this node has a row for, skips the three it has none for and counts them (${show(mv)})`);
    const mvNone = await call('POST', fay, '/api/blocks', { targetPubkeys: [newKey(), newKey()] });
    assert(mvNone.status === 200 && Array.isArray(mvNone.body?.added) && mvNone.body.added.length === 0 && mvNone.body?.skipped === 2
        && sameSet(keysOf(fay), [gus.pk, hal.pk]), `a move of keys it has no row for at all is answered, both skipped, nothing written (${show(mvNone)})`);
    const mvAgain = await call('POST', fay, '/api/blocks', { targetPubkeys: [gus.pk, strangers[0]] });
    assert(mvAgain.status === 200 && same(mvAgain.body?.added ?? ['x'], []) && mvAgain.body?.skipped === 1 && sameSet(keysOf(fay), [gus.pk, hal.pk]),
        `a key already on her list is left as it is, and a stranger still skipped (${show(mvAgain)})`);
    const mvFull = await call('POST', fay, '/api/blocks', { targetPubkeys: [...known.slice(0, 498), newKey(), newKey()] });
    assert(mvFull.status === 200 && mvFull.body?.added?.length === 498 && mvFull.body?.skipped === 2 && rowsOf(fay).length === 500,
        `the limit counts only what goes on her list: 498 known keys and 2 strangers fill it to 500 (${mvFull.status}, ${mvFull.body?.added?.length} added, ${rowsOf(fay).length})`);
    const mvOver = await call('POST', fay, '/api/blocks', { targetPubkeys: [known[498], newKey()] });
    assert(mvOver.status === 409 && mvOver.body?.code === 'block_limit' && rowsOf(fay).length === 500, `and past it a move is refused as a block is (${show(mvOver)})`);
    const single = await call('POST', gus, '/api/blocks', { targetPubkey: newKey() });
    assert(single.status === 200 && rowsOf(gus).length === 1 && single.body?.skipped === undefined,
        `one key at a time, a key with no row here is still blocked: the marketplace shows another community's listings (${show(single)})`);
    await call('POST', fay, '/api/blocks/clear', {});
    await call('POST', gus, '/api/blocks/clear', {});

    // Rounds of "block 500 keys + Unblock All", with keys this node knows and with keys that are nobody's.
    const rounds = 8;
    let requests = 0, worstStep = 0;
    const stepOf = async (who: Id, send: () => Promise<Res>) => {
        const before = tombsOf(who.pk);
        const r = await send();
        requests++;
        worstStep = Math.max(worstStep, tombsOf(who.pk) - before);
        return r;
    };
    let lastKnown: Res | undefined, lastRandom: Res | undefined;
    for (let i = 0; i < rounds; i++) {
        lastKnown = await stepOf(gus, () => call('POST', gus, '/api/blocks', { targetPubkeys: known }));
        await stepOf(gus, () => call('POST', gus, '/api/blocks/clear', {}));
        lastRandom = await stepOf(gus, () => call('POST', gus, '/api/blocks', { targetPubkeys: Array.from({ length: 500 }, newKey) }));
        await stepOf(gus, () => call('POST', gus, '/api/blocks/clear', {}));
    }
    assert(lastKnown?.status === 200 && lastKnown.body?.added?.length === 500 && lastRandom?.status === 200 && lastRandom.body?.skipped === 500,
        `each round blocks the 500 keys this node knows, and skips the 500 that are nobody's (${lastKnown?.body?.added?.length} added, ${lastRandom?.body?.skipped} skipped)`);
    assert(rowsOf(gus).length === 0 && tombsOf(gus.pk) <= 1 && worstStep <= 1,
        `${rounds} rounds of each (${requests} requests) leave ${tombsOf(gus.pk)} tombstone for his list, and no request added more than one (at most ${worstStep})`);

    // Rounds of "block + unblock", one key at a time, past the ceiling, while Hal keeps two blocks throughout.
    await call('POST', hal, '/api/blocks', { targetPubkeys: [fay.pk, gus.pk] });
    const halKept = rowsOf(hal);
    const singles = CEILING + 100;
    let halMost = 0, halStep = 0;
    for (let i = 0; i < singles; i++) {
        const k = newKey();
        const before = tombsOf(hal.pk);
        await call('POST', hal, '/api/blocks', { targetPubkey: k });
        await call('POST', hal, '/api/blocks/remove', { targetPubkey: k });
        const now9 = tombsOf(hal.pk);
        halStep = Math.max(halStep, now9 - before);
        halMost = Math.max(halMost, now9);
    }
    assert(halMost <= CEILING + 1 && halStep <= 1,
        `${singles} rounds of "block + unblock": never more than ${CEILING + 1} tombstones for his list (at most ${halMost}), and never more than one more a round (${halStep})`);
    const halList = listTombOf(hal.pk);
    const halRead = await call('GET', hal, '/api/blocks');
    assert(!!halList && same(listed(halRead), halKept.map(r => r.blocked_pubkey))
        && rowsOf(hal).every(r => r.updated_at > halList && r.created_at === halKept.find(k => k.blocked_pubkey === r.blocked_pubkey)?.created_at),
        `past ${CEILING}, his tombstones fold into one for his list; the two blocks he holds are stamped after it, so a standby keeps them, and read as before (${listed(halRead).length})`);

    // A whole copy carries no more than that.
    const copy9: any = await exportSyncState(nodeId);
    const copied = (o: Id) => (copy9.tombstones ?? []).filter((t: any) => t.tableName === 'member_blocks' && String(t.rowKey).startsWith(`${o.pk}|`)).length;
    const copiedAll = (copy9.tombstones ?? []).filter((t: any) => t.tableName === 'member_blocks').length;
    assert(copied(hal) <= CEILING + 1 && copied(gus) <= 1 && copied(fay) <= 1 && copiedAll <= CEILING + 3,
        `a whole copy carries at most ${CEILING + 1} of each owner's tombstones (Hal ${copied(hal)}, Gus ${copied(gus)}, Fay ${copied(fay)}; ${copiedAll} in all)`);

    // Unblock All against the clock.
    const T9 = Date.parse('2032-02-02T02:02:02.222Z');
    attempt(() => blocks.addBlocks(fay.pk, [gus.pk], T9 - 5));
    attempt(() => blocks.clearBlocks(fay.pk, T9));
    attempt(() => blocks.addBlocks(fay.pk, [gus.pk], T9));
    const w9 = listTombOf(fay.pk);
    const r9 = rowOf(fay.pk, gus.pk);
    assert(!!w9 && !!r9 && r9.updated_at > w9, `a block made again in the millisecond of Unblock All is stamped after it (${r9?.updated_at} > ${w9})`);
    attempt(() => blocks.clearBlocks(fay.pk, T9));
    attempt(() => blocks.addBlocks(fay.pk, [hal.pk], T9 - 60_000));
    const w9b = listTombOf(fay.pk);
    const r9b = rowOf(fay.pk, hal.pk);
    assert(!!w9b && !!r9b && r9b.updated_at > w9b, `and one made with the clock stepped back a minute (${r9b?.updated_at} > ${w9b})`);
    attempt(() => blocks.clearBlocks(fay.pk, T9 - 120_000));
    const w9c = listTombOf(fay.pk);
    assert(!!w9b && !!w9c && w9c >= w9b && !!r9b && w9c >= r9b.updated_at && rowsOf(fay).length === 0 && tombsOf(fay.pk) === 1,
        `an Unblock All with the clock two minutes back stamps her list's tombstone no earlier than the last one, nor than the row it deletes (${w9c})`);
    const emptyBefore = [tombsOf(fay.pk), listTombOf(fay.pk)];
    const emptyClear = await call('POST', fay, '/api/blocks/clear', {});
    assert(emptyClear.status === 200 && emptyClear.body?.removed === 0 && tombsOf(fay.pk) === emptyBefore[0] && listTombOf(fay.pk) === emptyBefore[1],
        'Unblock All of an empty list writes nothing');
    await p2p.stop();

    for (const s of [annTab1, annTab2, boSock, cySock, anonSock]) s.ws.close();
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Member block list checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
