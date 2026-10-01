/**
 * The names list (community modes slice 2; engine/names-list.ts, routes/names-list.ts, @beanpool/core
 * names-list-crypto.ts): the admins' list of who the members are, kept on the node encrypted to the admins' keys, and
 * confirming a member against an entry.
 *
 * Over REAL HTTPS through the real signature middleware, on a local community: Owen (owner), Ada and Abe (admins), Mo
 * (a moderator), Mel and Nia (members). This suite plays each admin's phone with @beanpool/core: it makes the key, wraps
 * it, seals and opens entries. The node only ever sees what a phone sends.
 *
 *   1. Who: unsigned 401, a key that is no member 403, a member and a moderator 403 `admins_only` on every route, with
 *      nothing written; the global node keeps no list (404 `feature_off`).
 *   2. The key: Owen's phone makes it (generation 1), wrapped to Owen and Ada; Abe waits. A stale generation, a key not
 *      wrapped to its maker, one wrapped to a member, and a new key from Abe while others hold this one are refused.
 *   3. Entries: a name in the clear is refused (400 `not_sealed`) and never stored; sealed entries are added, read and
 *      opened on Ada's phone, edited and deleted. Abe can't open them until Owen's phone shares the key (re-wrap on add).
 *   4. The access log: every read and the export are logged, with who; every admin reads the log; a member doesn't.
 *   5. Confirming: one person, one entry; not yourself while there is another admin; revoke, and confirm again. Two
 *      admins to confirm (an owner's setting, off by default): a confirmation waits, the same admin can't second it,
 *      another does. Real names to members stays off (409 `not_built`).
 *   6. An admin removed: the next request drops Abe's wrap, every write is refused until a new key, Ada's phone makes
 *      generation 2 and seals the older entries again; an entry written after can't be opened with the key Abe had,
 *      and the older generation's wraps go once nothing is sealed under it.
 *   7. A member leaving: removed by an admin, or deleting their own account, their confirmation is revoked; a re-key
 *      moves a confirmation to the new key, and an admin's re-key drops their wrap (a lost phone may hold it).
 *   8. The server never holds a readable name: the planted names are in no byte of the database or its WAL, of a
 *      snapshot, or of the whole copy a standby pulls, which carries the sealed entries.
 *
 * A standby's copy and a take-over: test-standby-names-list.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-names-list.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    newNamesListKey, newNamesEntryId, wrapNamesListKey, unwrapNamesListKey, sealNamesEntry, openNamesEntry, NamesListCryptoError,
    type NamesEntryText,
} from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, exportSyncState } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { hashPassword, updateLocalConfig } from './config/local-config.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { createSnapshot, SNAPSHOTS_DIR } from './services/snapshot-scheduler.js';
import { issueRekeyCode, completeRekey } from './engine/member-wizards.js';

let BASE = '';
const ADMIN_PW = 'Names-List-Admin-Pw-62!';
const PASSWORD = { 'X-Admin-Password': ADMIN_PW };
const DATA_DIR = process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
/** A step the checks after it stand on: stop here rather than report a cascade. */
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`setup failed: ${msg}`);
}

// ── identities and calls ─────────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; seedHex: string; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pk = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    const seedHex = (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    return { pk, priv: privateKey, seedHex, name };
}

