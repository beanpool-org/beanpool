/**
 * #143 slice step 1 — the cross-node purchase route's refusal matrix.
 *
 * WHAT THIS IS FOR. `POST /api/federation/purchase` is the first thing in the system that can debit a member
 * on behalf of another community. Everything downstream of it — escrow, the signed receipt, the bridge tab —
 * is already tested. What is new, and what this covers, is the set of things that must be **impossible to
 * ask for**, and the rule that a refusal never costs the member a bean.
 *
 * `beginOutboundSettlement` debits the buyer into escrow as its very first act. So every check the route can
 * make beforehand is a refusal that needs no compensating entry — and every check it *fails* to make is a
 * ledger move that has to be unwound. That is why the assertions below all end the same way: the buyer's
 * balance is untouched and the node still sums to where it started.
 *
 * WHAT IT CANNOT COVER, and why that is honest rather than convenient: the happy path needs a real peer on
 * the other end of a real connection. The furthest a single process can get is the transport check — which is
 * exactly the point where every gate has passed and the settlement call is next. Reaching that specific
 * refusal is therefore a POSITIVE result here: it proves a well-formed request gets all the way through. One
 * purchase actually completing is slice step 2, against two live nodes.
 *
 * RUNS IN BOTH FLAG STATES. `FEDERATION_SETTLEMENT_ENABLED` is a module const read at import, so one process
 * sees one value. With the flag off this asserts the kill switch refuses everything; with it on it runs the
 * full matrix. test-all.sh runs it both ways, which is the only way to cover a const.
 *
 * Run: ENABLE_PEER_CONNECTORS=true FEDERATION_SETTLEMENT=true BEANPOOL_DATA_DIR=$(mktemp -d) \
 *        pnpm exec tsx src/test-federation-purchase-route.ts
 */
import crypto from 'node:crypto';
import { generateKeyPair } from '@libp2p/crypto/keys';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { initStateEngine, reconcileLedgerFromDb, getCommonsBalanceExact } from './state-engine.js';
import { ledger } from './engine/ledger.js';
import { db } from './db/db.js';
import { addConnector, setConnectorCreditCap } from './connector-manager.js';
import { FEDERATION_SETTLEMENT_ENABLED, SETTLEMENT_REFUSED_CODE } from './federation-settlement.js';
import { createFederationPurchaseRoutes } from './routes/federation-purchase.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const r4 = (n: number): number => Math.round(n * 10000) / 10000;
const bal = (pk: string): number =>
    r4((db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(pk) as any)?.balance ?? 0);

/** Every account row except the COMMONS_POOL shadow, plus the live global. A refusal must not move it. */
const nodeTotal = (): number => {
    const s = (db.prepare(`SELECT COALESCE(SUM(balance),0) AS s FROM accounts WHERE public_key != 'COMMONS_POOL'`)
        .get() as { s: number }).s;
    return r4(s + getCommonsBalanceExact());
};

function makeMember(callsign: string, balance: number, homeNodeUrl?: string): string {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const pk = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at, earned_credit, home_node_url)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 500, ?)`)
        .run(pk, callsign, homeNodeUrl ?? null);
    // Epoch at NOW, not 0 — epoch 0 is 1970 and the first read would charge ~56 years of demurrage (#138).
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, ?)`)
        .run(pk, balance, ledger.getCurrentEpoch());
    reconcileLedgerFromDb();
    return pk;
}

/** A pubkey that is nobody — what a seller on another node looks like before any visitor row exists. */
const stranger = (): string => crypto.randomBytes(32).toString('hex');

