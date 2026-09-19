/**
 * The /ws live-updates feed does not stream member activity to strangers on a node started with NO
 * configuration.
 *
 * Before this suite, ENFORCE_WS_AUTH defaulted to off and every event without `recipients` went to every
 * socket, signed or not: a DM notice (conversation id, both parties, the ciphertext), a trade request with
 * both parties and the Beans, an operator announcement, every new member. Anyone who could reach a node
 * could open /ws and watch.
 *
 * Boots the real server with ENFORCE_WS_AUTH REMOVED from the environment, and drives real engine paths:
 *   1. upgrades: unsigned → 101; signed by a non-member key (the PWA guest) → 101; signed by a member → 101;
 *      a forged, replayed, stale or partial token → 401
 *   2. an unsigned or guest socket gets no member-private event — no DM notice, no conversation, no trade,
 *      no balance change, no announcement, no new member, no members-only (direct) post — and for a public
 *      listing only a bare `{ type }` doorbell, so an event's private note never reaches it
 *   3. a member socket gets what it got before (the community-wide events in full, plus the transfers it is
 *      a party to)
 *   4. a socket signed by a key that becomes a member while connected (mid-join) is promoted on its
 *      member_joined; a member pruned while connected is demoted to a stranger's feed on user_pruned
 *   5. /ws/logs still refuses an upgrade without admin auth
 *
 * With ENFORCE_WS_AUTH=false (the operator's escape hatch) the same script asserts the old open feed
 * instead: an unsigned socket gets the community-wide events in full, but still never a scoped one.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-ws-auth-default.ts
 *      ENFORCE_WS_AUTH=false BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-ws-auth-default.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
// The flag is a module const read at import, so it is settled here and the server is imported
// dynamically below — a static import would hoist above this.
const OPEN_FEED = process.env.ENFORCE_WS_AUTH === 'false';
if (!OPEN_FEED) delete process.env.ENFORCE_WS_AUTH;

import crypto from 'node:crypto';
import net from 'node:net';
import WebSocket from 'ws';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address() as net.AddressInfo;
            s.close(() => resolve(port));
        });
    });
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };

function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}

function signedWsQuery(id: Id, opts: { ts?: number; nonce?: string; signer?: crypto.KeyObject } = {}): string {
    const ts = opts.ts ?? Date.now();
    const nonce = opts.nonce ?? crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), opts.signer ?? id.privateKey).toString('base64');
    return `pubkey=${id.pubKeyHex}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
}

type Outcome =
    | { kind: 'open'; ws: WebSocket; events: any[]; raw: string[] }
    | { kind: 'status'; status: number }
    | { kind: 'destroyed'; error: string };

function upgrade(url: string): Promise<Outcome> {
    return new Promise((resolve) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const events: any[] = [];
        const raw: string[] = [];
        let settled = false;
        const done = (o: Outcome) => { if (!settled) { settled = true; resolve(o); } };
        ws.on('message', (d) => { raw.push(d.toString()); try { events.push(JSON.parse(d.toString())); } catch { /* */ } });
        ws.on('open', () => done({ kind: 'open', ws, events, raw }));
        ws.on('unexpected-response', (_req, res) => {
            done({ kind: 'status', status: res.statusCode || 0 });
            res.resume();
            ws.terminate();
        });
        ws.on('error', (e) => done({ kind: 'destroyed', error: e.message }));
        setTimeout(() => done({ kind: 'destroyed', error: 'timeout' }), 3000);
    });
}

function describe(o: Outcome): string {
    return o.kind === 'open' ? '101' : o.kind === 'status' ? String(o.status) : `destroyed (${o.error})`;
}

function mustOpen(o: Outcome, label: string): Extract<Outcome, { kind: 'open' }> {
    assert(o.kind === 'open', `${label} → 101 (got ${describe(o)})`);
    if (o.kind !== 'open') throw new Error(`${label}: cannot continue without the socket`);
    return o;
}