interface Res { status: number; body: any; text: string }
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** A request through the real stack, signed by `id` when given. Fresh limiter windows, so the suite's own count never decides a result. */
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
        h['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
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

// ── the phone ────────────────────────────────────────────────────────────────────────────────────
const state = (id: Id) => call(id, 'GET', '/api/names/state');
const entries = (id: Id, forExport = false) => call(id, 'GET', `/api/names/entries${forExport ? '?for=export' : ''}`);

/** What `id`'s phone does to open the list: its own wrap of `generation`, opened with its own key. */
async function listKeyOf(id: Id, generation: number): Promise<Uint8Array> {
    const s = await state(id);
    const wrap = (s.body?.myKeys ?? []).find((k: any) => k.generation === generation);
    if (!wrap) throw new Error(`${id.name} holds no wrap of generation ${generation} (${show(s)})`);
    return unwrapNamesListKey(wrap, id.seedHex, id.pk, generation);
}
const wrapFor = (key: Uint8Array, holder: Id, generation: number) => ({ holder: holder.pk, ...wrapNamesListKey(key, holder.pk, generation) });
const addEntry = (id: Id, key: Uint8Array, generation: number, text: NamesEntryText, entryId = newNamesEntryId()) =>
    call(id, 'POST', '/api/names/entries', { id: entryId, ciphertext: sealNamesEntry(key, entryId, generation, text), keyGeneration: generation })
        .then((r) => ({ ...r, entryId }));
const confirm = (id: Id, member: Id, entryId: string) => call(id, 'POST', '/api/names/confirmations', { memberPubkey: member.pk, entryId });
const log = (id: Id) => call(id, 'GET', '/api/names/log?limit=200');

// ── the database ─────────────────────────────────────────────────────────────────────────────────
const count = (table: string, where = '1') => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
const namesRows = () => ['names_entries', 'names_list_keys', 'confirmations', 'names_access_log'].map((t) => count(t)).join('/');
const logActions = (actor: string) => (db.prepare('SELECT action FROM names_access_log WHERE actor_pubkey = ? ORDER BY at, rowid').all(actor) as { action: string }[]).map((r) => r.action);

/** The planted names and note: the suite looks for each in every byte the server writes. */
const PLANTED = ['Zebedee Quillfeather', 'Ottoline Brackenbury', 'Persephone Wanderlust', 'Lives by the old cannery'];
function holdsPlanted(bytes: Buffer): string[] {
    const hay = bytes.toString('latin1').toLowerCase();
    return PLANTED.filter((p) => hay.includes(Buffer.from(p.toLowerCase(), 'utf8').toString('latin1')));
}

async function main(): Promise<void> {
    await initTls();
    initStateEngine();
    const { hash, salt } = hashPassword(ADMIN_PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null });
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    // The community.
    const seed = await call(null, 'POST', '/api/admin/seed-invite', { type: 'standard' }, PASSWORD);
    const owen = newId('Owen');
    require_(seed.status === 200 && (await redeem(owen, seed.body?.code)).status === 200, `Owen joins with the seed invite (${show(seed)})`);
    const [ada, abe, mo, mel, nia] = ['Ada', 'Abe', 'Mo', 'Mel', 'Nia'].map(newId);
    for (const who of [ada, abe, mo, mel, nia]) {
        const made = await generate(owen);
        require_(made.status === 200 && (await redeem(who, made.body?.invite?.code)).status === 200, `${who.name} joins with Owen's invite`);
    }
    for (const [who, role] of [[owen, 'owner'], [ada, 'admin'], [abe, 'admin'], [mo, 'moderator']] as const) {
        const granted = await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: who.pk, role }, PASSWORD);
        require_(granted.status === 200, `${who.name} is made ${role} (${show(granted)})`);
    }
    const stranger = newId('Stranger');

    // ── 1. Who ───────────────────────────────────────────────────────────────────────────────────
    const ROUTES: [Method, string, unknown?][] = [
        ['GET', '/api/names/state'], ['GET', '/api/names/entries'], ['GET', '/api/names/entries?for=export'],
        ['POST', '/api/names/entries', { id: newNamesEntryId(), ciphertext: 'x', keyGeneration: 1 }],
        ['PUT', `/api/names/entries/${newNamesEntryId()}`, { ciphertext: 'x', keyGeneration: 1 }],
        ['DELETE', `/api/names/entries/${newNamesEntryId()}`],
        ['POST', '/api/names/entries/re-encrypt', { generation: 1, entries: [] }],
        ['POST', '/api/names/key', { generation: 1, wraps: [] }], ['POST', '/api/names/key/share', { generation: 1, wraps: [] }],
        ['POST', '/api/names/confirmations', { memberPubkey: mel.pk, entryId: newNamesEntryId() }],
        ['POST', `/api/names/confirmations/${'a'.repeat(32)}/second`], ['POST', `/api/names/confirmations/${'a'.repeat(32)}/revoke`],
        ['GET', '/api/names/log'], ['POST', '/api/names/settings', { twoAdminsToConfirm: true }],
    ];
    const before = namesRows();
    const unsigned = await Promise.all(ROUTES.map(([m, p, b]) => call(null, m, p, b)));
    assert(unsigned.every((r) => r.status === 401), `1. unsigned: 401 on every route (${unsigned.map((r) => r.status).join(' ')})`);
    const strangers = await Promise.all(ROUTES.map(([m, p, b]) => call(stranger, m, p, b)));
    assert(strangers.every((r) => r.status === 401 || r.status === 403), `1. a key that is no member here: refused on every route (${strangers.map((r) => r.status).join(' ')})`);
    for (const who of [mel, mo]) {
        const rs: Res[] = [];
        for (const [m, p, b] of ROUTES) rs.push(await call(who, m, p, b));
        assert(rs.every((r) => r.status === 403 && r.body?.code === 'admins_only' && !/Newcomer|Resident|Steward|Elder|tier/i.test(r.body?.error ?? '')),
            `1. ${who.name} (${who === mo ? 'a moderator' : 'a member'}): 403 admins_only on every route, never a tier (${rs.map((r) => `${r.status}:${r.body?.code}`).join(' ')})`);
    }
    assert(namesRows() === before && before === '0/0/0/0', `1. nothing written by any refused request (${namesRows()})`);
    process.env.NODE_PROFILE = 'global';
    const onGlobal = await state(owen);
    delete process.env.NODE_PROFILE;
    assert(onGlobal.status === 404 && onGlobal.body?.code === 'feature_off', `1. the global node keeps no names list: 404 feature_off (${show(onGlobal)})`);

    // ── 2. The key ───────────────────────────────────────────────────────────────────────────────
    const fresh = await state(owen);
    require_(fresh.status === 200 && fresh.body.generation === 0 && fresh.body.myKeys.length === 0 && fresh.body.settings.twoAdminsToConfirm === false
        && fresh.body.settings.namesShownToMembers === false, `2. as it ships: no key, one admin confirms, real names to members off (${show(fresh)})`);
    assert(JSON.stringify(fresh.body.admins.map((a: any) => a.callsign)) === JSON.stringify(['Owen', 'Ada', 'Abe']), `2. the admins are the owner and the two admins, not the moderator (${JSON.stringify(fresh.body.admins)})`);
    const k1 = newNamesListKey();
    const stale = await call(owen, 'POST', '/api/names/key', { generation: 2, wraps: [wrapFor(k1, owen, 2)] });
    assert(stale.status === 409 && stale.body?.code === 'stale_generation', `2. a key for the wrong generation: 409 stale_generation (${show(stale)})`);
    const notSelf = await call(owen, 'POST', '/api/names/key', { generation: 1, wraps: [wrapFor(k1, ada, 1)] });
    assert(notSelf.status === 400 && notSelf.body?.code === 'bad_wraps', `2. a key its maker doesn't hold: 400 (${show(notSelf)})`);
    const toMember = await call(owen, 'POST', '/api/names/key', { generation: 1, wraps: [wrapFor(k1, owen, 1), wrapFor(k1, mel, 1)] });
    assert(toMember.status === 400 && toMember.body?.code === 'not_admin', `2. a key wrapped to a member: 400 not_admin (${show(toMember)})`);
    const badWrap = await call(owen, 'POST', '/api/names/key', { generation: 1, wraps: [{ ...wrapFor(k1, owen, 1), wrappedKey: 'bm90IGEga2V5' }] });
    assert(badWrap.status === 400 && badWrap.body?.code === 'bad_wraps', `2. a wrap not in the list's form: 400 (${show(badWrap)})`);
    assert(count('names_list_keys') === 0, '2. nothing kept from the refused keys');
    const made = await call(owen, 'POST', '/api/names/key', { generation: 1, wraps: [wrapFor(k1, owen, 1), wrapFor(k1, ada, 1)] });
    require_(made.status === 201 && made.body?.generation === 1, `2. Owen's phone makes the list's key, wrapped to Owen and Ada (${show(made)})`);
    assert(Buffer.from(await listKeyOf(ada, 1)).equals(Buffer.from(k1)), "2. Ada's phone opens her own wrap: the same key");
    const abeState = await state(abe);
    assert(abeState.body?.myKeys?.length === 0 && abeState.body.admins.find((a: any) => a.pubkey === abe.pk)?.holdsKey === false
        && abeState.body.admins.find((a: any) => a.pubkey === owen.pk)?.holdsKey === true, `2. Abe holds nothing yet and is shown waiting (${show(abeState)})`);
    const abeNewKey = await call(abe, 'POST', '/api/names/key', { generation: 2, wraps: [wrapFor(newNamesListKey(), abe, 2)] });
    assert(abeNewKey.status === 409 && abeNewKey.body?.code === 'ask_for_share', `2. Abe can't make a new key while Owen and Ada hold this one: 409 ask_for_share (${show(abeNewKey)})`);
    // Owen's wrap opens for Owen only: Ada's key, or generation 2, doesn't open it.
    const owenWrap = (await state(owen)).body.myKeys[0];
    let wrongOpen = 0;
    for (const [who, gen] of [[ada, 1], [owen, 2]] as const) {
        try { unwrapNamesListKey(owenWrap, who.seedHex, who.pk, gen); } catch (e) { if (e instanceof NamesListCryptoError) wrongOpen++; }
    }
    assert(wrongOpen === 2, "2. Owen's wrap opens for no other admin and as no other generation");

    // ── 3. Entries ───────────────────────────────────────────────────────────────────────────────
    const plainId = newNamesEntryId();
    const plain = await call(owen, 'POST', '/api/names/entries', { id: plainId, ciphertext: JSON.stringify({ name: PLANTED[0] }), keyGeneration: 1 });
    assert(plain.status === 400 && plain.body?.code === 'not_sealed' && count('names_entries') === 0, `3. a name in the clear is refused, not stored (${show(plain)})`);
    const zeb = await addEntry(owen, k1, 1, { name: PLANTED[0], note: PLANTED[3] });
    require_(zeb.status === 201, `3. Owen adds a sealed entry (${show(zeb)})`);
    const ott = await addEntry(ada, await listKeyOf(ada, 1), 1, { name: PLANTED[1], note: 'Mel’s aunt' });
    require_(ott.status === 201, `3. Ada adds one from her phone (${show(ott)})`);
    const again = await call(ada, 'POST', '/api/names/entries', { id: zeb.entryId, ciphertext: sealNamesEntry(k1, zeb.entryId, 1, { name: 'X', note: '' }), keyGeneration: 1 });
    assert(again.status === 409 && again.body?.code === 'entry_exists', `3. the same id twice: 409 (${show(again)})`);
    const abeAdds = await addEntry(abe, newNamesListKey(), 1, { name: 'Somebody', note: '' });
    assert(abeAdds.status === 403 && abeAdds.body?.code === 'no_key', `3. Abe, who holds no key, can't add (${show(abeAdds)})`);
    const read = await entries(ada);
    require_(read.status === 200 && read.body.entries.length === 2, `3. Ada reads the list (${show(read)})`);
    const opened = read.body.entries.map((e: any) => openNamesEntry(k1, e.id, e.keyGeneration, e.ciphertext).name).sort();
    assert(JSON.stringify(opened) === JSON.stringify([PLANTED[1], PLANTED[0]].sort()), `3. her phone opens both (${opened.join(', ')})`);
    assert(!holdsPlanted(Buffer.from(read.text)).length, '3. the read itself carries no name: sealed text only');
    // Abe reads sealed text he can't open, until Owen's phone shares the key with him.
    let abeOpens = 0;
    for (const e of (await entries(abe)).body.entries) { try { openNamesEntry(newNamesListKey(), e.id, e.keyGeneration, e.ciphertext); abeOpens++; } catch { /* sealed */ } }
    assert(abeOpens === 0, '3. without the key, Abe opens nothing');
    const shareToMember = await call(owen, 'POST', '/api/names/key/share', { generation: 1, wraps: [wrapFor(k1, mel, 1)] });
    assert(shareToMember.status === 400 && shareToMember.body?.code === 'not_admin', `3. the key is never shared with a member (${show(shareToMember)})`);
    const shareTwice = await call(owen, 'POST', '/api/names/key/share', { generation: 1, wraps: [wrapFor(k1, ada, 1)] });
    assert(shareTwice.status === 409 && shareTwice.body?.code === 'already_holds', `3. nor again with an admin who holds it (${show(shareTwice)})`);
    const shared = await call(owen, 'POST', '/api/names/key/share', { generation: 1, wraps: [wrapFor(k1, abe, 1)] });
    require_(shared.status === 200 && shared.body?.shared?.[0] === abe.pk, `3. Owen's phone shares the key with Abe: the re-wrap on an admin added (${show(shared)})`);
    const abeKey1 = await listKeyOf(abe, 1);
    assert(openNamesEntry(abeKey1, zeb.entryId, 1, (await entries(abe)).body.entries.find((e: any) => e.id === zeb.entryId).ciphertext).name === PLANTED[0],
        "3. now Abe's phone opens the entries");
    const edited = await call(ada, 'PUT', `/api/names/entries/${ott.entryId}`, { ciphertext: sealNamesEntry(k1, ott.entryId, 1, { name: PLANTED[1], note: 'Mel’s aunt, Left Bank Rd' }), keyGeneration: 1 });
    assert(edited.status === 200, `3. Ada edits an entry (${show(edited)})`);
    const editedNote = openNamesEntry(k1, ott.entryId, 1, (await entries(owen)).body.entries.find((e: any) => e.id === ott.entryId).ciphertext).note;
    assert(editedNote === 'Mel’s aunt, Left Bank Rd', `3. the edit opens as written (${editedNote})`);
    const extra = await addEntry(abe, abeKey1, 1, { name: 'Temporary Entry', note: '' });
    const deleted = await call(abe, 'DELETE', `/api/names/entries/${extra.entryId}`);
    assert(extra.status === 201 && deleted.status === 200 && count('names_entries', `id = '${extra.entryId}'`) === 0
        && count('tombstones', `table_name = 'names_entries' AND row_key = '${extra.entryId}'`) === 1, `3. an entry deleted, with a tombstone for a standby (${show(deleted)})`);

    // ── 4. The access log ────────────────────────────────────────────────────────────────────────
    const exported = await entries(owen, true);
    assert(exported.status === 200 && exported.body.entries.length === 2, `4. Owen's phone fetches the list to export it (${show(exported)})`);
    const owenLog = logActions(owen.pk);
    assert(owenLog.includes('read') && owenLog[owenLog.length - 1] === 'export', `4. his reads and the export are logged as his (${owenLog.join(', ')})`);
    assert(logActions(ada.pk).filter((a) => a === 'read').length === 1 && logActions(abe.pk).filter((a) => a === 'read').length === 2,
        `4. every read is logged: Ada 1, Abe 2 (${logActions(ada.pk).join(',')} | ${logActions(abe.pk).join(',')})`);
    const abeReadsLog = await log(abe);
    const exportLine = abeReadsLog.body?.log?.find((l: any) => l.action === 'export');
    assert(abeReadsLog.status === 200 && exportLine?.actor === owen.pk && exportLine?.actorCallsign === 'Owen' && typeof exportLine?.at === 'string',
        `4. another admin reads who exported, and when (${show(abeReadsLog)})`);
    assert((await state(owen)).status === 200 && logActions(owen.pk).filter((a) => a === 'read').length === owenLog.filter((a) => a === 'read').length,
        '4. opening the key (state) is not a read of the names: no line');

    // ── 5. Confirming ────────────────────────────────────────────────────────────────────────────
    const c1 = await confirm(ada, mel, ott.entryId);
    require_(c1.status === 201 && c1.body?.status === 'confirmed', `5. Ada confirms Mel against an entry (${show(c1)})`);
    const takenEntry = await confirm(owen, nia, ott.entryId);
    assert(takenEntry.status === 409 && takenEntry.body?.code === 'entry_taken', `5. one person, one entry: Nia against Mel's entry 409 (${show(takenEntry)})`);
    const melTwice = await confirm(owen, mel, zeb.entryId);
    assert(melTwice.status === 409 && melTwice.body?.code === 'already_confirmed', `5. Mel against a second entry: 409 (${show(melTwice)})`);
    const self = await confirm(ada, ada, zeb.entryId);
    assert(self.status === 403 && self.body?.code === 'self_confirm', `5. Ada can't confirm herself while there is another admin (${show(self)})`);
    const visitor = await confirm(ada, stranger, zeb.entryId);
    assert(visitor.status === 404 && visitor.body?.code === 'not_member', `5. a key that is no member can't be confirmed (${show(visitor)})`);
    const row1 = db.prepare('SELECT * FROM confirmations WHERE id = ?').get(c1.body.id) as any;
    assert(row1.member_pubkey === mel.pk && row1.entry_id === ott.entryId && row1.confirmed_by === ada.pk && !holdsPlanted(Buffer.from(JSON.stringify(row1))).length,
        '5. the confirmation names the key, the entry and the admin, never a name');
    const revoked = await call(abe, 'POST', `/api/names/confirmations/${c1.body.id}/revoke`, {});
    assert(revoked.status === 200 && revoked.body?.status === 'revoked', `5. Abe revokes it (${show(revoked)})`);
    const revokedAgain = await call(abe, 'POST', `/api/names/confirmations/${c1.body.id}/revoke`, {});
    assert(revokedAgain.status === 409, `5. revoking twice: 409 (${show(revokedAgain)})`);
    const c2 = await confirm(owen, mel, ott.entryId);
    assert(c2.status === 201 && c2.body?.status === 'confirmed', `5. and Mel can be confirmed again (${show(c2)})`);
    const listed = (await entries(ada)).body.confirmations;
    assert(listed.length === 2 && listed.filter((c: any) => c.status === 'revoked').length === 1 && listed.find((c: any) => c.status === 'confirmed')?.callsign === 'Mel',
        `5. the list shows both, the revoked one as history (${JSON.stringify(listed.map((c: any) => c.status))})`);
    // Two admins to confirm.
    const adaSets = await call(ada, 'POST', '/api/names/settings', { twoAdminsToConfirm: true });
    assert(adaSets.status === 403 && adaSets.body?.code === 'owner_only', `5. an admin can't change the settings: owner only (${show(adaSets)})`);
    const shownToMembers = await call(owen, 'POST', '/api/names/settings', { namesShownToMembers: true });
    assert(shownToMembers.status === 409 && shownToMembers.body?.code === 'not_built', `5. real names to members can't be turned on yet: 409 not_built, said plainly (${show(shownToMembers)})`);
    const setTwo = await call(owen, 'POST', '/api/names/settings', { twoAdminsToConfirm: true });
    assert(setTwo.status === 200 && setTwo.body?.twoAdminsToConfirm === true && count('node_config', "key = 'names_two_admins' AND value = 'true'") === 1,
        `5. Owen asks for two admins to confirm (${show(setTwo)})`);
    const c3 = await confirm(ada, nia, zeb.entryId);
    assert(c3.status === 201 && c3.body?.status === 'awaiting_second', `5. Ada's confirmation of Nia waits for a second admin (${show(c3)})`);
    const sameAdmin = await call(ada, 'POST', `/api/names/confirmations/${c3.body.id}/second`, {});
    assert(sameAdmin.status === 403 && sameAdmin.body?.code === 'same_admin', `5. Ada can't second her own (${show(sameAdmin)})`);
    const memberSeconds = await call(nia, 'POST', `/api/names/confirmations/${c3.body.id}/second`, {});
    assert(memberSeconds.status === 403 && memberSeconds.body?.code === 'admins_only', `5. nor can Nia (${show(memberSeconds)})`);
    const seconded = await call(abe, 'POST', `/api/names/confirmations/${c3.body.id}/second`, {});
    assert(seconded.status === 200 && seconded.body?.status === 'confirmed', `5. Abe seconds it: confirmed (${show(seconded)})`);
    const counts = (await state(owen)).body.counts;
    assert(counts.confirmed === 2 && counts.awaitingSecond === 0 && counts.entries === 2, `5. the counts (${JSON.stringify(counts)})`);
    const setOne = await call(owen, 'POST', '/api/names/settings', { twoAdminsToConfirm: false });
    assert(setOne.status === 200 && setOne.body?.twoAdminsToConfirm === false && count('node_config', "key = 'names_two_admins'") === 0,
        `5. and back to one: the row goes (${show(setOne)})`);
    const confirmLines = (db.prepare("SELECT action, actor_pubkey AS a, subject_pubkey AS s FROM names_access_log WHERE action IN ('confirm', 'second', 'revoke', 'settings')").all() as any[]);
    assert(confirmLines.length === 7 && confirmLines.some((l) => l.action === 'second' && l.a === abe.pk && l.s === nia.pk),
        `5. every confirm, second, revoke and setting is logged (${confirmLines.map((l) => l.action).join(', ')})`);

    // ── 6. An admin removed ──────────────────────────────────────────────────────────────────────
    const removed = await call(null, 'DELETE', `/api/local/admin/node-roles/${abe.pk}/admin`, undefined, PASSWORD);
    require_(removed.status === 200, `6. Owen removes Abe's admin role (${show(removed)})`);
    const abeNow = await state(abe);
    assert(abeNow.status === 403 && abeNow.body?.code === 'admins_only', `6. Abe is refused at once (${show(abeNow)})`);
    const abeRow = db.prepare('SELECT * FROM names_list_keys WHERE holder_pubkey = ?').get(abe.pk) as any;
    assert(abeRow?.dropped_at && abeRow.wrapped_key === null && abeRow.ephemeral_pubkey === null, '6. his wrap is dropped: cleared, and marked');
    assert(count('names_access_log', `action = 'holder_dropped' AND subject_pubkey = '${abe.pk}' AND actor_pubkey = 'node'`) === 1, '6. the log says the node dropped him');
    const blocked = await addEntry(ada, k1, 1, { name: 'Should Not Land', note: '' });
    assert(blocked.status === 409 && blocked.body?.code === 'new_key_first', `6. every write is refused until the list has a new key (${show(blocked)})`);
    const blockedEdit = await call(owen, 'PUT', `/api/names/entries/${zeb.entryId}`, { ciphertext: sealNamesEntry(k1, zeb.entryId, 1, { name: 'X', note: '' }), keyGeneration: 1 });
    assert(blockedEdit.status === 409 && blockedEdit.body?.code === 'new_key_first', `6. an edit too (${show(blockedEdit)})`);
    const st6 = (await state(ada)).body;
    assert(st6.newKeyNeeded === true && st6.nobodyHoldsKey === false, `6. the state says a new key is needed (${JSON.stringify({ n: st6.newKeyNeeded, h: st6.nobodyHoldsKey })})`);
    const k2 = newNamesListKey();
    const withAbe = await call(ada, 'POST', '/api/names/key', { generation: 2, wraps: [wrapFor(k2, ada, 2), wrapFor(k2, abe, 2)] });
    assert(withAbe.status === 400 && withAbe.body?.code === 'not_admin', `6. the new key can't be wrapped to Abe (${show(withAbe)})`);
    const rotated = await call(ada, 'POST', '/api/names/key', { generation: 2, wraps: [wrapFor(k2, ada, 2), wrapFor(k2, owen, 2)] });
    require_(rotated.status === 201 && rotated.body?.generation === 2, `6. Ada's phone makes a new key, generation 2, for Ada and Owen (${show(rotated)})`);
    assert(count('names_list_keys', `holder_pubkey = '${abe.pk}'`) === 0, "6. Abe's dropped row is spent and goes");
    // Ada's phone seals the older entries again.
    const old = (await entries(ada)).body.entries.filter((e: any) => e.keyGeneration === 1);
    const adaK1 = await listKeyOf(ada, 1);
    const reenc = await call(ada, 'POST', '/api/names/entries/re-encrypt', {
        generation: 2,
        entries: old.map((e: any) => ({ id: e.id, ciphertext: sealNamesEntry(k2, e.id, 2, openNamesEntry(adaK1, e.id, 1, e.ciphertext)) })),
    });
    assert(reenc.status === 200 && reenc.body?.done === 2 && reenc.body?.left === 0, `6. and sends them back sealed under generation 2 (${show(reenc)})`);
    assert(count('names_list_keys', 'generation = 1') === 0 && count('names_list_keys', 'generation = 2') === 2,
        "6. generation 1's wraps go once nothing is sealed under it");
    const pers = await addEntry(owen, await listKeyOf(owen, 2), 2, { name: PLANTED[2], note: '' });
    require_(pers.status === 201, `6. Owen adds an entry after Abe's removal (${show(pers)})`);
    const persSealed = (db.prepare('SELECT ciphertext FROM names_entries WHERE id = ?').get(pers.entryId) as { ciphertext: string }).ciphertext;
    let abeOpensNew = false;
    for (const gen of [1, 2]) { try { openNamesEntry(abeKey1, pers.entryId, gen, persSealed); abeOpensNew = true; } catch { /* the point */ } }
    for (const e of (db.prepare('SELECT id, ciphertext FROM names_entries').all() as { id: string; ciphertext: string }[])) {
        try { openNamesEntry(abeKey1, e.id, 2, e.ciphertext); abeOpensNew = true; } catch { /* the point */ }
    }
    assert(!abeOpensNew, '6. the key Abe kept opens no entry now, the one written after his removal included');
    const abeEntries = await entries(abe);
    assert(abeEntries.status === 403, `6. and the node gives him none (${show(abeEntries)})`);
    const owenOpens = openNamesEntry(await listKeyOf(owen, 2), zeb.entryId, 2, (await entries(owen)).body.entries.find((e: any) => e.id === zeb.entryId).ciphertext);
    assert(owenOpens.name === PLANTED[0] && owenOpens.note === PLANTED[3], "6. Owen's phone opens the older entries under the new key");
    const reenc2 = await call(ada, 'POST', '/api/names/entries/re-encrypt', { generation: 2, entries: [{ id: zeb.entryId, ciphertext: persSealed }] });
    assert(reenc2.status === 409 && reenc2.body?.code === 'already_current', `6. an entry already under the new key isn't re-encrypted (${show(reenc2)})`);
    // Abe made an admin again waits for a share, like anyone new.
    await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: abe.pk, role: 'admin' }, PASSWORD);
    const abeBack = (await state(abe)).body;
    assert(abeBack.myKeys.length === 0 && abeBack.admins.find((a: any) => a.pubkey === abe.pk)?.holdsKey === false, '6. made an admin again, Abe holds nothing until an admin shares it');

    // ── 7. A member leaving, and re-keys ─────────────────────────────────────────────────────────
    const pruned = await call(null, 'POST', `/api/local/admin/users/${nia.pk}/prune`, {}, PASSWORD);
    require_(pruned.status === 200, `7. an admin removes Nia (${show(pruned)})`);
    const niaRow = db.prepare('SELECT revoked_at, revoke_reason FROM confirmations WHERE member_pubkey = ? AND id = ?').get(nia.pk, c3.body.id) as any;
    assert(niaRow?.revoked_at && niaRow.revoke_reason === 'removed', `7. her confirmation is revoked: removed (${JSON.stringify(niaRow)})`);
    // A re-key moves Mel's confirmation to her new key.
    const melNew = newId('Mel');
    const melCode = issueRekeyCode(mel.pk, owen.pk);
    completeRekey(mel.pk, melNew.pk, melCode.code, owen.pk);
    const melMoved = db.prepare('SELECT member_pubkey FROM confirmations WHERE id = ?').get(c2.body.id) as any;
    assert(melMoved?.member_pubkey === melNew.pk, '7. a re-key moves the confirmation to the new key (design §4.1)');
    const purged = await call(melNew, 'POST', '/api/member/purge', { action: 'purge_account' });
    require_(purged.status === 200, `7. Mel deletes her account (${show(purged)})`);
    const melRow = db.prepare('SELECT revoked_at, revoke_reason FROM confirmations WHERE id = ?').get(c2.body.id) as any;
    assert(melRow?.revoked_at && melRow.revoke_reason === 'account_deleted', `7. her confirmation is revoked: account_deleted (${JSON.stringify(melRow)})`);
    assert(count('names_entries') === 3, "7. the entries are the admins' record and stay: an admin deletes one");
    // An admin's re-key (a lost phone): the old key's wrap is dropped and the list needs a new key.
    const adaNew = newId('Ada');
    completeRekey(ada.pk, adaNew.pk, issueRekeyCode(ada.pk, owen.pk).code, owen.pk);
    const afterRekey = (await state(owen)).body;
    assert(afterRekey.newKeyNeeded === true && count('names_list_keys', `holder_pubkey = '${ada.pk}' AND dropped_at IS NOT NULL`) === 1,
        "7. an admin's re-key drops the old key's wrap, and the list needs a new key (a lost phone may hold it)");
    assert(count('names_list_keys', `wrapped_by = '${adaNew.pk}'`) >= 1 && count('names_access_log', `actor_pubkey = '${adaNew.pk}'`) > 0,
        '7. what Ada did moves with her: the wraps she made, her log lines');

    // ── 8. No readable name anywhere ─────────────────────────────────────────────────────────────
    const snap = createSnapshot();
    // What GET /api/local/admin/sync-snapshot sends a standby, before it is signed (this node runs no libp2p identity).
    const copy = { text: JSON.stringify(await exportSyncState('test-names-list')) };
    const sealedC = JSON.parse(persSealed).c as string;
    assert(copy.text.includes(sealedC) && copy.text.includes('names_list_keys') && copy.text.includes('names_access_log') && copy.text.includes('confirmations'),
        '8. the whole copy a standby pulls carries the sealed entries, the wraps, the confirmations and the log');
    const where: [string, Buffer][] = [
        ['the database', fs.readFileSync(path.join(DATA_DIR, 'state.db'))],
        ['its WAL', fs.existsSync(path.join(DATA_DIR, 'state.db-wal')) ? fs.readFileSync(path.join(DATA_DIR, 'state.db-wal')) : Buffer.alloc(0)],
        ['a snapshot', fs.readFileSync(path.join(SNAPSHOTS_DIR, snap.name))],
        ['the standby copy', Buffer.from(copy.text)],
    ];
    for (const [what, bytes] of where) assert(bytes.length === 0 || holdsPlanted(bytes).length === 0, `8. no planted name in ${what} (${holdsPlanted(bytes).join(', ') || 'none'}, ${bytes.length} bytes)`);
    // The suite's own check works: the same bytes with a name in the clear are caught.
    assert(holdsPlanted(Buffer.from(`xx${PLANTED[2]}yy`)).length === 1, '8. (the scan finds a name written in the clear)');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${passed}/${run} passed`);
    process.exit(1);
});
