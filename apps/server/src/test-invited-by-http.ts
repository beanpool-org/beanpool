/**
 * Who invited whom (DESIGN-invites-vouching-review-fable.md §3 ask 2, slice I3; Marty, 10 Nov), over HTTPS through the real
 * middleware:
 *
 *   1. a member an owner invited reads "Invited by" that owner, named, with the role word: kind `member`, role `owner`
 *      (it read kind `admin`, "Invited directly by the system admin", for anyone an owner or admin invited)
 *   2. one an admin invited names the admin, role `admin`; one a plain member invited, role null
 *   3. a seed invite made under the node password reads kind `card` and names nobody
 *   4. a seed invite made under an admin's key hangs off that admin (created_by), so whoever joins with it names them
 *   5. the founder stays `founder`
 *   6. the member's switch (PUT /api/profile/privacy): off, a plain member reads no inviter; the member themself, an owner,
 *      an admin and the inviter still do; on again, everyone does. Only a member sets it; a bad body is a 400
 *   7. "Brought in n people": for an owner, an admin and the member themself; absent for a plain member viewing someone
 *   8. the invite tree honours the switch: never shown under the inviter to a plain member, never their inviter's key
 *   9. where invites are off (NODE_PROFILE=global), nobody reads either line: vouchedInBy null, no broughtIn (STOP rule)
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-invited-by-http.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
process.env.ADMIN_PASSWORD = 'InvitedByWhom123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember } from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { turnOn2faForTests } from './admin-auth-test-harness.js';
import { mintHandshakeToken, consumeHandshakeToken } from './admin-key-auth.js';
import { grantNodeRole } from './engine/node-roles.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { initAdminPassword } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { db } from './db/db.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
const DAY = 86_400_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 240)}`;

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

function makeMember(name: string, invitedBy = 'genesis'): Id {
    const id = keypair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, ?, ?, 'TEST', 'active')`).run(id.pk, name, ago(30 * DAY), invitedBy);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    return id;
}

function resetLimits(): void {
    resetGatewayRateLimit();
    resetAdminRateLimit();
    resetAdminAuthTarpit();
    pruneAuthAttempts(Date.now() + 120_000);
}

async function call(method: string, id: Id | null, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    resetLimits();
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = { ...extra };
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = signRequest(id.priv, { method, path: path.split('?')[0], timestamp: ts, nonce, body: bodyString });
        headers[SIGNED_FOR_HEADER] = signedForHost();
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

/** A key session for a member who holds `role`, as a computer's key sign-in opens one. */
function keySessionHeaders(pk: string, role: 'owner' | 'admin'): Record<string, string> {
    const { handshakeToken } = mintHandshakeToken(pk, role);
    const s = consumeHandshakeToken(handshakeToken);
    if (!s.ok || !s.sessionId) throw new Error(`could not open a test key session: ${s.error}`);
    return { 'X-Admin-Session': s.sessionId };
}

