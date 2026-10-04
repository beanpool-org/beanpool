/**
 * Community modes slice 3: an invite bound to a names-list entry (design §4.1 ways 1–3, §8 item 3). Through the real
 * HTTPS stack and its signature middleware: only an admin who may confirm someone against the entry makes one; a
 * redeem writes the member and the confirmation (by the invite's maker) in one transaction; one person, one entry:
 * an entry already confirmed refuses a new bound invite, and a second redeem of an older one still makes the member
 * but doesn't confirm, and says why; the column replicates as a plain row.
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
    namesKeyCheckMatches, namesKeyQr, namesKeyCode, buildInviteTicket, parseInviteTicketText,
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
import { TABLES } from './engine/replication-manifest.js';

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
const count = (table: string, where = '1') => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;

const bindInvite = (id: Id, entryId: string) => call(id, 'POST', `/api/names/entries/${entryId}/invite`, {});
const liveConfirmation = (pk: string) => db.prepare('SELECT entry_id, confirmed_by FROM confirmations WHERE member_pubkey = ? AND revoked_at IS NULL').get(pk) as { entry_id: string; confirmed_by: string } | undefined;
const inviteRow = (code: string) => db.prepare('SELECT names_entry_id, names_bind_outcome, used_by FROM invite_codes WHERE code = ?').get(code) as { names_entry_id: string | null; names_bind_outcome: string | null; used_by: string | null } | undefined;

async function main(): Promise<void> {
    COMMUNITY = (await ensureGenesis()).communityId;
    await initTls();
    initStateEngine();
    const { hash, salt } = hashPassword(ADMIN_PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null });
    twoFa = turnOn2faForTests(ADMIN_PW);
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const seed = await call(null, 'POST', '/api/admin/seed-invite', { type: 'standard' }, PASSWORD());
    const owen = newId('Owen');
    require_(seed.status === 200 && (await redeem(owen, seed.body?.code)).status === 200, `Owen joins with the seed invite (${show(seed)})`);
    const [ada, mel] = ['Ada', 'Mel'].map(newId);
    for (const who of [ada, mel]) {
        const made = await generate(owen);
        require_(made.status === 200 && (await redeem(who, made.body?.invite?.code)).status === 200, `${who.name} joins with Owen's invite`);
    }
    for (const [who, role] of [[owen, 'owner'], [ada, 'admin']] as const) {
        require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: who.pk, role }, PASSWORD())).status === 200, `${who.name} is made ${role}`);
    }
    const owenP = new Phone(owen);
    const opened = await owenP.open();
    require_(opened.plan.kind === 'ready', `Owen's phone makes the list's first key (${opened.plan.kind})`);
    const zed = await addEntry(owenP, { name: 'Zebedee Quillfeather', note: '' });
    require_(zed.status === 201, `Owen adds an entry (${show(zed)})`);

    // ── 1. Who makes one ─────────────────────────────────────────────────────────────────────────
    const invitesBefore = count('invite_codes');
    const byMember = await bindInvite(mel, zed.entryId);
    assert(byMember.status === 403 && byMember.body?.code === 'admins_only', `1. a member who is no admin: 403 admins_only (${show(byMember)})`);
    const byKeyless = await bindInvite(ada, zed.entryId);
    assert(byKeyless.status === 403 && byKeyless.body?.code === 'no_key', `1. an admin who can't open the entry (confirmMember's rule): 403 no_key (${show(byKeyless)})`);
    const unsigned = await call(null, 'POST', `/api/names/entries/${zed.entryId}/invite`, {});
    assert(unsigned.status === 401, `1. unsigned: 401 (${show(unsigned)})`);
    const noEntry = await bindInvite(owen, newNamesEntryId());
    assert(noEntry.status === 404 && noEntry.body?.code === 'no_entry', `1. an entry that isn't there: 404 no_entry (${show(noEntry)})`);
    assert(invitesBefore === count('invite_codes'), '1. none of those wrote an invite');
    const made = await bindInvite(owen, zed.entryId);
    require_(made.status === 201 && /^INV-/.test(made.body?.invite?.code) && made.body?.invite?.namesEntryId === zed.entryId, `1. Owen, who holds the key: 201 with a code (${show(made)})`);
    const code = made.body.invite.code as string;
    assert(inviteRow(code)?.names_entry_id === zed.entryId && inviteRow(code)?.names_bind_outcome === null, '1. the invite keeps the entry id, and nothing else of the entry');

    // ── 2. Redeem: the member and the confirmation together ─────────────────────────────────────
    const zedId = newId('Zed');
    const joined = await redeem(zedId, code);
    assert(joined.status === 200 && joined.body?.success === true, `2. Zed joins with it (${show(joined)})`);
    const conf = liveConfirmation(zedId.pk);
    assert(!!conf && conf.entry_id === zed.entryId && conf.confirmed_by === owen.pk, `2. and is confirmed against the entry, by Owen, the invite's maker (${JSON.stringify(conf)})`);
    assert(inviteRow(code)?.names_bind_outcome === 'confirmed' && inviteRow(code)?.used_by === zedId.pk, `2. the invite says so (${JSON.stringify(inviteRow(code))})`);
    const logged = db.prepare("SELECT 1 FROM names_access_log WHERE action = 'confirm' AND actor_pubkey = ? AND subject_pubkey = ?").get(owen.pk, zedId.pk);
    assert(!!logged, '2. the access log has the confirm line, by Owen');
    const listed = await call(owen, 'GET', '/api/names/invites');
    assert(listed.status === 200 && listed.body?.invites?.some((i: any) => i.code === code && i.outcome === 'confirmed' && i.usedBy === zedId.pk), `2. GET /api/names/invites shows it confirmed (${show(listed)})`);
    const listedByMember = await call(mel, 'GET', '/api/names/invites');
    assert(listedByMember.status === 403, `2. not to a member who is no admin (${show(listedByMember)})`);

    // ── 3. One person, one entry ─────────────────────────────────────────────────────────────────
    const again = await bindInvite(owen, zed.entryId);
    assert(again.status === 409 && again.body?.code === 'entry_taken', `3. a new invite for an entry already confirmed: 409 entry_taken (${show(again)})`);
    const ott = await addEntry(owenP, { name: 'Ottoline Brackenbury', note: '' });
    const first = await bindInvite(owen, ott.entryId);
    const second = await bindInvite(owen, ott.entryId);
    require_(first.status === 201 && second.status === 201, '3. two invites for one entry nobody holds yet');
    const ottId = newId('Ott');
    const yanId = newId('Yan');
    require_((await redeem(ottId, first.body.invite.code)).status === 200 && liveConfirmation(ottId.pk)?.entry_id === ott.entryId, '3. the first confirms Ott');
    const late = await redeem(yanId, second.body.invite.code);
    assert(late.status === 200 && late.body?.success === true && late.body?.member?.publicKey === yanId.pk, `3. the second still makes Yan a member: a joiner is never stranded (${show(late)})`);
    assert(!liveConfirmation(yanId.pk) && liveConfirmation(ottId.pk)?.entry_id === ott.entryId, '3. but doesn\'t confirm Yan, and Ott stays confirmed');
    assert(inviteRow(second.body.invite.code)?.names_bind_outcome === 'entry_taken', `3. and the invite says why, for the admins (${JSON.stringify(inviteRow(second.body.invite.code))})`);

    // ── 4. The maker no longer an admin at redeem ─────────────────────────────────────────────────
    const pers = await addEntry(owenP, { name: 'Persephone Wanderlust', note: '' });
    const persInv = await bindInvite(owen, pers.entryId);
    require_(persInv.status === 201, '4. Owen makes one more');
    db.prepare("UPDATE invite_codes SET names_entry_id = ? WHERE code = ?").run(pers.entryId, (await generate(ada)).body.invite.code);
    const adaCode = (db.prepare('SELECT code FROM invite_codes WHERE created_by = ? AND names_entry_id = ?').get(ada.pk, pers.entryId) as { code: string }).code;
    const adaJoiner = newId('Ana');
    assert((await redeem(adaJoiner, adaCode)).status === 200 && !liveConfirmation(adaJoiner.pk) && inviteRow(adaCode)?.names_bind_outcome === 'maker_not_admin',
        `4. a binding whose maker can't open the entry at redeem (planted by whoever runs the server): a member, unconfirmed, maker_not_admin (${JSON.stringify(inviteRow(adaCode))})`);

    // ── 5. All or nothing ────────────────────────────────────────────────────────────────────────
    db.exec("CREATE TEMP TRIGGER fail_confirm BEFORE INSERT ON confirmations BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    const pia = newId('Pia');
    const failed = await redeem(pia, persInv.body.invite.code);
    db.exec('DROP TRIGGER fail_confirm');
    assert(failed.status >= 500, `5. a confirmation that can't be written fails the redeem (${show(failed)})`);
    assert(!db.prepare('SELECT 1 FROM members WHERE public_key = ?').get(pia.pk) && inviteRow(persInv.body.invite.code)?.used_by === null,
        '5. and leaves no member and the invite unused: never a member without its confirmation');
    const retried = await redeem(pia, persInv.body.invite.code);
    assert(retried.status === 200 && liveConfirmation(pia.pk)?.entry_id === pers.entryId, `5. the same redeem again joins and confirms (${show(retried)})`);

    // ── 6. An ordinary invite is untouched ───────────────────────────────────────────────────────
    const plain = await generate(owen);
    const quin = newId('Quin');
    assert((await redeem(quin, plain.body.invite.code)).status === 200 && !liveConfirmation(quin.pk) && inviteRow(plain.body.invite.code)?.names_bind_outcome === null,
        '6. an invite with no entry joins as before, confirms nobody and has no outcome');

    // ── 7a. An offline ticket for a hall with no signal ──────────────────────────────────────────
    const owenSign = async (b: Uint8Array) => new Uint8Array(crypto.sign(null, Buffer.from(b), owen.priv));
    const wan = await addEntry(owenP, { name: 'Lives by the old cannery', note: '' });
    const ticket = await buildInviteTicket(BASE, owen.pk, owenSign, { namesEntryId: wan.entryId });
    const payload = JSON.parse(Buffer.from(ticket, 'base64').toString('utf8')).p as string;
    assert(parseInviteTicketText(payload)?.namesEntryId === wan.entryId && !payload.includes('cannery'), '7a. the ticket carries the entry id, signed, and never the name');
    const redeemTicket = (who: Id, t: string) => call(who, 'POST', '/api/invite/redeem-offline', { ticketB64: t, publicKey: who.pk, callsign: who.name });
    const tess = newId('Tess');
    const byTicket = await redeemTicket(tess, ticket);
    assert(byTicket.status === 200 && liveConfirmation(tess.pk)?.entry_id === wan.entryId && liveConfirmation(tess.pk)?.confirmed_by === owen.pk,
        `7a. redeeming it makes Tess a member confirmed against the entry by Owen (${show(byTicket)})`);
    const ticketRow = db.prepare('SELECT names_entry_id, names_bind_outcome FROM invite_codes WHERE used_by = ?').get(tess.pk) as any;
    assert(ticketRow?.names_entry_id === wan.entryId && ticketRow?.names_bind_outcome === 'confirmed', `7a. the ticket's row keeps the binding and the outcome (${JSON.stringify(ticketRow)})`);
    const tampered = JSON.parse(Buffer.from(ticket, 'base64').toString('utf8'));
    tampered.p = tampered.p.replace(wan.entryId, zed.entryId);
    const ulf = newId('Ulf');
    const forged = await redeemTicket(ulf, Buffer.from(JSON.stringify(tampered)).toString('base64'));
    assert(forged.status >= 400 && !db.prepare('SELECT 1 FROM members WHERE public_key = ?').get(ulf.pk), `7a. the entry id changed after signing: refused, nobody joins (${show(forged)})`);
    const melSign = async (b: Uint8Array) => new Uint8Array(crypto.sign(null, Buffer.from(b), mel.priv));
    const vix = await addEntry(owenP, { name: 'Vix', note: '' });
    const melTicket = await buildInviteTicket(BASE, mel.pk, melSign, { namesEntryId: vix.entryId });
    const vee = newId('Vee');
    const byMelTicket = await redeemTicket(vee, melTicket);
    assert(byMelTicket.status === 200 && !liveConfirmation(vee.pk), `7a. a member's ticket bound to an entry: the joiner is a member, unconfirmed (the maker isn't an admin) (${show(byMelTicket)})`);

    // ── 8. Answering a knock adds the entry and binds it in one step ─────────────────────────────
    const kim = newId('Kim');
    const knocked = await call(kim, 'POST', '/api/join/knock', { callsign: kim.name, message: 'Hello, I live by the river.' });
    require_(knocked.status === 200 || knocked.status === 201, `8. Kim knocks (${show(knocked)})`);
    const open = await call(owen, 'GET', '/api/join/knocks');
    const knockId = open.body?.knocks?.find((k: any) => k.pubkey === kim.pk)?.id as string;
    require_(!!knockId, `8. Owen sees Kim's knock (${show(open)})`);
    const kimEntryId = newNamesEntryId();
    const sealed = { id: kimEntryId, ciphertext: sealNamesEntry(owenP.key(), kimEntryId, owenP.head(), { name: 'Kimberley Riverside', note: '' }), keyId: owenP.head() };
    const entriesBefore = count('names_entries');
    const melAnswers = await call(mel, 'POST', `/api/join/knocks/${knockId}/approve`, { namesEntry: sealed });
    assert(melAnswers.status === 403 && melAnswers.body?.code === 'admins_only', `8. a member who is no admin can't add a name with the answer (${show(melAnswers)})`);
    assert(count('names_entries') === entriesBefore && (db.prepare('SELECT status FROM join_requests WHERE id = ?').get(knockId) as any)?.status === 'pending',
        '8. and nothing commits: no entry, the knock still waiting');
    const owenAnswers = await call(owen, 'POST', `/api/join/knocks/${knockId}/approve`, { namesEntry: sealed });
    assert(owenAnswers.status === 200 && /^INV-/.test(owenAnswers.body?.invite?.code), `8. Owen answers with the sealed entry (${show(owenAnswers)})`);
    const kimCode = owenAnswers.body?.invite?.code as string;
    assert(!!db.prepare('SELECT 1 FROM names_entries WHERE id = ?').get(kimEntryId) && inviteRow(kimCode)?.names_entry_id === kimEntryId,
        '8. the entry is on the list and the knock\'s invite is bound to it');
    const kimJoins = await redeem(kim, kimCode);
    assert(kimJoins.status === 200 && liveConfirmation(kim.pk)?.entry_id === kimEntryId && liveConfirmation(kim.pk)?.confirmed_by === owen.pk,
        `8. Kim joins with it, confirmed by Owen (${show(kimJoins)})`);

    // ── 7. Replication carries the binding ──────────────────────────────────────────────────────
    const cols = JSON.stringify(TABLES.invite_codes);
    assert(cols.includes('names_entry_id') && cols.includes('names_bind_outcome'), `7. the replication manifest carries both columns as plain (${cols.slice(0, 200)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${passed}/${run} passed`);
    process.exit(1);
});
