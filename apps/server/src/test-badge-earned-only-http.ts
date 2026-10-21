/**
 * The level badge counts what a member did, never the admins' confirmation (Marty, board, 21 Oct: "Badge counts what they
 * did only"), over HTTPS through the real middleware. A confirmed member's known grant raises their credit LIMIT only; the
 * confirmation stays private, so nothing another member reads (the trust profile, a post card, an inviter's badge) moves
 * with it. With the dial on and the default known floor (1,000):
 *
 *   1. a confirmed member with no trades: their own answer reads Newcomer and tierCredit 0, while their floor, usable
 *      floor and known grant are what they were before this change (-1,000, -1,000 with one live offer, 1,000)
 *   2. another member's view of them: the trust profile, their post card and the inviter's badge on someone they invited
 *      read Newcomer, exactly as an unconfirmed member with no trades reads: nothing gives the confirmation away
 *   3. a confirmed and an unconfirmed member with the same completed trades wear the same badge, from what they earned;
 *      only the confirmed one's limit is higher
 *   4. an enterprise: a keeper's known pledge (carved from their confirmation) deepens its line but never its badge; a
 *      keeper's ordinary pledge still counts towards it
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-badge-earned-only-http.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
process.env.ADMIN_PASSWORD = 'BadgeEarnedOnly123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { earnedCreditFromValue, tierForCredit } from '@beanpool/core';
import { initStateEngine, seedGenesisMember, createPost, getMemberTrustProfile, getEnterpriseUnderlyingFloor, pledgeEnterpriseBacking } from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { ownerSessionHeaders } from './admin-auth-test-harness.js';
import { grantNodeRole } from './engine/node-roles.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { initAdminPassword } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { db } from './db/db.js';
import { setMemberPhoto, clearEnterpriseFloorCache, confirmationDialOn, CONFIRMATION_DIAL_KEY } from '@beanpool/engine';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
const DAY = 86_400_000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`;

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

function makeMember(name: string, invitedBy = 'genesis'): Id {
    const id = keypair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, ?, ?, 'TEST', 'active')`).run(id.pk, name, ago(30 * DAY), invitedBy);
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    return id;
}

function makeEnterprise(name: string, keepers: Id[]): string {
    const pk = keypair(name).pk;
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_treasury)
                VALUES (?, ?, ?, 'genesis', 'TEST', 'active', 1)`).run(pk, name, ago(DAY));
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
    setMemberPhoto(db, pk, AVATAR);
    for (const k of keepers) {
        db.prepare('INSERT INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)').run(pk, k.pk);
        db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(k.pk);
    }
    clearEnterpriseFloorCache(db);
    return pk;
}

function confirm(member: Id, by: Id): void {
    db.prepare(`INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, 0)`)
        .run(crypto.randomBytes(16).toString('hex'), member.pk, crypto.randomBytes(16).toString('hex'), by.pk);
}

/** A completed marketplace (escrow) trade, the only thing that earns trust: `seller` sold `buyer` goods worth `credits`. */
function soldTo(seller: Id, buyer: Id, credits: number): void {
    const postId = crypto.randomUUID();
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status) VALUES (?, 'offer', 'produce', 'Sold', 'Sold', ?, ?, 'completed')`)
        .run(postId, credits, seller.pk);
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status) VALUES (?, ?, ?, ?, ?, 'completed')`)
        .run(crypto.randomUUID(), postId, buyer.pk, seller.pk, credits);
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
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

