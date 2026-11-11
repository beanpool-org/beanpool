/**
 * Members' locked contact lists on a community's server (scratch/fable-design/DESIGN-private-contacts-fable.md §4.3,
 * §4.4, test plan §11 "Server (C1)"): each member keeps one copy of their own list here, locked on their device and
 * signed by them (@beanpool/core makeContactsCopy). The server keeps it as bytes it can't open, for the signer alone.
 *
 * Over REAL HTTPS through the real signature middleware, on a local community: Owen (owner), Ada (admin), Ana, Ben, Cy,
 * Dot, Eve, Fay and Gus (members), and Vic (a visitor). Every copy is a real one, made by core's makeContactsCopy.
 *
 *   1. PUT then GET as Ana gives back her bytes; another member, an admin, the node's owner (each with or without a
 *      `?owner=` naming her) all get the same 404 `no_copy`; a visitor 403; unsigned 401. Ben uploading or deleting
 *      Ana's copy changes nothing of hers.
 *   2. Refusals: an equal or older number 409 `stale_copy` with the kept number; the identical copy 200 `exists`; a size
 *      that isn't a 16 KiB step 400; over 512 KiB 413; a bad signature, a box swapped under its header 400; the 13th save
 *      in an hour 429 `too_many_saves`.
 *   3. /api/me/unread says `contacts: { seq }` of the signer's own copy, or null.
 *   4. The node's budget: full, a member's first copy is refused (409 `node_full`); a member who has one still saves.
 *   5. The owners' switch: off, /api/community/info says `features.contacts: false`, GET and PUT 404 `contacts_off`,
 *      /api/me/unread says null, and every copy is deleted with a tombstone; on again, saves work.
 *   6. The row goes with the member: removed, account deleted, re-keyed; each delete leaves a tombstone. A member's own
 *      DELETE too.
 *   7. A standby: writes 409 `standby`, its GET answers the copy it keeps; the whole copy a standby pulls carries every
 *      row byte for byte, and a standby that imports it ends identical (a row it had of its own is gone).
 *   8. The schema step: a database without the table (a 1.4.0 one from before) boots with it, and nothing else changed:
 *      every other table, row and schema object byte for byte.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-contact-copies.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { CONTACTS_COPY_MAX_BYTES, CONTACTS_PAD_STEP, emptyContactsList, makeContactsCopy, putContact, writeContactsList, type ContactsCopy } from '@beanpool/core';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import { initStateEngine, exportSyncState, broadcast } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db, initSchema } from './db/db.js';
import { setSwitchOverride } from './config/node-profile.js';
import { ownerPhoneSessionHeaders } from './admin-auth-test-harness.js';
import { registerMemberInternal, registerVisitor } from './engine/members.js';
import { grantNodeRole } from './engine/node-roles.js';
import { claimGrantor } from './claim-code.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { setNodeRole } from './config/node-role.js';
import { issueRekeyCode, completeRekey } from './engine/member-wizards.js';
import { importPlainTables } from './engine/plain-tables.js';
import { CONTACT_COPIES_PER_HOUR, contactCopiesBytes, resetContactCopySavesForTests, setContactCopiesBudgetForTests } from './engine/contact-copies.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let BASE = '';
let OWNER: () => Record<string, string> = () => ({});

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`setup failed: ${msg}`);
}

interface Id { pk: string; priv: crypto.KeyObject; seedHex: string; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pk = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    const seedHex = (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    return { pk, priv: privateKey, seedHex, name };
}

interface Res { status: number; body: any; text: string }
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

async function call(id: Id | null, method: Method, urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const h: Record<string, string> = { ...headers };
    if (method !== 'GET') h['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        h['X-Public-Key'] = id.pk;
        h['X-Signature'] = signRequest(id.priv, { method, path: urlPath.split('?')[0], timestamp: ts, nonce, body: raw });
        h[SIGNED_FOR_HEADER] = signedForHost();
        h['X-Timestamp'] = String(ts);
        h['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${urlPath}`, { method, headers: h, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return { status: res.status, body: parsed, text };
}
const show = (r: Res | null) => (r ? `${r.status} ${r.text.slice(0, 200)}` : '-');

const generate = (id: Id) => call(id, 'POST', '/api/invite/generate', { publicKey: id.pk });
const redeem = (id: Id, code: string) => call(id, 'POST', '/api/invite/redeem', { code, publicKey: id.pk, callsign: id.name });
const wire = (c: ContactsCopy) => ({ header: c.header, signature: c.signature, nonce: c.nonce, sealed: c.sealed });
const getCopy = (id: Id | null, q = '') => call(id, 'GET', `/api/contacts/copy${q}`);
const putCopy = (id: Id | null, c: ContactsCopy | Record<string, unknown>) => call(id, 'PUT', '/api/contacts/copy', 'owner' in c ? wire(c as ContactsCopy) : c);
const delCopy = (id: Id | null) => call(id, 'DELETE', '/api/contacts/copy');
const unread = (id: Id) => call(id, 'GET', '/api/me/unread');

/** A device's list, `n` contacts long, locked as copy `seq`. */
function copyOf(id: Id, seq: number, n = 2, savedAt = '2026-11-11T10:00:00Z'): ContactsCopy {
    let list = emptyContactsList();
    for (let i = 0; i < n; i++) {
        list = putContact(list, { id: i.toString(16).padStart(32, '0'), name: `${id.name}'s contact ${i}`, phones: [`0400 ${String(i).padStart(6, '0')}`], emails: [], note: '', links: [], invite: null });
    }
    return makeContactsCopy({ json: writeContactsList(list), me: { publicKey: id.pk, privateKey: id.seedHex }, seq, savedAt });
}

