/**
 * An enterprise's key is never a member's Trust Profile (scratch/tools/DESIGN-shops-round3-enterprise-shopfront-fable.md
 * §1.1 and §0 row 11, slice E0).
 *
 * Every door in both apps that opens a profile by key (a post's author, a deal's other side, the map's preview…) opened
 * the member Trust Profile for an enterprise too: the profile shape said nothing about what the key was, and a voucher
 * could vouch for an enterprise, which its page then showed as trust ("Vouched by Damo"). The apps now replace that
 * screen with the enterprise page when the profile they load says `isTreasury`.
 *
 * Boots the real server (port 0, read auth as a fresh download has it) and proves:
 *   1. An enterprise's profile says so: getProfile, GET /api/profile/:key and the trust profile the phone reads
 *      (POST /api/trust/profile) each carry `isTreasury: true`; a project's too.
 *   2. A member's profile is unchanged: no `isTreasury` key on either read, every field as it was.
 *   3. vouchMember refuses an enterprise key in a sentence, and writes nothing (no voucher, no vouch credit, no
 *      profile_updated_at); POST /api/profile/vouch answers 400 with that sentence. A member is still vouched for.
 *   4. A vouch given to an enterprise before this change is left as it is (inert for credit): the row keeps it, and the
 *      voucher may still withdraw it.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-enterprise-not-a-member-profile.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
// Module consts read at import, so they are removed before the dynamic imports below: read auth ON, as a fresh download.
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_LEDGER_AUTH;

import crypto from 'node:crypto';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };

function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}

function signedHeaders(method: string, path: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

async function get(path: string, id: Id): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, { headers: signedHeaders('GET', path, '', id) });
    const text = await res.text();
    let body: any;
    try { body = JSON.parse(text); } catch { /* empty */ }
    return { status: res.status, body };
}

async function post(path: string, payload: unknown, id: Id): Promise<{ status: number; body: any }> {
    const body = JSON.stringify(payload);
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...signedHeaders('POST', path, body, id) },
        body,
    });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { /* empty */ }
    return { status: res.status, body: json };
}

const REFUSAL = 'An enterprise is kept, not vouched for.';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