async function main() {
    console.log(`/ws feed with ENFORCE_WS_AUTH ${OPEN_FEED ? '=false (the open-feed escape hatch)' : 'UNSET (the fresh-download default)'}...\n`);
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    // The invite-redeem path's own join (an open registration with no inviter is refused).
    const { registerMemberInternal } = await import('./engine/members.js');
    const join = (pubKeyHex: string, callsign: string) => registerMemberInternal(se.broadcast, pubKeyHex, callsign, alice.pubKeyHex, null);

    await initTls();
    se.initStateEngine();
    const port = await freePort();
    await startHttpsServer(port);
    const base = `wss://localhost:${port}`;

    const member = (callsign: string): Id => {
        const id = keypair();
        // A profile photo, because posting to the marketplace needs one.
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, avatar_url)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', 'seed', '/uploads/avatar.jpg')`).run(id.pubKeyHex, callsign);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        return id;
    };
    const alice = member('alice');
    const bob = member('bob');
    const carol = member('carol');
    const guestKey = keypair();   // holds a keypair and signs, but is not a member here (PWA guest)
    const joinerKey = keypair();  // signs before their membership exists, then joins

    // ── 1. Upgrades ──
    console.log('— upgrades —');
    const anon = mustOpen(await upgrade(`${base}/ws`), 'unsigned /ws');
    const guest = mustOpen(await upgrade(`${base}/ws?${signedWsQuery(guestKey)}`), 'signed by a non-member key /ws');
    const joiner = mustOpen(await upgrade(`${base}/ws?${signedWsQuery(joinerKey)}`), 'signed by a key about to join /ws');
    const aliceWs = mustOpen(await upgrade(`${base}/ws?${signedWsQuery(alice)}`), 'signed by member alice /ws');
    const carolWs = mustOpen(await upgrade(`${base}/ws?${signedWsQuery(carol)}`), 'signed by member carol /ws');

    if (!OPEN_FEED) {
        const forged = await upgrade(`${base}/ws?${signedWsQuery(alice, { signer: keypair().privateKey })}`);
        assert(forged.kind === 'status' && forged.status === 401, `alice's pubkey signed by another key → 401 (got ${describe(forged)})`);

        // The signature is checked before the nonce is spent, so a forger who sees (or guesses) a nonce
        // cannot burn it and lock the real member out of their own connect.
        const sharedNonce = crypto.randomBytes(16).toString('hex');
        const forgedFirst = await upgrade(`${base}/ws?${signedWsQuery(bob, { nonce: sharedNonce, signer: keypair().privateKey })}`);
        assert(forgedFirst.kind === 'status' && forgedFirst.status === 401, `a forged token for bob → 401 (got ${describe(forgedFirst)})`);
        const realAfter = await upgrade(`${base}/ws?${signedWsQuery(bob, { nonce: sharedNonce })}`);
        assert(realAfter.kind === 'open', `bob's real token with the nonce the forgery used → 101, the forgery did not spend it (got ${describe(realAfter)})`);
        if (realAfter.kind === 'open') realAfter.ws.close();

        const q = signedWsQuery(bob);
        const first = await upgrade(`${base}/ws?${q}`);
        assert(first.kind === 'open', `bob's fresh token → 101 (got ${describe(first)})`);
        if (first.kind === 'open') first.ws.close();
        const replay = await upgrade(`${base}/ws?${q}`);
        assert(replay.kind === 'status' && replay.status === 401, `bob's token replayed → 401 (got ${describe(replay)})`);

        const stale = await upgrade(`${base}/ws?${signedWsQuery(bob, { ts: Date.now() - 60 * 60 * 1000 })}`);
        assert(stale.kind === 'status' && stale.status === 401, `a token signed an hour ago → 401 (got ${describe(stale)})`);

        const partial = await upgrade(`${base}/ws?pubkey=${bob.pubKeyHex}`);
        assert(partial.kind === 'status' && partial.status === 401, `a pubkey with no signature → 401 (got ${describe(partial)})`);
    }

    await sleep(150);
    for (const [name, s] of [['unsigned', anon], ['guest', guest], ['alice', aliceWs]] as const) {
        assert(s.events.some(e => e.type === 'state_snapshot' && typeof e.memberCount === 'number'),
            `${name} socket gets the public state_snapshot on connect`);
    }
    for (const s of [anon, guest, joiner, aliceWs, carolWs]) { s.events.length = 0; s.raw.length = 0; }

    // ── 2/3. Real engine paths ──
    console.log('\n— events —');
    const conv = se.createConversation('dm', [alice.pubKeyHex, bob.pubKeyHex], alice.pubKeyHex);
    if (!conv) throw new Error('setup: could not create the DM');
    const DM_CIPHERTEXT = 'dm-ciphertext-' + crypto.randomBytes(4).toString('hex');
    se.sendMessage(conv.id, alice.pubKeyHex, DM_CIPHERTEXT, 'nonce-1');
    // A balance change, exactly as transfer() announces it (A2-20): scoped to its two parties.
    se.broadcast({ type: 'transaction', txn: { from: alice.pubKeyHex, to: bob.pubKeyHex, amount: 7, memo: 'rent' } }, [alice.pubKeyHex, bob.pubKeyHex]);
    // A trade request, as escrow announces it: to its two parties only (test-ws-feed-parties drives the real path).
    se.broadcast({ type: 'transaction_requested', transaction: { id: 'tx-1', buyerPublicKey: bob.pubKeyHex, sellerPublicKey: alice.pubKeyHex, credits: 12 } }, [alice.pubKeyHex, bob.pubKeyHex]);
    const ANNOUNCEMENT = 'members-meeting-' + crypto.randomBytes(4).toString('hex');
    se.adminBroadcastAnnouncement(ANNOUNCEMENT, 'at the hall', 'info');
    const PRIVATE_NOTE = 'gate-code-' + crypto.randomBytes(4).toString('hex');
    const startAt = new Date(Date.now() + 86_400_000).toISOString();
    const eventPost = se.createPost('event', 'social', 'Street picnic', 'Bring a plate', 0, 'fixed', alice.pubKeyHex, -28.55, 153.5,
        undefined, undefined, undefined, undefined, { eventStartAt: startAt, eventPlaceName: 'The park', eventPrivateNote: PRIVATE_NOTE });
    assert(!!eventPost, 'setup: a public event with a private note is created');
    const DIRECT_TITLE = 'for-carol-only-' + crypto.randomBytes(4).toString('hex');
    const directPost = se.createPost('offer', 'general', DIRECT_TITLE, 'just between us', 0, 'fixed', alice.pubKeyHex,
        undefined, undefined, undefined, undefined, undefined, undefined, { audienceScope: 'direct', targetPubkey: carol.pubKeyHex });
    assert(!!directPost, 'setup: a direct (members-only) post to carol is created');
    assert(!!join(keypair().pubKeyHex, 'newcomer'), 'setup: a newcomer joins');
    await sleep(400);

    const PRIVATE_TYPES = ['new_message', 'conversation_created', 'transaction', 'transaction_requested', 'system_announcement', 'member_joined', 'profile_updated'];
    const secrets = [DM_CIPHERTEXT, ANNOUNCEMENT, PRIVATE_NOTE, DIRECT_TITLE, bob.pubKeyHex];
    const strangers = OPEN_FEED ? [] : [['unsigned', anon], ['guest (signed, not a member)', guest]] as const;
    for (const [name, s] of strangers) {
        const got = s.events.map(e => e.type);
        for (const t of PRIVATE_TYPES) assert(!got.includes(t), `${name} socket does not get ${t} (got [${got.join(', ')}])`);
        for (const secret of secrets) assert(!s.raw.some(r => r.includes(secret)), `${name} socket never sees ${secret.slice(0, 14)}…`);
        assert(s.events.every(e => Object.keys(e).length === 1), `${name} socket gets bare { type } doorbells only`);
        assert(got.filter(t => t === 'new_post').length === 1, `${name} socket gets exactly one new_post doorbell — the public event, not the direct post (got ${got.filter(t => t === 'new_post').length})`);
    }

    if (OPEN_FEED) {
        const got = anon.events.map(e => e.type);
        for (const t of ['system_announcement', 'member_joined']) {
            assert(got.includes(t), `open feed: unsigned socket gets ${t}, as before this change`);
        }
        // A DM, a trade and a transfer are scoped to their parties, so even the open feed never carries them.
        for (const t of ['transaction', 'new_message', 'conversation_created', 'transaction_requested']) {
            assert(!got.includes(t), `open feed: unsigned socket never gets the scoped ${t}`);
        }
        assert(!anon.raw.some(r => r.includes(DM_CIPHERTEXT)), 'open feed: unsigned socket never sees a DM');
        assert(!anon.raw.some(r => r.includes(DIRECT_TITLE)), 'open feed: unsigned socket still never gets a direct post');
    }

    const aGot = aliceWs.events.map(e => e.type);
    for (const t of ['conversation_created', 'new_message', 'transaction', 'transaction_requested', 'system_announcement', 'new_post', 'member_joined']) {
        assert(aGot.includes(t), `member alice gets ${t}`);
    }
    assert(aliceWs.raw.some(r => r.includes(DM_CIPHERTEXT)), 'member alice gets the DM notice in full');
    assert(aliceWs.events.some(e => e.type === 'new_post' && e.post?.title === 'Street picnic'), 'member alice gets the public event post in full');
    const cGot = carolWs.events.map(e => e.type);
    assert(cGot.includes('system_announcement') && cGot.includes('member_joined'), 'member carol gets the community-wide events, as before');
    assert(!cGot.includes('new_message') && !cGot.includes('conversation_created') && !carolWs.raw.some(r => r.includes(DM_CIPHERTEXT)),
        "member carol does not get alice and bob's DM");
    assert(!cGot.includes('transaction_requested'), 'member carol does not get a trade request she is not a party to');
    assert(!cGot.includes('transaction'), 'member carol does not get a transfer she is not a party to');
    assert(carolWs.raw.some(r => r.includes(DIRECT_TITLE)), 'member carol gets the direct post addressed to her');

    // ── 4. Mid-join promotion ──
    if (!OPEN_FEED) {
        console.log('\n— joining while connected —');
        assert(!joiner.events.some(e => e.type === 'system_announcement'), 'before joining, the joiner socket gets no announcement');
        assert(!!join(joinerKey.pubKeyHex, 'joiner'), 'setup: the joiner joins');
        await sleep(150);
        joiner.events.length = 0;
        const LATER = 'after-join-' + crypto.randomBytes(4).toString('hex');
        se.adminBroadcastAnnouncement(LATER, 'welcome', 'info');
        await sleep(200);
        assert(joiner.events.some(e => e.type === 'system_announcement' && e.title === LATER), 'after its member_joined, the same socket gets member events');
        assert(!guest.raw.some(r => r.includes(LATER)), 'the guest socket still does not');
    }

    // ── 4b. A pruned member's open socket is demoted ──
    if (!OPEN_FEED) {
        console.log('\n— pruned while connected —');
        se.adminPruneUser(carol.pubKeyHex, 'owner:password');
        await sleep(150);
        carolWs.events.length = 0; carolWs.raw.length = 0; aliceWs.events.length = 0;
        const AFTER_PRUNE = 'after-prune-' + crypto.randomBytes(4).toString('hex');
        se.adminBroadcastAnnouncement(AFTER_PRUNE, 'members only', 'info');
        await sleep(200);
        assert(aliceWs.events.some(e => e.type === 'system_announcement' && e.title === AFTER_PRUNE), 'alice still gets member events');
        assert(!carolWs.raw.some(r => r.includes(AFTER_PRUNE)), 'carol, pruned while connected, no longer gets member events on her open socket');
        assert(carolWs.events.every(e => Object.keys(e).length === 1), 'carol\'s socket now gets bare doorbells only, like a stranger');
    }

    // ── 5. /ws/logs unchanged ──
    const logs = await upgrade(`${base}/ws/logs`);
    assert(logs.kind === 'status' && logs.status === 401, `/ws/logs without admin auth → 401 (got ${describe(logs)})`);

    for (const s of [anon, guest, joiner, aliceWs, carolWs]) s.ws.close();
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ /ws feed auth checks PASSED.');
}
main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