/** A copy its owner signed whatever its sizes say: for the size refusals a device never makes. */
function signedRaw(id: Id, paddedSize: number, sealedBytes: number): Record<string, string> {
    const nonceBytes = crypto.randomBytes(24);
    const sealedBuf = crypto.randomBytes(sealedBytes);
    const digest = crypto.createHash('sha256').update(Buffer.concat([nonceBytes, sealedBuf])).digest('hex');
    const header = ['beanpool-contacts-copy/1', id.pk, '50', String(paddedSize), digest, '2026-11-11T10:00:00Z'].join('\n');
    const signature = crypto.sign(null, Buffer.from(header, 'utf8'), id.priv).toString('hex');
    return { header, signature, nonce: nonceBytes.toString('base64'), sealed: sealedBuf.toString('base64') };
}

const rowOf = (pk: string) => db.prepare('SELECT * FROM contact_copies WHERE owner_pubkey = ?').get(pk) as Record<string, any> | undefined;
const tombstones = () => (db.prepare("SELECT COUNT(*) AS c FROM tombstones WHERE table_name = 'contact_copies'").get() as { c: number }).c;
/** Whether `pk`'s copy has a tombstone written at or after `since` (one per row key: a second delete renews it). */
const tombSince = (pk: string, since: string) => {
    const t = db.prepare("SELECT deleted_at FROM tombstones WHERE table_name = 'contact_copies' AND row_key = ?").get(pk) as { deleted_at: string } | undefined;
    return !!t && t.deleted_at >= since;
};
const allRows = () => JSON.stringify(db.prepare('SELECT * FROM contact_copies ORDER BY owner_pubkey').all());

