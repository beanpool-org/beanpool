/**
 * Read auth is ON for a node started with NO configuration.
 *
 * A freshly downloaded node (`docker compose up`, no .env) must refuse private reads to anyone who
 * cannot prove who they are, while a not-signed-in visitor can still browse the public community.
 * Before this suite, ENFORCE_READ_AUTH defaulted to off, so every self-hosted node served any member's
 * conversations, balance and transactions to any caller holding an id.
 *
 * Boots the real server with every ENFORCE_* variable REMOVED from the environment, then asserts:
 *   1. unsigned reads of a conversation, a conversation list, a member's transactions and a balance → 401
 *   2. a signed member reading their own of each → 200
 *   3. a signed member reading someone else's conversation / conversation list → 403
 *   3b. a signed member reading someone else's balance / transactions → 403 (balances and trades are private)
 *   4. every public read the guest path needs → 200, both unsigned (the Welcome screen, before any
 *      identity exists) and signed by a key that is NOT a member here (the PWA guest of #849/#850,
 *      which holds a keypair and signs every read); that guest is still refused private reads (403),
 *      and a local community's listings (401/403 naming the global community)
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-read-auth-default.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
// The point of the suite: nothing set. The flags are module consts read at import, so they are
// removed here and the server is imported dynamically below — a static import would hoist above this.
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_LEDGER_AUTH;

import crypto from 'node:crypto';
import { lockedDm } from './dm-test-payload.js'; // no engine import: safe to hoist

const PORT = 8597;
const BASE = `https://localhost:${PORT}`;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };

async function get(path: string, id?: Id): Promise<{ status: number; error?: string }> {
    const headers: Record<string, string> = {};
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const canonical = `GET\n${path.split('?')[0]}\n${ts}\n${nonce}\n`;
        headers['X-Public-Key'] = id.pubKeyHex;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { headers });
    let error: string | undefined;
    try { error = (await res.json())?.error; } catch { /* binary or empty body */ }
    return { status: res.status, error };
}

