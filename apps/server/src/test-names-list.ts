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
 *      Every wrap is signed by its sender (@beanpool/core names-list-trust.ts): one unsigned, signed by another admin,
 *      for another community, or with its drops changed is refused; the state lists every wrap's signed header.
 *   3. Entries: a name in the clear is refused (400 `not_sealed`) and never stored; sealed entries are added, read and
 *      opened on Ada's phone, edited and deleted. Abe can't open them until Owen's phone shares the key (re-wrap on add).
 *   4. The access log: every read and the export are logged, with who; every admin reads the log; a member doesn't.
 *   5. Confirming: one person, one entry; not yourself while there is another admin; revoke, and confirm again. Two
 *      admins to confirm (an owner's setting, off by default): a confirmation waits, the same admin can't second it,
 *      another does. Real names to members stays off (409 `not_built`).
 *   6. An admin removed: the next request drops Abe's wrap, every write is refused until a new key, Ada's phone makes
 *      generation 2 (its signed wrap names Abe as dropped, or it is refused) and seals the older entries again; an entry
 *      written after can't be opened with the key Abe had, and the older generation's wraps are cleared once nothing is
 *      sealed under it, their signed headers kept. Owen's phone, which trusted Abe, stops: a generation Abe signs is
 *      refused.
 *   7. A member leaving: removed by an admin, or deleting their own account, their confirmation is revoked; a re-key
 *      moves a confirmation to the new key, and an admin's re-key drops their wrap (a lost phone may hold it).
 *   8. The server never holds a readable name: the planted names are in no byte of the database or its WAL, of a
 *      snapshot, or of the whole copy a standby pulls, which carries the sealed entries.
 *   9. Whoever runs the server (PR #1411's deciding review). The phones' side is played with core's traceNamesTrust,
 *      the walk the app runs, over the state this server answers:
 *      a. Owen's phone makes generation 3 and shares it, signed, with Ada's new key and with Abe.
 *      b. THE REVIEW'S ATTACK: one row written straight into names_list_keys, a key of the writer's own wrapped to Ada
 *         as the next generation and named as Owen's: Ada's phone refuses it (unsigned), so nothing is sealed under
 *         it; every entry stays sealed under generation 3, the real wraps stay, and the phone has a refusal to say.
 *      c. A key the operator makes an admin through node_roles (the owner password): the server gives it no key, and
 *         wraps it signs, written into the database, are refused by the admins' phones (untrusted).
 *      d. The same key added properly, by Owen's signed share, is trusted by Ada's phone, which never saw the share
 *         made; when Abe is removed, its new generation (naming Abe as dropped) is taken by Ada's and Owen's phones,
 *         and the key Abe kept opens nothing written after.
 *  10. Two admins to confirm with exactly two admins: each can confirm the other (no second admin could), and a member
 *      waits for the second.
 *  11. PR #1411's second deciding review. The phones' side again with core (the gate the app's Share runs, and the walk):
 *      a. The only key-holder, made a moderator and an admin again, starts a new key: her phone doesn't name herself as
 *         dropped, and the server doesn't ask it to (it answered 409 `drops_changed` to every tap).
 *      b. THE RE-KEY: with the owner password only, over HTTP, the operator re-keys Ada's account to a key it holds.
 *         Owen's phone drops Ada's old key, makes a new list key for itself, and offers no Share to the key under her
 *         name: it is not one it checked, and the real Ada's phone shows a different code. Re-keyed to her real new
 *         phone and checked in person, it is shared with, and that phone opens the list. The operator's key holds nothing.
 *      c. A new key is numbered past the current generation (up to 1000 past), never at or below it.
 *      d. THE ROLLBACK: rows written back to an older generation; a phone that took a newer one sees it rolled back.
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
    signedNamesWrap, signNamesWrap, namesWrapDigest, verifyNamesWrap, traceNamesTrust, type NamesEntryText, type NamesTrustPin,
    namesKeyChanges, pinKeyChanges, pinCallsigns, pinCheckedKey, namesShareCheck, namesKeyQr, namesKeyCode, namesKeyCheckMatches,
} from '@beanpool/core';
import { ensureGenesis } from './genesis.js';
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
/** This community's id (genesis.json): what every wrap's signature is bound to. */
let COMMUNITY = '';
const keysOf = (id: Id) => ({ publicKey: id.pk, privateKey: id.seedHex });
/** A wrap of `key` to `holder`, signed by `signer`'s phone (the one sending it). */
const wrapFor = (signer: Id, key: Uint8Array, holder: Id, generation: number, drops: string[] = []) =>
    signedNamesWrap(wrapNamesListKey(key, holder.pk, generation), { communityId: COMMUNITY, generation, holder: holder.pk, signer: keysOf(signer), drops });
/** What `id`'s phone decides about the key, from its pin and this server's state: the walk the app runs. */
async function phoneTrace(id: Id, pin: NamesTrustPin | null) {
    const s = await state(id);
    if (s.status !== 200) throw new Error(`${id.name}'s state: ${show(s)}`);
    const trace = traceNamesTrust({ communityId: s.body.communityId, me: keysOf(id), pin, records: s.body.records, myKeys: s.body.myKeys, generation: s.body.generation });
    return { ...trace, generation: s.body.generation as number };
}
/** A row written straight into the database, as whoever runs the server can: no route, no middleware. */
function plantWrap(holder: Id, generation: number, key: Uint8Array, wrappedBy: string, signature: string): void {
    const w = wrapNamesListKey(key, holder.pk, generation);
    db.prepare(`INSERT INTO names_list_keys (holder_pubkey, generation, wrapped_key, wrap_iv, wrap_tag, ephemeral_pubkey, kdf_params, wrapped_by, wrap_digest, drops, signature)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)`).run(holder.pk, generation, w.wrappedKey, w.wrapIv, w.wrapTag, w.ephemeralPubkey, w.kdfParams, wrappedBy, namesWrapDigest(w), signature);
}
/** The same, signed by `signer`'s real key (a key the server made an admin, or a removed admin working with the operator). */
function plantSigned(signer: Id, holder: Id, generation: number, key: Uint8Array): void {
    const w = wrapNamesListKey(key, holder.pk, generation);
    const sig = signNamesWrap({ communityId: COMMUNITY, generation, holder: holder.pk, wrappedBy: signer.pk, wrapDigest: namesWrapDigest(w), drops: [] }, signer.seedHex);
    db.prepare(`INSERT INTO names_list_keys (holder_pubkey, generation, wrapped_key, wrap_iv, wrap_tag, ephemeral_pubkey, kdf_params, wrapped_by, wrap_digest, drops, signature)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)`).run(holder.pk, generation, w.wrappedKey, w.wrapIv, w.wrapTag, w.ephemeralPubkey, w.kdfParams, signer.pk, namesWrapDigest(w), sig);
}
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
    COMMUNITY = (await ensureGenesis()).communityId;
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
    const stale = await call(owen, 'POST', '/api/names/key', { generation: 1001, wraps: [wrapFor(owen, k1, owen, 1001)] });
    assert(stale.status === 409 && stale.body?.code === 'stale_generation', `2. a key numbered more than 1000 past the current one: 409 stale_generation (${show(stale)})`);
    const notSelf = await call(owen, 'POST', '/api/names/key', { generation: 1, wraps: [wrapFor(owen, k1, ada, 1)] });
    assert(notSelf.status === 400 && notSelf.body?.code === 'bad_wraps', `2. a key its maker doesn't hold: 400 (${show(notSelf)})`);
    const toMember = await call(owen, 'POST', '/api/names/key', { generation: 1, wraps: [wrapFor(owen, k1, owen, 1), wrapFor(owen, k1, mel, 1)] });
    assert(toMember.status === 400 && toMember.body?.code === 'not_admin', `2. a key wrapped to a member: 400 not_admin (${show(toMember)})`);
    const badWrap = await call(owen, 'POST', '/api/names/key', { generation: 1, wraps: [{ ...wrapFor(owen, k1, owen, 1), wrappedKey: 'bm90IGEga2V5' }] });
    assert(badWrap.status === 400 && badWrap.body?.code === 'bad_wraps', `2. a wrap not in the list's form: 400 (${show(badWrap)})`);
    // Every wrap is signed by the admin who sends it, for this community, this generation and its holder.
    const { signature: _s, ...unsignedWrap } = wrapFor(owen, k1, owen, 1);
    void _s;
    const noSig = await call(owen, 'POST', '/api/names/key', { generation: 1, wraps: [unsignedWrap] });
    assert(noSig.status === 400 && noSig.body?.code === 'bad_signature', `2. a wrap with no signature: 400 bad_signature (${show(noSig)})`);
    const adasSig = await call(owen, 'POST', '/api/names/key', { generation: 1, wraps: [wrapFor(ada, k1, owen, 1)] });
    assert(adasSig.status === 400 && adasSig.body?.code === 'bad_signature', `2. a wrap Ada signed, sent by Owen: 400 bad_signature (${show(adasSig)})`);
    const elsewhere = signedNamesWrap(wrapNamesListKey(k1, owen.pk, 1), { communityId: 'ffffffffffffffff', generation: 1, holder: owen.pk, signer: keysOf(owen) });
    const otherCommunity = await call(owen, 'POST', '/api/names/key', { generation: 1, wraps: [elsewhere] });
    assert(otherCommunity.status === 400 && otherCommunity.body?.code === 'bad_signature', `2. a wrap signed for another community: 400 (${show(otherCommunity)})`);
    const dropsChanged = await call(owen, 'POST', '/api/names/key', { generation: 1, wraps: [{ ...wrapFor(owen, k1, owen, 1), drops: [abe.pk] }] });
    assert(dropsChanged.status === 400 && dropsChanged.body?.code === 'bad_signature', `2. a signed wrap whose drops were changed on the way: 400 (${show(dropsChanged)})`);
    assert(count('names_list_keys') === 0, '2. nothing kept from the refused keys');
    const made = await call(owen, 'POST', '/api/names/key', { generation: 1, wraps: [wrapFor(owen, k1, owen, 1), wrapFor(owen, k1, ada, 1)] });
    require_(made.status === 201 && made.body?.generation === 1, `2. Owen's phone makes the list's key, wrapped to Owen and Ada (${show(made)})`);
    assert(Buffer.from(await listKeyOf(ada, 1)).equals(Buffer.from(k1)), "2. Ada's phone opens her own wrap: the same key");
    const st2 = (await state(ada)).body;
    assert(st2.communityId === COMMUNITY && st2.records.length === 2 && st2.records.every((r: any) => verifyNamesWrap(r, r.signature) && r.wrappedBy === owen.pk)
        && typeof st2.myKeys[0]?.signature === 'string' && JSON.stringify(st2.myKeys[0].drops) === '[]',
        `2. the state lists every wrap's signed header, bound to this community, and Ada's own wrap with its signature (${st2.records.length} records)`);
    assert(count('names_list_keys', "length(signature) = 128 AND length(wrap_digest) = 64") === 2, '2. the server keeps each signature beside its wrap');
    const adaFirst = await phoneTrace(ada, null);
    assert(adaFirst.keys.get(1) && Buffer.from(adaFirst.keys.get(1)!).equals(Buffer.from(k1)) && adaFirst.firstTrust === owen.pk && adaFirst.currentTraced,
        "2. Ada's phone, opening the list for the first time, trusts Owen, who signed her wrap, and uses the key");
    assert(adaFirst.pin?.trusted.includes(owen.pk) && adaFirst.pin.communityId === COMMUNITY, "2. what her phone keeps: this community's id, and the keys it trusts");
    const abeState = await state(abe);
    assert(abeState.body?.myKeys?.length === 0 && abeState.body.admins.find((a: any) => a.pubkey === abe.pk)?.holdsKey === false
        && abeState.body.admins.find((a: any) => a.pubkey === owen.pk)?.holdsKey === true, `2. Abe holds nothing yet and is shown waiting (${show(abeState)})`);
    const abeNewKey = await call(abe, 'POST', '/api/names/key', { generation: 2, wraps: [wrapFor(abe, newNamesListKey(), abe, 2)] });
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
    const shareToMember = await call(owen, 'POST', '/api/names/key/share', { generation: 1, wraps: [wrapFor(owen, k1, mel, 1)] });
    assert(shareToMember.status === 400 && shareToMember.body?.code === 'not_admin', `3. the key is never shared with a member (${show(shareToMember)})`);
    const shareTwice = await call(owen, 'POST', '/api/names/key/share', { generation: 1, wraps: [wrapFor(owen, k1, ada, 1)] });
    assert(shareTwice.status === 409 && shareTwice.body?.code === 'already_holds', `3. nor again with an admin who holds it (${show(shareTwice)})`);
    const shared = await call(owen, 'POST', '/api/names/key/share', { generation: 1, wraps: [wrapFor(owen, k1, abe, 1)] });
    require_(shared.status === 200 && shared.body?.shared?.[0] === abe.pk, `3. Owen's phone shares the key with Abe: the re-wrap on an admin added (${show(shared)})`);
    const abeKey1 = await listKeyOf(abe, 1);
    const abeFirst = await phoneTrace(abe, null);
    assert(abeFirst.keys.has(1) && abeFirst.firstTrust === owen.pk, "3. Abe's phone trusts Owen, whose signed share added him");
    let owenPin = (await phoneTrace(owen, null)).pin!;
    assert(owenPin.trusted.includes(abe.pk) && owenPin.trusted.includes(ada.pk), "3. Owen's phone trusts the admins it added itself");
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
    const withAbe = await call(ada, 'POST', '/api/names/key', { generation: 2, wraps: [wrapFor(ada, k2, ada, 2, [abe.pk]), wrapFor(ada, k2, abe, 2)] });
    assert(withAbe.status === 400 && withAbe.body?.code === 'not_admin', `6. the new key can't be wrapped to Abe (${show(withAbe)})`);
    assert(JSON.stringify(st6.droppedHolders) === JSON.stringify([abe.pk]), `6. the state names whom the next key drops (${JSON.stringify(st6.droppedHolders)})`);
    const unsaid = await call(ada, 'POST', '/api/names/key', { generation: 2, wraps: [wrapFor(ada, k2, ada, 2)] });
    assert(unsaid.status === 409 && unsaid.body?.code === 'drops_changed', `6. a new key whose signed wrap doesn't name Abe as dropped is refused (${show(unsaid)})`);
    const rotated = await call(ada, 'POST', '/api/names/key', { generation: 2, wraps: [wrapFor(ada, k2, ada, 2, [abe.pk]), wrapFor(ada, k2, owen, 2)] });
    require_(rotated.status === 201 && rotated.body?.generation === 2, `6. Ada's phone makes a new key, generation 2, for Ada and Owen, its signed wrap naming Abe as dropped (${show(rotated)})`);
    const abeKept = db.prepare('SELECT * FROM names_list_keys WHERE holder_pubkey = ?').get(abe.pk) as any;
    assert(abeKept?.wrapped_key === null && abeKept.dropped_at && verifyNamesWrap({ communityId: COMMUNITY, generation: 1, holder: abe.pk, wrappedBy: owen.pk, wrapDigest: abeKept.wrap_digest, drops: [] }, abeKept.signature),
        "6. Abe's dropped row keeps no key, only its signed header");
    // Ada's phone seals the older entries again.
    const old = (await entries(ada)).body.entries.filter((e: any) => e.keyGeneration === 1);
    const adaK1 = await listKeyOf(ada, 1);
    const reenc = await call(ada, 'POST', '/api/names/entries/re-encrypt', {
        generation: 2,
        entries: old.map((e: any) => ({ id: e.id, ciphertext: sealNamesEntry(k2, e.id, 2, openNamesEntry(adaK1, e.id, 1, e.ciphertext)) })),
    });
    assert(reenc.status === 200 && reenc.body?.done === 2 && reenc.body?.left === 0, `6. and sends them back sealed under generation 2 (${show(reenc)})`);
    assert(count('names_list_keys', 'generation = 1 AND wrapped_key IS NOT NULL') === 0 && count('names_list_keys', 'generation = 1') === 3
        && count('names_list_keys', 'generation = 2 AND wrapped_key IS NOT NULL') === 2,
        "6. generation 1's wraps are cleared once nothing is sealed under it; their signed headers stay");
    // Owen's phone trusted Abe. Ada's signed generation 2 names him as dropped: from now on it refuses what Abe signs.
    const owen6 = await phoneTrace(owen, owenPin);
    assert(owen6.keys.has(2) && owen6.currentTraced && !owen6.trusted.has(abe.pk), "6. Owen's phone takes Ada's generation 2 and stops trusting Abe");
    owenPin = owen6.pin!;
    plantSigned(abe, abe, 3, newNamesListKey());
    plantSigned(abe, owen, 3, newNamesListKey());
    const owenVsAbe = await phoneTrace(owen, owenPin);
    assert(!owenVsAbe.keys.has(3) && !owenVsAbe.currentTraced && owenVsAbe.refused[0]?.reason === 'untrusted' && owenVsAbe.refused[0]?.wrappedBy === abe.pk,
        `6. a generation 3 Abe really signed, written in by whoever runs the server, is refused by Owen's phone (${JSON.stringify(owenVsAbe.refused)})`);
    db.prepare('DELETE FROM names_list_keys WHERE generation = 3').run();
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
    assert(afterRekey.newKeyNeeded === true && count('names_list_keys', `holder_pubkey = '${ada.pk}' AND generation = 2 AND dropped_at IS NOT NULL AND wrapped_key IS NULL`) === 1,
        "7. an admin's re-key drops the old key's wrap, and the list needs a new key (a lost phone may hold it)");
    const adaSigned = db.prepare('SELECT * FROM names_list_keys WHERE wrapped_by = ?').all(ada.pk) as any[];
    assert(adaSigned.length >= 1 && count('names_list_keys', `wrapped_by = '${adaNew.pk}'`) === 0
        && adaSigned.every((r) => verifyNamesWrap({ communityId: COMMUNITY, generation: r.generation, holder: r.holder_pubkey, wrappedBy: ada.pk, wrapDigest: r.wrap_digest, drops: r.drops ? r.drops.split(' ') : [] }, r.signature)),
        "7. the wraps Ada signed keep her old key as their signer, so their signatures still check out");
    assert(count('names_access_log', `actor_pubkey = '${adaNew.pk}'`) > 0, '7. her log lines move with her');

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

    // ── 9. Whoever runs the server ───────────────────────────────────────────────────────────────
    // a. Owen's phone makes generation 3 (Ada's old key dropped), seals the entries again, and shares it with Ada's new key and Abe.
    const owen9 = await phoneTrace(owen, owenPin);
    require_(owen9.currentTraced && owen9.keys.has(2), `9a. Owen's phone holds generation 2 (${JSON.stringify(owen9.refused)})`);
    const st9 = (await state(owen)).body;
    require_(st9.newKeyNeeded && JSON.stringify(st9.droppedHolders) === JSON.stringify([ada.pk]), `9a. a new key is needed: Ada's old key was dropped (${JSON.stringify(st9.droppedHolders)})`);
    const k3 = newNamesListKey();
    const made3 = await call(owen, 'POST', '/api/names/key', { generation: 3, wraps: [wrapFor(owen, k3, owen, 3, st9.droppedHolders)] });
    require_(made3.status === 201, `9a. Owen's phone makes generation 3 (${show(made3)})`);
    const old3 = (await entries(owen)).body.entries;
    const reenc3 = await call(owen, 'POST', '/api/names/entries/re-encrypt', {
        generation: 3, entries: old3.map((e: any) => ({ id: e.id, ciphertext: sealNamesEntry(k3, e.id, 3, openNamesEntry(owen9.keys.get(2)!, e.id, 2, e.ciphertext)) })),
    });
    require_(reenc3.status === 200 && reenc3.body?.left === 0, `9a. and seals every entry again under it (${show(reenc3)})`);
    const share3 = await call(owen, 'POST', '/api/names/key/share', { generation: 3, wraps: [wrapFor(owen, k3, adaNew, 3), wrapFor(owen, k3, abe, 3)] });
    require_(share3.status === 200, `9a. Owen's phone shares it, signed, with Ada's new key and with Abe (${show(share3)})`);
    const adaNewFirst = await phoneTrace(adaNew, null);
    require_(adaNewFirst.keys.has(3) && adaNewFirst.firstTrust === owen.pk, "9a. Ada's new phone trusts Owen on first use and takes generation 3");
    const adaNewPin = adaNewFirst.pin!;
    owenPin = (await phoneTrace(owen, owenPin)).pin!;
    const live3 = () => count('names_list_keys', 'generation = 3 AND wrapped_key IS NOT NULL');
    const allOpenWith = (key: Uint8Array, gen: number) => (db.prepare('SELECT id, ciphertext, key_generation AS g FROM names_entries').all() as any[])
        .every((e) => { try { return e.g === gen && !!openNamesEntry(key, e.id, gen, e.ciphertext).name; } catch { return false; } });
    require_(live3() === 3 && allOpenWith(k3, 3), '9a. three admins hold generation 3, and every entry is sealed under it');

    // b. THE REVIEW'S ATTACK: one row, written straight into the database.
    const planted = newNamesListKey();
    const reencBefore = count('names_access_log', "action = 're_encrypt'");
    plantWrap(adaNew, 4, planted, owen.pk, '00'.repeat(64));
    const adaSees = await phoneTrace(adaNew, adaNewPin);
    assert(adaSees.generation === 4 && !adaSees.keys.has(4) && !adaSees.currentTraced,
        `9b. Ada's phone refuses the written-in generation 4: no key to seal anything under (${JSON.stringify([...adaSees.keys.keys()])})`);
    assert(adaSees.refused.length === 1 && adaSees.refused[0].generation === 4 && adaSees.refused[0].reason === 'unsigned' && adaSees.refused[0].wrappedBy === owen.pk,
        `9b. and has a refusal to tell Ada: generation 4, named as Owen's, not signed by him (${JSON.stringify(adaSees.refused)})`);
    assert(adaSees.keys.has(3) && adaSees.pin?.trusted.includes(owen.pk), '9b. the key she holds from Owen still opens the list');
    assert(!(await phoneTrace(owen, owenPin)).currentTraced, "9b. Owen's phone, too, sees no admin made generation 4");
    let openedWithPlanted = 0;
    for (const e of db.prepare('SELECT id, ciphertext FROM names_entries').all() as any[]) {
        for (const g of [3, 4]) { try { openNamesEntry(planted, e.id, g, e.ciphertext); openedWithPlanted++; } catch { /* the point */ } }
    }
    assert(openedWithPlanted === 0 && allOpenWith(k3, 3), '9b. nothing is sealed under the written-in key: every entry is still under generation 3, and opens only with the real key');
    assert(live3() === 3 && count('names_list_keys', `generation = 3 AND holder_pubkey = '${owen.pk}' AND wrapped_key IS NOT NULL`) === 1,
        "9b. the real admins' wraps are all still there, Owen's included");
    assert(count('names_access_log', "action = 're_encrypt'") === reencBefore, '9b. the log shows no re-encryption since');
    db.prepare('DELETE FROM names_list_keys WHERE generation = 4').run();

    // c. A key the operator makes an admin through node_roles.
    const oscar = newId('Oscar');
    const oscarInvite = await generate(owen);
    require_(oscarInvite.status === 200 && (await redeem(oscar, oscarInvite.body?.invite?.code)).status === 200, '9c. Oscar joins');
    const opAdmin = await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: oscar.pk, role: 'admin' }, PASSWORD);
    require_(opAdmin.status === 200, `9c. the owner password makes Oscar an admin: the server's word alone (${show(opAdmin)})`);
    const oscarKey = await call(oscar, 'POST', '/api/names/key', { generation: 4, wraps: [wrapFor(oscar, newNamesListKey(), oscar, 4)] });
    const oscarShare = await call(oscar, 'POST', '/api/names/key/share', { generation: 3, wraps: [wrapFor(oscar, newNamesListKey(), adaNew, 3)] });
    assert(oscarKey.status === 409 && oscarKey.body?.code === 'ask_for_share' && oscarShare.status === 403 && oscarShare.body?.code === 'no_key',
        `9c. through the server, Oscar can make no key and share none (${show(oscarKey)} | ${show(oscarShare)})`);
    const oscarK = newNamesListKey();
    plantSigned(oscar, oscar, 4, oscarK);
    plantSigned(oscar, adaNew, 4, oscarK);
    plantSigned(oscar, owen, 4, oscarK);
    for (const [who, pin] of [[adaNew, adaNewPin], [owen, owenPin]] as const) {
        const t = await phoneTrace(who, pin);
        assert(!t.keys.has(4) && !t.currentTraced && !t.trusted.has(oscar.pk) && t.refused[0]?.reason === 'untrusted' && t.refused[0]?.wrappedBy === oscar.pk,
            `9c. ${who.name}'s phone refuses generation 4, which Oscar really signed: no admin it trusts added him (${JSON.stringify(t.refused)})`);
    }
    db.prepare('DELETE FROM names_list_keys WHERE generation = 4').run();

    // d. Oscar added properly: Owen's phone shares the key with him, signed. Ada's phone never saw it happen.
    const toOscar = await call(owen, 'POST', '/api/names/key/share', { generation: 3, wraps: [wrapFor(owen, k3, oscar, 3)] });
    require_(toOscar.status === 200, `9d. Owen's phone shares generation 3 with Oscar (${show(toOscar)})`);
    const oscarFirst = await phoneTrace(oscar, null);
    require_(oscarFirst.keys.has(3), "9d. Oscar's phone opens it");
    const adaLearns = await phoneTrace(adaNew, adaNewPin);
    assert(adaLearns.trusted.has(oscar.pk) && adaLearns.keys.has(3), "9d. Ada's phone trusts Oscar now: Owen, whom it trusts, signed his addition");
    const removedAbe = await call(null, 'DELETE', `/api/local/admin/node-roles/${abe.pk}/admin`, undefined, PASSWORD);
    require_(removedAbe.status === 200, `9d. Abe stops being an admin (${show(removedAbe)})`);
    const oscarSt = (await state(oscar)).body;
    require_(oscarSt.newKeyNeeded && JSON.stringify(oscarSt.droppedHolders) === JSON.stringify([abe.pk]), `9d. a new key is needed (${JSON.stringify(oscarSt.droppedHolders)})`);
    const k4 = newNamesListKey();
    const made4 = await call(oscar, 'POST', '/api/names/key', { generation: 4, wraps: [wrapFor(oscar, k4, oscar, 4, [abe.pk])] });
    require_(made4.status === 201, `9d. Oscar's phone makes generation 4, naming Abe as dropped (${show(made4)})`);
    const old4 = (await entries(oscar)).body.entries;
    const reenc4 = await call(oscar, 'POST', '/api/names/entries/re-encrypt', {
        generation: 4, entries: old4.map((e: any) => ({ id: e.id, ciphertext: sealNamesEntry(k4, e.id, 4, openNamesEntry(oscarFirst.keys.get(3)!, e.id, 3, e.ciphertext)) })),
    });
    const share4 = await call(oscar, 'POST', '/api/names/key/share', { generation: 4, wraps: [wrapFor(oscar, k4, adaNew, 4), wrapFor(oscar, k4, owen, 4)] });
    require_(reenc4.status === 200 && share4.status === 200, `9d. seals the entries again and shares it with Ada and Owen (${show(reenc4)} | ${show(share4)})`);
    for (const [who, pin] of [[adaNew, adaNewPin], [owen, owenPin]] as const) {
        const t = await phoneTrace(who, pin);
        assert(t.keys.get(4) && Buffer.from(t.keys.get(4)!).equals(Buffer.from(k4)) && t.currentTraced && !t.trusted.has(abe.pk),
            `9d. ${who.name}'s phone takes Oscar's generation 4 and stops trusting Abe (${JSON.stringify(t.refused)})`);
    }
    let abeOpens4 = 0;
    for (const e of db.prepare('SELECT id, ciphertext, key_generation AS g FROM names_entries').all() as any[]) {
        for (const k of [abeKey1, k3]) { try { openNamesEntry(k, e.id, e.g, e.ciphertext); abeOpens4++; } catch { /* the point */ } }
    }
    assert(abeOpens4 === 0 && (await entries(abe)).status === 403, '9d. the keys Abe kept open nothing written since, and the server gives him nothing');

    // ── 10. Two admins to confirm, with exactly two admins ───────────────────────────────────────
    const removedOscar = await call(null, 'DELETE', `/api/local/admin/node-roles/${oscar.pk}/admin`, undefined, PASSWORD);
    require_(removedOscar.status === 200, `10. Oscar stops being an admin: Owen and Ada are the only two (${show(removedOscar)})`);
    require_((await call(owen, 'POST', '/api/names/settings', { twoAdminsToConfirm: true })).status === 200, '10. Owen asks for two admins to confirm');
    const free = (db.prepare('SELECT e.id FROM names_entries e WHERE NOT EXISTS (SELECT 1 FROM confirmations c WHERE c.entry_id = e.id AND c.revoked_at IS NULL) ORDER BY e.id').all() as { id: string }[]).map((r) => r.id);
    require_(free.length >= 3, `10. three entries with nobody confirmed against them (${free.length})`);
    const owenConfirmsAda = await confirm(owen, adaNew, free[0]);
    assert(owenConfirmsAda.status === 201 && owenConfirmsAda.body?.status === 'confirmed',
        `10. Owen confirms Ada: confirmed, since no admin but Owen could (${show(owenConfirmsAda)})`);
    const adaConfirmsOwen = await confirm(adaNew, owen, free[1]);
    assert(adaConfirmsOwen.status === 201 && adaConfirmsOwen.body?.status === 'confirmed', `10. and Ada confirms Owen the same way (${show(adaConfirmsOwen)})`);
    const moWaits = await confirm(owen, mo, free[2]);
    assert(moWaits.status === 201 && moWaits.body?.status === 'awaiting_second', `10. a member still waits for a second admin (${show(moWaits)})`);
    const adaSeconds = await call(adaNew, 'POST', `/api/names/confirmations/${moWaits.body.id}/second`, {});
    assert(adaSeconds.status === 200 && adaSeconds.body?.status === 'confirmed', `10. whom Ada gives (${show(adaSeconds)})`);

    // ── 11. PR #1411's second deciding review ────────────────────────────────────────────────────
    // a. The only key-holder, out and back. Ada's phone makes generation 5 for her alone (Oscar was dropped from 4).
    const st11 = (await state(adaNew)).body;
    require_(st11.newKeyNeeded && JSON.stringify(st11.droppedHolders) === JSON.stringify([oscar.pk]), `11a. a new key is needed: Oscar was dropped (${JSON.stringify(st11.droppedHolders)})`);
    const adaK4 = (await phoneTrace(adaNew, adaNewPin)).keys.get(4)!;
    const k5 = newNamesListKey();
    require_((await call(adaNew, 'POST', '/api/names/key', { generation: 5, wraps: [wrapFor(adaNew, k5, adaNew, 5, [oscar.pk])] })).status === 201, "11a. Ada's phone makes generation 5, for her alone");
    const old5 = (await entries(adaNew)).body.entries;
    require_((await call(adaNew, 'POST', '/api/names/entries/re-encrypt', {
        generation: 5, entries: old5.map((e: any) => ({ id: e.id, ciphertext: sealNamesEntry(k5, e.id, 5, openNamesEntry(adaK4, e.id, 4, e.ciphertext)) })),
    })).status === 200, '11a. and seals every entry again under it: she is the only holder');
    require_((await call(null, 'DELETE', `/api/local/admin/node-roles/${adaNew.pk}/admin`, undefined, PASSWORD)).status === 200
        && (await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: adaNew.pk, role: 'moderator' }, PASSWORD)).status === 200, '11a. the owner makes Ada a moderator');
    require_((await state(owen)).status === 200, "11a. (the next names-list request drops Ada's wrap)");
    require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: adaNew.pk, role: 'admin' }, PASSWORD)).status === 200, '11a. and an admin again');
    const outBack = (await state(adaNew)).body;
    assert(outBack.nobodyHoldsKey === true && JSON.stringify(outBack.droppedHolders) === JSON.stringify([adaNew.pk]),
        `11a. nobody holds the key, and the state lists Ada herself as dropped (${JSON.stringify({ nobody: outBack.nobodyHoldsKey, dropped: outBack.droppedHolders })})`);
    const k6 = newNamesListKey();
    const restart = await call(adaNew, 'POST', '/api/names/key', { generation: 6, wraps: [wrapFor(adaNew, k6, adaNew, 6, [])] });
    assert(restart.status === 201, `11a. her phone starts a new key, naming nobody (not herself) as dropped: 201, not 409 drops_changed (${show(restart)})`);
    const adaRestarted = await phoneTrace(adaNew, adaNewPin);
    assert(adaRestarted.keys.has(6) && adaRestarted.currentTraced, "11a. and her phone takes it");
    // The entries sealed under 5 are locked now (nobody holds its key): Ada types each one again from the paper copy.
    for (const e of (await entries(adaNew)).body.entries as any[]) {
        const retyped = await call(adaNew, 'PUT', `/api/names/entries/${e.id}`, { ciphertext: sealNamesEntry(k6, e.id, 6, openNamesEntry(k5, e.id, 5, e.ciphertext)), keyGeneration: 6 });
        require_(retyped.status === 200, `11a. Ada types an entry again under generation 6 (${show(retyped)})`);
    }
    require_((await call(adaNew, 'POST', '/api/names/key/share', { generation: 6, wraps: [wrapFor(adaNew, k6, owen, 6)] })).status === 200, "11a. she shares it with Owen");
    // Owen's phone as the app keeps it: whom it trusts, and the callsign each of them shows.
    const owen11 = await phoneTrace(owen, owenPin);
    require_(owen11.keys.has(6) && owen11.trusted.has(adaNew.pk), `11a. Owen's phone takes generation 6 and trusts Ada (${JSON.stringify(owen11.refused)})`);
    owenPin = pinCallsigns(owen11.pin!, (await state(owen)).body.admins);
    require_(owenPin.names[adaNew.pk] === 'Ada', "11a. Owen's phone knows Ada's key by her callsign");

    // b. THE RE-KEY, with the owner password only, over HTTP.
    const op = newId('Ada');
    const issued = await call(null, 'POST', `/api/local/admin/members/${adaNew.pk}/rekey/issue-code`, {}, PASSWORD);
    const moved = await call(null, 'POST', `/api/local/admin/members/${adaNew.pk}/rekey/complete`, { code: issued.body?.code, newPubkey: op.pk }, PASSWORD);
    require_(issued.status === 200 && issued.body?.operator === 'owner:password' && moved.status === 200,
        `11b. the owner password alone re-keys Ada's account to a key the operator holds (${show(issued)} | ${show(moved)})`);
    const stOp = (await state(owen)).body;
    require_(stOp.admins.some((a: any) => a.pubkey === op.pk && a.callsign === 'Ada') && !stOp.admins.some((a: any) => a.pubkey === adaNew.pk),
        `11b. the server now shows "Ada" on the operator's key (${JSON.stringify(stOp.admins.map((a: any) => `${a.callsign}:${a.pubkey.slice(0, 6)}`))})`);
    // Owen's phone opens the list: Ada's callsign is on a key it doesn't trust, and the key it trusted under it is gone.
    const changes = namesKeyChanges(owenPin, stOp.admins);
    assert(changes.length === 1 && changes[0].callsign === 'Ada' && changes[0].was === adaNew.pk && changes[0].now === op.pk,
        `11b. Owen's phone sees Ada's key changed (${JSON.stringify(changes)})`);
    owenPin = pinKeyChanges(owenPin, changes);
    const owenRekeyed = traceNamesTrust({ communityId: stOp.communityId, me: keysOf(owen), pin: owenPin, records: stOp.records, myKeys: stOp.myKeys, generation: stOp.generation });
    assert(!owenRekeyed.trusted.has(adaNew.pk) && !owenRekeyed.trusted.has(op.pk) && owenRekeyed.keys.has(6),
        "11b. it trusts neither Ada's old key (dropped for good: a lost phone may hold it) nor the key now under her name, and still holds generation 6");
    owenPin = owenRekeyed.pin!;
    require_(stOp.newKeyNeeded && JSON.stringify(stOp.droppedHolders) === JSON.stringify([adaNew.pk]), `11b. the list needs a new key (${JSON.stringify(stOp.droppedHolders)})`);
    const k7 = newNamesListKey();
    require_((await call(owen, 'POST', '/api/names/key', { generation: 7, wraps: [wrapFor(owen, k7, owen, 7, stOp.droppedHolders)] })).status === 201,
        "11b. Owen's phone makes generation 7, for itself alone, naming Ada's old key as dropped");
    const old7 = (await entries(owen)).body.entries;
    require_((await call(owen, 'POST', '/api/names/entries/re-encrypt', {
        generation: 7, entries: old7.map((e: any) => ({ id: e.id, ciphertext: sealNamesEntry(k7, e.id, 7, openNamesEntry(k6, e.id, 6, e.ciphertext)) })),
    })).status === 200, '11b. and seals the entries again under it');
    const opRow = (await state(owen)).body.admins.find((a: any) => a.pubkey === op.pk);
    assert(opRow && opRow.holdsKey === false && namesShareCheck(owenPin, opRow) === 'changed',
        `11b. "Ada" waits for the key, and Owen's phone offers no Share: her key changed, so it must be checked in person (${namesShareCheck(owenPin, opRow)})`);
    assert(!namesKeyCheckMatches(namesKeyQr(adaNew.pk), op.pk) && !namesKeyCheckMatches(namesKeyCode(adaNew.pk), op.pk),
        "11b. checked in person, the real Ada's phone shows its own key and code, which don't match the key under her name: still no Share");
    assert(count('names_list_keys', `holder_pubkey = '${op.pk}'`) === 0 && (await state(op)).body?.myKeys?.length === 0,
        "11b. the operator's key holds no wrap of any generation: it opens no name");
    // Ada's real new phone: the owner re-keys the account to it, and Owen checks it in person before sharing.
    const adaReal = newId('Ada');
    const issued2 = await call(null, 'POST', `/api/local/admin/members/${op.pk}/rekey/issue-code`, {}, PASSWORD);
    require_((await call(null, 'POST', `/api/local/admin/members/${op.pk}/rekey/complete`, { code: issued2.body?.code, newPubkey: adaReal.pk }, PASSWORD)).status === 200,
        "11b. the owner moves Ada's account to her real new phone");
    const realRow = (await state(owen)).body.admins.find((a: any) => a.pubkey === adaReal.pk);
    assert(realRow && namesShareCheck(owenPin, realRow) === 'changed', '11b. still no Share before the check in person');
    assert(namesKeyCheckMatches(namesKeyCode(adaReal.pk), adaReal.pk), "11b. her phone's code matches the key the server lists for her");
    owenPin = pinCheckedKey(owenPin, adaReal.pk, 'Ada');
    assert(namesShareCheck(owenPin, realRow) === 'trusted', '11b. checked in person: Share is offered');
    require_((await call(owen, 'POST', '/api/names/key/share', { generation: 7, wraps: [wrapFor(owen, k7, adaReal, 7)] })).status === 200, "11b. Owen's phone shares generation 7 with her");
    const adaRealFirst = await phoneTrace(adaReal, null);
    assert(adaRealFirst.keys.has(7) && adaRealFirst.firstTrust === owen.pk && allOpenWith(adaRealFirst.keys.get(7)!, 7),
        "11b. her new phone opens every entry, and trusts Owen, whose code it shows her to compare");

    // c. Numbering a new key.
    const atCurrent = await call(owen, 'POST', '/api/names/key', { generation: 7, wraps: [wrapFor(owen, newNamesListKey(), owen, 7)] });
    assert(atCurrent.status === 409 && atCurrent.body?.code === 'stale_generation', `11c. a key numbered at the current generation: 409 stale_generation (${show(atCurrent)})`);
    const k9 = newNamesListKey();
    const leap = await call(owen, 'POST', '/api/names/key', { generation: 9, wraps: [wrapFor(owen, k9, owen, 9)] });
    assert(leap.status === 201 && (await state(owen)).body.generation === 9,
        `11c. a key numbered past it (a phone that took a newer one than this server has now): 201, and it is current (${show(leap)})`);
    const owenAt9 = await phoneTrace(owen, owenPin);
    require_(owenAt9.keys.has(9) && owenAt9.pin!.newest === 9, `11c. Owen's phone takes generation 9 and remembers it (${owenAt9.pin?.newest})`);

    // d. THE ROLLBACK: whoever runs the server deletes the newer rows; generation 7 is current again, and Abe-style keys with it.
    db.prepare('DELETE FROM names_list_keys WHERE generation > 7').run();
    const rolled = await phoneTrace(owen, owenAt9.pin!);
    assert(rolled.generation === 7 && rolled.rolledBack === true && rolled.pin!.newest === 9,
        `11d. Owen's phone, which took generation 9, sees the server offer 7: rolled back, so it reads and seals nothing (${JSON.stringify({ g: rolled.generation, rolledBack: rolled.rolledBack })})`);
    assert((await phoneTrace(adaReal, adaRealFirst.pin)).rolledBack === false, '11d. a phone that never took a newer one has nothing to tell it by: the documented limit');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${passed}/${run} passed`);
    process.exit(1);
});
