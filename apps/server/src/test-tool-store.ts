/**
 * The tool store (slice S2 of scratch/tools/DESIGN-shops-and-tools-fable.md §9.3; engine/tool-state.ts, routes/tools.ts):
 * each tool's private copy of its owner's document, read and written only by its owner, a member or an enterprise's
 * keepers.
 *
 * Over REAL HTTPS through the real signature middleware:
 *
 *   1. the owner's own copy: none yet; kept, read back whole, replaced (the stamp always moving on), private and no-store,
 *      nothing in the activity feed; deleted with a tombstone no earlier than the row; a delete of nothing writes
 *      nothing; written again after its delete, stamped after the tombstone
 *   2. nobody else reads or changes it: another member reads their own; a body naming the owner (ownerPubkey,
 *      publicKey) is refused by the middleware; a query naming the owner changes nothing; the owner's key on another
 *      key's signature, no signature, a replayed request, a key with no row and a visitor's row are refused; an
 *      enterprise's copies are its keepers' alone: another member 403, a keeper of another enterprise 403, a made-up
 *      enterprise or a member's key in the path 404; a second keeper of the same enterprise shares them; the keeper's own
 *      and the enterprise's are apart
 *   3. the bounds: 64 KB as stored taken, a byte over refused in a sentence and nothing written (UTF-8 counted as bytes);
 *      a body far over refused unread; a document that is no JSON object; bad tool ids and the reserved `community:`;
 *      32 different tools, the 33rd refused, a deleted one still counting and its own place still its own
 *   4. the day budget: a change is one of the signer's day of signed writes, a read is not; a keeper's change for the
 *      enterprise counts on the enterprise's day
 *   5. a standby answers the read from its copy and refuses every change, 409 standby, writing nothing; the engine
 *      refuses underneath
 *   6. a closed account: a removal and a self-deletion take the owner's copies, each with a tombstone no earlier than its
 *      row, and the key is refused after; an enterprise closed has no tools to read or change, one wound up keeps them
 *      to read; a re-key moves the copies to the new key, and the old key reads nothing
 *   7. replication: a whole copy carries every row verbatim and a new standby holds them exactly; a delta carries a new
 *      copy and a delete's tombstone, and the standby follows both; a delete and a write again in one millisecond, and a
 *      write then a delete, order on the standby as on the main server; a delete and then a re-key between two pulls,
 *      and the deleted copy comes back under neither key
 *   8. privacy by construction: no code outside the store's own files names the table
 *
 * Local only: it talks to the server it starts on localhost, and to nothing else.
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-tool-store.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_READ_AUTH;
process.env.ADMIN_PASSWORD = 'ToolStorePass123!';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initTls } from './services/tls.js';
import {
    initStateEngine, seedGenesisMember, adminPruneUser, exportSyncState, signSyncPayload, importRemoteState, setNodeRole,
    reconcileLedgerFromDb,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { db } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';
import { emptyCopiedTables } from './engine/copied-tables.js';
import { resetGatewayRateLimit, gatewayAdmitDayBudget } from './gateway-rate-limit.js';
import { WRITER_LIMITS } from './config/writer-limits.js';
import { issueRekeyCode, completeRekey } from './engine/member-wizards.js';
import { ledger } from './engine/ledger.js';
import { startP2P } from './p2p.js';
import { pinMainServerForTests } from './standby-pin-test-helper.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
/** A step that throws on a tree without the store (no such table, no such module) fails its assertion, not the run. */
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
let owner: Id;
const WEEK_AGO = () => new Date(Date.now() - 7 * 86_400_000).toISOString();
function member(name: string, opts: { visitor?: boolean } = {}): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_visitor)
                VALUES (?, ?, ?, ?, ?, 'active', ?)`)
        .run(id.pk, name, WEEK_AGO(), opts.visitor ? null : owner.pk, opts.visitor ? null : 'TEST', opts.visitor ? 1 : 0);
    if (!opts.visitor) setMemberPhoto(db, id.pk, 'https://example.com/a.jpg');
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, ?)').run(id.pk, ledger.getCurrentEpoch());
    return id;
}

type Method = 'GET' | 'PUT' | 'DELETE' | 'POST';
interface Req { method: Method; path: string; headers: Record<string, string>; body?: string }
interface Res { status: number; body: any; headers: Headers }
/** The app's signed request (the format before request binding, which every node still takes), ready to send or send again. */
function signed(method: Method, route: string, id: Id, body?: unknown, opts: { headerKey?: string; raw?: string } = {}): Req {
    const raw = method === 'GET' ? '' : opts.raw ?? JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
        'X-Public-Key': opts.headerKey ?? id.pk,
        'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${route.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    return { method, path: route, headers, body: method === 'GET' ? undefined : raw };
}
/** Sends it. Every send starts the gateway's buckets afresh, the day budget's too, but those of section 4. */
async function send(req: Req, opts: { keepDay?: boolean } = {}): Promise<Res> {
    if (!opts.keepDay) resetGatewayRateLimit();
    const res = await fetch(`${BASE}${req.path}`, { method: req.method, headers: req.headers, body: req.body });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* empty or not JSON */ }
    return { status: res.status, body: parsed, headers: res.headers };
}
const call = (method: Method, id: Id, route: string, body?: unknown, opts: { headerKey?: string; raw?: string; keepDay?: boolean } = {}) =>
    send(signed(method, route, id, body, opts), opts);
async function unsigned(method: Method, route: string, body?: unknown): Promise<Res> {
    return send({ method, path: route, headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
}
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 180)}`;