async function main() {
    const flag = FEDERATION_SETTLEMENT_ENABLED;
    console.log(`Running #143 cross-node purchase route checks (settlement flag ${flag ? 'ON' : 'OFF'})...\n`);
    if (process.env.ENABLE_PEER_CONNECTORS !== 'true') {
        throw new Error('Run with ENABLE_PEER_CONNECTORS=true — connector reads short-circuit otherwise');
    }
    initStateEngine();

    const router = createFederationPurchaseRoutes({
        checkAdminAuth: async () => false,
        rateLimit: () => true,
        clampLimit: (_v: unknown, def = 20) => def,
        clampOffset: () => 0,
        activeConnections: new Map(),
        calculateAnalytics: () => ({}),
        enforceReadAuth: false,
    });
    const layer = (router as any).stack.find((l: any) =>
        l.path === '/api/federation/purchase' && l.methods.includes('POST'));
    if (!layer) throw new Error('The purchase route is not mounted — this test is looking at the wrong path');

    /** Invoke the mounted handler the way Koa would. `actor` undefined = an unsigned request. */
    const buy = async (actor: string | undefined, body: Record<string, unknown>) => {
        const ctx: any = { state: actor ? { actor } : {}, requestBody: body, status: 200, body: undefined };
        await layer.stack[layer.stack.length - 1](ctx, async () => {});
        return ctx;
    };

    // Two real peer identities — a genuine peer id, since the route derives it from the connector address.
    const peerKey = await generateKeyPair('Ed25519');
    const PEER = peerIdFromPrivateKey(peerKey).toString();
    const mirrorKey = await generateKeyPair('Ed25519');
    const MIRROR = peerIdFromPrivateKey(mirrorKey).toString();
    const passiveKey = await generateKeyPair('Ed25519');
    const PASSIVE = peerIdFromPrivateKey(passiveKey).toString();
    const blockedKey = await generateKeyPair('Ed25519');
    const BLOCKED = peerIdFromPrivateKey(blockedKey).toString();

    const PEER_URL = 'https://byron.beanpool.org';
    const PEER_ADDR = `/dns4/byron.beanpool.org/tcp/4001/p2p/${PEER}`;
    addConnector(PEER_ADDR, 'peer', 'Byron', PEER_URL);
    setConnectorCreditCap(PEER_ADDR, 5_000);
    addConnector(`/dns4/backup.beanpool.org/tcp/4001/p2p/${MIRROR}`, 'mirror', 'Backup', 'https://backup.beanpool.org');
    // A PASSIVE peer — a trading partner we do not dial. Exactly one side of a healthy pair is Passive, so
    // this is the ordinary case, not an edge case, and it must be able to BUY as well as sell.
    const PASSIVE_URL = 'https://sleepy.beanpool.org';
    addConnector(`/dns4/sleepy.beanpool.org/tcp/4001/p2p/${PASSIVE}`, 'peer', 'Sleepy', PASSIVE_URL, /* enabled */ false);
    setConnectorCreditCap(`/dns4/sleepy.beanpool.org/tcp/4001/p2p/${PASSIVE}`, 5_000);
    // BLOCKED is the control for "stop trading with them" — the one Passive was being misused as.
    const BLOCKED_URL = 'https://shunned.beanpool.org';
    addConnector(`/dns4/shunned.beanpool.org/tcp/4001/p2p/${BLOCKED}`, 'blocked', 'Shunned', BLOCKED_URL);
    // A peer whose address carries no /p2p/ component — reachable config, unusable for settlement.
    const NOPEER_URL = 'https://nameless.beanpool.org';
    addConnector('/dns4/nameless.beanpool.org/tcp/4001', 'peer', 'Nameless', NOPEER_URL);

    // EVERY member seeded before the baseline. Seeding mints beans from nothing — a fixture's privilege, not
    // the code's — so one created later reads as a conservation failure. This check has now caught me doing
    // that three times across #138, the orchestration suite and here; it stays exactly as it is.
    const buyer = makeMember('Buyer', 400);
    const localSeller = makeMember('Local Seller', 0);
    const visitingSeller = makeMember('Visiting Seller', 0, PEER_URL);
    const visitorBuyer = makeMember('Visiting Buyer', 100, 'https://elsewhere.beanpool.org');
    const baseline = nodeTotal();
    const buyerBefore = bal(buyer);
    const good = { nodeUrl: PEER_URL, sellerPublicKey: stranger(), amount: 25 };

    if (!flag) {
        // ── The kill switch, which is the state every node ships in ──────────────────────────────
        const off = await buy(buyer, good);
        assert(off.status === 503 && off.body?.code === SETTLEMENT_REFUSED_CODE,
            `a well-formed purchase is refused 503 with the settlement code while the flag is off (${off.status})`);
        assert(bal(buyer) === buyerBefore && nodeTotal() === baseline,
            'and nothing moved — the switch is checked before any validation, let alone any ledger write');

        // The gate must not be bypassable by a malformed request finding a different code path first.
        for (const [name, body] of Object.entries({
            'no seller': { nodeUrl: PEER_URL, amount: 25 },
            'bad amount': { nodeUrl: PEER_URL, sellerPublicKey: stranger(), amount: -5 },
            'unknown peer': { nodeUrl: 'https://nowhere.example', sellerPublicKey: stranger(), amount: 25 },
            'no actor': { nodeUrl: PEER_URL, sellerPublicKey: stranger(), amount: 25 },
        })) {
            const res = await buy(name === 'no actor' ? undefined : buyer, body as any);
            assert(res.status === 503 && res.body?.code === SETTLEMENT_REFUSED_CODE,
                `the switch wins over "${name}" too — it is the first check, not one of several (${res.status})`);
        }
        console.log(`\n${passed}/${run} checks passed.`);
        if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
        console.log('⭐️ #143 route: the kill switch refuses everything, and costs nothing.');
        return;
    }

    // ── Identity: you may only spend your own beans ───────────────────────────────────────────────
    const unsigned = await buy(undefined, good);
    assert(unsigned.status === 401, `an unsigned request is refused (${unsigned.status})`);

    const impersonating = await buy(buyer, { ...good, buyerPublicKey: localSeller });
    assert(impersonating.status === 403,
        `naming a different buyer than the signer is refused (${impersonating.status}) — other marketplace routes `
        + 'fall back to the body field, and here that would let one valid signature spend anyone\'s beans');

    const ghost = await buy(stranger(), good);
    assert(ghost.status === 403, `a signer who is not a member of this community is refused (${ghost.status})`);

    const visiting = await buy(visitorBuyer, good);
    assert(visiting.status === 503 && visiting.body?.code === SETTLEMENT_REFUSED_CODE,
        `a VISITOR cannot buy from here (${visiting.status}) — their beans live on their home ledger, and this `
        + 'node charging them is the #102 bug in a new place');

    // ── Shape of the trade ───────────────────────────────────────────────────────────────────────
    const noSeller = await buy(buyer, { nodeUrl: PEER_URL, amount: 25 });
    assert(noSeller.status === 400, `a purchase with no seller is refused (${noSeller.status})`);

    for (const amount of [0, -5, 'lots', NaN, Infinity, null]) {
        const res = await buy(buyer, { ...good, amount });
        assert(res.status === 400, `amount ${String(amount)} is refused (${res.status})`);
    }

    for (const synthetic of ['COMMONS_POOL', 'SYSTEM', 'escrow_abc', 'bridge_byron', 'project_1', 'treasury_x']) {
        const res = await buy(buyer, { ...good, sellerPublicKey: synthetic });
        assert(res.status === 400,
            `${synthetic} cannot be the seller (${res.status}) — a purchase aimed at a bridge row would pay into `
            + 'the very account that records what the two nodes owe each other');
    }

    const localTrade = await buy(buyer, { ...good, sellerPublicKey: localSeller });
    assert(localTrade.status === 400,
        `a LOCAL seller is refused (${localTrade.status}) — settling it would open a bridge tab against a `
        + 'purchase that never left the node: real beans, imaginary obligation');

    const selfTrade = await buy(buyer, { ...good, sellerPublicKey: buyer });
    assert(selfTrade.status === 400, `buying from yourself is refused (${selfTrade.status})`);

    // ── The peer comes from the operator's connector list, never from the request ─────────────────
    const unknownPeer = await buy(buyer, { ...good, nodeUrl: 'https://nowhere.example' });
    assert(unknownPeer.status === 404,
        `a node that is not a configured connector is refused (${unknownPeer.status}) — the client names a `
        + 'community, but which credit line that maps to is ours to decide');

    const noPeerNamed = await buy(buyer, { sellerPublicKey: stranger(), amount: 25 });
    assert(noPeerNamed.status === 404, `naming no peer at all is refused (${noPeerNamed.status})`);

    const toMirror = await buy(buyer, { ...good, nodeUrl: 'https://backup.beanpool.org' });
    assert(toMirror.status === 403 && /backup replica/i.test(toMirror.body?.error ?? ''),
        `a MIRROR is refused, and says why (${toMirror.status}) — a replica mirrors a ledger, it does not `
        + 'author one, and the outer trust check admits both levels');

    // A PASSIVE peer is a full trading partner. This assertion is the inverse of the one it replaces, which
    // asserted the bug: `enabled` is a dialling setting, and gating trade on it made federation permanently
    // one-directional — the Passive side could sell but never buy, so a `bridge_<peer>` tab could only ever
    // grow. Reaching the transport refusal means every gate passed.
    const toPassive = await buy(buyer, { ...good, nodeUrl: PASSIVE_URL });
    assert(toPassive.status === 503 && /peer-to-peer transport/i.test(toPassive.body?.error ?? ''),
        `a PASSIVE peer can be bought from (${toPassive.status}: ${toPassive.body?.error}) — Passive means we `
        + 'do not dial them, not that we do not trade with them, and the inbound side never checked it either');

    const toBlocked = await buy(buyer, { ...good, nodeUrl: BLOCKED_URL });
    assert(toBlocked.status === 403 && toBlocked.body?.code === SETTLEMENT_REFUSED_CODE,
        `a BLOCKED peer is refused (${toBlocked.status}) — dropping the \`enabled\` gate costs no capability, `
        + 'because this is the control that actually means "stop trading", and it is in the Settings dropdown');
    assert(/Shunned/.test(toBlocked.body?.error ?? ''),
        `and the refusal NAMES the community (${toBlocked.body?.error}) — a member who named a peer and got a `
        + 'refusal is the only reader of this string, so "that one" told them nothing');

    const noPeerId = await buy(buyer, { ...good, nodeUrl: NOPEER_URL });
    assert(noPeerId.status === 400,
        `a connector whose address carries no peer id is refused (${noPeerId.status}) — settlement is keyed on `
        + 'the peer id for the bridge account, the cap and the receipt, so there is nothing to key on');

    // ── A well-formed request reaches the transport, which is as far as one process goes ──────────
    // Reaching THIS refusal is the positive result: every gate above has passed and the settlement call is
    // the next statement. It also proves the route resolves a peer id, a member and an amount correctly.
    const reached = await buy(buyer, good);
    assert(reached.status === 503 && /peer-to-peer transport/i.test(reached.body?.error ?? ''),
        `a valid purchase gets all the way to the transport (${reached.status}: ${reached.body?.error}) — no `
        + 'libp2p in this process, so completing one is slice step 2, on two live nodes');

    const viaAddress = await buy(buyer, { peerAddress: PEER_ADDR, sellerPublicKey: stranger(), amount: 25 });
    assert(viaAddress.status === 503 && /peer-to-peer transport/i.test(viaAddress.body?.error ?? ''),
        'and a peer named by multiaddr resolves the same way as one named by node URL');

    const toVisitingSeller = await buy(buyer, { ...good, sellerPublicKey: visitingSeller });
    assert(toVisitingSeller.status === 503 && /peer-to-peer transport/i.test(toVisitingSeller.body?.error ?? ''),
        'a seller who is a VISITOR here — a known member of the peer — is allowed through, unlike a local one');

    // ── The rule that matters: not one refusal cost the buyer anything ────────────────────────────
    assert(bal(buyer) === buyerBefore,
        `across all ${run} attempts the buyer's balance is unchanged (${bal(buyer)}) — every check runs BEFORE `
        + 'beginOutboundSettlement, which escrows as its first act');
    assert(nodeTotal() === baseline,
        `and the node still sums to where it started (${nodeTotal()} vs ${baseline}) — no refusal needed a `
        + 'compensating entry, because no refusal moved anything');
    assert((db.prepare(`SELECT COUNT(*) AS n FROM settlements`).get() as any).n === 0,
        'and not one settlement row was opened — a refused purchase leaves no state to recover');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ #143 route: every refusal is free, and a valid purchase reaches the wire.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
