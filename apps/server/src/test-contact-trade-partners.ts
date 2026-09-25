/**
 * "Trade Partners" contact details reach the members this member has a trade with, and contact details of every kind
 * reach members only.
 *
 * Both apps offer "🤝 Trade Partners — Visible when you enter a trade", but the rule (contactVisibleTo, #1145) read
 * `trade_partners` exactly like `community`: every member saw it. And with no viewer at all it answered yes for
 * `community`, so on a node running with read auth off an unsigned reader got every Community contact. Marty's answers
 * (2026-09-25): a trade partner is a member you have a trade with, in any state; Community, Trade Partners and Friends
 * all need a member viewer; the owner always sees their own.
 *
 * A trade is a row in marketplace_transactions (a request, an accepted deal in escrow, a completed, cancelled or
 * rejected one, or one in dispute) with the two of them as buyer and seller, either way round. A direct Bean transfer
 * is not a trade here.
 *
 * Boots the real server and reads the member list and the profile page as a member holding a trade with the Trade
 * Partners owner in each state, a member with no trade, a member whose trade is with someone else, a pruned member who
 * did trade with them, a signed non-member, nobody, and each owner. Then checks the member list's ETag moves when a
 * trade is requested through the real route, which changes no member row.
 *
 * Runs twice: here with every ENFORCE_* variable REMOVED (the fresh-download default, read auth on), then in a child
 * process with ENFORCE_READ_AUTH=false, where both routes answer an unsigned reader and a non-member.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-contact-trade-partners.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
const READ_AUTH_OFF = process.env.CONTACT_READ_AUTH_OFF === '1';
if (!READ_AUTH_OFF) {
    // Module consts read at import, so they are removed before the dynamic imports in main().
    delete process.env.ENFORCE_READ_AUTH;
    delete process.env.ENFORCE_WS_AUTH;
    delete process.env.ENFORCE_LEDGER_AUTH;
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MODE = READ_AUTH_OFF ? '[read auth off]' : '[defaults]';
let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${MODE} ${msg}`);
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

async function get(path: string, id?: Id, extra: Record<string, string> = {}): Promise<{ status: number; text: string; etag: string | null }> {
    const res = await fetch(`${BASE}${path}`, { headers: { ...(id ? signedHeaders('GET', path, '', id) : {}), ...extra } });
    return { status: res.status, text: await res.text(), etag: res.headers.get('etag') };
}

async function post(path: string, payload: unknown, id: Id): Promise<{ status: number; text: string; body: any }> {
    const body = JSON.stringify(payload);
    const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...signedHeaders('POST', path, body, id) },
        body,
    });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { /* empty */ }
    return { status: res.status, text, body: json };
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