// ── the store's routes ──────────────────────────────────────────────────────────────────────────
const own = (tool: string) => `/api/tools/${tool}`;
const ent = (treasury: string, tool: string) => `/api/treasury/${treasury}/tools/${tool}`;
const put = (id: Id, route: string, doc: unknown, opts: { keepDay?: boolean } = {}) => call('PUT', id, route, { doc }, opts);

// ── what is kept, read straight from the database ─────────────────────────────────────────────────
interface Row { public_key: string; tool: string; body: string; updated_at: string }
const rowOf = (pk: string, tool: string) => attempt(() => db.prepare('SELECT * FROM member_tool_state WHERE public_key = ? AND tool = ?').get(pk, tool) as Row | undefined);
const rowsOf = (pk: string) => attempt(() => db.prepare('SELECT * FROM member_tool_state WHERE public_key = ? ORDER BY tool').all(pk) as Row[]) ?? [];
const everyRow = () => attempt(() => db.prepare('SELECT * FROM member_tool_state ORDER BY public_key, tool').all() as Row[]) ?? [];
const tombOf = (pk: string, tool: string) => (db.prepare("SELECT deleted_at FROM tombstones WHERE table_name = 'member_tool_state' AND row_key = ?")
    .get(`${pk}|${tool}`) as { deleted_at: string } | undefined)?.deleted_at ?? null;
const tombsOf = (pk: string) => (db.prepare("SELECT COUNT(*) AS n FROM tombstones WHERE table_name = 'member_tool_state' AND substr(row_key, 1, 65) = ?")
    .get(`${pk}|`) as { n: number }).n;
