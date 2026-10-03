/**
 * The names list (community modes slice 2; engine/names-list.ts, routes/names-list.ts, @beanpool/core
 * names-list-crypto.ts and names-list-trust.ts; the trust model is scratch/global-node/DESIGN-names-list-trust-fable.md,
 * whose §10 matrix names the cases marked here): the admins' list of who the members are, kept on the node sealed on
 * the admins' phones, and confirming a member against an entry.
 *
 * Over REAL HTTPS through the real signature middleware, on a local community: Owen (owner), Ada, Abe and Bea (admins),
 * Mo (a moderator), Mel and Nia (members). This suite plays each admin's phone with @beanpool/core, by the steps the app
 * runs (apps/native utils/names-list.ts openNamesList): syncNames over this server's state, the generation the plan
 * makes without asking, and the keys sent to every admin the phone trusts. The node only ever sees what a phone sends.
 *
 *   1. Who: unsigned 401, a key that is no member 403, a member and a moderator 403 `admins_only` on every route, with
 *      nothing written; the global node keeps no list (404 `feature_off`).
 *   2. The key history and shares: Owen's phone makes the first generation. A statement not signed by its maker (A1),
 *      for another community, off another parent, or numbered past the next (E6, no leap) is refused; the same one twice
 *      is `exists`; Abe can't make the next while Owen holds this one (`ask_for_share`). Owen and Ada check each other;
 *      Owen's phone sends Ada the keys (and nobody it hasn't checked: B1). A share signed by someone else, to a member, for
 *      a key the server has no statement for, or with a box its header doesn't name, is refused (A9).
 *   3. Entries: a name in the clear is refused (400 `not_sealed`) and never stored; sealed entries are added under the
 *      head's key, a stale key id is 409 `stale_key` (F1), read and opened on Ada's phone, edited and deleted. Abe opens
 *      nothing until he and Owen check each other.
 *   4. The access log: every read and the export are logged, with who; every admin reads the log; a member doesn't.
 *   5. Confirming: one person, one entry; not yourself while there is another admin; revoke, and confirm again. Two
 *      admins to confirm (an owner's setting, off by default). Real names to members stays off (409 `not_built`).
 *   6. An admin removed (F2, F9): the next request marks Abe as no longer holding the key, once; every write is refused
 *      until a new key; Owen's phone makes it without Abe (the server asks for no drops: the phones decide) and sends it
 *      to Ada and Bea; the log says so. The key Abe kept opens nothing written after; a statement he signs, written into
 *      the database, is refused by every phone; made an admin again he gets nothing until checked again.
 *   7. A member leaving, and re-keys: a confirmation is revoked or moves with the member; an admin's re-key marks the old
 *      key, keeps every statement and share signed by it as it was, and the phones make a new key without it.
 *   8. The server never holds a readable name: the planted names are in no byte of the database or its WAL, of a
 *      snapshot, or of the whole copy a standby pulls, which carries the sealed entries, the history and the shares.
 *   9. Whoever runs the server: a statement and a share written straight into the tables (A1), a key the owner password
 *      makes an admin signing a real statement (A2), the same key added properly by a check and a vouch (B3), and the
 *      owner password moving Ada's account to the operator's key, over HTTP (A3).
 *  10. Two admins to confirm with exactly two admins (F7): each can confirm the other, and a member waits for the second.
 *  11. The only holder of the newest key, made a moderator and an admin again, makes a new key dropping nobody (C6); a
 *      server put back to an older history is refused by a phone that took a newer one, and the phone puts it back
 *      (E1), after which what it writes is under a key the removed admin never had.
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
    newNamesListKey, newNamesEntryId, sealNamesEntry, openNamesEntry, makeNamesGeneration, makeNamesShare, makeNamesGenerationFor, namesSelfClaim,
    syncNames, namesSharesToSend, checkNamesKeyInPerson, emptyNamesPin, namesReplay, namesRingKeys, readNamesGeneration, sealNamesRing,
    namesKeyCheckMatches, namesKeyQr, namesKeyCode,
    type NamesEntryText, type NamesPin, type NamesPlan, type NamesShare,
} from '@beanpool/core';
import { ed25519 } from '@noble/curves/ed25519.js';
const sha512 = (b: Uint8Array): Uint8Array => new Uint8Array(crypto.createHash('sha512').update(b).digest());
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import { initStateEngine, exportSyncState } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { hashPassword, updateLocalConfig } from './config/local-config.js';
import { turnOn2faForTests } from './admin-auth-test-harness.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { createSnapshot, SNAPSHOTS_DIR } from './services/snapshot-scheduler.js';
import { issueRekeyCode, completeRekey } from './engine/member-wizards.js';

let BASE = '';
const ADMIN_PW = 'Names-List-Admin-Pw-62!';
// Step 7c: the password alone opens no admin route with 2FA off, so the suite turns 2FA on and sends a code with it.
let twoFa: ReturnType<typeof turnOn2faForTests>;
const PASSWORD = () => twoFa.headers();
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
const postGen = (id: Id, g: { statement: string; signature: string }, replay = false) =>
    call(id, 'POST', '/api/names/generations', { statement: g.statement, signature: g.signature, ...(replay ? { replay: true } : {}) });
const postShare = (id: Id, s: NamesShare) => call(id, 'POST', '/api/names/shares', { header: s.header, signature: s.signature, box: s.box });

// ── A signature only ZIP-215 takes (as test-storm-smalls makes it, #1457): strict Ed25519 must refuse it ─────────────────
// R is the identity point encoded with y = p + 1 (non-canonical); with R = O, [8][S]B = [8]R + [8][k]A holds for S = k·a.
const ED_L = 2n ** 252n + 27742317777372353535851937790883648493n;
const leToBig = (b: Uint8Array) => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };
const bigToLe32 = (v: bigint) => { const out = new Uint8Array(32); let n = v; for (let i = 0; i < 32; i++) { out[i] = Number(n & 0xffn); n >>= 8n; } return out; };
function zip215OnlySignature(message: Uint8Array, seed: Uint8Array): Uint8Array {
    const { scalar, pointBytes } = ed25519.utils.getExtendedPublicKey(seed);
    const canonicalIdentity = new Uint8Array(32); canonicalIdentity[0] = 1;
    const nonCanonicalIdentity = new Uint8Array(32).fill(0xff); nonCanonicalIdentity[0] = 0xee; nonCanonicalIdentity[31] = 0x7f;
    const k = leToBig(sha512(new Uint8Array([...canonicalIdentity, ...pointBytes, ...message]))) % ED_L;
    return new Uint8Array([...nonCanonicalIdentity, ...bigToLe32((k * scalar) % ED_L)]);
}

/** An admin's phone: its pin, and the steps the app runs on opening the list. */
class Phone {
    pin: NamesPin | null = null;
    constructor(public id: Id) {}
    get signer() { return { publicKey: this.id.pk, privateKey: this.id.seedHex }; }
    async sync(): Promise<{ plan: NamesPlan; state: any; toDrop: string[] }> {
        const s = await state(this.id);
        if (s.status !== 200) throw new Error(`${this.id.name}'s state: ${show(s)}`);
        const r = syncNames({ pin: this.pin, state: s.body, me: this.signer });
        if (!(r.plan.kind === 'refused' && r.plan.reason === 'other_community')) this.pin = r.pin;
        return { plan: r.plan, state: s.body, toDrop: r.toDrop };
    }
    /** The app's open: sync; the generation the plan makes without asking; the keys sent to every admin this phone trusts. */
    async open(): Promise<{ plan: NamesPlan; state: any; made: Res | null; shares: Res[] }> {
        let r = await this.sync();
        let made: Res | null = null;
        if (r.plan.kind === 'make_first' || r.plan.kind === 'make_new') {
            const m = makeNamesGenerationFor(this.pin!, this.signer, r.plan.kind === 'make_new' ? r.plan.drops : []);
            this.pin = m.pin;
            made = await this.postMine(m.generation, r.state, r.plan.kind === 'make_new' ? r.plan.drops : []);
            r = await this.sync();
        }
        const shares: Res[] = [];
        if (r.plan.kind === 'ready') for (const s of namesSharesToSend(this.pin!, r.state, this.signer)) shares.push(await postShare(this.id, s));
        return { ...r, made, shares };
    }
    /**
     * Sends this phone's own new statement as the app does: refused with `ask_for_share` while the node counts no holder
     * on this phone's own word (design Addendum 4), it first sends its signed header to the admins it trusts (never to a
     * key the statement drops), then the statement once more.
     */
    async postMine(g: { statement: string; signature: string }, st: any, drops: string[]): Promise<Res> {
        const first = await postGen(this.id, g);
        if (first.status !== 409 || first.body?.code !== 'ask_for_share') return first;
        const head = this.pin!.chain[this.pin!.chain.length - 1];
        if (!head || !this.pin!.ring[head.id]) return first;
        for (const a of st.admins ?? []) {
            if (a.pubkey === this.id.pk || !this.pin!.trusted.includes(a.pubkey) || drops.includes(a.pubkey)) continue;
            const sh = namesSharesToSend(this.pin!, st, this.signer, a.pubkey, drops)[0]; // never vouching for a key it drops
            if (sh) await postShare(this.id, sh);
        }
        return postGen(this.id, g);
    }
    head(): string { return this.pin!.chain[this.pin!.chain.length - 1].id; }
    key(id = this.head()): Uint8Array { return namesRingKeys(this.pin!)[id]; }
}
/** Two admins check each other in person: each phone pins the other's key. */
function meet(a: Phone, b: Phone, communityId: string): void {
    a.pin = checkNamesKeyInPerson(a.pin ?? emptyNamesPin(communityId, a.id.pk), b.id.pk);
    b.pin = checkNamesKeyInPerson(b.pin ?? emptyNamesPin(communityId, b.id.pk), a.id.pk);
}
const sharedTo = (rs: Res[]) => rs.filter((r) => r.status === 200).map((r) => r.body?.to as string);