async function main(): Promise<void> {
    console.log('The level badge counts what a member did, never the confirmation\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const founder = keypair('Founder');
    seedGenesisMember(founder.pk, founder.name);
    const owner = ownerSessionHeaders();
    const ada = makeMember('Ada');
    grantNodeRole(ada.pk, 'admin', 'SYSTEM');
    const vic = makeMember('Vic');          // the other member who reads everyone below
    // The dial is on by default (Marty, 21 Oct): no row, and the owner's "on" writes none, so every check below runs on
    // the default, never on a stored 'on'.
    const dialRow = () => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(CONFIRMATION_DIAL_KEY) as { value: string } | undefined)?.value ?? null;
    assert(confirmationDialOn(db) && dialRow() === null, `before the owner touches it, the dial reads on with no row (${dialRow()})`);
    const on = await call('POST', null, '/api/local/admin/known-floor', { confirmation: true }, owner);
    assert(on.status === 200 && on.body?.confirmation === true && on.body?.knownFloor === 1000,
        `the owner turns the dial on, the known floor at its default 1,000 (${show(on)})`);
    assert(dialRow() === null, `and turning it on writes no row: the default (${dialRow()})`);

    const balanceOf = (who: Id) => call('GET', who, `/api/ledger/balance/${who.pk}`);
    const profileOf = (target: string) => call('POST', vic, '/api/trust/profile', { targetPubkey: target });
    const cardOf = async (postId: string) => {
        const board = await call('GET', vic, '/api/marketplace/posts');
        return (Array.isArray(board.body) ? board.body : board.body?.posts ?? []).find((p: any) => p.id === postId);
    };
    const offer = (who: Id) => createPost('offer', 'produce', `${who.name} mends bikes`, 'Bike repairs', 40, 'fixed', who.pk)!.id;

    // ── 1. a confirmed member with no trades: their own answer ───────────────────────────────────
    console.log('── 1. a confirmed member, no trades: their own answer ──');
    const cleo = makeMember('Cleo');
    const cleoOffer = offer(cleo);
    confirm(cleo, ada);
    const nia = makeMember('Nia');           // unconfirmed, no trades: what Cleo must look like to everyone else
    const niaOffer = offer(nia);
    const cleoOwn = await balanceOf(cleo);
    // The limit is unchanged: these are the numbers the code gave before the badge stopped counting the known grant.
    assert(cleoOwn.status === 200 && cleoOwn.body?.floor === -1000 && cleoOwn.body?.usableFloor === -1000 && cleoOwn.body?.knownGrant === 1000
        && cleoOwn.body?.activated === true,
        `Cleo's limit is the known floor's: floor -1,000, usable -1,000 on one live offer, known grant 1,000 (${show(cleoOwn)})`);
    // Marty, 21 Oct: the badge counts what she did. She has done nothing yet, so she is a Newcomer with 0 trust behind it.
    assert(cleoOwn.body?.tier?.name === 'Newcomer' && cleoOwn.body?.tierCredit === 0,
        `her badge is Newcomer with tierCredit 0, not the Steward 1,000 of confirmation gave (${cleoOwn.body?.tier?.name}, ${cleoOwn.body?.tierCredit})`);
    const cleoProfile = getMemberTrustProfile(cleo.pk);
    assert(cleoProfile.tier.name === 'Newcomer' && cleoProfile.tierCredit === 0 && cleoProfile.floor === -1000 && cleoProfile.knownGrant === 1000
        && cleoProfile.otherAllowance === 0 && cleoProfile.earnedCredit === 0 && cleoProfile.knownFrozen === false && cleoProfile.creditFrozen === false,
        `the engine profile agrees: Newcomer, tierCredit 0, floor -1,000, known grant 1,000 (${JSON.stringify({ ...cleoProfile, stats: undefined })})`);

    // ── 2. another member's view of her ─────────────────────────────────────────────────────────
    console.log("── 2. another member's view ──");
    const cleoSeen = await profileOf(cleo.pk);
    const niaSeen = await profileOf(nia.pk);
    assert(cleoSeen.status === 200 && cleoSeen.body?.tier?.name === 'Newcomer' && cleoSeen.body?.earnedCredit === 0,
        `Vic reads Cleo's trust profile: Newcomer, 0 Trust Points (${show(cleoSeen)})`);
    assert(niaSeen.status === 200 && JSON.stringify(cleoSeen.body?.tier) === JSON.stringify(niaSeen.body?.tier)
        && cleoSeen.body?.earnedCredit === niaSeen.body?.earnedCredit && JSON.stringify(cleoSeen.body?.risk) === JSON.stringify(niaSeen.body?.risk),
        `and exactly what he reads for Nia, unconfirmed: the same tier, Trust Points and risk (${JSON.stringify(cleoSeen.body?.risk)}; ${JSON.stringify(niaSeen.body?.risk)})`);
    const numbersIn = (v: unknown): number[] => typeof v === 'number' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(numbersIn) : [];
    assert(!numbersIn(cleoSeen.body).includes(1000) && !/known|confirm/i.test(Object.keys(cleoSeen.body ?? {}).join(',')),
        `nothing in her profile is the 1,000 or names a confirmation (${numbersIn(cleoSeen.body).join(', ')})`);
    const cleoCard = await cardOf(cleoOffer);
    const niaCard = await cardOf(niaOffer);
    assert(cleoCard?.authorEnergyCycled === 0 && tierForCredit(cleoCard.authorEnergyCycled).name === 'Newcomer',
        `her post card's badge is Newcomer's, 0, not Steward's 600 (${cleoCard?.authorEnergyCycled})`);
    assert(niaCard?.authorEnergyCycled === cleoCard?.authorEnergyCycled && niaCard?.authorFoundingNeeded === cleoCard?.authorFoundingNeeded,
        `the same as Nia's card (${niaCard?.authorEnergyCycled}, founding ${niaCard?.authorFoundingNeeded} / ${cleoCard?.authorFoundingNeeded})`);
    // Someone Cleo invited shows her badge as the one who brought them in.
    const ivy = makeMember('Ivy', cleo.pk);
    const ivySeen = await profileOf(ivy.pk);
    assert(ivySeen.status === 200 && ivySeen.body?.vouchedInBy?.publicKey === cleo.pk && ivySeen.body?.vouchedInBy?.tier === 'Newcomer',
        `the profile of someone she invited names her as a Newcomer (${JSON.stringify(ivySeen.body?.vouchedInBy)})`);
    // The admins' own list reads the same badge: one source.
    const adminData = await call('POST', null, '/api/local/admin/data', undefined, owner);
    const cleoRow = (adminData.body?.members ?? []).find((m: any) => m.publicKey === cleo.pk);
    assert(adminData.status === 200 && cleoRow?.tier === 'Newcomer', `the admin member list reads her as a Newcomer too (${cleoRow?.tier})`);

    // ── 3. the same trades, confirmed or not: the same badge ───────────────────────────────────
    console.log('── 3. the same trades, the same badge ──');
    const tess = makeMember('Tess');         // confirmed
    const uma = makeMember('Uma');           // not
    offer(tess);
    offer(uma);
    confirm(tess, ada);
    for (const [seller, n] of [[tess, 'T'], [uma, 'U']] as const) {
        soldTo(seller, makeMember(`${n} buyer 1`), 500);
        soldTo(seller, makeMember(`${n} buyer 2`), 500);
    }
    const earned = earnedCreditFromValue(1000);
    const tessOwn = await balanceOf(tess);
    const umaOwn = await balanceOf(uma);
    assert(earned === 320 && tessOwn.body?.earnedCredit === earned && umaOwn.body?.earnedCredit === earned,
        `each sold 500 to two buyers and earned ${earned} (Tess ${tessOwn.body?.earnedCredit}, Uma ${umaOwn.body?.earnedCredit})`);
    assert(tessOwn.body?.tier?.name === 'Resident' && tessOwn.body?.tierCredit === earned && umaOwn.body?.tier?.name === 'Resident' && umaOwn.body?.tierCredit === earned,
        `both are Residents on ${earned} trust, not Tess a Steward on 1,320 (Tess ${tessOwn.body?.tier?.name} ${tessOwn.body?.tierCredit}, Uma ${umaOwn.body?.tier?.name} ${umaOwn.body?.tierCredit})`);
    // The limits are what they were: Tess's holds her known floor on top of what she earned.
    assert(tessOwn.body?.floor === -1320 && tessOwn.body?.usableFloor === -1200 && tessOwn.body?.knownGrant === 1000
        && umaOwn.body?.floor === -320 && umaOwn.body?.usableFloor === -200 && umaOwn.body?.knownGrant === 0,
        `only the limits differ: Tess -1,320 (usable -1,200), Uma -320 (usable -200) (${tessOwn.body?.floor}/${tessOwn.body?.usableFloor}, ${umaOwn.body?.floor}/${umaOwn.body?.usableFloor})`);
    const tessSeen = await profileOf(tess.pk);
    const umaSeen = await profileOf(uma.pk);
    assert(tessSeen.body?.tier?.name === 'Resident' && JSON.stringify(tessSeen.body?.tier) === JSON.stringify(umaSeen.body?.tier)
        && tessSeen.body?.earnedCredit === umaSeen.body?.earnedCredit,
        `Vic reads them alike: ${tessSeen.body?.tier?.name} / ${umaSeen.body?.tier?.name}, ${tessSeen.body?.earnedCredit} / ${umaSeen.body?.earnedCredit} Trust Points`);
    // Neither freeze moves her badge either: the known line was never in it.
    const kf = await call('POST', null, '/api/local/admin/known-floor/exception', { memberPubkey: tess.pk, frozen: true }, owner);
    const tessFrozen = await balanceOf(tess);
    assert(kf.status === 200 && tessFrozen.body?.knownFrozen === true && tessFrozen.body?.floor === -earned
        && tessFrozen.body?.tier?.name === 'Resident' && tessFrozen.body?.tierCredit === earned,
        `her known floor frozen: floor -${earned}, still a Resident on ${earned} (${show(tessFrozen)})`);
    const raised = await call('POST', null, '/api/local/admin/known-floor/exception', { memberPubkey: tess.pk, amount: 1600 }, owner);
    const tessRaised = await balanceOf(tess);
    assert(raised.status === 200 && tessRaised.body?.floor === -1920 && tessRaised.body?.tier?.name === 'Resident' && tessRaised.body?.tierCredit === earned,
        `raised to 1,600: floor -1,920, still a Resident on ${earned}, not an Elder (${tessRaised.body?.floor}, ${tessRaised.body?.tier?.name})`);

    // ── 4. an enterprise: a keeper's known pledge deepens its line, never its badge ─────────────
    console.log('── 4. enterprises ──');
    const kai = makeMember('Kai');           // confirmed keeper with no trades: whatever he pledges comes from his known floor
    confirm(kai, ada);
    const pat = makeMember('Pat');           // unconfirmed keeper, nothing to pledge
    const knownCo = makeEnterprise('Known Co', [kai]);
    const plainCo = makeEnterprise('Plain Co', [pat]);
    pledgeEnterpriseBacking(knownCo, kai.pk, 500);
    const knownPledge = db.prepare("SELECT id FROM enterprise_pledges WHERE enterprise = ? AND released_at IS NULL").all(knownCo) as { id: string }[];
    assert(knownPledge.length === 1 && knownPledge[0].id.startsWith('known:'), `Kai's 500 is a known pledge (${JSON.stringify(knownPledge)})`);
    const knownCoTrust = getMemberTrustProfile(knownCo);
    const plainCoTrust = getMemberTrustProfile(plainCo);
    assert(getEnterpriseUnderlyingFloor(knownCo).floor === -500 && knownCoTrust.floor === -500,
        `Known Co's line is what it was: -500 from Kai's known pledge (${getEnterpriseUnderlyingFloor(knownCo).floor}, ${knownCoTrust.floor})`);
    assert(knownCoTrust.tier.name === 'Newcomer' && knownCoTrust.tierCredit === 0
        && knownCoTrust.tier.name === plainCoTrust.tier.name && knownCoTrust.tierCredit === plainCoTrust.tierCredit,
        `its badge is Newcomer, 0, like Plain Co's, not the Resident 500 would give (${knownCoTrust.tier.name} ${knownCoTrust.tierCredit}; ${plainCoTrust.tier.name} ${plainCoTrust.tierCredit})`);
    // An ordinary pledge (from a keeper's earned credit) still counts towards an enterprise's badge; the known one beside it does not.
    const dee = makeMember('Dee');
    db.prepare('INSERT INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)').run(knownCo, dee.pk);
    db.prepare('INSERT INTO enterprise_pledges (id, keeper, enterprise, amount, pledged_at) VALUES (?, ?, ?, ?, ?)').run(crypto.randomUUID(), dee.pk, knownCo, 300, ago(DAY));
    clearEnterpriseFloorCache(db);
    const mixed = getMemberTrustProfile(knownCo);
    assert(mixed.floor === -800 && mixed.tier.name === 'Resident' && mixed.tierCredit === 300,
        `with Dee's ordinary 300 beside it: line -800, badge Resident on 300, not Steward on 800 (${mixed.floor}, ${mixed.tier.name}, ${mixed.tierCredit})`);
    const coCard = createPost('offer', 'produce', 'Known Co sells jam', 'Jam', 10, 'fixed', knownCo);
    if (coCard) {
        const seen = await cardOf(coCard.id);
        assert(seen?.authorEnergyCycled === 200, `its card carries Resident's 200, not Steward's 600 (${seen?.authorEnergyCycled})`);
    }
    // With the dial off there is no known pledge to leave out: the badge is the line, as before.
    const off = await call('POST', null, '/api/local/admin/known-floor', { confirmation: false }, owner);
    const offCo = getMemberTrustProfile(knownCo);
    assert(off.status === 200 && offCo.floor === -300 && offCo.tierCredit === 300 && offCo.tier.name === 'Resident',
        `the dial off: Known Co's line and badge are both Dee's 300 (${offCo.floor}, ${offCo.tierCredit}, ${offCo.tier.name})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
