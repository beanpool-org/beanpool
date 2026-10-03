/**
 * The names list's locked copy on the node (scratch/global-node/DESIGN-names-locked-copy-opus.md §4, tests §8 items 9–15):
 * each admin's phone keeps one copy of its own names-list record here, sealed to its own member key and signed by it
 * (@beanpool/core makeNamesCopy). The node keeps it as text it can't open, for the signer alone.
 *
 * Over REAL HTTPS through the real signature middleware, on a local community: Owen (owner), Ada, Abe, Bea, Nia, Kit, Rex
 * and Dee (admins), Mo (a moderator), Mel (a member). Every copy is a real one, made by core's makeNamesCopy.
 *
 *   9. PUT then GET as the same admin gives back the bytes; GET as another admin is 404 `no_copy`.
 *  10. PUT refusals: owner ≠ signer 403 `not_yours`; another community 400 `other_community`; a bad signature 400; over
 *      1 MiB 413 `copy_too_big`; equal seq with another header 409 `stale_copy` (with the stored seq); identical 200
 *      `exists`; a member, a moderator, the global node, a standby refused as the other names routes are.
 *  11. `myCopy` in /api/names/state is the requester's own row only.
 *  12. A GET writes one `copy_restored` log line; a PUT writes none.
 *  13. The row goes with the member (removed, account deleted, key replaced) and stays on demotion.
 *  14. Replication: the whole copy a standby pulls carries the row.
 *  15. The 31st PUT within the hour is 429 `too_many_copies`.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-names-copy.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { emptyNamesPin, makeNamesCopy, namesPinForNextCopy, NAMES_COPY_MAX_BYTES, type NamesCopy, type NamesPin } from '@beanpool/core';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import { initStateEngine, exportSyncState } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { hashPassword, updateLocalConfig } from './config/local-config.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { setNodeRole } from './config/node-role.js';
import { issueRekeyCode, completeRekey } from './engine/member-wizards.js';

let BASE = '';
let COMMUNITY = '';
const ADMIN_PW = 'Names-Copy-Admin-Pw-62!';
const PASSWORD = { 'X-Admin-Password': ADMIN_PW };
const ADDRESS = 'https://copytown.example.org';

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
const state = (id: Id) => call(id, 'GET', '/api/names/state');
const getCopy = (id: Id) => call(id, 'GET', '/api/names/copy');
const wire = (c: NamesCopy) => ({ header: c.header, signature: c.signature, box: c.box });
const putCopy = (id: Id, c: NamesCopy | Record<string, unknown>) => call(id, 'PUT', '/api/names/copy', 'header' in c && 'box' in c && 'owner' in c ? wire(c as NamesCopy) : c);

/** A phone's pin, moved on to the next copy each time: what the app does before an upload. */
class Phone {
    pin: NamesPin;
    constructor(public id: Id, communityId = COMMUNITY) { this.pin = emptyNamesPin(communityId, id.pk); }
    get signer() { return { publicKey: this.id.pk, privateKey: this.id.seedHex }; }
    next(savedAt?: string): NamesCopy {
        this.pin = namesPinForNextCopy(this.pin);
        return makeNamesCopy({ pin: this.pin, address: ADDRESS, me: this.signer, savedAt });
    }
}

const copyRow = (pk: string) => db.prepare('SELECT * FROM names_copies WHERE owner_pubkey = ?').get(pk) as Record<string, any> | undefined;
const logCount = (action: string, actor?: string) =>
    (db.prepare(`SELECT COUNT(*) AS c FROM names_access_log WHERE action = ?${actor ? ' AND actor_pubkey = ?' : ''}`).get(...(actor ? [action, actor] : [action])) as { c: number }).c;
const allLog = () => (db.prepare('SELECT COUNT(*) AS c FROM names_access_log').get() as { c: number }).c;