async function main(): Promise<void> {
    await ensureGenesis();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const owen = newId('Owen');
    const claim = claimGrantor(crypto.randomBytes(4).toString('hex'));
    require_(!!registerMemberInternal(broadcast, owen.pk, owen.name, null, claim), 'Owen claims the community: its first member');
    grantNodeRole(owen.pk, 'owner', claim);
    OWNER = () => ownerPhoneSessionHeaders(owen.pk);
    const others = ['Ada', 'Ana', 'Ben', 'Cy', 'Dot', 'Eve', 'Fay', 'Gus'].map(newId);
    const [ada, ana, ben, cy, dot, eve, fay, gus] = others;
    for (const who of others) {
        const made = await generate(owen);
        require_(made.status === 200 && (await redeem(who, made.body?.invite?.code)).status === 200, `${who.name} joins with Owen's invite`);
    }
    require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: ada.pk, role: 'admin' }, OWNER())).status === 200, 'Ada is made an admin');
    const vic = newId('Vic');
    registerVisitor(vic.pk, vic.name);

    // ── 1. Only the owner reads or writes their copy ────────────────────────────────────────────────────────────
    const none = await getCopy(ana);
    assert(none.status === 404 && none.body?.code === 'no_copy', `1. before any copy: 404 no_copy (${show(none)})`);
    const a1 = copyOf(ana, 1);
    const put1 = await putCopy(ana, a1);
    assert(put1.status === 200 && put1.body?.seq === 1 && put1.body?.code === undefined, `1. Ana saves her first copy: 200 { seq: 1 } (${show(put1)})`);
    const got = await getCopy(ana);
    assert(got.status === 200 && JSON.stringify(got.body) === JSON.stringify(wire(a1)), `1. Ana fetches it: header, signature, nonce and locked bytes as she sent them (${show(got)})`);
    const others404 = [await getCopy(ben), await getCopy(ada), await getCopy(owen), await getCopy(ben, `?owner=${ana.pk}`), await getCopy(owen, `?owner=${ana.pk}`)];
    assert(others404.every((r) => r.status === 404 && r.text === none.text),
        `1. another member, an admin and the node's owner, with or without ?owner=Ana, get the same 404 (${others404.map(show).join(' | ')})`);
    // A visitor is refused by the member gates in front of every route (the read gate, the write gate), with the code the
    // route's own check gives a key that isn't an active member's.
    const visitorRs = [await getCopy(vic), await putCopy(vic, copyOf(vic, 1)), await delCopy(vic)];
    assert(visitorRs.every((r) => r.status === 403 && r.body?.code === 'not_a_member') && !rowOf(vic.pk),
        `1. a visitor: 403 not_a_member on every route, and nothing kept (${visitorRs.map(show).join(' | ')})`);
    const unsigned = [await getCopy(null), await putCopy(null, wire(a1)), await delCopy(null)];
    assert(unsigned.every((r) => r.status === 401), `1. unsigned: 401 on every route (${unsigned.map((r) => r.status).join(' ')})`);
    const benPutsAnas = await putCopy(ben, a1);
    assert(benPutsAnas.status === 403 && benPutsAnas.body?.code === 'not_yours', `1. Ben uploads Ana's signed copy: 403 not_yours (${show(benPutsAnas)})`);
    const benDeletes = await delCopy(ben);
    assert(benDeletes.status === 200 && benDeletes.body?.deleted === false && rowOf(ana.pk)?.header === a1.header, `1. Ben's DELETE removes only his own (none): Ana's is kept (${show(benDeletes)})`);
    assert(!rowOf(ben.pk), '1. nothing stored for Ben by any of it');

    // ── 2. Refusals ─────────────────────────────────────────────────────────────────────────────────────────────
    const exists = await putCopy(ana, a1);
    assert(exists.status === 200 && exists.body?.seq === 1 && exists.body?.code === 'exists', `2. the identical copy again: 200 exists (${show(exists)})`);
    const equal = await putCopy(ana, copyOf(ana, 1, 3));
    assert(equal.status === 409 && equal.body?.code === 'stale_copy' && equal.body?.seq === 1, `2. an equal number with other bytes: 409 stale_copy, kept seq 1 (${show(equal)})`);
    const a5 = copyOf(ana, 5, 4);
    require_((await putCopy(ana, a5)).status === 200 && rowOf(ana.pk)?.seq === 5, '2. a newer number replaces it');
    const older = await putCopy(ana, copyOf(ana, 4));
    assert(older.status === 409 && older.body?.code === 'stale_copy' && older.body?.seq === 5, `2. an older number: 409 stale_copy with the kept number (${show(older)})`);
    const step = await putCopy(cy, signedRaw(cy, CONTACTS_PAD_STEP + 100, CONTACTS_PAD_STEP + 116));
    assert(step.status === 400 && step.body?.code === 'bad_copy', `2. a size that isn't a 16 KiB step: 400 (${show(step)})`);
    const over = await putCopy(cy, signedRaw(cy, CONTACTS_COPY_MAX_BYTES + CONTACTS_PAD_STEP, CONTACTS_COPY_MAX_BYTES + CONTACTS_PAD_STEP + 16));
    assert(over.status === 413 && over.body?.code === 'copy_too_big', `2. over 512 KiB: 413 copy_too_big (${show(over)})`);
    const c1 = copyOf(cy, 1);
    const badSig = await putCopy(cy, { ...wire(c1), signature: '00'.repeat(64) });
    assert(badSig.status === 400 && badSig.body?.code === 'bad_copy', `2. a bad signature: 400 bad_copy (${show(badSig)})`);
    const swapped = await putCopy(cy, { ...wire(c1), sealed: copyOf(cy, 1).sealed });
    assert(swapped.status === 400 && swapped.body?.code === 'bad_copy', `2. locked bytes its header doesn't name: 400 bad_copy (${show(swapped)})`);
    const notCopy = await putCopy(cy, { header: 'x', signature: 'x', nonce: 'x', sealed: 'x' });
    assert(notCopy.status === 400 && notCopy.body?.code === 'bad_copy', `2. not a copy: 400 bad_copy (${show(notCopy)})`);
    assert(!rowOf(cy.pk), '2. nothing stored for Cy by any refusal');
    // The hourly cap: a fresh member's 12 saves land, the 13th doesn't, and the cap is the member's own.
    resetContactCopySavesForTests();
    let okCount = 0;
    for (let i = 1; i <= CONTACT_COPIES_PER_HOUR; i++) if ((await putCopy(dot, copyOf(dot, i))).status === 200) okCount++;
    assert(okCount === CONTACT_COPIES_PER_HOUR, `2. ${CONTACT_COPIES_PER_HOUR} saves in the hour are taken (${okCount})`);
    const thirteenth = await putCopy(dot, copyOf(dot, 13));
    assert(thirteenth.status === 429 && thirteenth.body?.code === 'too_many_saves' && rowOf(dot.pk)?.seq === 12, `2. the 13th: 429 too_many_saves, the 12th kept (${show(thirteenth)})`);
    assert((await putCopy(eve, copyOf(eve, 1))).status === 200, '2. the cap is per member: Eve still saves');
    assert((await getCopy(dot)).status === 200, '2. a GET has no cap');

    // ── 3. /api/me/unread ───────────────────────────────────────────────────────────────────────────────────────
    const [ua, ub] = [await unread(ana), await unread(ben)];
    assert(ua.status === 200 && ua.body?.contacts?.seq === 5 && Object.keys(ua.body.contacts).join() === 'seq', `3. Ana's unread says contacts { seq: 5 } (${show(ua)})`);
    assert(ub.status === 200 && ub.body?.contacts === null, `3. Ben's says null: he keeps none here (${show(ub)})`);

    // ── 4. The node's budget ────────────────────────────────────────────────────────────────────────────────────
    setContactCopiesBudgetForTests(contactCopiesBytes() + CONTACTS_PAD_STEP);
    const fills = await putCopy(fay, copyOf(fay, 1));
    assert(fills.status === 200, `4. Fay's first copy fits the last step (${show(fills)})`);
    const full = await putCopy(gus, copyOf(gus, 1));
    assert(full.status === 409 && full.body?.code === 'node_full' && !rowOf(gus.pk), `4. full: Gus's first copy is refused, 409 node_full (${show(full)})`);
    const grows = await putCopy(ana, copyOf(ana, 6, 200));
    assert(grows.status === 200 && rowOf(ana.pk)?.padded_size === 2 * CONTACTS_PAD_STEP, `4. full: Ana, who has one, still saves, a bigger one too (${show(grows)})`);
    setContactCopiesBudgetForTests(null);

    // ── 7. A standby (before the switch below empties the table) ────────────────────────────────────────────────
    const before = allRows();
    const sync = await exportSyncState('test-contact-copies');
    const shipped = (sync as any).plainTables?.contact_copies as Record<string, unknown>[] | undefined;
    assert(Array.isArray(shipped) && JSON.stringify([...shipped].sort((x, y) => String(x.owner_pubkey).localeCompare(String(y.owner_pubkey)))) === before,
        `7. the whole copy a standby pulls carries every row, byte for byte (${shipped?.length} rows)`);
    setNodeRole('backup');
    const onStandby = [await putCopy(ana, copyOf(ana, 7)), await delCopy(ana)];
    const standbyGet = await getCopy(ana);
    // The standby's import: its own stray row, and its rows wiped, then the whole copy.
    db.prepare('DELETE FROM contact_copies').run();
    db.prepare(`INSERT INTO contact_copies (owner_pubkey, seq, padded_size, saved_at, nonce, sealed, digest, header, signature, updated_at)
                VALUES (?, 1, 16384, 'x', 'x', 'x', 'x', 'x', 'x', '2020-01-01T00:00:00.000Z')`).run('f'.repeat(64));
    importPlainTables((sync as any).plainTables, true, null);
    setNodeRole('primary');
    assert(onStandby.every((r) => r.status === 409 && r.body?.code === 'standby'), `7. a standby's writes: 409 standby (${onStandby.map(show).join(' | ')})`);
    assert(standbyGet.status === 200 && standbyGet.body?.header === rowOf(ana.pk)?.header, `7. a standby answers a GET from the copy it keeps (${show(standbyGet)})`);
    assert(allRows() === before, '7. a standby that imports the whole copy ends identical, its own stray row gone');

    // ── 5. The owners' switch ───────────────────────────────────────────────────────────────────────────────────
    const infoOn = await call(ana, 'GET', '/api/community/info');
    assert(infoOn.status === 200 && infoOn.body?.features?.contacts === true, `5. on by default: features.contacts true (${infoOn.body?.features?.contacts})`);
    const rowsBefore = (db.prepare('SELECT COUNT(*) AS c FROM contact_copies').get() as { c: number }).c;
    const tombBefore = tombstones();
    const off = await call(null, 'POST', '/api/local/admin/community-shape', { changes: { contacts: false } }, OWNER());
    assert(off.status === 200, `5. an owner switches it off (${show(off)})`);
    const infoOff = await call(ana, 'GET', '/api/community/info');
    assert(infoOff.body?.features?.contacts === false, `5. off: features.contacts false (${infoOff.body?.features?.contacts})`);
    const offRefusals = [await getCopy(ana), await putCopy(ben, copyOf(ben, 1))];
    assert(offRefusals.every((r) => r.status === 404 && r.body?.code === 'contacts_off'), `5. off: GET and PUT 404 contacts_off (${offRefusals.map(show).join(' | ')})`);
    assert((await unread(ana)).body?.contacts === null, '5. off: unread says contacts null');
    assert((db.prepare('SELECT COUNT(*) AS c FROM contact_copies').get() as { c: number }).c === 0 && tombstones() === tombBefore + rowsBefore,
        `5. off: every copy is deleted, each with a tombstone (${rowsBefore} rows, ${tombstones() - tombBefore} tombstones)`);
    const shape = await call(null, 'GET', '/api/local/admin/community-shape', undefined, OWNER());
    assert(shape.body?.settings?.contacts?.value === false && shape.body?.settings?.contacts?.source === 'owner', `5. the shape reads it off, the owners' choice (${JSON.stringify(shape.body?.settings?.contacts)})`);
    const backOn = await call(null, 'POST', '/api/local/admin/community-shape', { changes: { contacts: true } }, OWNER());
    assert(backOn.status === 200 && (await putCopy(ana, copyOf(ana, 8))).status === 200, `5. on again: Ana saves (${show(backOn)})`);
    assert((db.prepare("SELECT value FROM node_config WHERE key = 'contact_copies'").get()) === undefined, '5. on is the default: no row is kept for it');

    // ── 6. The row goes with the member ─────────────────────────────────────────────────────────────────────────
    for (const who of [ben, cy, eve]) require_((await putCopy(who, copyOf(who, 1))).status === 200, `6. ${who.name} saves a copy`);
    const since = new Date(Date.now() - 1).toISOString();
    setSwitchOverride('decisions', false);
    const pruned = await call(null, 'POST', `/api/local/admin/users/${ben.pk}/prune`, {}, OWNER());
    setSwitchOverride('decisions', true);
    require_(pruned.status === 200, `6. Ben is removed (${show(pruned)})`);
    assert(!rowOf(ben.pk) && tombSince(ben.pk, since), '6. removed: Ben\'s copy is gone, with a tombstone');
    const purged = await call(cy, 'POST', '/api/member/purge', { action: 'purge_account' });
    require_(purged.status === 200, `6. Cy deletes his account (${show(purged)})`);
    assert(!rowOf(cy.pk) && tombSince(cy.pk, since), '6. account deleted: Cy\'s copy is gone, with a tombstone');
    const eveNew = newId('Eve2');
    completeRekey(eve.pk, eveNew.pk, issueRekeyCode(eve.pk, owen.pk).code, owen.pk);
    assert(!rowOf(eve.pk) && !rowOf(eveNew.pk) && tombSince(eve.pk, since), '6. re-keyed: Eve\'s old copy is gone (her new key can\'t open it), nothing moved, a tombstone');
    const own = await delCopy(ana);
    assert(own.status === 200 && own.body?.deleted === true && !rowOf(ana.pk) && tombSince(ana.pk, since), `6. Ana's own DELETE: gone, with a tombstone (${show(own)})`);
    const delta = await exportSyncState('test-contact-copies', since) as any;
    const shippedTombs = ((delta.tombstones ?? []) as { tableName: string; rowKey: string }[]).filter((t) => t.tableName === 'contact_copies').map((t) => t.rowKey);
    assert([ben.pk, cy.pk, eve.pk, ana.pk].every((k) => shippedTombs.includes(k)), `6. the delta a standby pulls carries each deleted row's tombstone (${shippedTombs.length})`);

    // ── 8. The schema step ──────────────────────────────────────────────────────────────────────────────────────
    const objects = () => JSON.stringify(db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name <> 'contact_copies' AND name NOT LIKE 'sqlite_%' ORDER BY type, name`).all());
    const tables = () => (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'contact_copies' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((t) => t.name);
    const contents = () => JSON.stringify(tables().map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).raw().all()]), (_k, v) => (typeof v === 'bigint' ? String(v) : Buffer.isBuffer(v) ? v.toString('hex') : v));
    db.exec('DROP TABLE contact_copies');
    const [objectsBefore, contentsBefore] = [objects(), contents()];
    initSchema();
    const made = db.prepare(`SELECT name FROM sqlite_master WHERE tbl_name = 'contact_copies' ORDER BY name`).all() as { name: string }[];
    assert(made.some((m) => m.name === 'contact_copies') && made.some((m) => m.name === 'idx_contact_copies_updated_at'), `8. a database without it boots with the table and its watermark (${made.map((m) => m.name).join(', ')})`);
    assert((db.prepare('SELECT COUNT(*) AS c FROM contact_copies').get() as { c: number }).c === 0, '8. born empty');
    assert(objects() === objectsBefore, '8. every other schema object is as it was');
    assert(contents() === contentsBefore, '8. every other table\'s rows are as they were, byte for byte');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${passed}/${run} passed`);
    process.exit(1);
});