async function main() {
    console.log(`Trade Partners means trade partners, and contacts need a member viewer ${MODE}...\n`);
    const { initTls } = await import('./services/tls.js');
    const { initStateEngine } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');

    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const member = (callsign: string, opts: { contact?: { value: string; visibility: string }; status?: string } = {}): Id => {
        const id = keypair();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, avatar_url, contact_value, contact_visibility)
                    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', ?, ?, ?, ?)`)
            .run(id.pubKeyHex, callsign, opts.status ?? 'active', `INV-${callsign.toUpperCase()}`, AVATAR,
                opts.contact?.value ?? null, opts.contact?.visibility ?? null);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        return id;
    };
    const listing = (owner: Id, type: 'offer' | 'need', title: string): string => {
        const id = `post-${crypto.randomUUID()}`;
        db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey) VALUES (?, ?, 'other', ?, '', 0, ?)`)
            .run(id, type, title, owner.pubKeyHex);
        return id;
    };
    /** A trade row between `buyer` and `seller` in `status`, as the escrow engine writes one. */
    const trade = (postId: string, buyer: Id, seller: Id, status: string): void => {
        db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at)
                    VALUES (?, ?, ?, ?, 0, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
            .run(crypto.randomUUID(), postId, buyer.pubKeyHex, seller.pubKeyHex, status);
    };

    const SECRET = {
        tradePartners: 'trade-partners-owner@example.org',
        community: 'community-owner@example.org',
        friends: 'friends-owner@example.org',
    };
    const owners = {
        tradePartners: member('tradeOwner', { contact: { value: SECRET.tradePartners, visibility: 'trade_partners' } }),
        community: member('commOwner', { contact: { value: SECRET.community, visibility: 'community' } }),
        friends: member('friendsOwner', { contact: { value: SECRET.friends, visibility: 'friends' } }),
    };
    const ownerOffer = listing(owners.tradePartners, 'offer', 'Bread');
    const otherOffer = listing(owners.community, 'offer', 'Eggs');

    // One member per trade state, alternating which side of the deal they are on: a partner either way round counts.
    const STATES = ['requested', 'pending', 'completed', 'disputed', 'cancelled', 'rejected'];
    const partners = STATES.map((status, i) => {
        const v = member(`partner_${status}`);
        if (i % 2 === 0) trade(ownerOffer, v, owners.tradePartners, status);
        else trade(ownerOffer, owners.tradePartners, v, status);
        return { status, id: v, side: i % 2 === 0 ? 'buyer' : 'seller' };
    });
    const noTrade = member('noTrade');
    const tradedElsewhere = member('tradedElsewhere');
    trade(otherOffer, tradedElsewhere, owners.community, 'completed');
    // A direct Bean transfer is not a trade.
    const beansOnly = member('beansOnly');
    db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo) VALUES (?, ?, ?, 1, 'thanks')`)
        .run(crypto.randomUUID(), beansOnly.pubKeyHex, owners.tradePartners.pubKeyHex);
    // A pruned member keeps their row and can still sign, and this one did trade with the owner and was added as a
    // friend: they are no longer in the community, so they see nobody's contact.
    const pruned = member('prunedPartner', { status: 'pruned' });
    trade(ownerOffer, pruned, owners.tradePartners, 'completed');
    db.prepare(`INSERT INTO friends (owner_pubkey, friend_pubkey) VALUES (?, ?)`).run(owners.friends.pubKeyHex, pruned.pubKeyHex);
    const friend = member('friendOfOwner');
    db.prepare(`INSERT INTO friends (owner_pubkey, friend_pubkey) VALUES (?, ?)`).run(owners.friends.pubKeyHex, friend.pubKeyHex);
    const guest = keypair(); // signs, but is not a member here

    const secretsIn = (text: string) => new Set(Object.entries(SECRET).filter(([, v]) => text.includes(v)).map(([k]) => k));
    const fmt = (s: Set<string>) => `[${[...s].sort().join(', ')}]`;
    const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every(x => b.has(x));

    const viewers: [string, Id, Set<string>][] = [
        ...partners.map(({ status, id, side }): [string, Id, Set<string>] =>
            [`a member with a ${status} trade (the ${side}) with the Trade Partners owner`, id, new Set(['community', 'tradePartners'])]),
        ['a member with no trade', noTrade, new Set(['community'])],
        ['a member whose trade is with someone else', tradedElsewhere, new Set(['community'])],
        ['a member who only sent the owner Beans', beansOnly, new Set(['community'])],
        ['a friend of the Friends-only owner', friend, new Set(['community', 'friends'])],
        ['the Trade Partners owner', owners.tradePartners, new Set(['community', 'tradePartners'])],
        ['the Community owner', owners.community, new Set(['community'])],
        ['the Friends-only owner', owners.friends, new Set(['community', 'friends'])],
        ['a pruned member who traded with the owner and was added as a friend', pruned, new Set()],
    ];

    console.log('── the member list ──');
    for (const [label, id, want] of viewers) {
        const r = await get('/api/community/members', id);
        assert(r.status === 200, `${label} reads the member list → 200 (got ${r.status})`);
        const seen = secretsIn(r.text);
        assert(same(seen, want), `${label} sees exactly ${fmt(want)} on the member list (saw ${fmt(seen)})`);
    }

    console.log('\n── the profile page ──');
    for (const [label, id, want] of viewers) {
        for (const [k, o] of Object.entries(owners)) {
            const r = await get(`/api/profile/${o.pubKeyHex}`, id);
            assert(r.status === 200, `${label} reads the ${k} owner's profile → 200 (got ${r.status})`);
            const sees = secretsIn(r.text).has(k);
            assert(sees === want.has(k), `${label} ${want.has(k) ? 'sees' : 'does not see'} the ${k} owner's contact on the profile page`);
        }
    }

    console.log('\n── readers who are not members ──');
    for (const [label, id] of [['nobody (unsigned)', undefined], ['a signed non-member', guest]] as const) {
        const paths = ['/api/community/members', ...Object.values(owners).map(o => `/api/profile/${o.pubKeyHex}`)];
        for (const p of paths) {
            const r = await get(p, id);
            if (READ_AUTH_OFF) {
                assert(r.status === 200, `${label} reads ${p.startsWith('/api/profile') ? 'a profile' : 'the member list'} → 200 with read auth off (got ${r.status})`);
            } else {
                assert(r.status === (id ? 403 : 401), `${label} is refused ${p.startsWith('/api/profile') ? 'a profile' : 'the member list'} (got ${r.status})`);
            }
            assert(secretsIn(r.text).size === 0, `${label} is sent no contact on ${p} (saw ${fmt(secretsIn(r.text))})`);
        }
    }

    console.log('\n── a new trade moves the member list\'s ETag ──');
    {
        // Requesting a trade writes a marketplace_transactions row and no member row, so the members version stays
        // where it was; the viewer's copy fetched before must not be confirmed with a 304 afterwards.
        const late = member('lateTrader');
        const before = await get('/api/community/members', late);
        assert(before.status === 200 && !secretsIn(before.text).has('tradePartners'), 'before any trade, lateTrader does not see the Trade Partners contact');
        const need = listing(owners.tradePartners, 'need', 'Help moving a couch');
        const asked = await post('/api/marketplace/posts/request', { postId: need, buyerPublicKey: late.pubKeyHex }, late);
        assert(asked.status === 200 && asked.body?.transaction?.status === 'requested',
            `lateTrader offers to help with the owner's Need through the real route (got ${asked.status} ${asked.text.slice(0, 160)})`);
        const after = await get('/api/community/members', late, { 'If-None-Match': before.etag || '' });
        assert(after.status === 200, `after the request, lateTrader's old ETag no longer answers 304 (got ${after.status})`);
        assert(secretsIn(after.text).has('tradePartners'), 'and the fresh list shows lateTrader the Trade Partners contact');
        const again = await get('/api/community/members', late, { 'If-None-Match': after.etag || '' });
        assert(again.status === 304, `with nothing changed since, the new ETag answers 304 (got ${again.status})`);
        const profile = await get(`/api/profile/${owners.tradePartners.pubKeyHex}`, late);
        assert(secretsIn(profile.text).has('tradePartners'), 'the profile page shows lateTrader the Trade Partners contact too');
    }

    console.log(`\n${passed}/${run} checks passed ${MODE}.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed ${MODE}`);

    if (!READ_AUTH_OFF) {
        console.log('\nAgain with ENFORCE_READ_AUTH=false...\n');
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'beanpool-contact-open-'));
        const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
            env: { ...process.env, CONTACT_READ_AUTH_OFF: '1', ENFORCE_READ_AUTH: 'false', BEANPOOL_DATA_DIR: dataDir },
            stdio: 'inherit',
        });
        fs.rmSync(dataDir, { recursive: true, force: true });
        if (child.status !== 0) throw new Error(`the read-auth-off run failed (exit ${child.status})`);
        console.log('⭐️ Trade Partners contacts reach trade partners, and every contact needs a member viewer, read auth on or off.');
    }
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