async function main() {
    console.log('An enterprise is never a member\'s Trust Profile, and is never vouched for...\n');
    const { initTls } = await import('./services/tls.js');
    const {
        initStateEngine, createTreasury, getProfile, getTrustProfileForViewer, vouchMember, unvouchMember, adminSetVoucher,
        getMemberTrustProfile,
    } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { initAdminPassword } = await import('./config/local-config.js');
    const { db } = await import('./db/db.js');
    const { setMemberPhoto } = await import('@beanpool/engine');

    initAdminPassword();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const member = (callsign: string): Id => {
        const id = keypair();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, bio)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', ?, ?)`)
            .run(id.pubKeyHex, callsign, `INV-${callsign.toUpperCase()}`, `${callsign}'s bio`);
        setMemberPhoto(db, id.pubKeyHex, AVATAR);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        return id;
    };

    const damo = member('Damo');        // an appointed voucher, and the enterprise's keeper
    const rosa = member('Rosa');        // a plain member, vouched for by Damo
    const kofi = member('Kofi');        // a plain member who reads the profiles
    adminSetVoucher(damo.pubKeyHex, true);
    const { publicKey: enterprise } = createTreasury("Damo's Enterprise", AVATAR, 0, { purpose: 'We fix bikes', leadKeeperPubkey: damo.pubKeyHex });
    const { publicKey: project } = createTreasury('Village Hall Roof', AVATAR, 0, { purpose: 'A new roof', lifecycle: 'bounded', goalAmount: 500 });

    // ── 1. An enterprise's profile says so ──
    console.log('── 1. an enterprise\'s profile says so ──');
    const entProfile = getProfile(enterprise, kofi.pubKeyHex);
    assert(entProfile?.isTreasury === true, `getProfile(enterprise).isTreasury is true (got ${JSON.stringify(entProfile?.isTreasury)})`);
    assert(getProfile(project, kofi.pubKeyHex)?.isTreasury === true, "a project's profile says isTreasury too");
    const entHttp = await get(`/api/profile/${enterprise}`, kofi);
    assert(entHttp.status === 200 && entHttp.body?.isTreasury === true, `GET /api/profile/<enterprise> → 200 with isTreasury: true (got ${entHttp.status}, ${JSON.stringify(entHttp.body?.isTreasury)})`);
    assert(entHttp.body?.callsign === "Damo's Enterprise", 'and the enterprise\'s name, as before');
    const entTrust = getTrustProfileForViewer(kofi.pubKeyHex, enterprise);
    assert(entTrust?.isTreasury === true, `the trust profile of an enterprise says isTreasury: true (got ${JSON.stringify(entTrust?.isTreasury)})`);
    const entTrustHttp = await post('/api/trust/profile', { targetPubkey: enterprise }, kofi);
    assert(entTrustHttp.status === 200 && entTrustHttp.body?.isTreasury === true, `POST /api/trust/profile for an enterprise → isTreasury: true (got ${entTrustHttp.status}, ${JSON.stringify(entTrustHttp.body?.isTreasury)})`);

    // ── 2. A member's profile is unchanged ──
    console.log('── 2. a member\'s profile is unchanged ──');
    const MEMBER_PROFILE_KEYS = ['archetype', 'avatar', 'bio', 'callsign', 'contact', 'elderVouchedBy', 'elderVouchedByCallsign', 'joinedAt', 'publicKey', 'status'];
    const rosaProfile = getProfile(rosa.pubKeyHex, kofi.pubKeyHex) as Record<string, unknown> | null;
    assert(!!rosaProfile && !('isTreasury' in rosaProfile), `a member's profile carries no isTreasury key (keys: ${Object.keys(rosaProfile ?? {}).sort().join(', ')})`);
    assert(JSON.stringify(Object.keys(rosaProfile ?? {}).sort()) === JSON.stringify(MEMBER_PROFILE_KEYS), "a member's profile has exactly the fields it had");
    assert(rosaProfile?.callsign === 'Rosa' && rosaProfile?.bio === "Rosa's bio" && rosaProfile?.avatar === AVATAR, "a member's name, bio and photo as before");
    const rosaHttp = await get(`/api/profile/${rosa.pubKeyHex}`, kofi);
    assert(rosaHttp.status === 200 && !('isTreasury' in (rosaHttp.body ?? {})), `GET /api/profile/<member> → 200, no isTreasury (got ${rosaHttp.status}, keys ${Object.keys(rosaHttp.body ?? {}).sort().join(', ')})`);
    const rosaTrust = getTrustProfileForViewer(kofi.pubKeyHex, rosa.pubKeyHex) as Record<string, unknown> | null;
    assert(!!rosaTrust && !('isTreasury' in rosaTrust), "a member's trust profile carries no isTreasury key");

    // ── 3. A vouch for an enterprise is refused, in a sentence, and writes nothing ──
    console.log('── 3. a vouch for an enterprise is refused ──');
    const rowOf = (pk: string) => db.prepare('SELECT elder_vouched_by, vouch_credit, profile_updated_at FROM members WHERE public_key = ?').get(pk) as { elder_vouched_by: string | null; vouch_credit: number | null; profile_updated_at: string | null };
    const before = rowOf(enterprise);
    let refusal = '';
    try { vouchMember(damo.pubKeyHex, enterprise, 2); } catch (e: any) { refusal = String(e?.message ?? e); }
    assert(refusal === REFUSAL, `vouchMember(voucher, enterprise) throws "${REFUSAL}" (got "${refusal}")`);
    const after = rowOf(enterprise);
    assert(after.elder_vouched_by === before.elder_vouched_by && after.vouch_credit === before.vouch_credit && after.profile_updated_at === before.profile_updated_at,
        `the refused vouch wrote nothing (before ${JSON.stringify(before)}, after ${JSON.stringify(after)})`);
    let projectRefusal = '';
    try { vouchMember(damo.pubKeyHex, project, 1); } catch (e: any) { projectRefusal = String(e?.message ?? e); }
    assert(projectRefusal === REFUSAL, `a project is refused the same way (got "${projectRefusal}")`);
    const vouchHttp = await post('/api/profile/vouch', { targetPubkey: enterprise, level: 1 }, damo);
    assert(vouchHttp.status === 400 && vouchHttp.body?.error === REFUSAL, `POST /api/profile/vouch for an enterprise → 400 "${REFUSAL}" (got ${vouchHttp.status}, ${JSON.stringify(vouchHttp.body)})`);
    assert(rowOf(enterprise).elder_vouched_by === null, 'and the enterprise is still vouched by nobody');
    // A member is vouched for as before.
    const rosaVouch = await post('/api/profile/vouch', { targetPubkey: rosa.pubKeyHex, level: 2 }, damo);
    assert(rosaVouch.status === 200 && rosaVouch.body?.success === true, `a member is still vouched for (got ${rosaVouch.status}, ${JSON.stringify(rosaVouch.body)})`);
    assert(rowOf(rosa.pubKeyHex).elder_vouched_by === damo.pubKeyHex && getMemberTrustProfile(rosa.pubKeyHex).floor === -50, "the member's vouch is recorded with its floor");

    // ── 4. A vouch an enterprise already has is left as it is ──
    console.log('── 4. a vouch given before stays as it is ──');
    // As a node from before this change wrote it (the tester's "Vouched by Damo").
    db.prepare('UPDATE members SET elder_vouched_by = ?, vouch_credit = 25 WHERE public_key = ?').run(damo.pubKeyHex, enterprise);
    assert(rowOf(enterprise).elder_vouched_by === damo.pubKeyHex, 'an existing vouch for an enterprise is left on its row');
    assert(getProfile(enterprise, kofi.pubKeyHex)?.elderVouchedBy === damo.pubKeyHex, 'and its profile still names the voucher (the apps never draw it for this key)');
    unvouchMember(damo.pubKeyHex, enterprise);
    assert(rowOf(enterprise).elder_vouched_by === null, 'the voucher may still withdraw it');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