async function main(): Promise<void> {
    COMMUNITY = (await ensureGenesis()).communityId;
    await initTls();
    initStateEngine();
    const { hash, salt } = hashPassword(ADMIN_PW);
    updateLocalConfig({ adminHash: hash, salt, totpEnabled: false, totpSecret: null });
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const seed = await call(null, 'POST', '/api/admin/seed-invite', { type: 'standard' }, PASSWORD);
    const owen = newId('Owen');
    require_(seed.status === 200 && (await redeem(owen, seed.body?.code)).status === 200, `Owen joins with the seed invite (${show(seed)})`);
    const others = ['Ada', 'Abe', 'Bea', 'Nia', 'Kit', 'Rex', 'Dee', 'Mo', 'Mel'].map(newId);
    const [ada, abe, bea, nia, kit, rex, dee, mo, mel] = others;
    for (const who of others) {
        const made = await generate(owen);
        require_(made.status === 200 && (await redeem(who, made.body?.invite?.code)).status === 200, `${who.name} joins with Owen's invite`);
    }
    for (const [who, role] of [[owen, 'owner'], [ada, 'admin'], [abe, 'admin'], [bea, 'admin'], [nia, 'admin'], [kit, 'admin'], [rex, 'admin'], [dee, 'admin'], [mo, 'moderator']] as const) {
        const granted = await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: who.pk, role }, PASSWORD);
        require_(granted.status === 200, `${who.name} is made ${role} (${show(granted)})`);
    }
    const [owenP, adaP, abeP, beaP, niaP, kitP, rexP, deeP] = [owen, ada, abe, bea, nia, kit, rex, dee].map((i) => new Phone(i));

    // ── 9. PUT then GET ──────────────────────────────────────────────────────────────────────────
    const none = await getCopy(ada);
    assert(none.status === 404 && none.body?.code === 'no_copy', `9. before any copy: 404 no_copy (${show(none)})`);
    const st0 = await state(ada);
    assert(st0.status === 200 && st0.body?.myCopy === null, `11. myCopy is null before any copy (${show(st0)})`);
    const logBeforePut = allLog();
    const a1 = adaP.next('2026-10-03T10:00:00Z');
    const put1 = await putCopy(ada, a1);
    assert(put1.status === 200 && put1.body?.seq === 1 && put1.body?.code === undefined, `9. Ada saves her first copy: 200 { seq: 1 } (${show(put1)})`);
    assert(allLog() === logBeforePut, `12. a save writes no log line (${allLog() - logBeforePut} written)`);
    const restoredBefore = logCount('copy_restored', ada.pk);
    const got = await getCopy(ada);
    assert(got.status === 200 && got.body?.header === a1.header && got.body?.signature === a1.signature && JSON.stringify(got.body?.box) === JSON.stringify(a1.box),
        `9. Ada fetches it: the same header, signature and box, byte for byte (${show(got)})`);
    assert(logCount('copy_restored', ada.pk) === restoredBefore + 1 && logCount('copy_restored') === restoredBefore + 1, '12. a fetch writes one copy_restored line, Ada as its actor');
    const abeGets = await getCopy(abe);
    assert(abeGets.status === 404 && abeGets.body?.code === 'no_copy', `9. Abe asks: 404 no_copy, never Ada's (${show(abeGets)})`);
    assert(logCount('copy_restored') === restoredBefore + 1, '12. a fetch that finds nothing writes no line');
    const owenGetsQ = await call(owen, 'GET', `/api/names/copy?owner=${ada.pk}`);
    assert(owenGetsQ.status === 404 && owenGetsQ.body?.code === 'no_copy', `9. no query names an owner: Owen with ?owner=Ada is 404 no_copy (${show(owenGetsQ)})`);

    // ── 11. myCopy ───────────────────────────────────────────────────────────────────────────────
    const stA = (await state(ada)).body;
    assert(stA?.myCopy && stA.myCopy.seq === 1 && stA.myCopy.headN === 0 && stA.myCopy.headId === null && stA.myCopy.savedAt === '2026-10-03T10:00:00Z'
        && stA.myCopy.digest === a1.boxDigest && Object.keys(stA.myCopy).sort().join(',') === 'digest,headId,headN,savedAt,seq',
        `11. Ada's state: myCopy { seq, headN, headId, savedAt, digest } of her own row (${JSON.stringify(stA?.myCopy)})`);
    const stB = (await state(abe)).body;
    assert(stB && stB.myCopy === null, `11. Abe's state: myCopy null, never Ada's (${JSON.stringify(stB?.myCopy)})`);
    const b1 = abeP.next();
    require_((await putCopy(abe, b1)).status === 200, '11. Abe saves his');
    const [stA2, stB2] = [(await state(ada)).body, (await state(abe)).body];
    assert(stA2.myCopy.digest === a1.boxDigest && stB2.myCopy.digest === b1.boxDigest && stB2.myCopy.seq === 1, '11. each admin sees their own row only');
    assert(!JSON.stringify(stA2).includes(b1.box.sealedCopy) && !JSON.stringify(stA2).includes(b1.signature), "11. Ada's state carries nothing of Abe's copy");

    // ── 10. PUT refusals ─────────────────────────────────────────────────────────────────────────
    const notYours = await putCopy(abe, adaP.next());
    assert(notYours.status === 403 && notYours.body?.code === 'not_yours', `10. Abe uploads a copy Ada signed: 403 not_yours (${show(notYours)})`);
    const elsewhere = new Phone(bea, 'ffffffffffffffff').next();
    const otherCommunity = await putCopy(bea, elsewhere);
    assert(otherCommunity.status === 400 && otherCommunity.body?.code === 'other_community', `10. a copy for another community: 400 other_community (${show(otherCommunity)})`);
    const forged = beaP.next();
    const badSig = await putCopy(bea, { ...wire(forged), signature: '00'.repeat(64) });
    assert(badSig.status === 400 && badSig.body?.code === 'bad_copy', `10. a bad signature: 400 bad_copy (${show(badSig)})`);
    const otherSigner = await putCopy(bea, { ...wire(forged), signature: makeNamesCopy({ pin: namesPinForNextCopy(emptyNamesPin(COMMUNITY, abe.pk)), address: ADDRESS, me: abeP.signer }).signature });
    assert(otherSigner.status === 400 && otherSigner.body?.code === 'bad_copy', `10. a header signed by another key: 400 bad_copy (${show(otherSigner)})`);
    const badBox = await putCopy(bea, { ...wire(forged), box: { ...forged.box, copyTag: forged.box.copyTag.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) } });
    assert(badBox.status === 400 && badBox.body?.code === 'bad_copy', `10. a box its header doesn't name: 400 bad_copy (${show(badBox)})`);
    const notJson = await putCopy(bea, { header: 'x', signature: 'x', box: 'x' });
    assert(notJson.status === 400 && notJson.body?.code === 'bad_copy', `10. not a copy: 400 bad_copy (${show(notJson)})`);
    const huge = await putCopy(bea, { ...wire(forged), box: { ...forged.box, sealedCopy: Buffer.alloc(NAMES_COPY_MAX_BYTES + 1, 7).toString('base64') } });
    assert(huge.status === 413 && huge.body?.code === 'copy_too_big', `10. over 1 MiB of ciphertext: 413 copy_too_big (${show(huge)})`);
    assert(!copyRow(bea.pk), '10. nothing stored for Bea by any refusal');
    const exists = await putCopy(ada, a1);
    assert(exists.status === 200 && exists.body?.seq === 1 && exists.body?.code === 'exists', `10. the identical copy again: 200 exists (${show(exists)})`);
    const sameSeq = makeNamesCopy({ pin: namesPinForNextCopy(emptyNamesPin(COMMUNITY, ada.pk)), address: ADDRESS, me: adaP.signer, savedAt: '2026-10-03T11:00:00Z' });
    const stale = await putCopy(ada, sameSeq);
    assert(stale.status === 409 && stale.body?.code === 'stale_copy' && stale.body?.seq === 1, `10. the same seq with another header: 409 stale_copy, stored seq 1 (${show(stale)})`);
    const a3 = adaP.next('2026-10-03T12:00:00Z');
    const put3 = await putCopy(ada, a3);
    assert(put3.status === 200 && put3.body?.seq === a3.seq && copyRow(ada.pk)?.header === a3.header, `10. a higher seq replaces it (${show(put3)})`);
    const older = await putCopy(ada, a1);
    assert(older.status === 409 && older.body?.code === 'stale_copy' && older.body?.seq === a3.seq, `10. an older copy replayed: 409 stale_copy with the stored seq (${show(older)})`);
    const nearCap = await putCopy(bea, beaP.next());
    assert(nearCap.status === 200, `10. Bea's own copy lands (${show(nearCap)})`);
    for (const who of [mel, mo]) {
        const rs = [await getCopy(who), await putCopy(who, new Phone(who).next())];
        assert(rs.every((r) => r.status === 403 && r.body?.code === 'admins_only'), `10. ${who.name}: 403 admins_only on both routes (${rs.map(show).join(' | ')})`);
        assert(!copyRow(who.pk), `10. nothing stored for ${who.name}`);
    }
    const unsigned = [await call(null, 'GET', '/api/names/copy'), await call(null, 'PUT', '/api/names/copy', wire(a3))];
    assert(unsigned.every((r) => r.status === 401), `10. unsigned: 401 (${unsigned.map((r) => r.status).join(' ')})`);
    process.env.NODE_PROFILE = 'global';
    const onGlobal = [await getCopy(ada), await putCopy(ada, adaP.next())];
    delete process.env.NODE_PROFILE;
    assert(onGlobal.every((r) => r.status === 404 && r.body?.code === 'feature_off'), `10. the global node: 404 feature_off (${onGlobal.map(show).join(' | ')})`);
    setNodeRole('backup');
    const onStandby = [await getCopy(ada), await putCopy(ada, adaP.next())];
    setNodeRole('primary');
    assert(onStandby.every((r) => r.status === 409 && r.body?.code === 'standby'), `10. a standby: 409 standby (${onStandby.map(show).join(' | ')})`);
    assert(copyRow(ada.pk)?.header === a3.header, "10. no refused route touched Ada's row");

    // ── 14. Replication ──────────────────────────────────────────────────────────────────────────
    const sync = JSON.stringify(await exportSyncState('test-names-copy'));
    assert(sync.includes(a3.header.split('\n').join('\\n')) && sync.includes(a3.box.sealedCopy) && sync.includes(b1.signature),
        '14. the whole copy a standby pulls carries every admin\'s row, as stored');

    // ── 13. Lifecycle ────────────────────────────────────────────────────────────────────────────
    for (const [who, p] of [[nia, niaP], [kit, kitP], [rex, rexP], [dee, deeP]] as const) require_((await putCopy(who, p.next())).status === 200, `13. ${who.name} saves a copy`);
    const demoted = await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: dee.pk, role: 'moderator' }, PASSWORD);
    require_(demoted.status === 200, `13. Dee is made a moderator (${show(demoted)})`);
    await state(owen);
    assert(!!copyRow(dee.pk), '13. demoted: Dee\'s row is kept');
    const pruned = await call(null, 'POST', `/api/local/admin/users/${nia.pk}/prune`, {}, PASSWORD);
    require_(pruned.status === 200, `13. Nia is removed (${show(pruned)})`);
    assert(!copyRow(nia.pk), '13. removed: Nia\'s row is gone');
    const purged = await call(kit, 'POST', '/api/member/purge', { action: 'purge_account' });
    require_(purged.status === 200, `13. Kit deletes his account (${show(purged)})`);
    assert(!copyRow(kit.pk), '13. account deleted: Kit\'s row is gone');
    const rexNew = newId('Rex2');
    completeRekey(rex.pk, rexNew.pk, issueRekeyCode(rex.pk, owen.pk).code, owen.pk);
    assert(!copyRow(rex.pk) && !copyRow(rexNew.pk), "13. key replaced: Rex's old row is gone, and nothing moved to the new key");
    const tomb = (db.prepare("SELECT COUNT(*) AS c FROM tombstones WHERE table_name = 'names_copies'").get() as { c: number }).c;
    assert(tomb === 3, `13. each delete leaves a tombstone, so a standby deletes it too (${tomb})`);

    // ── 15. Rate limit ───────────────────────────────────────────────────────────────────────────
    let last: Res | null = null;
    let okCount = 0;
    for (let i = 0; i < 30; i++) {
        last = await putCopy(owen, owenP.next());
        if (last.status === 200) okCount++;
        else break;
    }
    assert(okCount === 30 && last?.status === 200, `15. 30 PUTs in the hour are taken (${okCount}, last ${show(last)})`);
    const thirtyFirst = await putCopy(owen, owenP.next());
    assert(thirtyFirst.status === 429 && thirtyFirst.body?.code === 'too_many_copies', `15. the 31st: 429 too_many_copies (${show(thirtyFirst)})`);
    const otherAdmin = await putCopy(bea, beaP.next());
    assert(otherAdmin.status === 200, `15. the cap is per owner: Bea still saves (${show(otherAdmin)})`);
    const fetchStill = await getCopy(owen);
    assert(fetchStill.status === 200, `15. GET has no extra cap (${show(fetchStill)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${passed}/${run} passed`);
    process.exit(1);
});
