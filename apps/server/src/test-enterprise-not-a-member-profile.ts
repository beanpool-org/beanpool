/**
 * An enterprise's key is never a member's Trust Profile (scratch/tools/DESIGN-shops-round3-enterprise-shopfront-fable.md
 * §1.1 and §0 row 11, slice E0).
 *
 * Every door in both apps that opens a profile by key (a post's author, a deal's other side, the map's preview…) opened
 * the member Trust Profile for an enterprise too: the profile shape said nothing about what the key was. The apps now
 * replace that screen with the enterprise page when the profile they load says `isTreasury`.
 *
 * Boots the real server (port 0, read auth as a fresh download has it) and proves:
 *   1. An enterprise's profile says so: getProfile, GET /api/profile/:key and the trust profile the phone reads
 *      (POST /api/trust/profile) each carry `isTreasury: true`; a project's too.
 *   2. A member's profile is unchanged: no `isTreasury` key on either read, every field as it was.
 *   3. The node's own accounts, BeanPool and Daily Pulse, are treasury rows but not enterprises: no `isTreasury` on
 *      either read, so the Pulse card's author door opens BeanPool's profile with its channels. A real enterprise,
 *      one made without a photo included, still says `isTreasury`.
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

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

async function main() {
    console.log('An enterprise is never a member\'s Trust Profile...\n');
    const { initTls } = await import('./services/tls.js');
    const {
        initStateEngine, createTreasury, getProfile, getTrustProfileForViewer,
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

    const damo = member('Damo');        // the enterprise's keeper
    const rosa = member('Rosa');        // a plain member
    const kofi = member('Kofi');        // a plain member who reads the profiles
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
    const MEMBER_PROFILE_KEYS = ['archetype', 'avatar', 'bio', 'callsign', 'contact', 'joinedAt', 'publicKey', 'status'];
    const rosaProfile = getProfile(rosa.pubKeyHex, kofi.pubKeyHex) as Record<string, unknown> | null;
    assert(!!rosaProfile && !('isTreasury' in rosaProfile), `a member's profile carries no isTreasury key (keys: ${Object.keys(rosaProfile ?? {}).sort().join(', ')})`);
    assert(JSON.stringify(Object.keys(rosaProfile ?? {}).sort()) === JSON.stringify(MEMBER_PROFILE_KEYS), "a member's profile has exactly the fields it had");
    assert(rosaProfile?.callsign === 'Rosa' && rosaProfile?.bio === "Rosa's bio" && rosaProfile?.avatar === AVATAR, "a member's name, bio and photo as before");
    const rosaHttp = await get(`/api/profile/${rosa.pubKeyHex}`, kofi);
    assert(rosaHttp.status === 200 && !('isTreasury' in (rosaHttp.body ?? {})), `GET /api/profile/<member> → 200, no isTreasury (got ${rosaHttp.status}, keys ${Object.keys(rosaHttp.body ?? {}).sort().join(', ')})`);
    const rosaTrust = getTrustProfileForViewer(kofi.pubKeyHex, rosa.pubKeyHex) as Record<string, unknown> | null;
    assert(!!rosaTrust && !('isTreasury' in rosaTrust), "a member's trust profile carries no isTreasury key");

    // ── 3. The node's own accounts are not enterprises ──
    // BeanPool owns the curated learn channel (seeded at every boot) and every channel an admin adds; Daily Pulse posts
    // the day's entry. Both are treasury rows, so the People directory leaves them out, but neither has keepers or a
    // purpose: the Pulse card's author door opened an empty "BeanPool" enterprise page instead of its profile with its
    // channels (deciding review of #2367).
    console.log('── 3. the node\'s own accounts are not enterprises ──');
    const { ensureBeanPoolIdentity, BEANPOOL_LEARN_CHANNEL_ID } = await import('./engine/pulse-seed.js');
    const { ensurePulseTreasury } = await import('./daily-pulse.js');
    const { getAllProfiles } = await import('./state-engine.js');
    const beanpool = ensureBeanPoolIdentity(); // seeded by initStateEngine: this only reads it
    const dailyPulse = ensurePulseTreasury();
    const isTreasuryRow = (pk: string) => (db.prepare('SELECT is_treasury FROM members WHERE public_key = ?').get(pk) as { is_treasury: number } | undefined)?.is_treasury;
    assert(isTreasuryRow(beanpool) === 1 && isTreasuryRow(dailyPulse) === 1, 'BeanPool and Daily Pulse are still treasury rows (out of the People directory)');
    for (const [name, pk] of [['BeanPool', beanpool], ['Daily Pulse', dailyPulse]] as const) {
        const p = getProfile(pk, kofi.pubKeyHex) as Record<string, unknown> | null;
        assert(!!p && p.callsign === name && !('isTreasury' in p), `${name}'s profile carries no isTreasury key (got ${JSON.stringify(p?.isTreasury)})`);
        const http = await get(`/api/profile/${pk}`, kofi);
        assert(http.status === 200 && http.body?.callsign === name && !('isTreasury' in (http.body ?? {})),
            `GET /api/profile/<${name}> → 200, no isTreasury (got ${http.status}, ${JSON.stringify(http.body?.isTreasury)})`);
        const trust = getTrustProfileForViewer(kofi.pubKeyHex, pk) as Record<string, unknown> | null;
        assert(!!trust && !('isTreasury' in trust), `${name}'s trust profile carries no isTreasury key (got ${JSON.stringify(trust?.isTreasury)})`);
        const trustHttp = await post('/api/trust/profile', { targetPubkey: pk }, kofi);
        assert(trustHttp.status === 200 && !('isTreasury' in (trustHttp.body ?? {})),
            `POST /api/trust/profile for ${name} → 200, no isTreasury (got ${trustHttp.status}, ${JSON.stringify(trustHttp.body?.isTreasury)})`);
    }
    // The door itself: a curated Pulse card's author is BeanPool, whose profile is a profile, with its channel chips.
    const feed = await get('/api/pulse/feed', kofi);
    const owners = new Set(((feed.body?.items ?? []) as { ownerPubkey: string }[]).map(i => i.ownerPubkey));
    assert(feed.status === 200 && owners.has(beanpool), `the Pulse feed's curated cards are BeanPool's (got ${feed.status}, ${owners.size} owner(s))`);
    const chips = await get(`/api/members/${beanpool}/channels`, kofi);
    assert(chips.status === 200 && ((chips.body?.channels ?? []) as { id: string }[]).some(c => c.id === BEANPOOL_LEARN_CHANNEL_ID),
        `and BeanPool's profile lists its learn channel (got ${chips.status}, ${JSON.stringify((chips.body?.channels ?? []).map((c: any) => c.id))})`);
    // The admins' members list reads the same rule.
    const listed = new Map(getAllProfiles(kofi.pubKeyHex).map(p => [p.publicKey, p]));
    assert(!!listed.get(beanpool) && !('isTreasury' in listed.get(beanpool)!) && !('isTreasury' in (listed.get(dailyPulse) ?? { isTreasury: 1 })),
        'getAllProfiles: BeanPool and Daily Pulse carry no isTreasury');
    assert(listed.get(enterprise)?.isTreasury === true, 'getAllProfiles: an enterprise still says isTreasury');
    // A real enterprise still opens as one, including one made without a photo: POST /api/enterprise passes
    // `systemCreated: !photoUrl` (routes/treasury.ts), which is why that option is no sign of the node's own account.
    const { publicKey: photoless } = createTreasury('Kofi Bakes', '', 0, { systemCreated: true, purpose: 'Bread', leadKeeperPubkey: kofi.pubKeyHex });
    assert(getProfile(photoless, rosa.pubKeyHex)?.isTreasury === true && getTrustProfileForViewer(rosa.pubKeyHex, photoless)?.isTreasury === true,
        "an enterprise made without a photo still says isTreasury, on its profile and its trust profile");
    assert(getProfile(enterprise, kofi.pubKeyHex)?.isTreasury === true && getTrustProfileForViewer(kofi.pubKeyHex, enterprise)?.isTreasury === true,
        'and so does the enterprise from section 1, with the node\'s own accounts in place');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
