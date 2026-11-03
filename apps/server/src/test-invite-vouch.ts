/**
 * A quick vouch on an invite (Marty, 3 Nov): someone who can vouch picks 25, 50 or 100 when they make an invite, and the
 * person is vouched for the moment they join. Through the real HTTPS stack and its signature middleware.
 *
 *  1. Who may: an owner, an admin and an appointed voucher, never by tier; anyone else is refused in words, no code made.
 *  2. What a level is: 1, 2 or 3 and nothing else. None (left out, or null) is an invite as it always was.
 *  3. The redeem: the row a hand vouch leaves, "Vouched by" shows, and it is withdrawn the same way.
 *  4. The right again at the redeem: lost it, and the person joins with no vouch. Paused or left: the invite admits nobody,
 *     as a plain one, and vouches nobody; once a pause ends the code joins and vouches.
 *  5. One code, one vouch: the race, a refused redeem, a member re-entering, an expired code.
 *  6. The Offer covenant: a vouched newcomer with no live Offer has no spending room.
 *  7. What the person holding the code can read: nothing of the vouch before joining.
 *  8. Codes and links only: an offline ticket and a seed invite carry none.
 *  9. A standby applies no vouch, and the column travels with a copy.
 * 10. Beans off: the node says no choice, the route refuses a level, and an older code vouches nobody.
 *
 * An invite bound to a names-list entry that carries a vouch is in test-invite-bound-name.ts (section 7b), beside the rest
 * of the names list it stands on.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-invite-vouch.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { buildInviteTicket } from '@beanpool/core';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import { initStateEngine, exportSyncState, adminSetVoucher, adminSetTier, setUserStatusRow, getBalance, canVouch } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { hashPassword, updateLocalConfig } from './config/local-config.js';
import { setNodeRole } from './config/node-role.js';
import { NODE_PROFILE_KEY, getProfileSwitches } from './config/node-profile.js';
import { turnOn2faForTests } from './admin-auth-test-harness.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { TABLES } from './engine/replication-manifest.js';

let BASE = '';
const ADMIN_PW = 'Invite-Vouch-Admin-Pw-71!';
let twoFa: ReturnType<typeof turnOn2faForTests>;
const PASSWORD = () => twoFa.headers();

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`setup failed: ${msg}`);
}

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

interface Res { status: number; body: any; text: string }
async function call(id: Id | null, method: 'GET' | 'POST', urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
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

const generate = (id: Id, vouchLevel?: unknown) => call(id, 'POST', '/api/invite/generate', vouchLevel === undefined ? { publicKey: id.pk } : { publicKey: id.pk, vouchLevel });
const redeem = (id: Id, code: string) => call(id, 'POST', '/api/invite/redeem', { code, publicKey: id.pk, callsign: id.name });
const codes = () => (db.prepare('SELECT COUNT(*) AS n FROM invite_codes').get() as { n: number }).n;
const inviteRow = (code: string) => db.prepare('SELECT vouch_level, used_by FROM invite_codes WHERE code = ?').get(code) as { vouch_level: number | null; used_by: string | null } | undefined;
const memberRow = (pk: string) => db.prepare('SELECT elder_vouched_by, vouch_credit, status FROM members WHERE public_key = ?').get(pk) as { elder_vouched_by: string | null; vouch_credit: number; status: string } | undefined;
const setOverride = (name: string, value: string) =>
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`${NODE_PROFILE_KEY}.${name}`, value);

async function main(): Promise<void> {
    await ensureGenesis();
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
    const [ada, vic, mel, eld] = ['Ada', 'Vic', 'Mel', 'Eld'].map(newId);
    for (const who of [ada, vic, mel, eld]) {
        const made = await generate(owen);
        require_(made.status === 200 && (await redeem(who, made.body?.invite?.code)).status === 200, `${who.name} joins with Owen's invite`);
    }
    for (const [who, role] of [[owen, 'owner'], [ada, 'admin']] as const) {
        require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: who.pk, role }, PASSWORD())).status === 200, `${who.name} is made ${role}`);
    }
    adminSetVoucher(vic.pk, true);
    adminSetTier(eld.pk, 'Elder');
    const joinWith = async (code: string, name: string): Promise<{ who: Id; res: Res }> => {
        const who = newId(name);
        return { who, res: await redeem(who, code) };
    };

    // ── 1. Who may ───────────────────────────────────────────────────────────────────────────────
    console.log('── 1. who may ──');
    for (const [who, label, level] of [[owen, 'an owner', 1], [ada, 'an admin', 2], [vic, 'an appointed voucher', 3]] as const) {
        const made = await generate(who, level);
        assert(made.status === 200 && inviteRow(made.body?.invite?.code)?.vouch_level === level, `1. ${label} makes an invite carrying level ${level} (${show(made)})`);
    }
    const before = codes();
    const fromMember = await generate(mel, 2);
    assert(fromMember.status === 403 && fromMember.body?.code === 'not_a_voucher' && /vouch/i.test(fromMember.body?.error), `1. a plain member's level: 403, in words (${show(fromMember)})`);
    const fromElder = await generate(eld, 2);
    assert(canVouch(eld.pk) === false && fromElder.status === 403 && fromElder.body?.code === 'not_a_voucher', `1. never by tier: an Elder badge with no appointment is refused too (${show(fromElder)})`);
    const stranger = newId('Stranger');
    const fromStranger = await generate(stranger, 1);
    assert(fromStranger.status === 403, `1. a key with no membership: refused (${show(fromStranger)})`);
    const spoofed = await call(mel, 'POST', '/api/invite/generate', { publicKey: owen.pk, vouchLevel: 3 });
    assert(spoofed.status >= 400 && spoofed.status < 500, `1. a member naming a voucher's key: refused by the spoof check (${show(spoofed)})`);
    const unsigned = await call(null, 'POST', '/api/invite/generate', { publicKey: owen.pk, vouchLevel: 3 });
    assert(unsigned.status === 401, `1. unsigned: 401 (${show(unsigned)})`);
    assert(codes() === before, '1. and none of those made a code');

    // ── 2. What a level is ───────────────────────────────────────────────────────────────────────
    console.log('── 2. what a level is ──');
    for (const bad of [4, 0, -1, -2, 1.5, 1e21, Number.MAX_SAFE_INTEGER, '1', '2', 'deep', '', true, false, [2], { level: 2 }]) {
        const refused = await generate(owen, bad);
        assert(refused.status === 400 && refused.body?.code === 'bad_vouch_level' && /Beans/.test(refused.body?.error), `2. ${JSON.stringify(bad)} is no level: 400, in words (${show(refused)})`);
    }
    assert(codes() === before, '2. and no code was made');
    const plainInvite = await generate(owen);
    const nullInvite = await generate(owen, null);
    assert(plainInvite.status === 200 && inviteRow(plainInvite.body?.invite?.code)?.vouch_level === null, '2. no level: the column stays NULL');
    assert(nullInvite.status === 200 && inviteRow(nullInvite.body?.invite?.code)?.vouch_level === null, '2. null means none too');
    const melInvite = await generate(mel);
    assert(melInvite.status === 200, `2. a plain member still makes a plain invite (${show(melInvite)})`);
    const plainJoin = await joinWith(plainInvite.body.invite.code, 'Plain');
    assert(plainJoin.res.status === 200 && memberRow(plainJoin.who.pk)?.elder_vouched_by === null && memberRow(plainJoin.who.pk)?.vouch_credit === 0,
        `2. an invite with none joins someone with no vouch (${show(plainJoin.res)})`);
    const vouchedShape = await generate(ada, 1);
    assert(JSON.stringify(Object.keys(vouchedShape.body.invite).sort()) === JSON.stringify(Object.keys(nullInvite.body.invite).sort()),
        `2. the invite that comes back is the same shape either way (${Object.keys(vouchedShape.body.invite).join(',')})`);

    // ── 3. The redeem ────────────────────────────────────────────────────────────────────────────
    console.log('── 3. the redeem ──');
    const twin = newId('Twin');
    const twinCode = await generate(owen);
    require_((await redeem(twin, twinCode.body.invite.code)).status === 200, 'Twin joins, to take a hand vouch');
    const hand = await call(vic, 'POST', '/api/profile/vouch', { targetPubkey: twin.pk, level: 2 });
    require_(hand.status === 200, `Vic vouches for Twin by hand (${show(hand)})`);
    const byVic = await generate(vic, 2);
    const nell = await joinWith(byVic.body.invite.code, 'Nell');
    const handRow = memberRow(twin.pk);
    assert(nell.res.status === 200 && memberRow(nell.who.pk)?.elder_vouched_by === vic.pk && memberRow(nell.who.pk)?.vouch_credit === 50, `3. Nell joins vouched by Vic at 50 (${show(nell.res)})`);
    assert(JSON.stringify(memberRow(nell.who.pk)) === JSON.stringify(handRow), `3. the row is the one a hand vouch leaves (${JSON.stringify(handRow)})`);
    assert(getBalance(nell.who.pk).floor === -50, `3. her floor is -50 (${getBalance(nell.who.pk).floor})`);
    const seen = await call(owen, 'GET', `/api/profile/${nell.who.pk}`);
    assert(seen.status === 200 && seen.body?.elderVouchedBy === vic.pk, `3. "Vouched by" shows on her profile (${show(seen)})`);
    const other = await generate(vic, 1);
    const nora = await joinWith(other.body.invite.code, 'Nora');
    const eldTries = await call(eld, 'POST', '/api/profile/unvouch', { targetPubkey: nora.who.pk });
    assert(eldTries.status === 400 && memberRow(nora.who.pk)?.elder_vouched_by === vic.pk, `3. a member who didn't vouch can't withdraw it (${show(eldTries)})`);
    const withdrawn = await call(vic, 'POST', '/api/profile/unvouch', { targetPubkey: nora.who.pk });
    assert(withdrawn.status === 200 && memberRow(nora.who.pk)?.elder_vouched_by === null && memberRow(nora.who.pk)?.vouch_credit === 0 && getBalance(nora.who.pk).floor === 0,
        `3. Vic withdraws it the same way: floor back to 0 (${show(withdrawn)})`);
    const byAdmin = await call(ada, 'POST', '/api/profile/unvouch', { targetPubkey: nell.who.pk });
    assert(byAdmin.status === 200 && memberRow(nell.who.pk)?.elder_vouched_by === null, `3. an admin may withdraw any, as by hand (${show(byAdmin)})`);
    for (const [level, credit] of [[1, 25], [3, 100]] as const) {
        const made = await generate(owen, level);
        const joined = await joinWith(made.body.invite.code, `L${level}`);
        assert(joined.res.status === 200 && memberRow(joined.who.pk)?.vouch_credit === credit && memberRow(joined.who.pk)?.elder_vouched_by === owen.pk, `3. level ${level} hands out ${credit}`);
    }

    // ── 4. The right again at the redeem ─────────────────────────────────────────────────────────
    console.log('── 4. the right again at the redeem ──');
    const lost = await generate(vic, 3);
    adminSetVoucher(vic.pk, false);
    const olive = await joinWith(lost.body.invite.code, 'Olive');
    assert(olive.res.status === 200 && memberRow(olive.who.pk)?.status === 'active' && inviteRow(lost.body.invite.code)?.used_by === olive.who.pk, `4. Vic lost the right: Olive still joins (${show(olive.res)})`);
    assert(memberRow(olive.who.pk)?.elder_vouched_by === null && memberRow(olive.who.pk)?.vouch_credit === 0, '4. with no vouch');
    adminSetVoucher(vic.pk, true);

    const pausedCode = await generate(vic, 2);
    const plainFromPaused = await generate(vic);
    require_((await call(null, 'POST', `/api/local/admin/users/${vic.pk}/suspend`, { reason: 'A pause for the suite' }, PASSWORD())).status === 200, 'Vic is paused');
    const pia = newId('Pia');
    const whilePaused = await redeem(pia, pausedCode.body.invite.code);
    const plainWhilePaused = await redeem(pia, plainFromPaused.body.invite.code);
    assert(whilePaused.status === 400 && whilePaused.body?.error === plainWhilePaused.body?.error && !memberRow(pia.pk) && inviteRow(pausedCode.body.invite.code)?.used_by === null,
        `4. paused: the invite admits nobody, as a plain invite of theirs, and vouches nobody (${show(whilePaused)})`);
    require_((await call(null, 'POST', `/api/local/admin/users/${vic.pk}/status`, { status: 'active' }, PASSWORD())).status === 200, 'the pause ends');
    const afterPause = await redeem(pia, pausedCode.body.invite.code);
    assert(afterPause.status === 200 && memberRow(pia.pk)?.vouch_credit === 50 && memberRow(pia.pk)?.elder_vouched_by === vic.pk, `4. the pause over, with the right still held, the code joins and vouches (${show(afterPause)})`);

    const lea = newId('Lea');
    const leaveCode = await generate(vic, 1);
    const plainLeave = await generate(vic);
    setUserStatusRow(vic.pk, 'pruned');
    const afterLeft = await redeem(lea, leaveCode.body.invite.code);
    const plainAfterLeft = await redeem(lea, plainLeave.body.invite.code);
    assert(afterLeft.status === 400 && afterLeft.body?.error === plainAfterLeft.body?.error && !memberRow(lea.pk) && inviteRow(leaveCode.body.invite.code)?.used_by === null,
        `4. left: the invite admits nobody, as a plain invite of theirs, and vouches nobody (${show(afterLeft)})`);

    // ── 5. One code, one vouch ───────────────────────────────────────────────────────────────────
    console.log('── 5. one code, one vouch ──');
    const raceCode = await generate(owen, 3);
    const [r1, r2] = [newId('Rae'), newId('Rob')];
    const [a1, a2] = await Promise.all([redeem(r1, raceCode.body.invite.code), redeem(r2, raceCode.body.invite.code)]);
    const winner = a1.status === 200 ? r1 : r2;
    const loser = a1.status === 200 ? r2 : r1;
    const lostRace = a1.status === 200 ? a2 : a1;
    assert([a1.status, a2.status].sort().join() === '200,400', `5. two redeems at once: one joins, one is refused (${a1.status}, ${a2.status})`);
    assert(lostRace.body?.code === 'invite_used' && !memberRow(loser.pk), `5. the other is told it is used, and is nobody (${show(lostRace)})`);
    assert(memberRow(winner.pk)?.vouch_credit === 100 && (db.prepare('SELECT COUNT(*) AS n FROM members WHERE elder_vouched_by = ? AND vouch_credit = 100').get(owen.pk) as { n: number }).n === 2, '5. one vouch from it (level 3 above, and this one)');
    const again = await redeem(loser, raceCode.body.invite.code);
    assert(again.status === 400 && !memberRow(loser.pk), `5. a later try: refused too (${show(again)})`);

    const reentry = await generate(owen, 3);
    const melBack = await redeem(mel, reentry.body.invite.code);
    assert(melBack.status === 200 && melBack.body?.alreadyMember === true && memberRow(mel.pk)?.elder_vouched_by === null && inviteRow(reentry.body.invite.code)?.used_by === null,
        `5. a member re-entering with a vouched code is vouched for nothing, and the code stays unused (${show(melBack)})`);

    const stale = await generate(owen, 3);
    db.prepare('UPDATE invite_codes SET created_at = ? WHERE code = ?').run(new Date(Date.now() - 31 * 86_400_000).toISOString(), stale.body.invite.code);
    const late = newId('Late');
    const tooLate = await redeem(late, stale.body.invite.code);
    assert(tooLate.status === 400 && !memberRow(late.pk), `5. an expired code joins nobody and vouches nobody (${show(tooLate)})`);

    // ── 6. The Offer covenant ────────────────────────────────────────────────────────────────────
    console.log('── 6. the Offer covenant ──');
    const covenant = await generate(owen, 3);
    const cal = await joinWith(covenant.body.invite.code, 'Cal');
    const calBalance = getBalance(cal.who.pk);
    assert(calBalance.floor === -100 && calBalance.usableFloor === 0, `6. vouched, no live Offer: floor -100, usable 0 (${calBalance.floor}, ${calBalance.usableFloor})`);
    const spend = await call(cal.who, 'POST', '/api/ledger/transfer', { from: cal.who.pk, to: owen.pk, amount: calBalance.balance + 1, memo: 'over' });
    assert(spend.status >= 400 && getBalance(cal.who.pk).balance === calBalance.balance, `6. and a send past nothing is refused (${show(spend)})`);

    // ── 7. What the person holding the code can read ─────────────────────────────────────────────
    console.log('── 7. what the holder reads ──');
    const quiet = await generate(owen, 3);
    const quietPlain = await generate(owen);
    const check = await call(null, 'GET', `/api/invite/check?code=${quiet.body.invite.code}`);
    const checkPlain = await call(null, 'GET', `/api/invite/check?code=${quietPlain.body.invite.code}`);
    assert(check.status === 200 && check.body?.valid === true && check.text === checkPlain.text && !/vouch|\b100\b/i.test(check.text), `7. /api/invite/check reads the same as for a plain invite (${check.text})`);
    const mine = await call(owen, 'GET', `/api/invite/mine/${owen.pk}`);
    const listed = mine.body?.invites?.find((i: any) => i.code === quiet.body.invite.code);
    assert(listed && !/vouch/i.test(JSON.stringify(mine.body)), `7. the maker's own list is as it was (${JSON.stringify(listed)})`);
    const tree = await call(owen, 'GET', '/api/invite/tree');
    assert(tree.status === 200 && !/vouch_level|vouchLevel/.test(tree.text), '7. nor does the tree carry it');
    const trampoline = await fetch(`${BASE}/?invite=${quiet.body.invite.code}`);
    assert(!/vouch/i.test(await trampoline.text()), '7. nor does the invite link\'s page');

    // ── 8. Codes and links only ──────────────────────────────────────────────────────────────────
    console.log('── 8. codes and links only ──');
    const owenSign = async (b: Uint8Array) => new Uint8Array(crypto.sign(null, Buffer.from(b), owen.priv));
    const ticket = await buildInviteTicket(BASE, owen.pk, owenSign, {});
    const tia = newId('Tia');
    const byTicket = await call(tia, 'POST', '/api/invite/redeem-offline', { ticketB64: ticket, publicKey: tia.pk, callsign: tia.name, vouchLevel: 3 });
    assert(byTicket.status === 200 && memberRow(tia.pk)?.elder_vouched_by === null && memberRow(tia.pk)?.vouch_credit === 0, `8. an offline ticket joins with no vouch, whatever the body says (${show(byTicket)})`);
    const ticketRow = db.prepare('SELECT vouch_level FROM invite_codes WHERE used_by = ?').get(tia.pk) as { vouch_level: number | null };
    assert(ticketRow?.vouch_level === null, '8. and its row holds none');
    const seeded = await call(null, 'POST', '/api/admin/seed-invite', { type: 'trusted', vouchLevel: 3 }, PASSWORD());
    assert(seeded.status === 200 && inviteRow(seeded.body?.code)?.vouch_level === null, `8. a seed invite takes no level, and its tier is untouched (${show(seeded)})`);

    // ── 9. A standby, and the copy ───────────────────────────────────────────────────────────────
    console.log('── 9. a standby, and the copy ──');
    assert(JSON.stringify(TABLES.invite_codes).includes('vouch_level'), '9. the replication manifest carries the column');
    const copied = (await exportSyncState('test-invite-vouch') as any).plainTables?.invite_codes as any[] | undefined;
    assert(copied?.some((r) => r.code === quiet.body.invite.code && r.vouch_level === 3), '9. a copy holds an unused invite\'s level');
    setNodeRole('backup');
    const sam = newId('Sam');
    const onStandby = await redeem(sam, quiet.body.invite.code);
    const makeOnStandby = await generate(owen, 2);
    setNodeRole('primary');
    assert(onStandby.status >= 400 && !memberRow(sam.pk) && inviteRow(quiet.body.invite.code)?.used_by === null, `9. a standby takes no redeem: nobody joins, nobody is vouched (${show(onStandby)})`);
    assert(makeOnStandby.status >= 400, `9. nor makes a code (${show(makeOnStandby)})`);

    // ── 10. Beans off ────────────────────────────────────────────────────────────────────────────
    console.log('── 10. Beans off ──');
    const info = await call(null, 'GET', '/api/community/info');
    assert(info.body?.features?.inviteVouch === true, `10. with Beans on the node says it takes one (${JSON.stringify(info.body?.features?.inviteVouch)})`);
    const madeBefore = await generate(owen, 2);
    db.prepare('DELETE FROM transactions').run();
    setOverride('beans', 'false');
    if (getProfileSwitches().beans === false) {
        const offInfo = await call(null, 'GET', '/api/community/info');
        assert(offInfo.body?.features?.beans === false && offInfo.body?.features?.inviteVouch === false, '10. Beans off: the node says no choice');
        const count = codes();
        const refused = await generate(owen, 2);
        assert(refused.status === 403 && refused.body?.code === 'profile_no_beans' && codes() === count, `10. the route refuses the level, in words, and makes no code (${show(refused)})`);
        const stillPlain = await generate(owen);
        assert(stillPlain.status === 200, `10. a plain invite still works (${show(stillPlain)})`);
        const fay = await joinWith(madeBefore.body.invite.code, 'Fay');
        assert(fay.res.status === 200 && memberRow(fay.who.pk)?.elder_vouched_by === null, `10. a code made while they were on joins with no vouch (${show(fay.res)})`);
    } else {
        assert(false, '10. the suite could not switch Beans off: its ledger has moved');
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    console.log(`\n${passed}/${run} passed`);
    process.exit(1);
});
