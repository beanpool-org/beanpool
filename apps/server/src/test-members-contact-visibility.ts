/**
 * A member's contact details leave the node only as far as their visibility allows — on every route.
 *
 * The profile page (GET /api/profile/:publicKey) always honoured the choice a member makes under
 * Settings → "Who can see this?". GET /api/community/members did not: it spread each whole member row into
 * the response, so any member who could read the list got every other member's phone number or email,
 * including the ones marked Hidden or Friends. On a global node, where anyone becomes a member by signing
 * in, that was the whole node's contact list one request away (found by #1140's deciding review,
 * 2026-09-25). The sweep behind this test found the same whole row going out in three more places: the
 * unsigned invite-redeem routes (for ANY existing member's key, to anyone holding a recent invite code),
 * the member_joined broadcast, and the admin dashboard's member list.
 *
 * Boots the real server with every ENFORCE_* variable REMOVED (the fresh-download default, read auth ON),
 * seeds one member per visibility, and reads every route that sends member rows as:
 *   - a signed stranger (a member nobody has added as a friend),
 *   - a signed friend (a member the Friends-only owner has added),
 *   - each owner (who always sees their own),
 *   - a signed non-member,
 *   - the old key of a member whose phone was lost or stolen, whom the Friends-only owner had added: an operator has
 *     issued a re-key code (issueRekeyCode), so the node has invalidated that key, though the row stays and the key can
 *     still sign. Refused like a non-member,
 *   - nobody (unsigned — refused on every gated route).
 * None of these viewers has a trade with the Trade Partners owner, so only that owner sees it here; who does see it
 * (a member with a trade in any state) is test-contact-trade-partners.ts, which also reads with read auth off.
 * The check is a search of the raw response text for each secret, so a contact that rides along under any
 * field name is caught, not only under the names the routes use today.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-members-contact-visibility.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
// Module consts read at import, so they are removed before the dynamic imports below.
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_LEDGER_AUTH;
process.env.ADMIN_PASSWORD = 'ContactTest123!'; // read by initAdminPassword

import crypto from 'node:crypto';
import WebSocket from 'ws';

const ADMIN_PW = 'ContactTest123!';
let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

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

async function get(path: string, id?: Id): Promise<{ status: number; text: string; etag: string | null; cacheControl: string | null }> {
    const res = await fetch(`${BASE}${path}`, { headers: id ? signedHeaders('GET', path, '', id) : {} });
    return { status: res.status, text: await res.text(), etag: res.headers.get('etag'), cacheControl: res.headers.get('cache-control') };
}

/** A POST, signed by `id` when given. */
async function post(path: string, payload: unknown, id?: Id): Promise<{ status: number; text: string; body: any }> {
    const body = JSON.stringify(payload);
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(id ? signedHeaders('POST', path, body, id) : {}) },
        body,
    });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { /* empty */ }
    return { status: res.status, text, body: json };
}

