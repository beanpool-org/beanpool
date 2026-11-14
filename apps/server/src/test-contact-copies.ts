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
 *   8. The schema step: a database without the tables (a 1.4.0 one from before) boots with them, and nothing else changed:
 *      every other table, row and schema object byte for byte.
 *   9. After a re-key (design §6.2, slice C6): the old key's copy is kept a year beside the new key in
 *      contact_copies_former, still locked: it opens with the OLD key's words only, and no column or answer holds a
 *      contact's name or number. GET /api/contacts/former answers it to the new key alone (everyone else the same 404, a
 *      visitor 403, unsigned 401) and DELETE removes it with a tombstone. At most one: a second re-key keeps the newest
 *      copy (the current one, or the former one moved with its year). Past its year it is no longer served and the sweep
 *      deletes it with a tombstone; it goes with the member (removed, account deleted) and with the owners' switch. A
 *      standby's DELETE 409, its GET answers; a standby following the re-key drops the old key's rows and writes none of
 *      its own (the main server's come in the copy, byte for byte).
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
import {
    CONTACT_COPIES_PER_HOUR, CONTACT_FORMER_KEEP_MS, contactCopiesBytes, forgetExpiredFormerCopies, resetContactCopySavesForTests, setContactCopiesBudgetForTests,
} from './engine/contact-copies.js';
import { moveMemberKeyRows } from './engine/key-move.js';
import { openContactsCopy, readContactsList } from '@beanpool/core';
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
const getFormer = (id: Id | null, q = '') => call(id, 'GET', `/api/contacts/former${q}`);
const delFormer = (id: Id | null) => call(id, 'DELETE', '/api/contacts/former');
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
const formerOf = (pk: string) => db.prepare('SELECT * FROM contact_copies_former WHERE owner_pubkey = ?').get(pk) as Record<string, any> | undefined;
const formerTombSince = (pk: string, since: string) => {
    const t = db.prepare("SELECT deleted_at FROM tombstones WHERE table_name = 'contact_copies_former' AND row_key = ?").get(pk) as { deleted_at: string } | undefined;
    return !!t && t.deleted_at >= since;
};
const allFormerRows = () => JSON.stringify(db.prepare('SELECT * FROM contact_copies_former ORDER BY owner_pubkey').all());
const rekey = (from: Id, to: Id, owner: Id) => completeRekey(from.pk, to.pk, issueRekeyCode(from.pk, owner.pk).code, owner.pk);

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
    assert(formerOf(eveNew.pk)?.former_pubkey === eve.pk, '6. re-keyed: it is kept as her former copy instead (section 9)');
    const own = await delCopy(ana);
    assert(own.status === 200 && own.body?.deleted === true && !rowOf(ana.pk) && tombSince(ana.pk, since), `6. Ana's own DELETE: gone, with a tombstone (${show(own)})`);
    const delta = await exportSyncState('test-contact-copies', since) as any;
    const shippedTombs = ((delta.tombstones ?? []) as { tableName: string; rowKey: string }[]).filter((t) => t.tableName === 'contact_copies').map((t) => t.rowKey);
    assert([ben.pk, cy.pk, eve.pk, ana.pk].every((k) => shippedTombs.includes(k)), `6. the delta a standby pulls carries each deleted row's tombstone (${shippedTombs.length})`);

    // ── 9. After a re-key: the former copy, a year ─────────────────────────────────────────────────────────────
    {
        const [ivy, jo, kim] = ['Ivy', 'Jo', 'Kim'].map(newId);
        for (const who of [ivy, jo, kim]) {
            const made = await generate(owen);
            require_(made.status === 200 && (await redeem(who, made.body?.invite?.code)).status === 200, `9. ${who.name} joins with Owen's invite`);
        }
        resetContactCopySavesForTests();
        const i3 = copyOf(ivy, 3, 5);
        require_((await putCopy(ivy, i3)).status === 200, '9. Ivy saves her list, copy 3');
        const none9 = await getFormer(ivy);
        assert(none9.status === 404 && none9.body?.code === 'no_former', `9. before any re-key: 404 no_former (${show(none9)})`);
        const since9 = new Date(Date.now() - 1).toISOString();
        const ivy2 = newId('Ivy2');
        const before9 = Date.now();
        rekey(ivy, ivy2, owen);
        const f = formerOf(ivy2.pk);
        assert(!rowOf(ivy.pk) && !rowOf(ivy2.pk) && tombSince(ivy.pk, since9), '9. re-keyed: no current copy under either key, the old one\'s with a tombstone');
        assert(!!f && f.former_pubkey === ivy.pk && f.header === i3.header && f.signature === i3.signature && f.nonce === i3.nonce && f.sealed === i3.sealed && f.seq === 3,
            `9. the old copy is kept beside the new key, byte for byte (${JSON.stringify(f && { former: String(f.former_pubkey).slice(0, 8), seq: f.seq })})`);
        const keptFor = f ? Date.parse(f.kept_until) - before9 : NaN;
        assert(keptFor >= CONTACT_FORMER_KEEP_MS - 5_000 && keptFor <= CONTACT_FORMER_KEEP_MS + 60_000, `9. kept a year from the re-key (${f?.kept_until})`);
        assert(!formerOf(ivy.pk), '9. nothing kept under the old key');
        // Still locked: no column holds a contact's name or number, and it opens with the old key's words alone.
        const rowText = JSON.stringify(f);
        assert(!rowText.includes("Ivy's contact") && !rowText.includes('0400 000'), '9. no column of the kept row holds a contact\'s name or number');
        const got9 = await getFormer(ivy2);
        assert(got9.status === 200 && got9.body?.header === i3.header && got9.body?.signature === i3.signature && got9.body?.nonce === i3.nonce && got9.body?.sealed === i3.sealed
            && got9.body?.formerKey === ivy.pk && got9.body?.keptUntil === f?.kept_until, `9. GET /api/contacts/former as the new key: the old copy, the key it is locked with, and its last day (${show(got9)})`);
        assert(!got9.text.includes("Ivy's contact") && !got9.text.includes('0400 000'), '9. the answer holds no contact\'s name or number');
        const oldOpens = openContactsCopy(got9.body, { publicKey: ivy.pk, privateKey: ivy.seedHex });
        const oldList = oldOpens.ok ? readContactsList(oldOpens.json) : null;
        assert(!!oldList?.ok && oldList.list.contacts.length === 5 && oldList.list.contacts[0].name === "Ivy's contact 0", '9. the old key opens it: her 5 contacts');
        const newOpens = openContactsCopy(got9.body, { publicKey: ivy2.pk, privateKey: ivy2.seedHex });
        const newOpensAsOld = openContactsCopy(got9.body, { publicKey: ivy.pk, privateKey: ivy2.seedHex });
        assert(!newOpens.ok && !newOpensAsOld.ok, `9. the new key opens nothing (${!newOpens.ok && newOpens.reason}, ${!newOpensAsOld.ok && newOpensAsOld.reason})`);
        // Nobody else reads it: the same 404 for every other member, an admin, the owner, with or without a key named.
        const others9 = [await getFormer(dot), await getFormer(ada), await getFormer(owen), await getFormer(owen, `?owner=${ivy2.pk}`), await getFormer(dot, `?owner=${ivy.pk}`)];
        assert(others9.every((r) => r.status === 404 && r.text === none9.text), `9. another member, an admin and the owner get the same 404 (${others9.map(show).join(' | ')})`);
        const oldKey9 = await getFormer(ivy);
        assert(oldKey9.status === 401 || oldKey9.status === 403, `9. the old key itself is refused: it is no member now (${show(oldKey9)})`);
        const vis9 = [await getFormer(vic), await delFormer(vic)];
        assert(vis9.every((r) => r.status === 403 && r.body?.code === 'not_a_member'), `9. a visitor: 403 not_a_member (${vis9.map(show).join(' | ')})`);
        const uns9 = [await getFormer(null), await delFormer(null)];
        assert(uns9.every((r) => r.status === 401), `9. unsigned: 401 (${uns9.map((r) => r.status).join(' ')})`);
        const dotDeletes = await delFormer(dot);
        assert(dotDeletes.status === 200 && dotDeletes.body?.deleted === false && !!formerOf(ivy2.pk), `9. another member's DELETE removes only their own (none) (${show(dotDeletes)})`);
        // The former copy is not the current one: the new key starts a list of its own beside it.
        const cur9 = await getCopy(ivy2);
        assert(cur9.status === 404 && cur9.body?.code === 'no_copy', `9. GET /api/contacts/copy as the new key: 404 no_copy, the former isn't served as current (${show(cur9)})`);
        const u9 = await unread(ivy2);
        assert(u9.status === 200 && u9.body?.contacts === null, '9. unread says contacts null for the new key');
        const n1 = copyOf(ivy2, 1, 1);
        assert((await putCopy(ivy2, n1)).status === 200 && formerOf(ivy2.pk)?.header === i3.header, '9. the new key saves its own copy 1, and the former stays');

        // At most one: re-keyed again with a current copy, that copy is the former one now, with a new year.
        const ivy3 = newId('Ivy3');
        rekey(ivy2, ivy3, owen);
        const f3 = formerOf(ivy3.pk);
        const all3 = db.prepare('SELECT owner_pubkey FROM contact_copies_former WHERE owner_pubkey IN (?, ?, ?)').all(ivy.pk, ivy2.pk, ivy3.pk) as unknown[];
        assert(!!f3 && f3.former_pubkey === ivy2.pk && f3.header === n1.header && all3.length === 1 && formerTombSince(ivy2.pk, since9) && !rowOf(ivy2.pk),
            `9. a second re-key: the newest copy (Ivy2's own) is the former one, one row, the last one's with a tombstone (${all3.length} rows)`);
        // Re-keyed again with no current copy: the former one moves, its year as it was.
        resetContactCopySavesForTests();
        require_((await putCopy(jo, copyOf(jo, 2))).status === 200, '9. Jo saves a list');
        const jo2 = newId('Jo2');
        const jo3 = newId('Jo3');
        rekey(jo, jo2, owen);
        const fj2 = formerOf(jo2.pk);
        rekey(jo2, jo3, owen);
        const fj3 = formerOf(jo3.pk);
        assert(!!fj2 && !!fj3 && fj3.former_pubkey === jo.pk && fj3.header === fj2.header && fj3.kept_until === fj2.kept_until && !formerOf(jo2.pk) && formerTombSince(jo2.pk, since9),
            '9. re-keyed again with no copy of its own: the former copy moves to the newest key, locked with the first key, its year unchanged');

        // DELETE: the member's own choice, with a tombstone.
        const sinceDel = new Date(Date.now() - 1).toISOString();
        const del9 = await delFormer(ivy3);
        assert(del9.status === 200 && del9.body?.deleted === true && !formerOf(ivy3.pk) && formerTombSince(ivy3.pk, sinceDel), `9. DELETE: gone, with a tombstone (${show(del9)})`);
        const delAgain = await delFormer(ivy3);
        assert(delAgain.status === 200 && delAgain.body?.deleted === false, `9. DELETE again: nothing to remove (${show(delAgain)})`);
        assert((await getFormer(ivy3)).body?.code === 'no_former', '9. after DELETE: 404 no_former');

        // Past its year: no longer served, and the sweep deletes it with a tombstone; one within its year stays.
        const kim2 = newId('Kim2');
        require_((await putCopy(kim, copyOf(kim, 1))).status === 200, '9. Kim saves a list');
        rekey(kim, kim2, owen);
        require_(!!formerOf(kim2.pk), '9. Kim is re-keyed: her former copy is kept');
        db.prepare('UPDATE contact_copies_former SET kept_until = ? WHERE owner_pubkey = ?').run(new Date(Date.now() - 1000).toISOString(), jo3.pk);
        const expired = await getFormer(jo3);
        assert(expired.status === 404 && expired.body?.code === 'no_former', `9. past its year: 404 no_former before any sweep (${show(expired)})`);
        const sinceSweep = new Date(Date.now() - 1).toISOString();
        const swept = forgetExpiredFormerCopies();
        assert(swept === 1 && !formerOf(jo3.pk) && formerTombSince(jo3.pk, sinceSweep) && !!formerOf(kim2.pk), `9. the sweep deletes the one past its year with a tombstone, and keeps the other (${swept})`);
        assert(contactCopiesBytes() === (db.prepare('SELECT COALESCE(SUM(padded_size), 0) AS n FROM contact_copies').get() as { n: number }).n
            + (db.prepare('SELECT COALESCE(SUM(padded_size), 0) AS n FROM contact_copies_former').get() as { n: number }).n, '9. the node\'s budget counts the former copies too');

        // A standby: its DELETE is refused, its GET answers; the whole copy carries the rows byte for byte.
        const formerBefore = allFormerRows();
        const sync9 = await exportSyncState('test-contact-copies');
        const shipped9 = (sync9 as any).plainTables?.contact_copies_former as Record<string, unknown>[] | undefined;
        assert(Array.isArray(shipped9) && JSON.stringify([...shipped9].sort((x, y) => String(x.owner_pubkey).localeCompare(String(y.owner_pubkey)))) === formerBefore,
            `9. the whole copy a standby pulls carries every former row, byte for byte (${shipped9?.length} rows)`);
        setNodeRole('backup');
        const sbDel = await delFormer(kim2);
        const sbGet = await getFormer(kim2);
        const sbSwept = forgetExpiredFormerCopies(Date.now() + 2 * CONTACT_FORMER_KEEP_MS);
        setNodeRole('primary');
        assert(sbDel.status === 409 && sbDel.body?.code === 'standby' && !!formerOf(kim2.pk), `9. a standby's DELETE: 409 standby (${show(sbDel)})`);
        assert(sbGet.status === 200 && sbGet.body?.header === formerOf(kim2.pk)?.header, `9. a standby answers a GET from the copy it keeps (${show(sbGet)})`);
        assert(sbSwept === 0 && !!formerOf(kim2.pk), '9. a standby sweeps nothing: the main server\'s tombstones come in its copy');
        // A standby following its main server's re-key drops the old key's rows, writes no tombstone and no row of its own.
        const [lo, lo2] = [newId('Lo'), newId('Lo2')];
        const tombsBefore = (db.prepare("SELECT COUNT(*) AS c FROM tombstones WHERE table_name IN ('contact_copies', 'contact_copies_former')").get() as { c: number }).c;
        db.prepare(`INSERT INTO contact_copies (owner_pubkey, seq, padded_size, saved_at, nonce, sealed, digest, header, signature) VALUES (?, 1, 16384, 'x', 'x', 'x', 'x', 'x', 'x')`).run(lo.pk);
        db.prepare(`INSERT INTO contact_copies_former (owner_pubkey, former_pubkey, seq, padded_size, saved_at, nonce, sealed, digest, header, signature, kept_until)
                    VALUES (?, ?, 1, 16384, 'x', 'x', 'x', 'x', 'x', 'x', ?)`).run(lo.pk, 'e'.repeat(64), new Date(Date.now() + 1e9).toISOString());
        moveMemberKeyRows(lo.pk, lo2.pk, new Date().toISOString(), { keepStamps: true });
        const tombsAfter = (db.prepare("SELECT COUNT(*) AS c FROM tombstones WHERE table_name IN ('contact_copies', 'contact_copies_former')").get() as { c: number }).c;
        assert(!rowOf(lo.pk) && !formerOf(lo.pk) && !formerOf(lo2.pk) && !rowOf(lo2.pk) && tombsAfter === tombsBefore,
            '9. a standby following a re-key drops the old key\'s current and former rows, with no tombstone and no row of its own');

        // It goes with the member: an account deleted, a member removed.
        const sinceGo = new Date(Date.now() - 1).toISOString();
        const purged9 = await call(kim2, 'POST', '/api/member/purge', { action: 'purge_account' });
        require_(purged9.status === 200, `9. Kim deletes her account (${show(purged9)})`);
        assert(!formerOf(kim2.pk) && formerTombSince(kim2.pk, sinceGo), '9. account deleted: her former copy is gone, with a tombstone');
        const [mo, mo2] = [newId('Mo'), newId('Mo2')];
        {
            const made = await generate(owen);
            require_(made.status === 200 && (await redeem(mo, made.body?.invite?.code)).status === 200, '9. Mo joins');
        }
        require_((await putCopy(mo, copyOf(mo, 1))).status === 200, '9. Mo saves a list');
        rekey(mo, mo2, owen);
        setSwitchOverride('decisions', false);
        const pruned9 = await call(null, 'POST', `/api/local/admin/users/${mo2.pk}/prune`, {}, OWNER());
        setSwitchOverride('decisions', true);
        require_(pruned9.status === 200, `9. Mo is removed (${show(pruned9)})`);
        assert(!formerOf(mo2.pk) && formerTombSince(mo2.pk, sinceGo), '9. removed: his former copy is gone, with a tombstone');

        // The owners' switch: off deletes the former copies too, and the route says so.
        const [ned, ned2] = [newId('Ned'), newId('Ned2')];
        {
            const made = await generate(owen);
            require_(made.status === 200 && (await redeem(ned, made.body?.invite?.code)).status === 200, '9. Ned joins');
        }
        resetContactCopySavesForTests();
        require_((await putCopy(ned, copyOf(ned, 1))).status === 200, '9. Ned saves a list');
        rekey(ned, ned2, owen);
        require_(!!formerOf(ned2.pk), '9. Ned is re-keyed: his former copy is kept');
        require_((await call(null, 'POST', '/api/local/admin/community-shape', { changes: { contacts: false } }, OWNER())).status === 200, '9. an owner switches copies off');
        const offFormer = await getFormer(ned2);
        const offDel = await delFormer(ned2);
        assert(offFormer.status === 404 && offFormer.body?.code === 'contacts_off' && offDel.status === 200 && !formerOf(ned2.pk) && formerTombSince(ned2.pk, sinceGo),
            `9. off: every former copy is deleted with a tombstone, GET 404 contacts_off, DELETE still answers (${show(offFormer)} | ${show(offDel)})`);
        require_((await call(null, 'POST', '/api/local/admin/community-shape', { changes: { contacts: true } }, OWNER())).status === 200, '9. and back on');
    }

    // ── 8. The schema step ──────────────────────────────────────────────────────────────────────────────────────
    const OURS = `('contact_copies', 'contact_copies_former')`;
    const objects = () => JSON.stringify(db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name NOT IN ${OURS} AND name NOT LIKE 'sqlite_%' ORDER BY type, name`).all());
    const tables = () => (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ${OURS} AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[]).map((t) => t.name);
    const contents = () => JSON.stringify(tables().map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).raw().all()]), (_k, v) => (typeof v === 'bigint' ? String(v) : Buffer.isBuffer(v) ? v.toString('hex') : v));
    db.exec('DROP TABLE contact_copies');
    db.exec('DROP TABLE contact_copies_former');
    const [objectsBefore, contentsBefore] = [objects(), contents()];
    initSchema();
    const made = db.prepare(`SELECT name FROM sqlite_master WHERE tbl_name = 'contact_copies' ORDER BY name`).all() as { name: string }[];
    assert(made.some((m) => m.name === 'contact_copies') && made.some((m) => m.name === 'idx_contact_copies_updated_at'), `8. a database without it boots with the table and its watermark (${made.map((m) => m.name).join(', ')})`);
    const madeFormer = db.prepare(`SELECT name FROM sqlite_master WHERE tbl_name = 'contact_copies_former' ORDER BY name`).all() as { name: string }[];
    assert(madeFormer.some((m) => m.name === 'contact_copies_former') && madeFormer.some((m) => m.name === 'idx_contact_copies_former_updated_at'),
        `8. and with the former copies' table and its watermark (${madeFormer.map((m) => m.name).join(', ')})`);
    assert((db.prepare('SELECT COUNT(*) AS c FROM contact_copies').get() as { c: number }).c === 0
        && (db.prepare('SELECT COUNT(*) AS c FROM contact_copies_former').get() as { c: number }).c === 0, '8. born empty');
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