let COMMUNITY = '';
const addEntry = (p: Phone, text: NamesEntryText, entryId = newNamesEntryId(), keyId = p.head()) =>
    call(p.id, 'POST', '/api/names/entries', { id: entryId, ciphertext: sealNamesEntry(p.key(keyId), entryId, keyId, text), keyId }).then((r) => ({ ...r, entryId }));
const confirm = (id: Id, member: Id, entryId: string) => call(id, 'POST', '/api/names/confirmations', { memberPubkey: member.pk, entryId });
const log = (id: Id) => call(id, 'GET', '/api/names/log?limit=200');

// ── the database ─────────────────────────────────────────────────────────────────────────────────
const count = (table: string, where = '1') => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
const NAMES_TABLES = ['names_entries', 'names_generations', 'names_shares', 'names_dropped_holders', 'confirmations', 'names_access_log'];
const namesRows = () => NAMES_TABLES.map((t) => count(t)).join('/');
const logActions = (actor: string) => (db.prepare('SELECT action FROM names_access_log WHERE actor_pubkey = ? ORDER BY at, rowid').all(actor) as { action: string }[]).map((r) => r.action);
const logSince = (rowid: number) => db.prepare('SELECT action, actor_pubkey AS actor, subject_pubkey AS subject FROM names_access_log WHERE rowid > ? ORDER BY rowid').all(rowid) as { action: string; actor: string; subject: string | null }[];
const lastLogRow = () => (db.prepare('SELECT MAX(rowid) AS r FROM names_access_log').get() as { r: number | null }).r ?? 0;
/** A statement written straight into the table, as whoever runs the server can: no route, no middleware. */
function plantGeneration(g: { id: string; n: number; parentId: string | null; maker: string; drops: string[]; statement: string; signature: string }): void {
    db.prepare('INSERT INTO names_generations (id, n, parent_id, maker, drops, statement, signature) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(g.id, g.n, g.parentId, g.maker, g.drops.join(','), g.statement, g.signature);
}
function plantShare(s: NamesShare, signature = s.signature): void {
    db.prepare(`INSERT OR REPLACE INTO names_shares (from_pubkey, to_pubkey, head_id, key_ids, trusts, sealed_ring, ring_iv, ring_tag, ephemeral_pubkey, kdf_params, box_digest, header, signature)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(s.from, s.to, s.headId, s.keyIds.join(','), s.trusts.join(','), s.box!.sealedRing, s.box!.ringIv, s.box!.ringTag,
        s.box!.ephemeralPubkey, s.box!.kdfParams, s.boxDigest, s.header, signature);
}

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
    twoFa = turnOn2faForTests(ADMIN_PW);
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    // The community.
    const seed = await call(null, 'POST', '/api/admin/seed-invite', { type: 'standard' }, PASSWORD());
    const owen = newId('Owen');
    require_(seed.status === 200 && (await redeem(owen, seed.body?.code)).status === 200, `Owen joins with the seed invite (${show(seed)})`);
    const [ada, abe, bea, mo, mel, nia] = ['Ada', 'Abe', 'Bea', 'Mo', 'Mel', 'Nia'].map(newId);
    for (const who of [ada, abe, bea, mo, mel, nia]) {
        const made = await generate(owen);
        require_(made.status === 200 && (await redeem(who, made.body?.invite?.code)).status === 200, `${who.name} joins with Owen's invite`);
    }
    for (const [who, role] of [[owen, 'owner'], [ada, 'admin'], [abe, 'admin'], [bea, 'admin'], [mo, 'moderator']] as const) {
        const granted = await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: who.pk, role }, PASSWORD());
        require_(granted.status === 200, `${who.name} is made ${role} (${show(granted)})`);
    }
    const stranger = newId('Stranger');
    const [owenP, adaP, abeP, beaP] = [owen, ada, abe, bea].map((i) => new Phone(i));

    // ── 1. Who ───────────────────────────────────────────────────────────────────────────────────
    const ROUTES: [Method, string, unknown?][] = [
        ['GET', '/api/names/state'], ['GET', '/api/names/entries'], ['GET', '/api/names/entries?for=export'],
        ['POST', '/api/names/entries', { id: newNamesEntryId(), ciphertext: 'x', keyId: 'a'.repeat(64) }],
        ['PUT', `/api/names/entries/${newNamesEntryId()}`, { ciphertext: 'x', keyId: 'a'.repeat(64) }],
        ['DELETE', `/api/names/entries/${newNamesEntryId()}`],
        ['POST', '/api/names/generations', { statement: 'x', signature: 'x' }], ['POST', '/api/names/shares', { header: 'x', signature: 'x' }],
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
    assert(namesRows() === before && before === '0/0/0/0/0/0', `1. nothing written by any refused request (${namesRows()})`);
    process.env.NODE_PROFILE = 'global';
    const onGlobal = await state(owen);
    delete process.env.NODE_PROFILE;
    assert(onGlobal.status === 404 && onGlobal.body?.code === 'feature_off', `1. the global node keeps no names list: 404 feature_off (${show(onGlobal)})`);

    // ── 2. The key history and shares ────────────────────────────────────────────────────────────
    const fresh = await state(owen);
    require_(fresh.status === 200 && fresh.body.current === null && fresh.body.generations.length === 0 && fresh.body.shares.length === 0
        && fresh.body.settings.twoAdminsToConfirm === false && fresh.body.settings.namesShownToMembers === false && fresh.body.communityId === COMMUNITY,
        `2. as it ships: no key history, one admin confirms, real names to members off (${show(fresh)})`);
    assert(JSON.stringify(fresh.body.admins.map((a: any) => a.callsign)) === JSON.stringify(['Owen', 'Ada', 'Abe', 'Bea']), `2. the admins are the owner and the three admins, not the moderator (${JSON.stringify(fresh.body.admins.map((a: any) => a.callsign))})`);
    // A1 (server side): a statement whose signature isn't its maker's.
    const g1 = makeNamesGeneration({ communityId: COMMUNITY, n: 1, parentId: null, drops: [] }, owenP.signer);
    const unsignedGen = await postGen(owen, { statement: g1.statement, signature: '00'.repeat(64) });
    assert(unsignedGen.status === 400 && unsignedGen.body?.code === 'bad_signature', `2. A1 a statement not signed by the maker it names: 400 bad_signature (${show(unsignedGen)})`);
    const laxGen = await postGen(owen, { statement: g1.statement, signature: Buffer.from(zip215OnlySignature(Buffer.from(g1.statement), Buffer.from(owen.seedHex, 'hex'))).toString('hex') });
    assert(laxGen.status === 400 && laxGen.body?.code === 'bad_signature', `2. a statement signed in a form only ZIP-215 takes: 400 bad_signature, strict Ed25519 (#1457) (${show(laxGen)})`);
    const elsewhere = makeNamesGeneration({ communityId: 'ffffffffffffffff', n: 1, parentId: null, drops: [] }, owenP.signer);
    const elsewhereGen = await postGen(owen, elsewhere);
    assert(elsewhereGen.status === 400 && elsewhereGen.body?.code === 'bad_statement', `2. a statement for another community: 400 (${show(elsewhereGen)})`);
    const notFirst = makeNamesGeneration({ communityId: COMMUNITY, n: 2, parentId: 'a'.repeat(64), drops: [] }, owenP.signer);
    const notFirstGen = await postGen(owen, notFirst);
    assert(notFirstGen.status === 409 && notFirstGen.body?.code === 'stale', `2. a statement off a parent this server doesn't have as current: 409 stale (${show(notFirstGen)})`);
    assert(count('names_generations') === 0, '2. nothing kept from the refused statements');
    const o1 = await owenP.open();
    require_(o1.made?.status === 201 && o1.plan.kind === 'ready', `2. Owen's phone makes the first generation without asking (${show(o1.made)})`);
    const k1 = owenP.head();
    assert(count('names_generations', `id = '${k1}' AND n = 1 AND parent_id IS NULL AND maker = '${owen.pk}' AND length(signature) = 128`) === 1,
        '2. the server keeps the statement as signed: its id is the SHA-256 of the bytes, its maker the signer');
    const again = await postGen(owen, readNamesGeneration(o1.state.generations[0], COMMUNITY)!);
    assert(again.status === 200 && again.body?.code === 'exists', `2. the same statement again (a retry): 200 exists (${show(again)})`);
    const leap = makeNamesGeneration({ communityId: COMMUNITY, n: 3, parentId: k1, drops: [] }, owenP.signer);
    const leapGen = await postGen(owen, leap);
    assert(leapGen.status === 409 && leapGen.body?.code === 'stale', `2. E6 a statement numbered past the next: 409 stale, no leap (${show(leapGen)})`);
    const secondRoot = makeNamesGeneration({ communityId: COMMUNITY, n: 1, parentId: null, drops: [] }, adaP.signer);
    assert((await postGen(ada, secondRoot)).status === 409, '2. a second first statement: 409');
    const abeNext = makeNamesGeneration({ communityId: COMMUNITY, n: 2, parentId: k1, drops: [] }, abeP.signer);
    const abeNextGen = await postGen(abe, abeNext);
    assert(abeNextGen.status === 409 && abeNextGen.body?.code === 'ask_for_share', `2. Abe can't make the next while Owen holds this one: 409 ask_for_share (${show(abeNextGen)})`);
    assert(logActions(owen.pk).join(',') === 'key_made', `2. the log: Owen made the list's first key (${logActions(owen.pk).join(',')})`);
    // B1: Owen's phone sends the keys to nobody it hasn't checked.
    const o1b = await owenP.open();
    assert(o1b.shares.length === 0 && count('names_shares') === 0, '2. B1 Owen\'s phone sends the keys to no admin it hasn\'t checked in person');
    meet(owenP, adaP, COMMUNITY);
    const o2 = await owenP.open();
    require_(JSON.stringify(sharedTo(o2.shares)) === JSON.stringify([ada.pk]), `2. after Owen and Ada check each other, Owen's phone sends her the keys, and only her (${o2.shares.map(show).join(' | ')})`);
    const a1 = await adaP.open();
    assert(a1.plan.kind === 'ready' && Buffer.from(adaP.key(k1)).equals(Buffer.from(owenP.key(k1))), "2. Ada's phone takes the history and the key from Owen's box");
    assert(JSON.stringify(sharedTo(a1.shares)) === JSON.stringify([owen.pk]), "2. and sends Owen her own header (her vouch), once");
    // Shares the server refuses.
    const asAda = makeNamesShare({ communityId: COMMUNITY, from: adaP.signer, to: bea.pk, headId: k1, ring: { [k1]: adaP.key(k1) }, trusts: [] });
    const adaSigned = await postShare(owen, asAda);
    assert(adaSigned.status === 400 && adaSigned.body?.code === 'bad_signature', `2. a share Ada signed, sent by Owen: 400 bad_signature (${show(adaSigned)})`);
    const toMel = await postShare(owen, makeNamesShare({ communityId: COMMUNITY, from: owenP.signer, to: mel.pk, headId: k1, ring: { [k1]: owenP.key(k1) }, trusts: [] }));
    assert(toMel.status === 400 && toMel.body?.code === 'not_admin', `2. the keys never go to a member (${show(toMel)})`);
    const unknownKey = await postShare(owen, makeNamesShare({ communityId: COMMUNITY, from: owenP.signer, to: bea.pk, headId: k1, ring: { [k1]: owenP.key(k1), ['b'.repeat(64)]: newNamesListKey() }, trusts: [] }));
    assert(unknownKey.status === 400 && unknownKey.body?.code === 'unknown_key', `2. A9 a share naming a key this server has no statement for: 400 unknown_key (${show(unknownKey)})`);
    const realShare = makeNamesShare({ communityId: COMMUNITY, from: owenP.signer, to: bea.pk, headId: k1, ring: { [k1]: owenP.key(k1) }, trusts: [] });
    const swappedBox = sealNamesRing({ [k1]: newNamesListKey() }, { communityId: COMMUNITY, from: owen.pk, to: bea.pk, headId: k1 });
    const badBox = await call(owen, 'POST', '/api/names/shares', { header: realShare.header, signature: realShare.signature, box: swappedBox });
    assert(badBox.status === 400 && badBox.body?.code === 'bad_box', `2. a box its signed header doesn't name: 400 bad_box (${show(badBox)})`);
    const laxShare = await call(owen, 'POST', '/api/names/shares', { header: realShare.header, signature: Buffer.from(zip215OnlySignature(Buffer.from(realShare.header), Buffer.from(owen.seedHex, 'hex'))).toString('hex'), box: realShare.box });
    assert(laxShare.status === 400 && laxShare.body?.code === 'bad_signature', `2. a share header signed in a form only ZIP-215 takes: 400 bad_signature (${show(laxShare)})`);
    assert(count('names_shares') === 2, '2. nothing kept from the refused shares');
    const abeSees = (await state(abe)).body;
    const st2 = (await state(ada)).body;
    assert(abeSees.shares.length === 2 && abeSees.shares.every((x: any) => x.box === undefined)
        && st2.shares.filter((x: any) => x.box).map((x: any) => x.to).join() === ada.pk,
        '2. every admin sees every share\'s signed header; only its recipient gets the box');
    assert(JSON.stringify(st2.admins.map((a: any) => a.keyIds.length)) === JSON.stringify([1, 1, 0, 0]) && st2.holdersOfCurrent.length === 2,
        `2. the state says who holds which key, on each holder's own word (${JSON.stringify(st2.admins.map((a: any) => a.keyIds.length))})`);

    // ── 3. Entries ───────────────────────────────────────────────────────────────────────────────
    const plainId = newNamesEntryId();
    const plain = await call(owen, 'POST', '/api/names/entries', { id: plainId, ciphertext: JSON.stringify({ name: PLANTED[0] }), keyId: k1 });
    assert(plain.status === 400 && plain.body?.code === 'not_sealed' && count('names_entries') === 0, `3. a name in the clear is refused, not stored (${show(plain)})`);
    const zeb = await addEntry(owenP, { name: PLANTED[0], note: PLANTED[3] });
    require_(zeb.status === 201, `3. Owen adds a sealed entry under the head's key (${show(zeb)})`);
    const ott = await addEntry(adaP, { name: PLANTED[1], note: 'Mel’s aunt' });
    // K4's other half: a box addressed to her is enough for `no_key` (the loose count: she may hold it).
    require_(ott.status === 201, `3. Ada adds one from her phone; a box addressed to her counts for no_key (${show(ott)})`);
    const dup = await call(ada, 'POST', '/api/names/entries', { id: zeb.entryId, ciphertext: sealNamesEntry(adaP.key(), zeb.entryId, k1, { name: 'X', note: '' }), keyId: k1 });
    assert(dup.status === 409 && dup.body?.code === 'entry_exists', `3. the same id twice: 409 entry_exists (${show(dup)})`);
    const staleKey = await call(owen, 'POST', '/api/names/entries', { id: newNamesEntryId(), ciphertext: sealNamesEntry(owenP.key(), plainId, k1, { name: 'X', note: '' }), keyId: 'c'.repeat(64) });
    assert(staleKey.status === 409 && staleKey.body?.code === 'stale_key', `3. F1 an entry under a key that isn't the current one: 409 stale_key (${show(staleKey)})`);
    const abeAdds = await call(abe, 'POST', '/api/names/entries', { id: newNamesEntryId(), ciphertext: sealNamesEntry(newNamesListKey(), plainId, k1, { name: 'Somebody', note: '' }), keyId: k1 });
    assert(abeAdds.status === 403 && abeAdds.body?.code === 'no_key', `3. Abe, who holds no key, can't add (${show(abeAdds)})`);
    const read = await entries(ada);
    require_(read.status === 200 && read.body.entries.length === 2 && read.body.current === k1, `3. Ada reads the list (${show(read)})`);
    const opened = read.body.entries.map((e: any) => openNamesEntry(adaP.key(e.keyId), e.id, e.keyId, e.ciphertext).name).sort();
    assert(JSON.stringify(opened) === JSON.stringify([PLANTED[1], PLANTED[0]].sort()), `3. her phone opens both (${opened.join(', ')})`);
    assert(!holdsPlanted(Buffer.from(read.text)).length, '3. the read itself carries no name: sealed text only');
    const abeFirst = await abeP.open();
    assert(abeFirst.plan.kind === 'refused' && abeFirst.plan.reason === 'untrusted_maker' && abeFirst.plan.maker === owen.pk,
        `3. Abe's phone, never checked, takes nothing and is told to meet Owen (${JSON.stringify(abeFirst.plan)})`);
    meet(owenP, abeP, COMMUNITY);
    meet(owenP, beaP, COMMUNITY);
    const o3 = await owenP.open();
    // Ada too: Owen's phone now trusts two more admins than its last header to her said, so it sends her its vouch again.
    require_(JSON.stringify(sharedTo(o3.shares).sort()) === JSON.stringify([ada.pk, abe.pk, bea.pk].sort()), `3. checked, Abe and Bea get the keys on Owen's next open (${o3.shares.map(show).join(' | ')})`);
    // K3 (design Addendum 4): a key is held on the holder's own word (made it, or its own signed header lists it). A box
    // addressed to Bea doesn't make her a holder until her own header says so.
    const st3k = (await state(owen)).body;
    assert(!st3k.admins.find((a: any) => a.pubkey === bea.pk).keyIds.includes(k1) && !st3k.holdersOfCurrent.includes(bea.pk),
        `3. K3 Bea, only sent a box, holds nothing on her own word yet (${JSON.stringify(st3k.admins.find((a: any) => a.pubkey === bea.pk).keyIds)})`);
    for (const p of [abeP, beaP]) require_((await p.open()).plan.kind === 'ready', `3. ${p.id.name}'s phone opens the list`);
    assert(abeP.pin!.trusted.includes(ada.pk) && adaP.pin!.trusted.length === 2, "3. Abe's phone trusts Ada from Owen's signed header (a vouch)");
    await adaP.open();
    assert(adaP.pin!.trusted.includes(abe.pk) && adaP.pin!.trusted.includes(bea.pk), "3. and Ada's phone trusts Abe and Bea the same way");
    assert(openNamesEntry(abeP.key(k1), zeb.entryId, k1, (await entries(abe)).body.entries.find((e: any) => e.id === zeb.entryId).ciphertext).name === PLANTED[0],
        "3. now Abe's phone opens the entries");
    const edited = await call(ada, 'PUT', `/api/names/entries/${ott.entryId}`, { ciphertext: sealNamesEntry(adaP.key(), ott.entryId, k1, { name: PLANTED[1], note: 'Mel’s aunt, Left Bank Rd' }), keyId: k1 });
    assert(edited.status === 200, `3. Ada edits an entry (${show(edited)})`);
    const editedNote = openNamesEntry(owenP.key(), ott.entryId, k1, (await entries(owen)).body.entries.find((e: any) => e.id === ott.entryId).ciphertext).note;
    assert(editedNote === 'Mel’s aunt, Left Bank Rd', `3. the edit opens as written (${editedNote})`);
    const extra = await addEntry(abeP, { name: 'Temporary Entry', note: '' });
    const deleted = await call(abe, 'DELETE', `/api/names/entries/${extra.entryId}`);
    assert(extra.status === 201 && deleted.status === 200 && count('names_entries', `id = '${extra.entryId}'`) === 0
        && count('tombstones', `table_name = 'names_entries' AND row_key = '${extra.entryId}'`) === 1, `3. an entry deleted, with a tombstone for a standby (${show(deleted)})`);
    const afterDelete = await entries(ada);
    assert(Array.isArray(afterDelete.body?.deleted) && afterDelete.body.deleted[0] === extra.entryId && !afterDelete.body.entries.some((e: any) => e.id === extra.entryId),
        `3. the list says which ids an admin deleted (newest first), so a phone counts no honest delete as a loss (${JSON.stringify(afterDelete.body?.deleted)})`);

    // ── 4. The access log ────────────────────────────────────────────────────────────────────────
    const exported = await entries(owen, true);
    assert(exported.status === 200 && exported.body.entries.length === 2, `4. Owen's phone fetches the list to export it (${show(exported)})`);
    const owenLog = logActions(owen.pk);
    assert(owenLog.includes('read') && owenLog[owenLog.length - 1] === 'export', `4. his reads and the export are logged as his (${owenLog.join(', ')})`);
    const abeReadsLog = await log(abe);
    const exportLine = abeReadsLog.body?.log?.find((l: any) => l.action === 'export');
    assert(abeReadsLog.status === 200 && exportLine?.actor === owen.pk && exportLine?.actorCallsign === 'Owen' && typeof exportLine?.at === 'string',
        `4. another admin reads who exported, and when (${show(abeReadsLog)})`);
    const sharedLines = (db.prepare("SELECT subject_pubkey AS s FROM names_access_log WHERE action = 'key_shared' AND actor_pubkey = ?").all(owen.pk) as { s: string }[]).map((r) => r.s);
    assert([ada.pk, abe.pk, bea.pk].every((k) => sharedLines.includes(k)), '4. every automatic send of the keys is a line: Owen sent them to Ada, Abe and Bea');
    const readsBefore = logActions(owen.pk).filter((a) => a === 'read').length;
    assert((await state(owen)).status === 200 && logActions(owen.pk).filter((a) => a === 'read').length === readsBefore, '4. opening the key history (state) is not a read of the names: no line');
    assert((await log(mel)).status === 403, '4. a member reads no log');

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
    const adaSets = await call(ada, 'POST', '/api/names/settings', { twoAdminsToConfirm: true });
    assert(adaSets.status === 403 && adaSets.body?.code === 'owner_only', `5. an admin can't change the settings: owner only (${show(adaSets)})`);
    const shownToMembers = await call(owen, 'POST', '/api/names/settings', { namesShownToMembers: true });
    assert(shownToMembers.status === 409 && shownToMembers.body?.code === 'not_built', `5. real names to members can't be turned on yet: 409 not_built (${show(shownToMembers)})`);
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
    assert(counts.confirmed === 2 && counts.awaitingSecond === 0 && counts.entries === 2 && counts.byKey[k1] === 2, `5. the counts (${JSON.stringify(counts)})`);
    const setOne = await call(owen, 'POST', '/api/names/settings', { twoAdminsToConfirm: false });
    assert(setOne.status === 200 && setOne.body?.twoAdminsToConfirm === false && count('node_config', "key = 'names_two_admins'") === 0,
        `5. and back to one: the row goes (${show(setOne)})`);

    // ── 6. An admin removed ──────────────────────────────────────────────────────────────────────
    const abeKey1 = abeP.key(k1);
    const logMark = lastLogRow();
    const abeHeldOwnWord = (await state(owen)).body.admins.find((a: any) => a.pubkey === abe.pk).keyIds.includes(k1);
    const removed = await call(null, 'DELETE', `/api/local/admin/node-roles/${abe.pk}/admin`, undefined, PASSWORD());
    require_(removed.status === 200, `6. Owen removes Abe's admin role (${show(removed)})`);
    const abeNow = await state(abe);
    assert(abeNow.status === 403 && abeNow.body?.code === 'admins_only', `6. Abe is refused at once (${show(abeNow)})`);
    assert(count('names_dropped_holders', `holder_pubkey = '${abe.pk}' AND key_id = '${k1}'`) === 1, '6. he is marked as no longer holding the current key');
    const blocked = await addEntry(adaP, { name: 'Should Not Land', note: '' });
    assert(blocked.status === 409 && blocked.body?.code === 'new_key_first', `6. F2 every write is refused until the list has a new key (${show(blocked)})`);
    const blockedEdit = await call(owen, 'PUT', `/api/names/entries/${zeb.entryId}`, { ciphertext: sealNamesEntry(owenP.key(), zeb.entryId, k1, { name: 'X', note: '' }), keyId: k1 });
    assert(blockedEdit.status === 409 && blockedEdit.body?.code === 'new_key_first', `6. an edit too (${show(blockedEdit)})`);
    const st6 = (await state(ada)).body;
    // K4: the freeze keeps the loose count (a box sealed to Abe's key is readable with it), whatever Abe's own word was.
    assert(!st6.holdersOfCurrent.includes(abe.pk), `6. K4 Abe is no holder now (on his own word he ${abeHeldOwnWord ? 'was' : 'never was'}); the freeze still holds`);
    assert(st6.newKeyNeeded === true && st6.nobodyHoldsKey === false && JSON.stringify(st6.droppedHolders) === JSON.stringify([abe.pk]) && st6.callsigns[abe.pk] === 'Abe',
        `6. the state says a new key is needed, and names whom the server saw go (${JSON.stringify({ n: st6.newKeyNeeded, h: st6.nobodyHoldsKey, d: st6.droppedHolders })})`);
    const o6 = await owenP.open();
    const k2 = owenP.head();
    require_(o6.made?.status === 201 && o6.plan.kind === 'ready' && readNamesGeneration(o6.state.generations.find((g: any) => g.id === k2), COMMUNITY)?.drops.join() === abe.pk,
        `6. Owen's phone makes generation 2 without Abe, without being asked (${show(o6.made)})`);
    assert(JSON.stringify(sharedTo(o6.shares).sort()) === JSON.stringify([ada.pk, bea.pk].sort()), "6. and sends it to Ada and Bea, the admins it trusts");
    const f9 = logSince(logMark).filter((l) => l.action !== 'read').map((l) => (l.action === 'key_shared' ? `key_shared:${l.subject === ada.pk ? 'Ada' : l.subject === bea.pk ? 'Bea' : '?'}` : l.action));
    assert(JSON.stringify(f9.sort()) === JSON.stringify(['holder_dropped', 'key_changed', 'key_shared:Ada', 'key_shared:Bea'].sort()),
        `6. F9 the log: holder_dropped once, key_changed, key_shared twice (${f9.join(', ')})`);
    for (const p of [adaP, beaP]) {
        const r = await p.open();
        require_(r.plan.kind === 'ready' && p.head() === k2 && !p.pin!.trusted.includes(abe.pk), `6. ${p.id.name}'s phone takes generation 2 and stops trusting Abe`);
    }
    const pers = await addEntry(owenP, { name: PLANTED[2], note: '' });
    require_(pers.status === 201, `6. Owen adds an entry after Abe's removal, under key 2 (${show(pers)})`);
    const persRow = db.prepare('SELECT ciphertext, key_id FROM names_entries WHERE id = ?').get(pers.entryId) as { ciphertext: string; key_id: string };
    let abeOpensNew = false;
    for (const kid of [k1, k2]) { try { openNamesEntry(abeKey1, pers.entryId, kid, persRow.ciphertext); abeOpensNew = true; } catch { /* the point */ } }
    assert(persRow.key_id === k2 && !abeOpensNew, '6. the key Abe kept opens nothing written after his removal');
    assert(openNamesEntry(owenP.key(k1), zeb.entryId, k1, (await entries(owen)).body.entries.find((e: any) => e.id === zeb.entryId).ciphertext).name === PLANTED[0],
        '6. nothing was sealed again: the older entries stay under key 1, and open with it');
    const abeGen = makeNamesGeneration({ communityId: COMMUNITY, n: 3, parentId: k2, drops: [] }, abeP.signer);
    plantGeneration(abeGen);
    for (const p of [owenP, adaP]) {
        const r = await p.sync();
        assert(r.plan.kind === 'refused' && r.plan.reason === 'untrusted_maker' && r.plan.maker === abe.pk, `6. a generation 3 Abe really signed, written in, is refused by ${p.id.name}'s phone (${JSON.stringify(r.plan)})`);
    }
    db.prepare('DELETE FROM names_generations WHERE id = ?').run(abeGen.id);
    await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: abe.pk, role: 'admin' }, PASSWORD());
    const o6b = await owenP.open();
    assert(!sharedTo(o6b.shares).includes(abe.pk) && owenP.pin!.dropped[abe.pk] === k2, // by the dropping statement's id (Addendum 2)
        "6. made an admin again, Abe gets nothing from Owen's phone: it dropped him, and only a check in person brings him back");

    // ── 7. A member leaving, and re-keys ─────────────────────────────────────────────────────────
    await call(null, 'DELETE', `/api/local/admin/node-roles/${abe.pk}/admin`, undefined, PASSWORD());
    const pruned = await call(null, 'POST', `/api/local/admin/users/${nia.pk}/prune`, {}, PASSWORD());
    require_(pruned.status === 200, `7. an admin removes Nia (${show(pruned)})`);
    const niaRow = db.prepare('SELECT revoked_at, revoke_reason FROM confirmations WHERE member_pubkey = ? AND id = ?').get(nia.pk, c3.body.id) as any;
    assert(niaRow?.revoked_at && niaRow.revoke_reason === 'removed', `7. her confirmation is revoked: removed (${JSON.stringify(niaRow)})`);
    const melNew = newId('Mel');
    completeRekey(mel.pk, melNew.pk, issueRekeyCode(mel.pk, owen.pk).code, owen.pk);
    const melMoved = db.prepare('SELECT member_pubkey FROM confirmations WHERE id = ?').get(c2.body.id) as any;
    assert(melMoved?.member_pubkey === melNew.pk, '7. a re-key moves the confirmation to the new key (design §4.1)');
    const purged = await call(melNew, 'POST', '/api/member/purge', { action: 'purge_account' });
    require_(purged.status === 200, `7. Mel deletes her account (${show(purged)})`);
    const melRow = db.prepare('SELECT revoked_at, revoke_reason FROM confirmations WHERE id = ?').get(c2.body.id) as any;
    assert(melRow?.revoked_at && melRow.revoke_reason === 'account_deleted', `7. her confirmation is revoked: account_deleted (${JSON.stringify(melRow)})`);
    assert(count('names_entries') === 3, "7. the entries are the admins' record and stay: an admin deletes one");
    // An admin's re-key (a lost phone): the old key is marked, the history and the shares it signed stay as they were.
    const adaNew = newId('Ada');
    const adaMadeOrSent = count('names_shares', `from_pubkey = '${ada.pk}' OR to_pubkey = '${ada.pk}'`);
    completeRekey(ada.pk, adaNew.pk, issueRekeyCode(ada.pk, owen.pk).code, owen.pk);
    const afterRekey = (await state(owen)).body;
    assert(afterRekey.newKeyNeeded === true && count('names_dropped_holders', `holder_pubkey = '${ada.pk}' AND key_id = '${k2}'`) === 1,
        "7. an admin's re-key marks the old key as no longer holding the list's key, and the list needs a new one (a lost phone may hold it)");
    assert(count('names_shares', `from_pubkey = '${ada.pk}' OR to_pubkey = '${ada.pk}'`) === adaMadeOrSent && count('names_shares', `from_pubkey = '${adaNew.pk}' OR to_pubkey = '${adaNew.pk}'`) === 0,
        '7. the shares signed by, or sealed to, her old key keep it: the signatures and boxes are that key\'s');
    assert(count('names_access_log', `actor_pubkey = '${adaNew.pk}'`) > 0 && afterRekey.callsigns[ada.pk] === 'Ada', '7. her log lines move with her, and the old key still goes by her name in the words');
    const o7 = await owenP.open();
    const k3 = owenP.head();
    assert(o7.made?.status === 201 && readNamesGeneration(o7.state.generations.find((g: any) => g.id === k3), COMMUNITY)?.drops.join() === ada.pk && !sharedTo(o7.shares).includes(adaNew.pk),
        "7. Owen's phone makes generation 3 without Ada's old key, and sends nothing to her new key: it hasn't checked it");
    const adaNewP = new Phone(adaNew);
    meet(owenP, adaNewP, COMMUNITY);
    const o7b = await owenP.open();
    require_(sharedTo(o7b.shares).includes(adaNew.pk), "7. after Owen and Ada's new phone check each other, Owen's phone sends it the keys");
    require_((await adaNewP.open()).plan.kind === 'ready', "7. Ada's new phone opens the list");
    await beaP.open();

    // ── 8. No readable name anywhere ─────────────────────────────────────────────────────────────
    const snap = createSnapshot();
    const copy = { text: JSON.stringify(await exportSyncState('test-names-list')) };
    const sealedC = JSON.parse(persRow.ciphertext).c as string;
    assert(copy.text.includes(sealedC) && ['names_generations', 'names_shares', 'names_dropped_holders', 'names_access_log', 'confirmations'].every((t) => copy.text.includes(t)),
        '8. the whole copy a standby pulls carries the sealed entries, the key history, the shares, the marks, the confirmations and the log');
    const where: [string, Buffer][] = [
        ['the database', fs.readFileSync(path.join(DATA_DIR, 'state.db'))],
        ['its WAL', fs.existsSync(path.join(DATA_DIR, 'state.db-wal')) ? fs.readFileSync(path.join(DATA_DIR, 'state.db-wal')) : Buffer.alloc(0)],
        ['a snapshot', fs.readFileSync(path.join(SNAPSHOTS_DIR, snap.name))],
        ['the standby copy', Buffer.from(copy.text)],
    ];
    for (const [what, bytes] of where) assert(bytes.length === 0 || holdsPlanted(bytes).length === 0, `8. F3 no planted name in ${what} (${holdsPlanted(bytes).join(', ') || 'none'}, ${bytes.length} bytes)`);
    assert(holdsPlanted(Buffer.from(`xx${PLANTED[2]}yy`)).length === 1, '8. (the scan finds a name written in the clear)');

    // ── 9. Whoever runs the server ───────────────────────────────────────────────────────────────
    // A1: a statement with no valid signature, and a box "to Ada" under a header nobody signed, written into the tables.
    const ringBefore = JSON.stringify(adaNewP.pin!.ring);
    const forged = makeNamesGeneration({ communityId: COMMUNITY, n: 4, parentId: k3, drops: [owen.pk] }, owenP.signer);
    plantGeneration({ ...forged, signature: '00'.repeat(64) });
    plantShare(makeNamesShare({ communityId: COMMUNITY, from: owenP.signer, to: adaNew.pk, headId: k3, ring: { [forged.id]: newNamesListKey() }, trusts: [owen.pk] }), '11'.repeat(64));
    const writesBefore = count('names_entries');
    const adaSees = await adaNewP.open();
    assert(adaSees.plan.kind === 'refused' && adaSees.plan.reason === 'missing_record' && adaSees.made === null && adaSees.shares.length === 0,
        `9. A1 Ada's phone refuses the written-in statement the server now calls current: nothing taken, made or sent (${JSON.stringify(adaSees.plan)})`);
    assert(JSON.stringify(adaNewP.pin!.ring) === ringBefore && count('names_entries') === writesBefore && adaNewP.head() === k3, "9. A1 her ring and her history are as they were");
    db.prepare('DELETE FROM names_generations WHERE id = ?').run(forged.id);
    db.prepare('DELETE FROM names_shares WHERE from_pubkey = ? AND to_pubkey = ?').run(owen.pk, adaNew.pk);
    require_((await owenP.open()).plan.kind === 'ready' && (await adaNewP.open()).plan.kind === 'ready', '9. (the rows taken out again, both phones are ready)');
    // A2: a key the owner password makes an admin.
    const oscar = newId('Oscar');
    const oscarInvite = await generate(owen);
    require_(oscarInvite.status === 200 && (await redeem(oscar, oscarInvite.body?.invite?.code)).status === 200, '9. Oscar joins');
    require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: oscar.pk, role: 'admin' }, PASSWORD())).status === 200, "9. the owner password makes Oscar an admin: the server's word alone");
    const oscarP = new Phone(oscar);
    const oscarGen = makeNamesGeneration({ communityId: COMMUNITY, n: 4, parentId: k3, drops: [owen.pk, adaNew.pk] }, oscarP.signer);
    const oscarMakes = await postGen(oscar, oscarGen);
    assert(oscarMakes.status === 409 && oscarMakes.body?.code === 'ask_for_share', `9. A2 through the server, Oscar can't make the next key while others hold this one (${show(oscarMakes)})`);
    plantGeneration(oscarGen);
    for (const p of [owenP, adaNewP]) {
        const r = await p.open();
        assert(r.plan.kind === 'refused' && r.plan.reason === 'untrusted_maker' && r.plan.maker === oscar.pk && r.plan.canCheck === true && r.shares.length === 0,
            `9. A2 ${p.id.name}'s phone refuses generation 4, which Oscar really signed: nobody it trusts checked him (${JSON.stringify(r.plan)})`);
    }
    assert(count('names_shares', `to_pubkey = '${oscar.pk}'`) === 0, '9. A2 no phone sent Oscar anything');
    db.prepare('DELETE FROM names_generations WHERE id = ?').run(oscarGen.id);
    // B3: Oscar added properly: Owen checks him in person; Ada's phone, which never met him, takes him from Owen's header.
    meet(owenP, oscarP, COMMUNITY);
    const o9 = await owenP.open();
    require_(sharedTo(o9.shares).includes(oscar.pk), "9. B3 Owen's phone sends Oscar the keys after they check each other");
    require_((await oscarP.open()).plan.kind === 'ready', "9. B3 Oscar's phone opens the list");
    await adaNewP.open();
    assert(adaNewP.pin!.trusted.includes(oscar.pk), "9. B3 Ada's phone trusts Oscar from Owen's signed header");
    // A3: the owner password alone moves Ada's account to a key the operator holds, over HTTP.
    const op = newId('Ada');
    const issued = await call(null, 'POST', `/api/local/admin/members/${adaNew.pk}/rekey/issue-code`, {}, PASSWORD());
    const moved = await call(null, 'POST', `/api/local/admin/members/${adaNew.pk}/rekey/complete`, { code: issued.body?.code, newPubkey: op.pk }, PASSWORD());
    require_(issued.status === 200 && issued.body?.operator === 'owner:password' && moved.status === 200,
        `9. A3 the owner password alone re-keys Ada's account to a key the operator holds (${show(issued)} | ${show(moved)})`);
    const o9b = await owenP.open();
    const k4 = owenP.head();
    assert(o9b.made?.status === 201 && readNamesGeneration(o9b.state.generations.find((g: any) => g.id === k4), COMMUNITY)?.drops.join() === adaNew.pk,
        "9. A3 Owen's phone makes a new key without Ada's previous key, on its own");
    assert(!sharedTo(o9b.shares).includes(op.pk) && count('names_shares', `to_pubkey = '${op.pk}'`) === 0 && (await state(op)).body?.admins?.find((a: any) => a.pubkey === op.pk)?.keyIds.length === 0,
        '9. A3 and sends nothing to the key under her name: it hasn\'t checked it; the operator\'s key holds nothing');
    const adaReal = newId('Ada');
    assert(!namesKeyCheckMatches(namesKeyQr(adaReal.pk), op.pk) && !namesKeyCheckMatches(namesKeyCode(adaReal.pk), op.pk),
        "9. A3 checked in person, the real Ada's phone shows a key and code that aren't the one under her name");
    const issued2 = await call(null, 'POST', `/api/local/admin/members/${op.pk}/rekey/issue-code`, {}, PASSWORD());
    require_((await call(null, 'POST', `/api/local/admin/members/${op.pk}/rekey/complete`, { code: issued2.body?.code, newPubkey: adaReal.pk }, PASSWORD())).status === 200,
        "9. A3 the owner moves Ada's account to her real new phone");
    const adaRealP = new Phone(adaReal);
    meet(owenP, adaRealP, COMMUNITY);
    const o9c = await owenP.open();
    require_(sharedTo(o9c.shares).includes(adaReal.pk), "9. A3 after a mutual scan, Owen's phone sends her real new phone the keys");
    const adaRealOpen = await adaRealP.open();
    const allOpen = (await entries(adaReal)).body.entries.every((e: any) => { try { return !!openNamesEntry(adaRealP.key(e.keyId), e.id, e.keyId, e.ciphertext).name; } catch { return false; } });
    assert(adaRealOpen.plan.kind === 'ready' && allOpen, "9. A3 and it opens every entry");

    // ── 10. Two admins to confirm, with exactly two admins (F7) ──────────────────────────────────
    for (const gone of [oscar, bea]) require_((await call(null, 'DELETE', `/api/local/admin/node-roles/${gone.pk}/admin`, undefined, PASSWORD())).status === 200, `10. ${gone.name} stops being an admin`);
    require_((await owenP.open()).plan.kind === 'ready' && (await adaRealP.open()).plan.kind === 'ready', '10. Owen and Ada are the only two, and both phones are ready');
    require_((await call(owen, 'POST', '/api/names/settings', { twoAdminsToConfirm: true })).status === 200, '10. Owen asks for two admins to confirm');
    const free = (db.prepare('SELECT e.id FROM names_entries e WHERE NOT EXISTS (SELECT 1 FROM confirmations c WHERE c.entry_id = e.id AND c.revoked_at IS NULL) ORDER BY e.id').all() as { id: string }[]).map((r) => r.id);
    require_(free.length >= 3, `10. three entries with nobody confirmed against them (${free.length})`);
    const owenConfirmsAda = await confirm(owen, adaReal, free[0]);
    assert(owenConfirmsAda.status === 201 && owenConfirmsAda.body?.status === 'confirmed', `10. F7 Owen confirms Ada: confirmed, since no admin but Owen could (${show(owenConfirmsAda)})`);
    const adaConfirmsOwen = await confirm(adaReal, owen, free[1]);
    assert(adaConfirmsOwen.status === 201 && adaConfirmsOwen.body?.status === 'confirmed', `10. F7 and Ada confirms Owen the same way (${show(adaConfirmsOwen)})`);
    const moWaits = await confirm(owen, mo, free[2]);
    assert(moWaits.status === 201 && moWaits.body?.status === 'awaiting_second', `10. F7 a member still waits for a second admin (${show(moWaits)})`);
    const adaSeconds = await call(adaReal, 'POST', `/api/names/confirmations/${moWaits.body.id}/second`, {});
    assert(adaSeconds.status === 200 && adaSeconds.body?.status === 'confirmed', `10. F7 whom Ada gives (${show(adaSeconds)})`);

    // ── 11. The only holder out and back (C6), and a rollback (E1) ───────────────────────────────
    // Ada's phone makes key N and dies before sending it: she is its only holder. Then she is made a moderator and an admin again.
    const st11 = (await state(adaReal)).body;
    const mN = makeNamesGenerationFor(adaRealP.pin!, adaRealP.signer, []);
    adaRealP.pin = mN.pin;
    require_((await adaRealP.postMine(mN.generation, st11, [])).status === 201, "11. Ada's phone makes a new key and its answer lands (after saying, in her own header, which keys she holds), but it sends nothing more");
    await adaRealP.sync();
    require_(adaRealP.head() === mN.generation.id && !!adaRealP.key(), '11. her phone holds it');
    require_((await call(null, 'DELETE', `/api/local/admin/node-roles/${adaReal.pk}/admin`, undefined, PASSWORD())).status === 200
        && (await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: adaReal.pk, role: 'moderator' }, PASSWORD())).status === 200, '11. the owner makes Ada a moderator');
    require_((await state(owen)).status === 200, '11. (the next names-list request marks her)');
    require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: adaReal.pk, role: 'admin' }, PASSWORD())).status === 200, '11. and an admin again');
    const outBack = (await state(adaReal)).body;
    assert(outBack.nobodyHoldsKey === true && outBack.newKeyNeeded === true && JSON.stringify(outBack.droppedHolders) === JSON.stringify([adaReal.pk]),
        `11. C6 nobody holds the key as far as the server knows, and it lists Ada herself as dropped (${JSON.stringify({ nobody: outBack.nobodyHoldsKey, dropped: outBack.droppedHolders })})`);
    const a11 = await adaRealP.open();
    const kN1 = adaRealP.head();
    assert(a11.made?.status === 201 && readNamesGeneration(a11.state.generations.find((g: any) => g.id === kN1), COMMUNITY)?.drops.length === 0 && a11.plan.kind === 'ready',
        `11. C6 her phone makes the next key, dropping nobody (never itself): 201, no drops asked for (${show(a11.made)})`);
    require_((await owenP.open()).plan.kind === 'ready', "11. Owen's phone takes it, with her box");
    // E1: whoever runs the server puts the history back to generation 3 (and drops the newer shares).
    const head11 = owenP.head();
    const headN = readNamesGeneration(owenP.pin!.chain[owenP.pin!.chain.length - 1], COMMUNITY)!.n;
    const k3n = 3;
    db.prepare('DELETE FROM names_generations WHERE n > ?').run(k3n);
    const rolled = await owenP.open();
    assert(rolled.plan.kind === 'refused' && rolled.plan.reason === 'rolled_back' && rolled.plan.offered?.n === 3 && rolled.plan.newest?.n === headN && rolled.made === null && rolled.shares.length === 0,
        `11. E1 Owen's phone, which took key ${headN}, sees the server offer 3: refused, nothing read or written (${JSON.stringify(rolled.plan)})`);
    for (const l of namesReplay(owenP.pin!, rolled.state)) {
        const r = await postGen(owen, l, true);
        require_(r.status === 201 || r.status === 200, `11. E1 "Put the key history back": generation ${l.n} goes back (${show(r)})`);
    }
    const back = await owenP.open();
    require_(back.plan.kind === 'ready' && owenP.head() === head11, `11. E1 the history is back, and Owen's phone is ready (${JSON.stringify(back.plan)})`);
    const after = await addEntry(owenP, { name: 'Written after the rollback', note: '' });
    require_(after.status === 201, `11. E1 a name added under the newest key (${show(after)})`);
    const afterRow = db.prepare('SELECT ciphertext, key_id FROM names_entries WHERE id = ?').get(after.entryId) as { ciphertext: string; key_id: string };
    let abeReads = false;
    try { openNamesEntry(abeKey1, after.entryId, afterRow.key_id, afterRow.ciphertext); abeReads = true; } catch { /* the point */ }
    assert(afterRow.key_id === head11 && !abeReads, "11. E1 it is sealed under that key, which Abe's key 1 doesn't open");

    // ── 12. A claim to oneself (design Addendum 5) ──────────────────────────────────────────────────
    // Ada's phone makes key N2 and sends Owen its box. Owen's phone takes the key without sending anything yet: it holds
    // N2, but on no word of its own, so the node refuses his next statement (ask_for_share). A header Owen addresses to
    // himself is his claim: the node counts it, and his statement lands.
    const st12 = (await state(adaReal)).body;
    const mN2 = makeNamesGenerationFor(adaRealP.pin!, adaRealP.signer, []);
    adaRealP.pin = mN2.pin;
    require_((await adaRealP.postMine(mN2.generation, st12, [])).status === 201, '12. Ada makes key N2');
    await adaRealP.open();
    await owenP.sync();
    require_(owenP.head() === mN2.generation.id && !!owenP.key(), "12. Owen's phone takes N2 from Ada's box, and sends nothing");
    const st12o = (await state(owen)).body;
    assert(!st12o.admins.find((a: any) => a.pubkey === owen.pk).keyIds.includes(mN2.generation.id), '12. on no word of his own, Owen is no holder of N2');
    const mN3 = makeNamesGenerationFor(owenP.pin!, owenP.signer, []);
    const refused12 = await postGen(owen, mN3.generation);
    assert(refused12.status === 409 && refused12.body?.code === 'ask_for_share', `12. his statement is refused: 409 ask_for_share (${show(refused12)})`);
    const selfClaim = namesSelfClaim(owenP.pin!, st12o, owenP.signer, []);
    require_(!!selfClaim && selfClaim.to === owen.pk && selfClaim.from === owen.pk && selfClaim.keyIds.includes(mN2.generation.id), '12. Owen\'s phone signs a header to itself naming the keys it holds');
    const selfPosted = await postShare(owen, selfClaim!);
    assert(selfPosted.status === 200, `12. Addendum 5 the node takes a header addressed to its own sender (${show(selfPosted)})`);
    const st12b = (await state(owen)).body;
    assert(st12b.admins.find((a: any) => a.pubkey === owen.pk).keyIds.includes(mN2.generation.id) && st12b.holdersOfCurrent.includes(owen.pk),
        '12. Addendum 5 and counts it as his claim: Owen holds N2 on his own word');
    const adaSees12 = (await state(adaReal)).body.shares.find((x: any) => x.from === owen.pk && x.to === owen.pk);
    assert(!!adaSees12 && adaSees12.box === undefined, '12. Addendum 5 every admin sees the header; its box goes to nobody but Owen');
    owenP.pin = mN3.pin;
    const landed12 = await postGen(owen, mN3.generation);
    assert(landed12.status === 201, `12. Addendum 5 his statement lands now (${show(landed12)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${passed}/${run} passed`);
    process.exit(1);
});