async function main(): Promise<void> {
    console.log('Who invited whom: every member inviter named, with the role word, and the member\'s own switch\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const founder = keypair('Founder');
    seedGenesisMember(founder.pk, founder.name);
    const olive = makeMember('Olive');
    grantNodeRole(olive.pk, 'owner', 'SYSTEM');
    const ada = makeMember('Ada');
    grantNodeRole(ada.pk, 'admin', 'SYSTEM');
    const pat = makeMember('Pat');                 // a plain member who invites
    const vic = makeMember('Vic');                 // the plain member who reads everyone below
    const mia = makeMember('Mia', olive.pk);       // invited by the owner
    const ben = makeMember('Ben', ada.pk);         // invited by the admin
    const quin = makeMember('Quin', pat.pk);       // invited by the plain member

    const profile = (viewer: Id, target: Id) => call('POST', viewer, '/api/trust/profile', { targetPubkey: target.pk });

    // ── 1. invited by an owner ──────────────────────────────────────────────────────────────────
    console.log('── 1. invited by an owner ──');
    const miaSeen = await profile(vic, mia);
    const by = miaSeen.body?.vouchedInBy;
    assert(miaSeen.status === 200 && by?.kind === 'member' && by?.publicKey === olive.pk && by?.callsign === 'Olive' && by?.role === 'owner',
        `1. a member reads Mia "Invited by @Olive · owner": kind member, her key and name, role owner (${show(miaSeen)})`);
    assert(by?.kind !== 'admin', '1b. never kind admin ("Invited directly by the system admin") for an owner\'s invitee');

    // ── 2. invited by an admin, and by a plain member ───────────────────────────────────────────
    console.log('── 2. by an admin, by a plain member ──');
    const benSeen = await profile(vic, ben);
    assert(benSeen.body?.vouchedInBy?.kind === 'member' && benSeen.body?.vouchedInBy?.callsign === 'Ada' && benSeen.body?.vouchedInBy?.role === 'admin',
        `2. Ben reads "Invited by @Ada · admin" (${show(benSeen)})`);
    const quinSeen = await profile(vic, quin);
    assert(quinSeen.body?.vouchedInBy?.kind === 'member' && quinSeen.body?.vouchedInBy?.callsign === 'Pat' && quinSeen.body?.vouchedInBy?.role === null,
        `2b. Quin reads "Invited by @Pat", no role word (${show(quinSeen)})`);

    // ── 3. a seed invite made under the node password: an owner's invite card ───────────────────
    console.log("── 3. an owner's invite card ──");
    const tfa = turnOn2faForTests(process.env.ADMIN_PASSWORD!);
    const card = await call('POST', null, '/api/admin/seed-invite', { type: 'standard' }, tfa.headers());
    assert(card.status === 200 && typeof card.body?.code === 'string', `3. the password makes a seed invite (${show(card)})`);
    const cara = keypair('Cara');
    // Typed in small letters, as a joiner may: the redeem matches it without case, and the card's words must too.
    const caraRedeem = await call('POST', cara, '/api/invite/redeem', { code: String(card.body.code).toLowerCase(), publicKey: cara.pk, callsign: 'Cara' });
    assert(caraRedeem.status === 200 && caraRedeem.body?.success === true, `3a. Cara joins with it (${show(caraRedeem)})`);
    const caraSeen = await profile(vic, cara);
    const caraBy = caraSeen.body?.vouchedInBy;
    assert(caraBy?.kind === 'card' && caraBy?.publicKey === null && caraBy?.callsign === null && caraBy?.role === null,
        `3b. Cara reads kind card, naming nobody: "Invited with an owner's invite card" (${show(caraSeen)})`);

    // ── 4. a seed invite made under an admin's key hangs off the admin ──────────────────────────
    console.log("── 4. a seed invite under an admin's key ──");
    const keyed = await call('POST', null, '/api/admin/seed-invite', { type: 'standard' }, keySessionHeaders(ada.pk, 'admin'));
    assert(keyed.status === 200 && typeof keyed.body?.code === 'string', `4. Ada's key session makes a seed invite (${show(keyed)})`);
    const row = db.prepare('SELECT created_by, issued_by FROM invite_codes WHERE code = ?').get(keyed.body.code) as { created_by: string; issued_by: string };
    assert(row?.created_by === ada.pk && row?.issued_by === ada.pk, `4a. it hangs off Ada: created_by and issued_by her key (${JSON.stringify(row)})`);
    const dan = keypair('Dan');
    const danRedeem = await call('POST', dan, '/api/invite/redeem', { code: keyed.body.code, publicKey: dan.pk, callsign: 'Dan' });
    assert(danRedeem.status === 200 && danRedeem.body?.success === true, `4b. Dan joins with it (${show(danRedeem)})`);
    const danSeen = await profile(vic, dan);
    assert(danSeen.body?.vouchedInBy?.kind === 'member' && danSeen.body?.vouchedInBy?.publicKey === ada.pk && danSeen.body?.vouchedInBy?.role === 'admin',
        `4c. Dan reads "Invited by @Ada · admin" (${show(danSeen)})`);
    // The password's card still hangs off the genesis member, as before: no person is known.
    const cardRow = db.prepare('SELECT created_by, issued_by FROM invite_codes WHERE code = ?').get(card.body.code) as { created_by: string; issued_by: string };
    assert(cardRow?.created_by === founder.pk && cardRow?.issued_by === 'owner:password', `4d. the password's card hangs off the founder (${JSON.stringify(cardRow)})`);

    // ── 5. the founder ──────────────────────────────────────────────────────────────────────────
    console.log('── 5. the founder ──');
    const founderId: Id = { ...founder };
    const founderSeen = await profile(vic, founderId);
    assert(founderSeen.body?.vouchedInBy?.kind === 'founder' && founderSeen.body?.vouchedInBy?.publicKey === null,
        `5. the founder stays kind founder (${show(founderSeen)})`);

    // ── 6. the member's switch ──────────────────────────────────────────────────────────────────
    console.log("── 6. the member's switch ──");
    const read0 = await call('GET', mia, '/api/profile/privacy');
    assert(read0.status === 200 && read0.body?.inviterShown === true, `6. on by default (${show(read0)})`);
    const off = await call('PUT', mia, '/api/profile/privacy', { inviterShown: false });
    assert(off.status === 200 && off.body?.inviterShown === false, `6a. Mia switches it off (${show(off)})`);
    const stored = (db.prepare('SELECT inviter_shown FROM members WHERE public_key = ?').get(mia.pk) as { inviter_shown: number }).inviter_shown;
    assert(stored === 0, `6b. stored 0 on her row (${stored})`);
    const vicNow = await profile(vic, mia);
    assert(vicNow.status === 200 && vicNow.body?.vouchedInBy === null && !JSON.stringify(vicNow.body).includes(olive.pk) && !JSON.stringify(vicNow.body).includes('Olive'),
        `6c. a plain member reads no inviter on Mia's profile, nor Olive's key or name anywhere in it (${show(vicNow)})`);
    const oliveNow = await profile(olive, mia);
    assert(oliveNow.body?.vouchedInBy?.publicKey === olive.pk, `6d. the inviter (an owner too) still reads it (${show(oliveNow)})`);
    const adaNow = await profile(ada, mia);
    assert(adaNow.body?.vouchedInBy?.publicKey === olive.pk, `6e. an admin still reads it (${show(adaNow)})`);
    const miaOwn = await profile(mia, mia);
    assert(miaOwn.body?.vouchedInBy?.publicKey === olive.pk && miaOwn.body?.inviterShown === false,
        `6f. Mia reads it on her own profile, and her switch (${show(miaOwn)})`);
    // A plain inviter still reads it on the member they invited.
    await call('PUT', quin, '/api/profile/privacy', { inviterShown: false });
    const patNow = await profile(pat, quin);
    const vicQuin = await profile(vic, quin);
    assert(patNow.body?.vouchedInBy?.publicKey === pat.pk && vicQuin.body?.vouchedInBy === null,
        `6g. Quin hid it: Pat, who invited him, still reads it; Vic doesn't (${show(patNow)} | ${show(vicQuin)})`);
    assert(vicNow.body?.inviterShown === undefined && patNow.body?.inviterShown === undefined, '6h. nobody but the member reads their switch');
    const on = await call('PUT', mia, '/api/profile/privacy', { inviterShown: true });
    const vicAgain = await profile(vic, mia);
    assert(on.status === 200 && vicAgain.body?.vouchedInBy?.publicKey === olive.pk, `6i. on again, a plain member reads it again (${show(vicAgain)})`);
    const bad = await call('PUT', mia, '/api/profile/privacy', { inviterShown: 'no' });
    assert(bad.status === 400, `6j. a body that isn't true or false is a 400 (${show(bad)})`);
    const unsigned = await call('PUT', null, '/api/profile/privacy', { inviterShown: false });
    const stranger = keypair('Stranger');
    const strangers = await call('PUT', stranger, '/api/profile/privacy', { inviterShown: false });
    const strangerRead = await call('GET', stranger, '/api/profile/privacy');
    assert(unsigned.status === 401 && strangers.status === 403 && strangerRead.status === 403,
        `6k. unsigned 401, a key with no account here 403 to write and to read (${unsigned.status}, ${strangers.status}, ${strangerRead.status})`);

    // ── 7. Brought in n people ──────────────────────────────────────────────────────────────────
    console.log('── 7. Brought in n people ──');
    const oliveByVic = await profile(vic, olive);
    assert(oliveByVic.status === 200 && oliveByVic.body?.broughtIn === undefined && !('broughtIn' in (oliveByVic.body ?? {})),
        `7. a plain member viewing someone else reads no Brought in (${show(oliveByVic)})`);
    const oliveOwn = await profile(olive, olive);
    assert(oliveOwn.body?.broughtIn === 1, `7a. Olive reads her own: 1 (Mia) (${oliveOwn.body?.broughtIn})`);
    const adaOfAda = await profile(ada, ada);
    const oliveOfAda = await profile(olive, ada);
    assert(adaOfAda.body?.broughtIn === 2 && oliveOfAda.body?.broughtIn === 2, `7b. Ada brought in 2 (Ben, Dan): she and an owner read 2 (${adaOfAda.body?.broughtIn}, ${oliveOfAda.body?.broughtIn})`);
    const patOwn = await profile(pat, pat);
    const patByAda = await profile(ada, pat);
    assert(patOwn.body?.broughtIn === 1 && patByAda.body?.broughtIn === 1, `7c. a plain member reads their own (1), an admin reads it too (${patOwn.body?.broughtIn}, ${patByAda.body?.broughtIn})`);

    // ── 8. the invite tree honours the switch ───────────────────────────────────────────────────
    console.log('── 8. the invite tree ──');
    const flat = (nodes: any[]): any[] => nodes.flatMap((n) => [n, ...flat(n.children ?? [])]);
    const patBranchByVic = await call('GET', vic, `/api/invite/tree?root=${pat.pk}`);
    const patBranchByPat = await call('GET', pat, `/api/invite/tree?root=${pat.pk}`);
    assert(patBranchByVic.status === 200 && !flat(patBranchByVic.body).some((n) => n.publicKey === quin.pk),
        `8. Vic reads Pat's branch without Quin, who hid it (${show(patBranchByVic)})`);
    assert(flat(patBranchByPat.body).some((n) => n.publicKey === quin.pk), '8a. Pat reads his own branch with Quin');
    const whole = await call('GET', vic, '/api/invite/tree');
    const quinNode = flat(whole.body ?? []).find((n) => n.publicKey === quin.pk);
    const underPat = flat(whole.body ?? []).find((n) => n.publicKey === pat.pk)?.children?.some((c: any) => c.publicKey === quin.pk);
    assert(whole.status === 200 && !!quinNode && quinNode.invitedBy === '' && !underPat && !JSON.stringify(quinNode).includes(pat.pk),
        `8b. in the whole tree Vic reads Quin as a root of his own, his inviter's key nowhere on him (${JSON.stringify(quinNode)})`);
    const quinRooted = await call('GET', vic, `/api/invite/tree?root=${quin.pk}`);
    assert(quinRooted.body?.[0]?.invitedBy === '', `8c. Quin's own branch read by Vic carries no inviter key (${show(quinRooted)})`);
    const wholeByAda = await call('GET', ada, '/api/invite/tree');
    assert(flat(wholeByAda.body ?? []).find((n) => n.publicKey === pat.pk)?.children?.some((c: any) => c.publicKey === quin.pk),
        '8d. an admin reads Quin under Pat');

    // ── 9. where invites are off (the global node): neither line, for anyone ────────────────────
    // The I3 STOP rule (state-engine.ts getMemberTrustProfile `invitesOn`): a member there came through the open door, and
    // a row from before the switch names nobody to anyone. Same rows, same readers as above; only the profile changes.
    console.log('── 9. invites off (global) ──');
    const before = await profile(olive, mia);
    assert(before.body?.vouchedInBy?.publicKey === olive.pk && (await profile(olive, olive)).body?.broughtIn === 1,
        `9. on a local node, the same rows: Olive reads Mia's inviter and her own Brought in (${show(before)})`);
    process.env.NODE_PROFILE = 'global';
    try {
        const readers: [string, Id, Id][] = [
            ['a plain member reading an owner\'s invitee', vic, mia],
            ['the inviter (an owner) reading her invitee', olive, mia],
            ['an admin reading the admin\'s invitee', ada, ben],
            ['the member on their own profile', mia, mia],
            ['an owner on her own profile', olive, olive],
            ['an admin reading an admin', olive, ada],
            ['a plain member on his own profile', pat, pat],
        ];
        for (const [who, viewer, target] of readers) {
            const r = await profile(viewer, target);
            assert(r.status === 200 && r.body?.vouchedInBy === null && !('broughtIn' in (r.body ?? {})),
                `9a. global, ${who}: vouchedInBy null, no broughtIn (${show(r)})`);
        }
    } finally {
        delete process.env.NODE_PROFILE;
    }

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