function signedWsQuery(id: Id): string {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.privateKey).toString('base64');
    return `pubkey=${id.pubKeyHex}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
}

function openSocket(url: string): Promise<{ ws: WebSocket; events: any[]; raw: string[] }> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const events: any[] = [];
        const raw: string[] = [];
        ws.on('message', (d) => { raw.push(d.toString()); try { events.push(JSON.parse(d.toString())); } catch { /* */ } });
        ws.on('open', () => resolve({ ws, events, raw }));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('socket did not open')), 3000);
    });
}

async function main() {
    console.log('Member contact details follow each member\'s visibility, with NO environment set...\n');
    const { initTls } = await import('./services/tls.js');
    const { initStateEngine } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { initAdminPassword } = await import('./config/local-config.js');
    const { db } = await import('./db/db.js');
    const { issueRekeyCode } = await import('./engine/member-wizards.js');

    initAdminPassword();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const member = (callsign: string, contact?: { value: string; visibility: string | null }): Id => {
        const id = keypair();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, contact_value, contact_visibility)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', ?, ?, ?)`)
            .run(id.pubKeyHex, callsign, `INV-${callsign.toUpperCase()}`, contact?.value ?? null, contact?.visibility ?? null);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        return id;
    };

    // One owner per choice in Settings → "Who can see this?", plus a contact stored with no choice at all.
    const SECRET = {
        community: 'community-owner@example.org',
        tradePartners: 'trade-partners-owner@example.org',
        friends: 'friends-owner@example.org',
        hidden: 'hidden-owner@example.org',
        unset: 'no-visibility-owner@example.org',
    };
    const owners = {
        community: member('commOwner', { value: SECRET.community, visibility: 'community' }),
        tradePartners: member('tradeOwner', { value: SECRET.tradePartners, visibility: 'trade_partners' }),
        friends: member('friendsOwner', { value: SECRET.friends, visibility: 'friends' }),
        hidden: member('hiddenOwner', { value: SECRET.hidden, visibility: 'hidden' }),
        unset: member('unsetOwner', { value: SECRET.unset, visibility: null }),
    };
    const stranger = member('stranger');
    const friend = member('friendOfOwner');
    const guest = keypair(); // signs, but is not a member here

    // The Friends-only owner adds `friend`, through the real signed route. The stranger adds the owner the
    // other way round: that must reveal nothing, because the choice is about who the OWNER has added.
    const added = await post('/api/friends/add', { friendPubkey: friend.pubKeyHex }, owners.friends);
    assert(added.status === 200 && added.body?.success === true, `friendsOwner adds friendOfOwner as a friend (got ${added.status})`);
    const reverse = await post('/api/friends/add', { friendPubkey: owners.friends.pubKeyHex }, stranger);
    assert(reverse.status === 200 && reverse.body?.success === true, `stranger adds friendsOwner as a friend — one-way, reveals nothing (got ${reverse.status})`);
    // The Friends-only owner adds rekeyPending too; then rekeyPending's phone is lost and an operator issues a re-key code.
    const rekeyPending = member('rekeyPending');
    const addedRekey = await post('/api/friends/add', { friendPubkey: rekeyPending.pubKeyHex }, owners.friends);
    assert(addedRekey.status === 200 && addedRekey.body?.success === true, `friendsOwner adds rekeyPending as a friend (got ${addedRekey.status})`);
    issueRekeyCode(rekeyPending.pubKeyHex, 'owner:password');

    const secretsIn = (text: string) => new Set(Object.entries(SECRET).filter(([, v]) => text.includes(v)).map(([k]) => k));
    const fmt = (s: Set<string>) => `[${[...s].sort().join(', ')}]`;
    const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(x => b.has(x));
    const ownerInviteCodes = Object.keys(owners).map(k => `INV-${({ community: 'COMMOWNER', tradePartners: 'TRADEOWNER', friends: 'FRIENDSOWNER', hidden: 'HIDDENOWNER', unset: 'UNSETOWNER' } as Record<string, string>)[k]}`);
    const anyInviteCode = (text: string) => ownerInviteCodes.some(c => text.includes(c)) || text.includes('INV-STRANGER');

    // Every route that sends member rows to a member's app. Each one is read by every viewer below.
    const LIST_ROUTES = [
        '/api/community/members',
        '/api/members',
        '/api/members?updatedAfter=2000-01-01T00:00:00.000Z',
        '/api/invite/tree',
    ];

    console.log('── the member lists ──');
    // Every member sees Community. Trade Partners is for members with a trade with its owner, and nobody here has one.
    const everyone = new Set(['community']);
    const expectFor = (viewer: Id): Set<string> => {
        const s = new Set(everyone);
        if (viewer === friend) s.add('friends');
        for (const [k, o] of Object.entries(owners)) if (o === viewer) s.add(k);
        return s;
    };
    for (const path of LIST_ROUTES) {
        // Only the community list carries contact details; the app's directory sync and the invite tree never did,
        // and must stay that way.
        const carriesContact = path === '/api/community/members';
        const viewers: [string, Id][] = [
            ['stranger', stranger],
            ['friend of the Friends-only owner', friend],
            ...Object.entries(owners).map(([k, o]): [string, Id] => [`the ${k} owner`, o]),
        ];
        for (const [label, viewer] of viewers) {
            const r = await get(path, viewer);
            const seen = secretsIn(r.text);
            const want = carriesContact ? expectFor(viewer) : new Set<string>();
            assert(r.status === 200, `${label}, signed, GET ${path} → 200 (got ${r.status})`);
            assert(same(seen, want), `${label} sees exactly ${fmt(want)} on ${path} (saw ${fmt(seen)})`);
            assert(!anyInviteCode(r.text), `${label} is sent no member's invite code on ${path}`);
        }
        const unsigned = await get(path);
        assert(unsigned.status === 401, `unsigned GET ${path} is refused with 401 (got ${unsigned.status})`);
        assert(secretsIn(unsigned.text).size === 0, `the unsigned refusal of ${path} carries no contact`);
        const asGuest = await get(path, guest);
        assert(asGuest.status === 403, `a signed non-member is refused ${path} with 403 (got ${asGuest.status})`);
        assert(secretsIn(asGuest.text).size === 0, `the non-member's refusal of ${path} carries no contact (saw ${fmt(secretsIn(asGuest.text))})`);
        const asRekeyPending = await get(path, rekeyPending);
        assert(asRekeyPending.status === 403 && secretsIn(asRekeyPending.text).size === 0,
            `a re-key-pending key is refused ${path} with 403 and no contact (got ${asRekeyPending.status}, saw ${fmt(secretsIn(asRekeyPending.text))})`);
    }

    console.log('\n── the member list carries no other private field ──');
    {
        const r = await get('/api/community/members', stranger);
        const rows: any[] = JSON.parse(r.text);
        const other = rows.find(m => m.publicKey === owners.hidden.pubKeyHex);
        assert(!!other, 'the hidden owner is still listed for the stranger');
        assert(other && other.contactValue == null && other.contactVisibility == null && other.contact == null,
            `the hidden owner's row has no contact fields at all for the stranger (got ${JSON.stringify({ v: other?.contactValue, vis: other?.contactVisibility, c: other?.contact })})`);
        assert(other && !('inviteCode' in other) && !('updatedAt' in other),
            `the list row has no inviteCode or updatedAt field (keys: ${other ? Object.keys(other).sort().join(', ') : '-'})`);
        for (const field of ['publicKey', 'callsign', 'avatarUrl', 'joinedAt', 'status', 'nodeRole']) {
            assert(other && field in other, `the list row still has ${field}, which the apps read`);
        }
        const mine = JSON.parse((await get('/api/community/members', owners.hidden)).text).find((m: any) => m.publicKey === owners.hidden.pubKeyHex);
        assert(mine?.contactValue === SECRET.hidden && mine?.contactVisibility === 'hidden',
            `the hidden owner still sees their own contact and choice in the list (got ${JSON.stringify({ v: mine?.contactValue, vis: mine?.contactVisibility })})`);
    }

    console.log('\n── the member list is cached per viewer ──');
    {
        const a = await get('/api/community/members', stranger);
        const b = await get('/api/community/members', friend);
        assert(a.etag !== b.etag, `two viewers get different ETags for their different lists (${a.etag} vs ${b.etag})`);
        assert(a.cacheControl === 'private, max-age=0, must-revalidate',
            `the list is never storable by a shared cache (Cache-Control: ${a.cacheControl})`);
        // Being added as a friend later changes what the list shows, so the viewer's cached copy must not be
        // confirmed with a 304.
        const late = member('lateFriend');
        const before = await get('/api/community/members', late);
        assert(!secretsIn(before.text).has('friends'), 'lateFriend does not see the Friends-only contact before being added');
        const addLate = await post('/api/friends/add', { friendPubkey: late.pubKeyHex }, owners.friends);
        assert(addLate.status === 200, `friendsOwner adds lateFriend (got ${addLate.status})`);
        const res = await fetch(`${BASE}/api/community/members`, {
            headers: { ...signedHeaders('GET', '/api/community/members', '', late), 'If-None-Match': before.etag || '' },
        });
        const text = await res.text();
        assert(res.status === 200, `after being added, lateFriend's old ETag no longer answers 304 (got ${res.status})`);
        assert(secretsIn(text).has('friends'), 'and the fresh list shows lateFriend the Friends-only contact');
    }

    console.log('\n── the profile page, the rule the list now shares ──');
    for (const [k, o] of Object.entries(owners)) {
        const path = `/api/profile/${o.pubKeyHex}`;
        const key = k as keyof typeof SECRET;
        const asStranger = secretsIn((await get(path, stranger)).text).has(key);
        const asFriend = secretsIn((await get(path, friend)).text).has(key);
        const asSelf = secretsIn((await get(path, o)).text).has(key);
        const public_ = k === 'community';
        assert(asStranger === public_, `the stranger ${public_ ? 'sees' : 'does not see'} the ${k} owner's contact on the profile page`);
        assert(asFriend === (public_ || k === 'friends'), `the friend ${public_ || k === 'friends' ? 'sees' : 'does not see'} the ${k} owner's contact on the profile page`);
        assert(asSelf, `the ${k} owner sees their own contact on their profile page`);
        const unsigned = await get(path);
        assert(unsigned.status === 401, `unsigned GET /api/profile/:publicKey is refused with 401 (got ${unsigned.status})`);
        const asGuest = await get(path, guest);
        assert(asGuest.status === 403 && !secretsIn(asGuest.text).has(key),
            `a signed non-member is refused the ${k} owner's profile page with 403 and no contact (got ${asGuest.status})`);
        const asRekeyPending = await get(path, rekeyPending);
        assert(asRekeyPending.status === 403 && !secretsIn(asRekeyPending.text).has(key),
            `a re-key-pending key is refused the ${k} owner's profile page with 403 and no contact (got ${asRekeyPending.status})`);
    }

    console.log('\n── the unsigned invite-redeem routes, named with an existing member\'s key ──');
    {
        // Any recent invite code will do: the "already a member" answer comes before the code is checked as used.
        db.prepare(`INSERT INTO invite_codes (code, created_by, created_at) VALUES ('INV-PROBE-0001', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(stranger.pubKeyHex);
        const payload = JSON.stringify({ i: stranger.pubKeyHex, t: Date.now() });
        const sig = crypto.sign(null, Buffer.from(payload), stranger.privateKey).toString('base64');
        const ticketB64 = Buffer.from(JSON.stringify({ p: payload, s: sig })).toString('base64');
        const CARD = ['avatarUrl', 'callsign', 'joinedAt', 'publicKey'].join(',');
        for (const [k, o] of Object.entries(owners)) {
            for (const [route, body] of [
                ['/api/invite/redeem', { code: 'INV-PROBE-0001', publicKey: o.pubKeyHex, callsign: 'probe' }],
                ['/api/invite/redeem-offline', { ticketB64, publicKey: o.pubKeyHex, callsign: 'probe' }],
            ] as const) {
                const r = await post(route, body);
                assert(r.status === 200 && r.body?.alreadyMember === true, `unsigned ${route} for the ${k} owner's key answers alreadyMember (got ${r.status})`);
                assert(secretsIn(r.text).size === 0, `…and carries no contact (saw ${fmt(secretsIn(r.text))})`);
                assert(!anyInviteCode(r.text), '…and no invite code');
                assert(Object.keys(r.body?.member || {}).sort().join(',') === CARD,
                    `…and only the public card (keys: ${Object.keys(r.body?.member || {}).sort().join(', ')})`);
            }
        }
    }

    console.log('\n── the member_joined broadcast ──');
    {
        const sock = await openSocket(`${BASE.replace('https', 'wss')}/ws?${signedWsQuery(stranger)}`);
        await sleep(200);
        db.prepare(`INSERT INTO invite_codes (code, created_by, created_at) VALUES ('INV-JOIN-0001', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(stranger.pubKeyHex);
        const joiner = keypair();
        const joined = await post('/api/invite/redeem', { code: 'INV-JOIN-0001', publicKey: joiner.pubKeyHex, callsign: 'newcomer' });
        assert(joined.status === 200 && joined.body?.success === true && !joined.body?.alreadyMember, `a newcomer joins with a fresh code (got ${joined.status})`);
        assert(!joined.text.includes('INV-JOIN-0001'), 'the join response does not echo the invite code back in the member');
        await sleep(400);
        const ev = sock.events.find(e => e.type === 'member_joined' && e.member?.publicKey === joiner.pubKeyHex);
        assert(!!ev, 'a member socket gets member_joined for the newcomer');
        assert(ev && Object.keys(ev.member).sort().join(',') === 'avatarUrl,callsign,joinedAt,publicKey',
            `member_joined carries only the public card (keys: ${ev ? Object.keys(ev.member).sort().join(', ') : '-'})`);
        assert(!sock.raw.some(r => r.includes('INV-JOIN-0001')), 'no socket message carries the newcomer\'s invite code');
        sock.ws.close();
    }

    console.log('\n── the admin dashboard\'s member list ──');
    {
        const r = await post('/api/local/admin/data', { password: ADMIN_PW });
        assert(r.status === 200, `the admin reads /api/local/admin/data (got ${r.status})`);
        // The password proves no member, and Community, Trade Partners and Friends all need a member viewer.
        const seen = secretsIn(r.text);
        assert(seen.size === 0, `an admin, signed in with the password and no member key, is sent no contact details (saw ${fmt(seen)})`);
        const row = (r.body?.members || []).find((m: any) => m.publicKey === owners.hidden.pubKeyHex);
        assert(!!row && !('contactValue' in row) && !('contactVisibility' in row), 'the admin member rows carry no contact fields');
        assert(!!row && row.invitedBy === 'seed' && typeof row.status === 'string', 'the admin rows still carry what the manager draws from (invitedBy, status)');
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Contact details follow each member\'s choice on every route that sends member rows.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