async function main() {
    console.log('Read auth with NO environment set (the fresh-download default)...\n');
    const { initTls } = await import('./services/tls.js');
    const { initStateEngine, createConversation, sendMessage, createTreasury } = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');

    await initTls();
    initStateEngine();
    await startHttpsServer(PORT);

    const member = (callsign: string): Id => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const pubKeyHex = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', 'seed')`).run(pubKeyHex, callsign);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
        return { pubKeyHex, privateKey };
    };
    const alice = member('alice');
    const bob = member('bob');
    const carol = member('carol');

    const conv = createConversation('dm', [alice.pubKeyHex, bob.pubKeyHex], alice.pubKeyHex);
    if (!conv) throw new Error('setup: could not create the DM');
    const line = lockedDm(); // a DM goes in encrypted
    sendMessage(conv.id, alice.pubKeyHex, line.ciphertext, line.nonce);
    db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo, timestamp) VALUES (?,?,?,?,?,?)`)
        .run('tx-read-auth-default', alice.pubKeyHex, bob.pubKeyHex, 1, 'private memo', new Date().toISOString());

    const privateReads: Array<[string, string]> = [
        ['a conversation', `/api/messages/${conv.id}`],
        ['a conversation list', `/api/messages/conversations/${alice.pubKeyHex}`],
        ["a member's transactions", `/api/ledger/transactions?publicKey=${alice.pubKeyHex}`],
        ['a balance', `/api/ledger/balance/${alice.pubKeyHex}`],
        ['a standing (probation and mute)', '/api/community/me'],
        ['moderation notices', '/api/notices'],
        ['a block list', '/api/blocks'],
    ];

    console.log('── 1. a stranger (unsigned) is refused ──');
    for (const [what, path] of privateReads) {
        const r = await get(path);
        assert(r.status === 401, `unsigned read of ${what} is refused with 401 (got ${r.status})`);
    }

    console.log('\n── 2. a member reading their own gets it ──');
    for (const [what, path] of privateReads) {
        const r = await get(path, alice);
        assert(r.status === 200, `alice, signed, reads her own ${what.replace(/^a (member's )?/, '')} (got ${r.status} ${r.error ?? ''})`);
    }

    console.log("\n── 3. a member reading someone else's is refused ──");
    const otherConv = await get(`/api/messages/${conv.id}`, carol);
    assert(otherConv.status === 403, `carol, signed, is refused alice and bob's conversation (got ${otherConv.status})`);
    const otherList = await get(`/api/messages/conversations/${alice.pubKeyHex}`, carol);
    assert(otherList.status === 403, `carol, signed, is refused alice's conversation list (got ${otherList.status})`);
    // Balances and trades are private (Marty, 2026-09-28, reversing 2026-09-18's "member-visible by design", which this
    // suite only measured): a member reads their own and nobody else's (test-privacy-defaults has the rest).
    const otherBal = await get(`/api/ledger/balance/${alice.pubKeyHex}`, carol);
    const otherTx = await get(`/api/ledger/transactions?publicKey=${alice.pubKeyHex}`, carol);
    assert(otherBal.status === 403, `carol, signed, is refused alice's balance (got ${otherBal.status})`);
    assert(otherTx.status === 403, `carol, signed, is refused alice's transactions (got ${otherTx.status})`);

    console.log('\n── 4. a guest can still browse ──');
    const enterprise = createTreasury('Guest Visible Bakery', 'data:image/png;base64,iVBORw0KGgo=', 0, { leadKeeperPubkey: alice.pubKeyHex }).publicKey;
    const guestReads: string[] = [
        '/api/version',
        '/api/community/info',
        '/api/community/health',
        '/api/node/config',
        '/api/node/info',
        // Not /api/marketplace/posts: a local community's listings are its members' (Marty, 2026-09-28), so a guest is
        // refused them below. It was listed here while the board was public on every node.
        '/api/enterprises',
        '/api/enterprises/map',
        '/api/treasuries',
        '/api/commons/balance',
        '/api/commons/projects',
        '/api/commons/decisions',
        '/api/crowdfund/projects',
        // Not /api/activity/feed: it names the members in every trade and the Beans, so it is members-only
        // (test-activity-feed-members-only). It was listed here while the feed was public.
        '/api/pulse/feed',
        '/api/pricing-guide',
        '/api/federation/links',
        '/api/federation/reachable-peers',
        `/api/enterprise/${enterprise}`,
        `/api/treasury/${enterprise}`,
        `/api/community/membership/${alice.pubKeyHex}`,
        '/api/members/callsign-available/somebody-new',
    ];
    const { publicKey: gPub, privateKey: gPriv } = crypto.generateKeyPairSync('ed25519');
    const guest: Id = { pubKeyHex: gPub.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey: gPriv };
    for (const path of guestReads) {
        const r = await get(path);
        assert(r.status === 200, `unsigned GET ${path.split('?')[0]} is 200 (got ${r.status} ${r.error ?? ''})`);
        const g = await get(path, guest);
        assert(g.status === 200, `non-member guest, signed, GET ${path.split('?')[0]} is 200 (got ${g.status} ${g.error ?? ''})`);
    }
    for (const [what, path] of privateReads) {
        const g = await get(path, guest);
        assert(g.status === 403, `non-member guest, signed, is refused ${what} (got ${g.status})`);
    }
    // The listings: refused to both, in words that send them to the global community.
    const boardUnsigned = await get('/api/marketplace/posts');
    const boardGuest = await get('/api/marketplace/posts', guest);
    assert(boardUnsigned.status === 401 && /global\.beanpool\.org/.test(boardUnsigned.error ?? ''), `unsigned GET /api/marketplace/posts is refused, naming the global community (got ${boardUnsigned.status})`);
    assert(boardGuest.status === 403 && /global\.beanpool\.org/.test(boardGuest.error ?? ''), `non-member guest, signed, GET /api/marketplace/posts is refused the same way (got ${boardGuest.status})`);
    const boardMember = await get('/api/marketplace/posts', alice);
    assert(boardMember.status === 200, `alice, a member, reads the board (got ${boardMember.status})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Read auth is on by default, and guest browsing still works.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