const feedCount = () => (db.prepare('SELECT COUNT(*) AS n FROM activity_feed').get() as { n: number }).n;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function main(): Promise<void> {
    console.log('\n=== The tool store: each tool\'s private copy, its owner\'s alone ===\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    // Absent on a tree without it: every check that needs it fails, and the rest still run.
    const store: any = await import('./engine/tool-state.js').catch(() => null);

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const ann = member('Ann');
    const bo = member('Bo');
    const cy = member('Cy');
    const dee = member('Dee');
    const eve = member('Eve');
    const vera = member('Vera', { visitor: true });
    const nobody = newId('Nemo'); // a key that is no member here
    reconcileLedgerFromDb();

    // Two enterprises: Ann's shop (Ann, then Bo, keep it) and Cy's.
    const startEnterprise = async (keeper: Id, name: string): Promise<string> => {
        const r = await call('POST', keeper, '/api/enterprise', { name, purpose: `${name}, a test enterprise` });
        const pk = r.body?.publicKey as string;
        if (!pk) throw new Error(`setup: ${keeper.name} could not start ${name}: ${show(r)}`);
        setMemberPhoto(db, pk, 'https://example.com/e.jpg');
        return pk;
    };
    const shop = await startEnterprise(ann, 'Ann Tools');
    const cyShop = await startEnterprise(cy, 'Cy Seeds');
    db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(bo.pk);
    db.prepare('INSERT OR IGNORE INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)').run(shop, bo.pk);

    // ── 1. the owner's own copy ─────────────────────────────────────────────────────────────────
    console.log('── 1. the owner\'s own copy ──');
    const feedBefore = feedCount();
    const none = await call('GET', ann, own('things'));
    assert(none.status === 200 && none.body?.tool === 'things' && none.body?.doc === null && none.body?.updatedAt === null && none.body?.max === 65_536,
        `none kept yet: 200, doc and updatedAt null, and the bound (${show(none)})`);
    const doc1 = { v: 1, things: [{ id: 't1', name: 'Drill', note: 'Lent to Steve since 3 Oct' }], ownerPubkey: bo.pk, unicode: 'ñ 🌱 漢' };
    const w1 = await put(ann, own('things'), doc1);
    const r1 = rowOf(ann.pk, 'things');
    assert(w1.status === 200 && w1.body?.success === true && w1.body?.tool === 'things' && typeof w1.body?.updatedAt === 'string'
        && w1.body?.updatedAt === r1?.updated_at && w1.body?.bytes === Buffer.byteLength(r1?.body ?? '', 'utf8'),
        `kept: 200, with the copy's stamp and size as stored (${show(w1)})`);
    assert(!!r1 && r1.public_key === ann.pk && same(JSON.parse(r1.body), doc1),
        "stored under the signer's key, the document whole (a key inside it is the document's, never read as an identity)");
    const g1 = await call('GET', ann, own('things'));
    assert(g1.status === 200 && same(g1.body?.doc, doc1) && g1.body?.updatedAt === r1?.updated_at && g1.body?.bytes === w1.body?.bytes,
        `read back whole, with the same stamp (${show(g1)})`);
    assert(/private/.test(g1.headers.get('cache-control') ?? '') && /no-store/.test(g1.headers.get('cache-control') ?? '')
        && /no-store/.test(w1.headers.get('cache-control') ?? ''), `private and no-store (${g1.headers.get('cache-control')})`);
    const doc2 = { v: 2, things: [] };
    const stamps: string[] = [];
    for (let i = 0; i < 4; i++) stamps.push((await put(ann, own('things'), { ...doc2, i })).body?.updatedAt);
    assert(stamps.every((s, i) => typeof s === 'string' && (i === 0 ? s > (r1?.updated_at ?? '') : s > stamps[i - 1])),
        `replaced whole each time, and each stamp after the one before, however fast (${stamps.map(s => s?.slice(17)).join(', ')})`);
    assert(same(JSON.parse(rowOf(ann.pk, 'things')?.body ?? 'null'), { ...doc2, i: 3 }) && rowsOf(ann.pk).length === 1, 'the last writer wins, one row');
    const sameMs = attempt(() => { const t = Date.now() + 60_000; return [store.writeToolState(ann.pk, 'notes', { v: 1 }, t).updatedAt, store.writeToolState(ann.pk, 'notes', { v: 2 }, t).updatedAt]; });
    assert(!!sameMs && sameMs[1] > sameMs[0], `two writes in one millisecond still order (${sameMs?.join(' < ')})`);
    attempt(() => store.deleteToolState(ann.pk, 'notes', Date.now() + 120_000));
    const before = rowOf(ann.pk, 'things');
    const d1 = await call('DELETE', ann, own('things'));
    const t1 = tombOf(ann.pk, 'things');
    assert(d1.status === 200 && d1.body?.success === true && d1.body?.removed === true && rowOf(ann.pk, 'things') === undefined,
        `deleted (${show(d1)})`);
    assert(!!t1 && !!before && t1 >= before.updated_at, `with a tombstone no earlier than the row, so a standby deletes it too (${t1} ≥ ${before?.updated_at})`);
    const g2 = await call('GET', ann, own('things'));
    assert(g2.status === 200 && g2.body?.doc === null && g2.body?.updatedAt === null, `gone: the read says none (${show(g2)})`);
    const tombsBefore = tombsOf(ann.pk);
    const d2 = await call('DELETE', ann, own('things'));
    const d3 = await call('DELETE', ann, own('garden'));
    assert(d2.status === 200 && d2.body?.removed === false && d3.body?.removed === false && tombsOf(ann.pk) === tombsBefore && tombOf(ann.pk, 'garden') === null,
        `a delete of nothing answers removed: false and writes nothing (${show(d2)}; ${tombsOf(ann.pk)} tombstones)`);
    const w2 = await put(ann, own('things'), doc2);
    assert(w2.status === 200 && (w2.body?.updatedAt ?? '') > (tombOf(ann.pk, 'things') ?? ''), `written again after its delete, stamped after the tombstone (${w2.body?.updatedAt})`);
    assert(feedCount() === feedBefore, 'nothing in the activity feed');

    // ── 2. nobody else ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. nobody else reads or changes it ──');
    const annRow = rowOf(ann.pk, 'things');
    const boRead = await call('GET', bo, own('things'));
    assert(boRead.status === 200 && boRead.body?.doc === null, `another member reads their own, which is none (${show(boRead)})`);
    const boQuery = await call('GET', bo, `${own('things')}?owner=${ann.pk}&publicKey=${ann.pk}`);
    assert(boQuery.status === 200 && boQuery.body?.doc === null, `a query naming the owner reads the signer's own all the same (${show(boQuery)})`);
    const spoofs = [
        await call('PUT', bo, own('things'), { doc: { v: 9 }, ownerPubkey: ann.pk }),
        await call('PUT', bo, own('things'), { doc: { v: 9 }, publicKey: ann.pk }),
        await call('DELETE', bo, own('things'), { publicKey: ann.pk }),
    ];
    assert(spoofs.every(r => r.status === 403), `a body naming the owner is refused by the middleware (${spoofs.map(r => r.status).join(', ')})`);
    const boPut = await put(bo, `${own('things')}?owner=${ann.pk}`, { v: 9 });
    assert(boPut.status === 200 && rowOf(bo.pk, 'things') !== undefined, `a write with the owner in the query is the signer's own (${show(boPut)})`);
    attempt(() => store.deleteToolState(bo.pk, 'things'));
    const forged = [
        await call('GET', bo, own('things'), undefined, { headerKey: ann.pk }),
        await call('PUT', bo, own('things'), { doc: { v: 9 } }, { headerKey: ann.pk }),
        await call('DELETE', bo, own('things'), undefined, { headerKey: ann.pk }),
    ];
    assert(forged.every(r => r.status === 403 && /signature/i.test(r.body?.error ?? '')) && rowOf(ann.pk, 'things')?.body === annRow?.body,
        `the owner's key on another key's signature: refused by the middleware, nothing changed (${forged.map(show).join(' | ')})`);
    const anon = [await unsigned('GET', own('things')), await unsigned('PUT', own('things'), { doc: { v: 9 } }), await unsigned('DELETE', own('things'))];
    assert(anon.every(r => r.status === 401), `no signature: 401 (${anon.map(r => r.status).join(', ')})`);
    const once = signed('PUT', own('things'), ann, { doc: { v: 7 } });
    const first = await send(once);
    const replay = await send(once);
    assert(first.status === 200 && replay.status !== 200, `a replayed request is refused (${first.status}, then ${show(replay)})`);
    const nobodyR = [await call('GET', nobody, own('things')), await put(nobody, own('things'), { v: 9 }), await call('DELETE', nobody, own('things'))];
    assert(nobodyR[0].status === 403 && nobodyR[1].status === 403 && nobodyR[1].body?.code === 'not_a_member' && nobodyR[2].status === 403
        && rowsOf(nobody.pk).length === 0, `a key with no row: 403, nothing kept (${nobodyR.map(show).join(' | ')})`);
    const veraR = [await call('GET', vera, own('things')), await put(vera, own('things'), { v: 9 }), await call('DELETE', vera, own('things'))];
    assert(veraR.every(r => r.status === 403) && veraR[1].body?.code === 'not_a_member' && rowsOf(vera.pk).length === 0,
        `a visitor's row: 403, answered as a key with no row, nothing kept (${veraR.map(show).join(' | ')})`);
    assert(!!annRow && rowOf(ann.pk, 'things')?.body === JSON.stringify({ v: 7 }) && rowsOf(ann.pk).length === 1,
        "and Ann's copy is hers alone: only her own write changed it");

    // An enterprise's copies.
    const shopDoc = { v: 1, stock: [{ name: 'Eggs', qty: 12 }] };
    const sw = await put(ann, ent(shop, 'stock'), shopDoc);
    assert(sw.status === 200 && same(JSON.parse(rowOf(shop, 'stock')?.body ?? 'null'), shopDoc) && rowOf(ann.pk, 'stock') === undefined,
        `a keeper keeps the enterprise's copy, under the enterprise's key, not her own (${show(sw)})`);
    const boKeeps = await call('GET', bo, ent(shop, 'stock'));
    assert(boKeeps.status === 200 && same(boKeeps.body?.doc, shopDoc), `a second keeper of it reads the same copy (${show(boKeeps)})`);
    const annOwn = await call('GET', ann, own('stock'));
    assert(annOwn.status === 200 && annOwn.body?.doc === null, "the keeper's own copies and the enterprise's are apart");
    const notKeeper = [await call('GET', dee, ent(shop, 'stock')), await put(dee, ent(shop, 'stock'), { v: 9 }), await call('DELETE', dee, ent(shop, 'stock'))];
    assert(notKeeper.every(r => r.status === 403 && /not a keeper of this enterprise/.test(r.body?.error ?? '')),
        `another member: 403, not a keeper of this enterprise (${notKeeper.map(r => r.status).join(', ')})`);
    const otherKeeper = [await call('GET', cy, ent(shop, 'stock')), await put(cy, ent(shop, 'stock'), { v: 9 }), await call('DELETE', cy, ent(shop, 'stock'))];
    assert(otherKeeper.every(r => r.status === 403 && /not a keeper of this enterprise/.test(r.body?.error ?? '')),
        `a keeper of another enterprise: 403 (${otherKeeper.map(r => r.status).join(', ')})`);
    const cyOwn = await put(cy, ent(cyShop, 'stock'), { v: 1, mine: true });
    const annOnCy = await call('GET', ann, ent(cyShop, 'stock'));
    assert(cyOwn.status === 200 && annOnCy.status === 403, `and the other way: Ann, keeping hers, reads none of Cy's (${show(annOnCy)})`);
    const veraEnt = await put(vera, ent(shop, 'stock'), { v: 9 });
    const madeUp = await call('GET', ann, ent(newId('x').pk, 'stock'));
    const memberKey = await put(ann, ent(bo.pk, 'stock'), { v: 9 });
    assert(veraEnt.status === 403 && madeUp.status === 404 && memberKey.status === 404 && rowOf(bo.pk, 'stock') === undefined,
        `a visitor's row 403; a made-up enterprise and a member's key in the path 404, nothing kept (${[veraEnt, madeUp, memberKey].map(show).join(' | ')})`);
    assert(same(JSON.parse(rowOf(shop, 'stock')?.body ?? 'null'), shopDoc), "the enterprise's copy unchanged by every refusal");
    const spoofEnt = await call('PUT', dee, ent(shop, 'stock'), { doc: { v: 9 }, treasuryPubkey: shop });
    assert(spoofEnt.status === 403 && same(JSON.parse(rowOf(shop, 'stock')?.body ?? 'null'), shopDoc),
        `naming the enterprise in the body gives nobody its copy (${show(spoofEnt)})`);

    // ── 3. the bounds ───────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. the bounds ──');
    // {"v":1,"p":"<pad>"} is 14 bytes and the pad.
    const sized = (bytes: number, ch = 'a') => ({ v: 1, p: ch.repeat(Math.floor((bytes - 14) / Buffer.byteLength(ch, 'utf8'))) });
    const full = sized(65_536);
    assert(Buffer.byteLength(JSON.stringify(full), 'utf8') === 65_536 && Buffer.byteLength(JSON.stringify(sized(65_537)), 'utf8') === 65_537, 'setup: the sizes are exact');
    const atMax = await put(eve, own('things'), full);
    assert(atMax.status === 200 && atMax.body?.bytes === 65_536 && Buffer.byteLength(rowOf(eve.pk, 'things')?.body ?? '', 'utf8') === 65_536,
        `64 KB as stored is taken (${show(atMax)})`);
    const over = await put(eve, own('things'), sized(65_537));
    assert(over.status === 413 && over.body?.code === 'tool_doc_too_large' && /at most 64 KB/.test(over.body?.error ?? '') && /\.$/.test(over.body?.error ?? ''),
        `a byte over is refused in a sentence (${show(over)})`);
    assert(Buffer.byteLength(rowOf(eve.pk, 'things')?.body ?? '', 'utf8') === 65_536, 'and nothing is written: the copy before stays');
    const wide = sized(65_536, 'é'); // 32,775 characters, 65,536 bytes
    const wideOver = await put(eve, own('garden'), { ...wide, p: wide.p + 'é' });
    assert(Buffer.byteLength(JSON.stringify(wide), 'utf8') === 65_536 && JSON.stringify(wide).length < 40_000 && wideOver.status === 413 && rowOf(eve.pk, 'garden') === undefined,
        `counted as UTF-8 bytes, not characters (${show(wideOver)})`);
    const huge = await call('PUT', eve, own('garden'), undefined, { raw: JSON.stringify({ doc: { p: 'x'.repeat(300 * 1024) } }) });
    assert(huge.status === 413 && rowOf(eve.pk, 'garden') === undefined, `a body far over is refused before it is read (${show(huge)})`);
    const notObjects = [await put(eve, own('garden'), [1, 2]), await put(eve, own('garden'), 'text'), await put(eve, own('garden'), null),
        await put(eve, own('garden'), 7), await call('PUT', eve, own('garden'), {})];
    assert(notObjects.every(r => r.status === 400 && r.body?.code === 'bad_tool_doc') && rowOf(eve.pk, 'garden') === undefined,
        `a document that is no JSON object, or none: 400 in a sentence (${notObjects.map(r => r.status).join(', ')}; ${notObjects[0].body?.error})`);
    const ok24 = await put(eve, own('a'.repeat(20) + '-9z0'), { v: 1 });
    assert(ok24.status === 200, `a 24-character id of letters, digits and hyphens is taken (${show(ok24)})`);
    const badIds = ['Things', 'a'.repeat(25), 'a_b', 'a.b', '%20', 'th%C3%ADngs'];
    const badR = await Promise.all(badIds.map(async t => [t, await put(eve, own(t), { v: 1 })] as const));
    assert(badR.every(([, r]) => r.status === 400 && r.body?.code === 'bad_tool'), `bad ids: 400 bad_tool (${badR.map(([t, r]) => `${t} ${r.status}`).join(', ')})`);
    const reserved = [await put(eve, own('community:things'), { v: 1 }), await put(eve, own('community%3Athings'), { v: 1 }),
        await call('GET', eve, own('community:things')), await put(ann, ent(shop, 'community:stock'), { v: 1 })];
    assert(reserved.every(r => r.status === 400 && r.body?.code === 'tool_reserved' && /community:/.test(r.body?.error ?? '')),
        `the community: prefix is kept, refused in a sentence of its own (${reserved.map(show).join(' | ')})`);
    assert(rowsOf(eve.pk).length === 2, `nothing else kept for Eve (${rowsOf(eve.pk).map(r => r.tool).join(', ')})`);
    const MAX = store?.TOOL_STATE_TOOLS_MAX ?? 32;
    const fill: number[] = [];
    for (let i = rowsOf(eve.pk).length; i < MAX; i++) fill.push((await put(eve, own(`t${i}`), { v: 1 })).status);
    assert(fill.every(s => s === 200) && rowsOf(eve.pk).length === MAX, `${MAX} different tools are kept (${rowsOf(eve.pk).length})`);
    const past = await put(eve, own('one-more'), { v: 1 });
    assert(past.status === 409 && past.body?.code === 'tool_copies_max' && /at most 32 different tools/.test(past.body?.error ?? '') && rowOf(eve.pk, 'one-more') === undefined,
        `one more is refused in a sentence (${show(past)})`);
    await call('DELETE', eve, own('t5'));
    const afterDelete = await put(eve, own('one-more'), { v: 1 });
    const backAgain = await put(eve, own('t5'), { v: 2 });
    const update = await put(eve, own('t6'), { v: 2 });
    assert(afterDelete.status === 409 && backAgain.status === 200 && update.status === 200 && rowsOf(eve.pk).length === MAX,
        `a deleted one still counts for its 30 days, and keeps its own place (${afterDelete.status}, ${backAgain.status}, ${update.status})`);
    for (let round = 0; round < 3; round++) for (const t of ['t7', 't8']) { await call('DELETE', eve, own(t)); await put(eve, own(t), { v: round }); }
    assert(tombsOf(eve.pk) <= MAX && rowsOf(eve.pk).length === MAX, `delete and write again leaves one tombstone a tool at most (${tombsOf(eve.pk)})`);

    // ── 4. the day budget ───────────────────────────────────────────────────────────────────────
    console.log('\n── 4. the day budget ──');
    resetGatewayRateLimit();
    const ctx = (actor: string) => ({ state: { actor }, method: 'POST', path: '/api/community/me/area', status: 200, body: undefined, set: () => {} }) as any;
    const now = Date.now();
    for (let i = 0; i < WRITER_LIMITS.signedWritesPerDay - 2; i++) gatewayAdmitDayBudget(ctx(ann.pk), now);
    const lastTwo = [await put(ann, own('garden'), { v: 1 }, { keepDay: true }), await call('DELETE', ann, own('garden'), undefined, { keepDay: true })];
    const spent = await put(ann, own('garden'), { v: 2 }, { keepDay: true });
    assert(lastTwo.every(r => r.status === 200) && spent.status === 429 && spent.body?.code === 'day_budget' && rowOf(ann.pk, 'garden') === undefined,
        `a write and a delete are each one of the day's ${WRITER_LIMITS.signedWritesPerDay.toLocaleString('en')} signed writes: the next is 429 day_budget (${show(spent)})`);
    const reads = [await call('GET', ann, own('things'), undefined, { keepDay: true }), await call('GET', ann, own('things'), undefined, { keepDay: true })];
    assert(reads.every(r => r.status === 200), 'a read is not counted');
    const forShop = await put(ann, ent(shop, 'stock'), { v: 2 }, { keepDay: true });
    assert(forShop.status === 200, `with her own day spent, her write for the enterprise counts on its day and goes (${show(forShop)})`);
    resetGatewayRateLimit();

    // ── 5. a standby ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. a standby answers the read and refuses a change ──');
    const snapshot = JSON.stringify(everyRow());
    const tombsAll = () => (db.prepare("SELECT COUNT(*) AS n FROM tombstones WHERE table_name = 'member_tool_state'").get() as { n: number }).n;
    const tombsBeforeStandby = tombsAll();
    setNodeRole('backup');
    const sRead = await call('GET', ann, own('things'));
    const sEnt = await call('GET', bo, ent(shop, 'stock'));
    const sChanges = [await put(ann, own('things'), { v: 99 }), await call('DELETE', ann, own('things')), await put(ann, own('fresh'), { v: 1 }),
        await put(bo, ent(shop, 'stock'), { v: 99 }), await call('DELETE', bo, ent(shop, 'stock'))];
    const engineRefuses = [() => store.writeToolState(ann.pk, 'things', { v: 98 }), () => store.deleteToolState(ann.pk, 'things')].map(fn => {
        try { fn(); return 'wrote'; } catch (e: any) { return e?.code ?? e?.message; }
    });
    setNodeRole('primary');
    assert(sRead.status === 200 && sRead.body?.doc?.v === 7 && sEnt.status === 200 && sEnt.body?.doc?.v === 2, `the reads, from its copy (${show(sRead)}; ${show(sEnt)})`);
    assert(sChanges.every(r => r.status === 409 && r.body?.code === 'standby'), `every change: 409 standby (${sChanges.map(r => r.status).join(', ')})`);
    assert(engineRefuses.every(c => c === 'standby'), `and the engine refuses underneath (${engineRefuses.join(', ')})`);
    assert(JSON.stringify(everyRow()) === snapshot && tombsAll() === tombsBeforeStandby, 'nothing written');

    // ── 6. closed accounts, closed enterprises, a re-key ────────────────────────────────────────
    console.log('\n── 6. a closed account, a closed enterprise, a re-key ──');
    await put(cy, own('things'), { v: 1 });
    await put(cy, own('garden'), { v: 1 });
    const cyRows = rowsOf(cy.pk);
    const purge = await call('POST', cy, '/api/member/purge', { action: 'purge_account' });
    assert(purge.status === 200 && cyRows.length === 2 && rowsOf(cy.pk).length === 0, `Cy deletes her account: her copies go (${show(purge)}; ${cyRows.length} → ${rowsOf(cy.pk).length})`);
    assert(cyRows.every(r => (tombOf(cy.pk, r.tool) ?? '') >= r.updated_at), 'each with a tombstone no earlier than it, so a standby deletes it too');
    const cyAfter = [await call('GET', cy, own('things')), await put(cy, own('things'), { v: 2 }), await call('DELETE', cy, own('things'))];
    assert(cyAfter.every(r => r.status === 403 && r.body?.code === 'account_closed') && rowsOf(cy.pk).length === 0,
        `her key is refused after: 403 account_closed (${cyAfter.map(r => r.status).join(', ')})`);
    assert(rowOf(cyShop, 'stock') !== undefined, "the enterprise she kept keeps its own copies (they are the enterprise's)");
    await put(dee, own('things'), { v: 1 });
    const deeRows = rowsOf(dee.pk);
    attempt(() => adminPruneUser(dee.pk, 'owner:password'));
    assert(deeRows.length === 1 && rowsOf(dee.pk).length === 0 && deeRows.every(r => (tombOf(dee.pk, r.tool) ?? '') >= r.updated_at),
        `a removal takes Dee's copies, tombstoned (${deeRows.length} → ${rowsOf(dee.pk).length})`);
    const deeAfter = [await call('GET', dee, own('things')), await put(dee, own('things'), { v: 2 })];
    assert(deeAfter.every(r => r.status === 403 && r.body?.code === 'account_closed') && rowsOf(dee.pk).length === 0,
        `a pruned account is refused: 403 account_closed, nothing kept (${deeAfter.map(r => r.status).join(', ')})`);

    const closedShop = await startEnterprise(bo, 'Bo Closed');
    await put(bo, ent(closedShop, 'stock'), { v: 1 });
    for (const status of ['suspended', 'pruned']) {
        db.prepare('UPDATE members SET status = ? WHERE public_key = ?').run(status, closedShop);
        const r = [await call('GET', bo, ent(closedShop, 'stock')), await put(bo, ent(closedShop, 'stock'), { v: 2 }), await call('DELETE', bo, ent(closedShop, 'stock'))];
        assert(r.every(x => x.status === 403 && x.body?.code === 'enterprise_closed') && JSON.parse(rowOf(closedShop, 'stock')?.body ?? '{}').v === 1,
            `an enterprise ${status}: no tools to read or change (${r.map(x => x.status).join(', ')})`);
    }
    db.prepare("UPDATE members SET status = 'completed' WHERE public_key = ?").run(closedShop);
    const woundUp = [await call('GET', bo, ent(closedShop, 'stock')), await put(bo, ent(closedShop, 'stock'), { v: 2 }), await call('DELETE', bo, ent(closedShop, 'stock'))];
    assert(woundUp[0].status === 200 && woundUp[0].body?.doc?.v === 1 && woundUp[1].status === 403 && woundUp[2].status === 403
        && /wound up/.test(woundUp[1].body?.error ?? '') && rowOf(closedShop, 'stock') !== undefined,
        `one wound up keeps its copies to read, and none changes (${woundUp.map(show).join(' | ')})`);
    db.prepare("UPDATE members SET status = 'suspended' WHERE public_key = ?").run(bo.pk);
    const suspendedKeeper = await call('GET', bo, ent(shop, 'stock'));
    const suspendedOwn = [await call('GET', bo, own('things')), await put(bo, own('things'), { v: 3 })];
    db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(bo.pk);
    assert(suspendedKeeper.status === 403 && suspendedOwn.every(r => r.status === 200),
        `a suspended keeper touches none of the enterprise's; a suspended member keeps their own (${show(suspendedKeeper)}; ${suspendedOwn.map(r => r.status).join(', ')})`);

    await put(eve, own('t2'), { v: 'rekey' });
    const eveBefore = rowsOf(eve.pk);
    const eveNew = newId('EveNew');
    const moved = attempt(() => { const code = issueRekeyCode(eve.pk, owner.pk).code; return completeRekey(eve.pk, eveNew.pk, code, owner.pk); });
    assert(moved?.success === true, 'Eve is re-keyed');
    assert(rowsOf(eve.pk).length === 0 && rowsOf(eveNew.pk).length === eveBefore.length
        && rowsOf(eveNew.pk).every(r => r.body === eveBefore.find(b => b.tool === r.tool)?.body),
        `her copies are hers on the new key, each whole (${eveBefore.length} → ${rowsOf(eveNew.pk).length})`);
    const newRead = await call('GET', eveNew, own('t2'));
    const oldRead = await call('GET', eve, own('t2'));
    assert(newRead.status === 200 && newRead.body?.doc?.v === 'rekey', `she reads them on her new key (${show(newRead)})`);
    assert(oldRead.status === 403 && oldRead.body?.code === 'key_invalidated', `the old key reads nothing (${show(oldRead)})`);

    // ── 7. replication ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 7. replication: a standby holds every copy ──');
    const p2p = await startP2P(0, 0);
    const nodeId = p2p.peerId.toString();
    pinMainServerForTests(`/ip4/127.0.0.1/tcp/4283/p2p/${nodeId}`);
    const mainRows = everyRow();
    const whole: any = await exportSyncState(nodeId);
    const exported: any[] = whole.plainTables?.member_tool_state ?? [];
    const byKey = (a: any, b: any) => `${a.public_key}|${a.tool}`.localeCompare(`${b.public_key}|${b.tool}`);
    assert(mainRows.length >= 30 && exported.length === mainRows.length && same([...exported].sort(byKey).map((r: any) => [r.public_key, r.tool, r.body, r.updated_at]),
        [...mainRows].sort(byKey).map(r => [r.public_key, r.tool, r.body, r.updated_at])), `a whole copy carries every row verbatim (${exported.length} of ${mainRows.length})`);
    const wholeCopy = await signSyncPayload((({ signature: _s, publicKey: _k, ...rest }) => rest)(whole));
    attempt(() => emptyCopiedTables(db));
    assert(everyRow().length === 0, 'a new standby holds none');
    setNodeRole('backup');
    let importError = '';
    try { await importRemoteState(wholeCopy, { full: true }); } catch (e: any) { importError = e?.message || String(e); }
    setNodeRole('primary');
    reconcileLedgerFromDb();
    assert(importError === '' && same(everyRow(), mainRows), `the standby holds them exactly, row for row and stamp for stamp (${importError || `${everyRow().length} rows`})`);
    const standbyRead = await call('GET', ann, own('things'));
    assert(standbyRead.status === 200 && standbyRead.body?.doc?.v === 7, `and answers its owner from them (${show(standbyRead)})`);

    // A delta: a new copy, a change, a delete.
    const since = new Date().toISOString();
    await sleep(5);
    const keptRows = everyRow();
    await put(ann, own('garden'), { v: 1, beds: 3 });
    await put(ann, own('things'), { v: 8 });
    await call('DELETE', bo, ent(shop, 'stock'));
    const afterMain = everyRow();
    const delta: any = await exportSyncState(nodeId, since);
    const dRows: any[] = delta.plainTables?.member_tool_state ?? [];
    const dTomb = (delta.tombstones ?? []).find((t: any) => t.tableName === 'member_tool_state' && t.rowKey === `${shop}|stock`);
    assert(same(dRows.map((r: any) => r.tool).sort(), ['garden', 'things']) && !!dTomb,
        `a delta carries the new copy, the changed one and the delete's tombstone, nothing older (${dRows.map((r: any) => r.tool).join(', ')})`);
    // The standby as it was before the delta.
    db.transaction(() => {
        db.prepare('DELETE FROM member_tool_state').run();
        const ins = db.prepare('INSERT INTO member_tool_state (public_key, tool, body, updated_at) VALUES (?, ?, ?, ?)');
        for (const r of keptRows) ins.run(r.public_key, r.tool, r.body, r.updated_at);
        db.prepare("DELETE FROM tombstones WHERE table_name = 'member_tool_state' AND row_key = ?").run(`${shop}|stock`);
    })();
    const deltaCopy = await signSyncPayload((({ signature: _s, publicKey: _k, ...rest }) => rest)(delta));
    setNodeRole('backup');
    importError = '';
    try { await importRemoteState(deltaCopy); } catch (e: any) { importError = e?.message || String(e); }
    setNodeRole('primary');
    assert(importError === '' && same(everyRow(), afterMain) && rowOf(shop, 'stock') === undefined,
        `the standby follows: the new copy and the change in, the deleted one gone (${importError || `${everyRow().length} rows`})`);

    // In one millisecond: Bo deletes a copy and writes it again; Ann writes one (stamped past the clock) and deletes it.
    const ms = Date.now() + 10 * 60_000;
    attempt(() => store.writeToolState(bo.pk, 'jobs', { v: 1 }, ms - 1));
    const since2 = new Date(Date.now() - 1).toISOString();
    attempt(() => { store.deleteToolState(bo.pk, 'jobs', ms); store.writeToolState(bo.pk, 'jobs', { v: 2 }, ms); });
    attempt(() => { store.writeToolState(ann.pk, 'costs', { v: 1 }, ms); store.writeToolState(ann.pk, 'costs', { v: 2 }, ms); store.deleteToolState(ann.pk, 'costs', ms); });
    const boJobs = rowOf(bo.pk, 'jobs');
    assert(!!boJobs && boJobs.updated_at > (tombOf(bo.pk, 'jobs') ?? '') && (tombOf(ann.pk, 'costs') ?? '') >= new Date(ms + 1).toISOString() && rowOf(ann.pk, 'costs') === undefined,
        `on the main server: the copy written again is stamped after its tombstone, and the delete after the copy it took (${boJobs?.updated_at} > ${tombOf(bo.pk, 'jobs')}; ${tombOf(ann.pk, 'costs')})`);
    const delta2: any = await exportSyncState(nodeId, since2);
    const afterMain2 = everyRow();
    db.transaction(() => {
        db.prepare('INSERT OR REPLACE INTO member_tool_state (public_key, tool, body, updated_at) VALUES (?, ?, ?, ?)').run(bo.pk, 'jobs', '{"v":1}', new Date(ms - 1).toISOString());
        db.prepare('INSERT OR REPLACE INTO member_tool_state (public_key, tool, body, updated_at) VALUES (?, ?, ?, ?)').run(ann.pk, 'costs', '{"v":2}', new Date(ms + 1).toISOString());
        db.prepare("DELETE FROM tombstones WHERE table_name = 'member_tool_state' AND row_key IN (?, ?)").run(`${bo.pk}|jobs`, `${ann.pk}|costs`);
    })();
    const delta2Copy = await signSyncPayload((({ signature: _s, publicKey: _k, ...rest }) => rest)(delta2));
    setNodeRole('backup');
    importError = '';
    try { await importRemoteState(delta2Copy); } catch (e: any) { importError = e?.message || String(e); }
    setNodeRole('primary');
    assert(importError === '' && rowOf(bo.pk, 'jobs')?.body === '{"v":2}' && rowOf(ann.pk, 'costs') === undefined && same(everyRow(), afterMain2),
        `and on the standby: the copy written again stays, the one deleted goes (${importError || `${rowOf(bo.pk, 'jobs')?.body}, ${rowOf(ann.pk, 'costs')?.body ?? 'gone'}`})`);

    // Between two pulls, Fay deletes a copy and is then re-keyed. The standby follows the re-key before the copy's rows,
    // so the delete, keyed by her old key, goes first: after the move it would match no row, and the deleted copy would
    // stay on the standby under her new key, sent back to her phone by a standby that takes over.
    const fay = member('Fay');
    await put(fay, own('kept'), { v: 1 });
    await put(fay, own('gone'), { v: 1 });
    const beforeRekey: any = await exportSyncState(nodeId);
    const since3 = new Date(Date.now() - 1).toISOString();
    await sleep(5);
    const fayDelete = await call('DELETE', fay, own('gone'));
    const fayNew = newId('FayNew');
    const fayMoved = attempt(() => { const code = issueRekeyCode(fay.pk, owner.pk).code; return completeRekey(fay.pk, fayNew.pk, code, owner.pk); });
    const afterMain3 = everyRow();
    assert(fayDelete.status === 200 && fayMoved?.success === true && rowsOf(fay.pk).length === 0 && same(rowsOf(fayNew.pk).map(r => r.tool), ['kept']),
        `on the main server: her deleted copy gone, the one she kept on her new key (${show(fayDelete)}; ${rowsOf(fayNew.pk).map(r => r.tool).join(', ')})`);
    const delta3: any = await exportSyncState(nodeId, since3);
    // The standby as it was before: a whole copy from then.
    const beforeCopy = await signSyncPayload((({ signature: _s, publicKey: _k, ...rest }) => rest)(beforeRekey));
    const delta3Copy = await signSyncPayload((({ signature: _s, publicKey: _k, ...rest }) => rest)(delta3));
    attempt(() => emptyCopiedTables(db));
    setNodeRole('backup');
    importError = '';
    try { await importRemoteState(beforeCopy, { full: true }); } catch (e: any) { importError = e?.message || String(e); }
    const standbyHad = rowsOf(fay.pk).map(r => r.tool);
    try { await importRemoteState(delta3Copy); } catch (e: any) { importError ||= e?.message || String(e); }
    setNodeRole('primary');
    reconcileLedgerFromDb();
    assert(importError === '' && same(standbyHad, ['gone', 'kept']) && rowsOf(fay.pk).length === 0 && rowOf(fayNew.pk, 'gone') === undefined
        && same(everyRow(), afterMain3),
        `and the standby follows both: the deleted copy gone under either key, the kept one on her new key (${importError || `${standbyHad.join(', ')} → ${rowsOf(fayNew.pk).map(r => r.tool).join(', ')}`})`);

    // ── 8. privacy by construction ──────────────────────────────────────────────────────────────
    console.log('\n── 8. no other code reads the store ──');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const root = path.resolve(here, '../../..');
    const named: string[] = [];
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, e.name);
            if (e.isDirectory()) {
                // beanpool-core has no database (it runs on the phone and the web too): its tools types only name the table in comments.
                if (!['node_modules', 'dist', '__tests__', '__fixtures__', 'generated', 'build', '.expo'].includes(e.name) && path.relative(root, file) !== path.join('packages', 'beanpool-core')) walk(file);
                continue;
            }
            if (!/\.(ts|tsx|mts|js|mjs|sql)$/.test(e.name) || /^(test-|bench-)|-test-harness\.ts$|\.test\.tsx?$/.test(e.name)) continue;
            if (fs.readFileSync(file, 'utf-8').includes('member_tool_state')) named.push(path.relative(root, file));
        }
    };
    for (const dir of ['apps/server/src', 'packages']) walk(path.join(root, dir));
    const EXPECTED = ['apps/server/src/db/schema.sql', 'apps/server/src/engine/key-move.ts', 'apps/server/src/engine/replication-manifest.ts',
        'apps/server/src/engine/sync.ts', 'apps/server/src/engine/tool-state.ts'];
    assert(same(named.sort(), EXPECTED),
        `only the store, its schema, its manifest line, the re-key and the standby's re-key tombstones name the table (${named.join(', ')})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) process.exit(1);
    console.log('⭐️ Each tool\'s private copy is its owner\'s alone, bounded, tombstoned and on every standby.');
    process.exit(0);
}

main().catch((e) => {
    console.error('✗ the suite stopped:', e);
    process.exit(1);
});
