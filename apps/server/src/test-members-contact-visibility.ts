/**
 * A member's contact details leave the node only as far as their visibility allows — on every route.
 *
 * The profile page (GET /api/profile/:publicKey) always honoured the choice a member makes under
 * Settings → "Who can see this?". GET /api/community/members did not: it spread each whole member row into
 * the response, so any member who could read the list got every other member's phone number or email,
 * including the ones marked Hidden or Friends. On a global node, where anyone becomes a member by signing
 * in, that was the whole node's contact list one request away (found by #1140's deciding review,
 * 2026-09-25).
 *
 * Boots the real server with every ENFORCE_* variable REMOVED (the fresh-download default, read auth ON),
 * seeds one member per visibility, and reads every route that sends member rows as:
 *   - a signed stranger (a member nobody has added as a friend),
 *   - a signed friend (a member the Friends-only owner has added),
 *   - each owner (who always sees their own),
 *   - a signed non-member,
 *   - nobody (unsigned — refused on every gated route).
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

import crypto from 'node:crypto';

const PORT = 8613;
const BASE = `https://localhost:${PORT}`;
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

async function get(path: string, id?: Id): Promise<{ status: number; text: string; etag: string | null; cacheControl: string | null }> {
    const res = await fetch(`${BASE}${path}`, { headers: id ? signedHeaders('GET', path, '', id) : {} });
    return { status: res.status, text: await res.text(), etag: res.headers.get('etag'), cacheControl: res.headers.get('cache-control') };
}

async function post(path: string, payload: unknown, id: Id): Promise<{ status: number; body: any }> {
    const body = JSON.stringify(payload);
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...signedHeaders('POST', path, body, id) },
        body,
    });
    let json: any;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

async function main() {
    console.log('Member contact details follow each member\'s visibility, with NO environment set...\n');
    const { initTls } = await import('./services/tls.js');
    const { initStateEngine } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');

    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

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

    const secretsIn = (text: string) => new Set(Object.entries(SECRET).filter(([, v]) => text.includes(v)).map(([k]) => k));
    const fmt = (s: Set<string>) => `[${[...s].sort().join(', ')}]`;
    const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(x => b.has(x));

    // Every route that sends member rows to a member's app. Each one is read by every viewer below.
    const LIST_ROUTES = [
        '/api/community/members',
        '/api/members',
        '/api/members?updatedAfter=2000-01-01T00:00:00.000Z',
    ];

    console.log('── the member lists ──');
    const everyone = new Set(['community', 'tradePartners']);
    const expectFor = (viewer: Id): Set<string> => {
        const s = new Set(everyone);
        if (viewer === friend) s.add('friends');
        for (const [k, o] of Object.entries(owners)) if (o === viewer) s.add(k);
        return s;
    };
    for (const path of LIST_ROUTES) {
        // `/api/members` is the app's directory sync and never carried contact details; it must stay that way.
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
        }
        const unsigned = await get(path);
        assert(unsigned.status === 401, `unsigned GET ${path} is refused with 401 (got ${unsigned.status})`);
        assert(secretsIn(unsigned.text).size === 0, `the unsigned refusal of ${path} carries no contact`);
        const asGuest = await get(path, guest);
        assert(!['friends', 'hidden', 'unset'].some(k => secretsIn(asGuest.text).has(k)),
            `a signed non-member sees no Friends-only, Hidden or unset contact on ${path} (status ${asGuest.status}, saw ${fmt(secretsIn(asGuest.text))})`);
    }

    console.log('\n── the member list carries no other private field ──');
    {
        const r = await get('/api/community/members', stranger);
        const rows: any[] = JSON.parse(r.text);
        const other = rows.find(m => m.publicKey === owners.hidden.pubKeyHex);
        assert(!!other, 'the hidden owner is still listed for the stranger');
        assert(other && other.contactValue == null && other.contactVisibility == null && other.contact == null,
            `the hidden owner's row has no contact fields at all for the stranger (got ${JSON.stringify({ v: other?.contactValue, vis: other?.contactVisibility, c: other?.contact })})`);
        assert(!r.text.includes('INV-HIDDENOWNER'), 'no invite code rides along in the list');
        assert(other && !('inviteCode' in other), 'the list row has no inviteCode field');
        const own = rows.find(m => m.publicKey === stranger.pubKeyHex);
        assert(!!own, 'the stranger is in their own list');
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
        const public_ = k === 'community' || k === 'tradePartners';
        assert(asStranger === public_, `the stranger ${public_ ? 'sees' : 'does not see'} the ${k} owner's contact on the profile page`);
        assert(asFriend === (public_ || k === 'friends'), `the friend ${public_ || k === 'friends' ? 'sees' : 'does not see'} the ${k} owner's contact on the profile page`);
        assert(asSelf, `the ${k} owner sees their own contact on their profile page`);
        const unsigned = await get(path);
        assert(unsigned.status === 401, `unsigned GET /api/profile/:publicKey is refused with 401 (got ${unsigned.status})`);
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Contact details follow each member\'s choice on every route that sends member rows.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
