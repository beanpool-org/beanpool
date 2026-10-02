/**
 * A settlement's key never names another account's money, and a caller-chosen id never names money at all (the review of
 * #1329 at 2e3caa2b, measured there and on origin/main).
 *
 * `/api/federation/purchase` and `/api/federation/commission` took a caller-chosen `key`, and a settlement holds its Beans in
 * `escrow_<key>`. A crowdfund project's escrow is `escrow_<project id>` and a deal's is `escrow_<transaction id>`, so a key
 * could name either. `beginOutboundSettlement` read a NEW settlement whose escrow already held Beans as "already funded by an
 * earlier attempt" and debited nobody; when the ask failed, `abandonOutboundSettlement` paid amount + fee out of that escrow to
 * the caller. A member with 0 Beans took 40.6 of a project's 50, and 3.96 of a deal's 4 (whose seller could then never be
 * paid); a link keeper's commission did the same into the link enterprise.
 *
 *  1. The engine, in this process: a new settlement whose key names money already here (an escrow holding Beans, an escrow at
 *     0, a project with no escrow yet, a deal, a member, an enterprise, the Commons, an escrow's own name) is refused with
 *     `key_clash`: no row, and nothing moves. A new key funds from the buyer; the same key again (a retry) finds its row and
 *     debits nobody a second time; abandoning it gives back exactly the buyer's own amount + fee.
 *  2. Over real HTTPS through the real signature middleware, in a child node with settlement ON, its own libp2p transport and
 *     a trading peer that isn't there (a made-up key at 127.0.0.1:9): a project holding Pat's 50, a deal whose escrow holds
 *     Bea's 4, and a second project holding 30, all made over HTTPS. Jo's own purchase, with no key: the ask fails, and he
 *     gets back exactly his own Beans; sent again with the key the node gave him, it is answered from its row and nothing
 *     moves; with that key and another amount or seller it is 409 key_conflict.
 *  3. Mallory (0 Beans) buys with a key that is the project's id, the deal's id, `escrow_<deal>`, an enterprise's key, the
 *     Commons, Jo's key, a fresh key in the node's own form, a commission's form, Jo's key respelt, or not text: every one is
 *     refused (400 invalid_key or 409 key_conflict), no settlement is written, and nothing moves: her balance, both escrows,
 *     the node's total.
 *  4. Kit, the link's keeper, commissions with a key that is the second project's id, the deal's id, `escrow_<deal>`, the
 *     link's own key, Jo's purchase key, a fresh key in the commission form or the purchase form, or not text: each refused,
 *     and nothing moves (the link, the Commons, the escrows). His commission with no key fails the ask and gives the link back
 *     exactly what it held; sent again with its own key it is answered from its row.
 *  5. A post's id: Vic posts with an id that is a project's id, the deal's id, `escrow_<deal>`, a settlement's key, an
 *     enterprise's key, the Commons, or not text: each 400, and no post is made. A fresh UUID (what the phone app sends)
 *     still posts, under that id.
 *  6. The escrow-key boot migration is gone: a pending deal whose escrow is empty, on a post whose id is a project's (planted
 *     while the node is stopped, as a caller-chosen post id could make it before), takes nothing from that project's escrow
 *     when the node boots again.
 *  7. The operators' data checks (the SQL in the PR body), in this process: they list a settlement whose key names a project
 *     and what it moved, and a projects row made under another enterprise's key; not a settlement under a key the node made.
 *
 * It imports nothing that origin/main lacks, so the same file runs there to show each check failing first.
 *
 * Local only: the servers it starts on localhost. The peer a purchase asks is a made-up key at a closed local port.
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-federation-settlement-key.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_ROLE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, reconcileLedgerFromDb, getCommonsBalanceExact, getMember, createTreasury } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { ledger } from './engine/ledger.js';
import { updateGatewayConfig } from './config/local-config.js';
import { DEFAULT_GATEWAY_CONFIG } from './config/gateway.js';
import { beginOutboundSettlement, abandonOutboundSettlement, SettlementError } from './federation-settlement-exchange.js';
import { getSettlement } from './federation-settlement-state.js';
import { rotateDailyPulse } from './daily-pulse.js';

const SCRIPT = fileURLToPath(import.meta.url);
const CHILD_FLAG = '--settlement-key-child';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}
const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;
const uuid = () => crypto.randomUUID();

// ── members and signed requests ─────────────────────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

interface Res { status: number; body: any }
async function callAt(base: string, method: 'GET' | 'POST', id: Id | null, urlPath: string, body?: unknown): Promise<Res> {
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${base}${urlPath}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed };
}
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body ?? null).slice(0, 220)}`;

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// CHILD: a node on its own data directory, seeded from SK_SEED, serving until its stdin closes.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

interface Seed {
    owner: string;
    members: { pk: string; name: string; balance: number }[];
    /** A trading peer that isn't there: its key, at a closed port on this machine. */
    peer: { address: string; url: string; peerId: string };
    /** Its link enterprise, kept by `keeper`, holding `balance`; and one of its listings cached here, `postId`, by `seller`. */
    link: { keeper: string; balance: number; seller: string; postId: string };
}

async function runChild(): Promise<void> {
    const seed = JSON.parse(process.env.SK_SEED ?? '{}') as Seed;
    await initTls();
    initStateEngine();
    // Seeded once: a restart on the same data finds the rows there and changes nothing.
    const first = !getMember(seed.owner);
    if (first) seedGenesisMember(seed.owner, 'Owner');
    const insert = db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at, invited_by, invite_code, avatar_ref, status)
                               VALUES (?, ?, ?, ?, 'TEST', 'https://example.com/a.jpg', 'active')`);
    if (first) {
        for (const m of seed.members) {
            insert.run(m.pk, m.name, ago(7 * DAY), seed.owner);
            // The epoch now, never 0: epoch 0 is 1970, and the first read would charge decades of demurrage.
            db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, ?)').run(m.pk, m.balance, ledger.getCurrentEpoch());
        }
        reconcileLedgerFromDb();
    }
    const { addConnector, setConnectorCreditCap } = await import('./connector-manager.js');
    if (first) {
        addConnector(seed.peer.address, 'peer', 'Faraway', seed.peer.url);
        setConnectorCreditCap(seed.peer.address, 500);
    }
    // This node's own transport, listening on this machine only for the test's life: the settlement routes ask it.
    const { startP2P } = await import('./p2p.js');
    await startP2P(0, 0);
    const { ensureFederationLink, setCommissionCeiling } = await import('./federation-link.js');
    const link = ensureFederationLink(seed.peer.peerId, 'Faraway', createTreasury, seed.link.keeper)!;
    if (first) {
        setCommissionCeiling(seed.peer.peerId, 500);
        db.prepare('UPDATE accounts SET balance = ?, last_demurrage_epoch = ? WHERE public_key = ?').run(seed.link.balance, ledger.getCurrentEpoch(), link.treasuryPubkey);
        // The seller is a member of the other community (a visitor's row with its home), and the listing came from there.
        db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, joined_at, home_node_url, is_visitor) VALUES (?, 'Far Seller', ?, ?, 1)`)
            .run(seed.link.seller, ago(7 * DAY), seed.peer.url);
        db.prepare(`INSERT OR IGNORE INTO posts (id, type, category, title, description, credits, author_pubkey, status, active, origin_node)
                    VALUES (?, 'offer', 'other', 'A far thing', 'test', 1, ?, 'active', 1, ?)`).run(seed.link.postId, seed.link.seller, seed.peer.url);
        reconcileLedgerFromDb();
    }
    const port = await startHttpsServer(0);
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } });
    process.stdout.write('@@ ' + JSON.stringify({ port, link: link.treasuryPubkey }) + '\n');
    process.stdin.on('data', () => { /* nothing is sent; the parent only closes it */ });
    process.stdin.on('end', () => process.exit(0));
}

interface Node { base: string; link: string; proc: ChildProcess; output: () => string; stop: () => Promise<void> }

/** Start a child node on `dataDir` with settlement ON, resolved once it serves. */
function startNode(dataDir: string, seed: Seed): Promise<Node> {
    fs.mkdirSync(dataDir, { recursive: true });
    const childEnv: Record<string, string | undefined> = {
        ...process.env, BEANPOOL_DATA_DIR: dataDir, ENABLE_PEER_CONNECTORS: 'true', FEDERATION_SETTLEMENT: 'true', SK_SEED: JSON.stringify(seed),
    };
    delete childEnv.CF_RECORD_NAME;
    delete childEnv.CF_API_TOKEN;
    delete childEnv.CF_ZONE_ID;
    delete childEnv.NODE_ROLE;
    delete childEnv.NODE_PROFILE;
    // The script under node itself with tsx's loader (process.execArgv), never the tsx wrapper: a kill reaches the node.
    const proc = spawn(process.execPath, [...process.execArgv, SCRIPT, CHILD_FLAG], { env: childEnv as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout!.on('data', (d) => { out += d.toString(); });
    proc.stderr!.on('data', (d) => { out += d.toString(); });
    const exited = new Promise<void>((resolve) => proc.on('exit', () => resolve()));
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error(`the child node did not serve within 90s:\n${out}`)); }, 90_000);
        exited.then(() => { clearTimeout(timer); reject(new Error(`the child node exited before it served:\n${out}`)); });
        const poll = setInterval(() => {
            const line = out.split('\n').find((l) => l.startsWith('@@ '));
            if (!line) return;
            clearInterval(poll);
            clearTimeout(timer);
            const { port, link } = JSON.parse(line.slice(3));
            resolve({
                base: `https://127.0.0.1:${port}`,
                link,
                proc,
                output: () => out,
                stop: async () => { proc.stdin!.end(); const t = setTimeout(() => proc.kill('SIGKILL'), 10_000); await exited; clearTimeout(t); },
            });
        }, 25);
        exited.then(() => clearInterval(poll));
    });
}

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// THE OPERATORS' DATA CHECKS: the same text as the PR body.
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Outbound settlements under a key this node did not make (`xn-` or `xc-` and a 36-character UUID). */
const SQL_FOREIGN_KEYS = `
SELECT s.key, s.state, s.buyer_pubkey, s.amount, s.fee, s.failure_reason, s.created_at
FROM settlements s
WHERE s.direction = 'outbound'
  AND NOT (length(s.key) = 39 AND substr(s.key, 1, 3) IN ('xn-', 'xc-'))
ORDER BY s.created_at`;

/** What each of those moved, and from or to whose escrow: every ledger row naming its key, or its escrow. */
const SQL_FOREIGN_KEY_MOVES = `
SELECT s.key, t.id, t.from_pubkey, t.to_pubkey, t.amount, t.memo, t.timestamp
FROM settlements s
JOIN transactions t ON t.from_pubkey = 'escrow_' || s.key OR t.to_pubkey = 'escrow_' || s.key
WHERE s.direction = 'outbound'
  AND NOT (length(s.key) = 39 AND substr(s.key, 1, 3) IN ('xn-', 'xc-'))
ORDER BY s.key, t.timestamp`;

/** A projects row under an enterprise's key whose creator is not one of that enterprise's keepers (#1329's last clause). */
const SQL_PROJECT_ON_ANOTHERS_ENTERPRISE = `
SELECT p.id, p.creator_pubkey, p.status, p.current_amount
FROM projects p JOIN members m ON m.public_key = p.id AND m.is_treasury = 1
WHERE p.creator_pubkey IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM treasury_operators o WHERE o.treasury_pubkey = p.id AND o.member_pubkey = p.creator_pubkey)`;

// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// PARENT
// ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

/** Every account row but the COMMONS_POOL shadow, plus the live Commons. */
const nodeTotal = () => r4((db.prepare(`SELECT COALESCE(SUM(balance), 0) AS s FROM accounts WHERE public_key != 'COMMONS_POOL'`).get() as { s: number }).s + getCommonsBalanceExact());
const bal = (pk: string) => r4((db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(pk) as { balance: number } | undefined)?.balance ?? 0);
const hasAccount = (pk: string) => !!db.prepare('SELECT 1 FROM accounts WHERE public_key = ?').get(pk);

function seedMember(name: string, balance: number, isTreasury = false): string {
    const pk = newId(name).pk;
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_ref, status, is_treasury) VALUES (?, ?, ?, 'https://example.com/a.jpg', 'active', ?)`)
        .run(pk, name, ago(7 * DAY), isTreasury ? 1 : 0);
    db.prepare('INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, ?)').run(pk, balance, ledger.getCurrentEpoch());
    return pk;
}

async function engineChecks(): Promise<void> {
    console.log('--- 1. the engine: a new settlement\'s key names no money here ---');
    initStateEngine();
    const { generateKeyPair } = await import('@libp2p/crypto/keys');
    const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
    const PEER = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
    const seller = crypto.randomBytes(32).toString('hex');

    // Every row and Bean seeded before the baseline: seeding mints from nothing, which is a fixture's privilege.
    const buyer = seedMember('Buyer', 100);
    const holder = seedMember('Holder', 0);
    const shop = seedMember('Shop', 20, true);
    const project = uuid();
    db.prepare(`INSERT INTO projects (id, creator_pubkey, title, description, photos, goal_amount, status) VALUES (?, ?, 'Orchard', 'test', '[]', 1000, 'ACTIVE')`).run(project, holder);
    db.prepare('INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 50, ?)').run(`escrow_${project}`, ledger.getCurrentEpoch());
    const bareProject = uuid();     // a project nobody has pledged to yet: no escrow account
    db.prepare(`INSERT INTO projects (id, creator_pubkey, title, description, photos, goal_amount, status) VALUES (?, ?, 'Hall', 'test', '[]', 1000, 'ACTIVE')`).run(bareProject, holder);
    const deal = uuid();
    const dealPost = uuid();
    db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status) VALUES (?, 'offer', 'other', 'Mowing', 'test', 4, ?, 'pending')`).run(dealPost, holder);
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at) VALUES (?, ?, ?, ?, 4, 'pending', ?)`)
        .run(deal, dealPost, buyer, holder, new Date().toISOString());
    db.prepare('INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 4, ?)').run(`escrow_${deal}`, ledger.getCurrentEpoch());
    const emptyEscrow = uuid();     // an escrow account at 0: one that held Beans and paid them out
    db.prepare('INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, ?)').run(`escrow_${emptyEscrow}`, ledger.getCurrentEpoch());
    reconcileLedgerFromDb();

    const baseline = nodeTotal();
    const held = () => [bal(buyer), bal(`escrow_${project}`), bal(`escrow_${deal}`), bal(shop), bal(holder)].join(',');
    const heldBefore = held();
    const clashes: [string, string][] = [
        [project, 'a project\'s id (its escrow holds 50)'],
        [deal, 'a deal\'s id (its escrow holds 4)'],
        [emptyEscrow, 'the name of an escrow at 0'],
        [bareProject, 'a project\'s id with no escrow yet'],
        [holder, 'a member\'s key'],
        [shop, 'an enterprise\'s key'],
        ['COMMONS_POOL', 'the Commons'],
        [`escrow_${deal}`, 'an escrow\'s own name'],
    ];
    for (const [key, what] of clashes) {
        let thrown: unknown = null;
        try {
            beginOutboundSettlement({ key, peerId: PEER, buyerPublicKey: buyer, sellerPublicKey: seller, amount: 10 });
        } catch (e) { thrown = e; }
        const reason = thrown instanceof SettlementError ? thrown.reason : String((thrown as any)?.message ?? thrown);
        const row = getSettlement(key)?.state ?? null;
        assert(thrown instanceof SettlementError && thrown.reason === 'key_clash' && !row && !hasAccount(`escrow_escrow_${deal}`),
            `1. a new settlement keyed on ${what} is refused with key_clash, and no row is written (${reason}, row ${JSON.stringify(row)})`);
        // Where a build let it through (origin/main did), the ask fails and the hold is released: that release is where
        // the escrow's Beans went to the caller. Never reached here when the settlement is refused.
        if (row === 'escrowed') {
            try { abandonOutboundSettlement(key, 'ASK_UNREACHABLE'); } catch (e: any) { console.log(`   (abandoning it threw: ${e?.message ?? e})`); }
        }
        assert(held() === heldBefore && nodeTotal() === baseline,
            `1. and nothing moves: the buyer, the escrows, the enterprise, the node's total (${heldBefore} → ${held()}, ${baseline} → ${nodeTotal()})`);
    }

    // A key the node makes: funds from the buyer, once.
    const key = `xn-${uuid()}`;
    const opened = beginOutboundSettlement({ key, peerId: PEER, buyerPublicKey: buyer, sellerPublicKey: seller, amount: 10 });
    assert(opened.state === 'escrowed' && bal(buyer) === 89.85 && bal(`escrow_${key}`) === 10.15,
        `1. a new key the node made is funded from the buyer: 10 and its fee of 0.15 (${opened.state}, buyer ${bal(buyer)}, escrow ${bal(`escrow_${key}`)})`);
    const again = beginOutboundSettlement({ key, peerId: PEER, buyerPublicKey: buyer, sellerPublicKey: seller, amount: 10 });
    assert(again.key === key && again.state === 'escrowed' && bal(buyer) === 89.85 && bal(`escrow_${key}`) === 10.15,
        `1. the same key again is a retry: it finds its row and debits nobody a second time (buyer ${bal(buyer)}, escrow ${bal(`escrow_${key}`)})`);
    abandonOutboundSettlement(key, 'ASK_UNREACHABLE');
    assert(bal(buyer) === 100 && bal(`escrow_${key}`) === 0 && getSettlement(key)?.state === 'abandoned' && nodeTotal() === baseline,
        `1. abandoning it gives the buyer back exactly their own 10.15, and the escrow ends at 0 (buyer ${bal(buyer)}, escrow ${bal(`escrow_${key}`)}, total ${nodeTotal()})`);
    assert(held() === heldBefore, `1. and the project's, the deal's and the enterprise's Beans are where they were (${held()})`);

    // An inbound settlement's key is the peer's choice and names no account here, so it takes no id the node makes itself.
    const pulseDay = new Date('2026-08-16T05:00:00Z');
    const pulseKey = `pulse_${new Date(pulseDay.getTime() - pulseDay.getTimezoneOffset() * 60_000).toISOString().split('T')[0]}`;
    db.prepare(`INSERT INTO settlements (key, direction, peer_id, buyer_pubkey, seller_pubkey, amount, fee, state)
                VALUES (?, 'inbound', ?, ?, ?, 1, 0, 'reserved')`).run(pulseKey, PEER, crypto.randomBytes(32).toString('hex'), holder);
    let pulsePost: any = null;
    let pulseError = '';
    try { pulsePost = rotateDailyPulse(pulseDay).post; } catch (e: any) { pulseError = String(e?.message ?? e); }
    assert(pulsePost?.id === pulseKey && !pulseError,
        `1. a trading peer's inbound key ${pulseKey} doesn't stop the node's own Daily Pulse post under that id (${pulsePost?.id ?? pulseError})`);
    assert(nodeTotal() === baseline, `1. and nothing moves (${baseline} → ${nodeTotal()})`);

    // ── 7. The operators' data checks ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- 7. the operators\' data checks ---');
    // A settlement made the old way, under a project's id, and the release it paid out of that project's escrow. Planted:
    // this build refuses to make one, which is the point.
    const legacy = uuid();
    db.prepare(`INSERT INTO projects (id, creator_pubkey, title, description, photos, goal_amount, status) VALUES (?, ?, 'Pool', 'test', '[]', 1000, 'ACTIVE')`).run(legacy, holder);
    db.prepare(`INSERT INTO settlements (key, direction, peer_id, buyer_pubkey, seller_pubkey, amount, fee, state, failure_reason)
                VALUES (?, 'outbound', ?, ?, ?, 40, 0.6, 'abandoned', 'ASK_UNREACHABLE')`).run(legacy, PEER, holder, seller);
    db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, memo, timestamp) VALUES (?, ?, ?, 40.6, ?, ?)`)
        .run(uuid(), `escrow_${legacy}`, holder, `Released cross-community hold (${legacy})`, new Date().toISOString());
    const foreign = db.prepare(SQL_FOREIGN_KEYS).all() as { key: string }[];
    assert(foreign.length === 1 && foreign[0].key === legacy,
        `7. the first check lists the settlement under a project's id, and not the one under a key the node made (${JSON.stringify(foreign.map(f => f.key))})`);
    const moves = db.prepare(SQL_FOREIGN_KEY_MOVES).all() as { key: string; from_pubkey: string; amount: number }[];
    assert(moves.length === 1 && moves[0].from_pubkey === `escrow_${legacy}` && moves[0].amount === 40.6,
        `7. the second lists what it moved: 40.6 out of that project's escrow (${JSON.stringify(moves)})`);
    // A projects row under an enterprise's key, made by someone who does not keep it (the old crowdfund route took ids).
    db.prepare(`INSERT INTO projects (id, creator_pubkey, title, description, photos, goal_amount, status) VALUES (?, ?, 'Taken', 'test', '[]', 10, 'ACTIVE')`).run(shop, holder);
    const taken = db.prepare(SQL_PROJECT_ON_ANOTHERS_ENTERPRISE).all() as { id: string }[];
    assert(taken.length === 1 && taken[0].id === shop,
        `7. the third lists a projects row made under another's enterprise (${JSON.stringify(taken.map(t => t.id))})`);
}

async function httpChecks(): Promise<void> {
    console.log('\n--- 2. over HTTPS, settlement ON: a real purchase, and its retry ---');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settlement-key-'));
    const { generateKeyPair } = await import('@libp2p/crypto/keys');
    const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
    const peer = peerIdFromPrivateKey(await generateKeyPair('Ed25519')).toString();
    // Port 9 on this machine: nothing listens, so the ask fails at once and nothing leaves the box.
    const peerAddress = `/ip4/127.0.0.1/tcp/9/p2p/${peer}`;
    const owner = newId('Owner');
    const [mallory, pat, cara, sam, bea, jo, kit, vic] = ['Mallory', 'Pat', 'Cara', 'Sam', 'Bea', 'Jo', 'Kit', 'Vic'].map(newId);
    const remoteSeller = crypto.randomBytes(32).toString('hex');
    const seed: Seed = {
        owner: owner.pk,
        members: [
            { pk: mallory.pk, name: 'Mallory', balance: 0 }, { pk: pat.pk, name: 'Pat', balance: 100 }, { pk: cara.pk, name: 'Cara', balance: 10 },
            { pk: sam.pk, name: 'Sam', balance: 0 }, { pk: bea.pk, name: 'Bea', balance: 100 }, { pk: jo.pk, name: 'Jo', balance: 100 },
            { pk: kit.pk, name: 'Kit', balance: 10 }, { pk: vic.pk, name: 'Vic', balance: 10 },
        ],
        peer: { address: peerAddress, url: 'https://faraway.invalid', peerId: peer },
        link: { keeper: kit.pk, balance: 2_000, seller: crypto.randomBytes(32).toString('hex'), postId: 'far-post' },
    };
    let node = await startNode(dir, seed);
    let their = new Database(path.join(dir, 'state.db'), { readonly: true, fileMustExist: true });
    const balOf = (pk: string) => r4((their.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(pk) as { balance: number } | undefined)?.balance ?? 0);
    // Every row's balance, the Commons row included: nothing below moves Beans into or out of the node.
    const total = () => r4((their.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM accounts').get() as { s: number }).s);
    const outbound = () => (their.prepare(`SELECT COUNT(*) AS n FROM settlements WHERE direction = 'outbound'`).get() as { n: number }).n;
    const postsBy = (pk: string) => (their.prepare('SELECT COUNT(*) AS n FROM posts WHERE author_pubkey = ?').get(pk) as { n: number }).n;
    const call = (who: Id, urlPath: string, body: unknown) => callAt(node.base, 'POST', who, urlPath, body);
    try {
        const link = node.link;
        // A project holding Pat's 50, a second holding 30, and a deal whose escrow holds Bea's 4: all made the way members make them.
        const made = await call(cara, '/api/crowdfund/projects', { title: 'A community orchard', description: 'test', goalAmount: 1000 });
        const projectA = made.body?.project?.id as string;
        const pledgedA = await call(pat, `/api/crowdfund/projects/${projectA}/pledge`, { amount: 50 });
        const madeB = await call(cara, '/api/crowdfund/projects', { title: 'A tool library', description: 'test', goalAmount: 1000 });
        const projectB = madeB.body?.project?.id as string;
        const pledgedB = await call(pat, `/api/crowdfund/projects/${projectB}/pledge`, { amount: 30 });
        assert(!!projectA && !!projectB && pledgedA.status === 200 && pledgedB.status === 200 && balOf(`escrow_${projectA}`) === 50 && balOf(`escrow_${projectB}`) === 30,
            `setup: Cara's two projects, with Pat's 50 and 30 in their escrows (${show(made)}; ${show(pledgedA)}; ${show(pledgedB)})`);
        const offer = await call(sam, '/api/marketplace/posts', { type: 'offer', category: 'other', title: 'Lawn mowing', description: 'test', credits: 4, authorPublicKey: sam.pk });
        // A member takes an offer once they have listed one of their own (CONTRIBUTION_REQUIRED).
        const beasOwn = await call(bea, '/api/marketplace/posts', { type: 'offer', category: 'other', title: 'Sourdough', description: 'test', credits: 2, authorPublicKey: bea.pk });
        const accepted = await call(bea, '/api/marketplace/posts/accept', { postId: offer.body?.post?.id, buyerPublicKey: bea.pk });
        const deal = accepted.body?.transaction?.id as string;
        assert(!!deal && balOf(`escrow_${deal}`) === 4, `setup: Bea takes Sam's mowing, and the deal's escrow holds her 4 (${show(offer)}; ${show(beasOwn)}; ${show(accepted)})`);
        if (!projectA || !projectB || !deal) throw new Error('setup failed: the checks below would aim at nothing');

        // ── Jo's own purchase, and its retry ──────────────────────────────────────────────────────────────────
        const purchase = (who: Id, body: Record<string, unknown>) => call(who, '/api/federation/purchase', { peerAddress, sellerPublicKey: remoteSeller, amount: 10, ...body });
        const baseline = total();
        const jos = await purchase(jo, {});
        const joKey = jos.body?.key as string;
        assert(jos.status === 409 && jos.body?.status === 'refused' && /^xn-[0-9a-f-]{36}$/.test(joKey ?? '') && balOf(jo.pk) === 100 && balOf(`escrow_${joKey}`) === 0,
            `2. Jo buys with no key: the node makes one, the ask fails, and he has exactly his own 100 back (${show(jos)}, Jo ${balOf(jo.pk)})`);
        assert(outbound() === 1 && total() === baseline, `2. one settlement, and the node's total unchanged (${outbound()}, ${baseline} → ${total()})`);
        const retried = await purchase(jo, { key: joKey });
        assert(retried.status === 409 && retried.body?.status === 'refused' && retried.body?.key === joKey && outbound() === 1 && balOf(jo.pk) === 100,
            `2. sent again with the key the node gave him, it is answered from its row: no second settlement, nothing charged (${show(retried)}, ${outbound()}, Jo ${balOf(jo.pk)})`);
        const otherAmount = await purchase(jo, { key: joKey, amount: 11 });
        const otherSeller = await purchase(jo, { key: joKey, sellerPublicKey: crypto.randomBytes(32).toString('hex') });
        assert([otherAmount, otherSeller].every(r => r.status === 409 && r.body?.reason === 'key_conflict') && outbound() === 1 && balOf(jo.pk) === 100,
            `2. his key with another amount or another seller is 409 key_conflict, and nothing moves (${show(otherAmount)}; ${show(otherSeller)})`);

        // ── Mallory aims a purchase's key at other people's money ─────────────────────────────────────────────
        console.log('\n--- 3. purchases whose key names other money ---');
        const heldBy = () => [balOf(mallory.pk), balOf(`escrow_${projectA}`), balOf(`escrow_${projectB}`), balOf(`escrow_${deal}`), balOf(link), balOf(jo.pk)].join(',');
        const before = heldBy();
        const keys: [unknown, string, number][] = [
            [projectA, 'the project\'s id', 40],
            [deal, 'the deal\'s id', 3.9409],
            [`escrow_${deal}`, 'escrow_<deal>', 1],
            [link, 'an enterprise\'s key', 1],
            ['COMMONS_POOL', 'the Commons', 1],
            [joKey, 'Jo\'s purchase key', 10],
            [`xn-${uuid()}`, 'a fresh key in the node\'s own form', 1],
            [`xc-${uuid()}`, 'a commission\'s form', 1],
            [joKey.toUpperCase(), 'Jo\'s key in capitals', 10],
            [` ${joKey}`, 'Jo\'s key with a space', 10],
            [7, 'a number', 1],
            [[joKey], 'a list holding Jo\'s key', 10],
            [{ key: joKey }, 'an object', 10],
            [true, 'true', 1],
            ['', 'an empty key', 1],
        ];
        for (const [key, what, amount] of keys) {
            const r = await purchase(mallory, { key, amount });
            assert((r.status === 400 && r.body?.reason === 'invalid_key') || (r.status === 409 && r.body?.reason === 'key_conflict'),
                `3. Mallory buys ${amount} with ${what} as the key: refused (${show(r)})`);
            assert(outbound() === 1 && heldBy() === before && total() === baseline,
                `3. no settlement is written and nothing moves: Mallory, both projects' escrows, the deal's, the link, Jo (${before} → ${heldBy()}, ${outbound()} settlements, total ${total()})`);
        }
        const released = await call(bea, '/api/marketplace/transactions/complete', { transactionId: deal, confirmerPublicKey: bea.pk });
        assert(released.status === 200 && balOf(`escrow_${deal}`) === 0 && balOf(sam.pk) > 3.9,
            `3. the deal's escrow is whole, so Bea's confirmation still pays Sam his 4 less the fee (${show(released)}, Sam ${balOf(sam.pk)})`);

        // ── Kit aims a commission's key at other people's money ───────────────────────────────────────────────
        console.log('\n--- 4. commissions whose key names other money ---');
        const commission = (body: Record<string, unknown>) => call(kit, '/api/federation/commission', { postId: 'far-post', ...body });
        const commons = () => balOf('COMMONS_POOL');
        const cBaseline = total();
        const cBefore = [heldBy(), commons()].join('|');
        const linkOutbound = () => (their.prepare(`SELECT COUNT(*) AS n FROM settlements WHERE direction = 'outbound' AND buyer_pubkey = ?`).get(link) as { n: number }).n;
        const commissionKeys: [unknown, string, number | undefined][] = [
            [projectB, 'the second project\'s id', 20],
            [projectA, 'the first project\'s id', 1],
            [`escrow_${projectB}`, 'escrow_<project>', undefined],
            [link, 'the link\'s own key', undefined],
            [joKey, 'Jo\'s purchase key', undefined],
            [`xc-${uuid()}`, 'a fresh key in the commission form', undefined],
            [`xn-${uuid()}`, 'a purchase\'s form', undefined],
            [7, 'a number', undefined],
        ];
        for (const [key, what, amount] of commissionKeys) {
            const r = await commission(amount === undefined ? { key } : { key, amount });
            assert((r.status === 400 && r.body?.reason === 'invalid_key') || (r.status === 409 && r.body?.reason === 'key_conflict'),
                `4. Kit commissions with ${what} as the key: refused (${show(r)})`);
            assert(linkOutbound() === 0 && [heldBy(), commons()].join('|') === cBefore && total() === cBaseline,
                `4. no settlement, and nothing moves: the link, the Commons, the escrows (${cBefore} → ${[heldBy(), commons()].join('|')}, total ${total()})`);
        }
        const linkBefore = balOf(link);
        const kits = await commission({});
        const kitKey = kits.body?.key as string;
        assert(kits.status === 409 && kits.body?.status === 'refused' && /^xc-[0-9a-f-]{36}$/.test(kitKey ?? '') && balOf(link) === linkBefore && balOf(`escrow_${kitKey}`) === 0 && linkOutbound() === 1,
            `4. Kit's commission with no key: the ask fails, and the link has exactly its own ${linkBefore} back (${show(kits)}, link ${balOf(link)})`);
        const kitAgain = await commission({ key: kitKey });
        assert(kitAgain.status === 409 && kitAgain.body?.status === 'refused' && kitAgain.body?.key === kitKey && linkOutbound() === 1 && balOf(link) === linkBefore && total() === cBaseline,
            `4. sent again with its own key, it is answered from its row: no second settlement, nothing moves (${show(kitAgain)})`);
        const kitOther = await commission({ key: kitKey, amount: 2 });
        assert(kitOther.status === 409 && kitOther.body?.reason === 'key_conflict' && linkOutbound() === 1 && balOf(link) === linkBefore,
            `4. its key with another amount is 409 key_conflict (${show(kitOther)})`);
        const joWithKits = await purchase(jo, { key: kitKey });
        assert(joWithKits.status === 400 && joWithKits.body?.reason === 'invalid_key' && outbound() === 2,
            `4. and Jo can't buy under the commission's key (${show(joWithKits)})`);

        // ── A post's id ───────────────────────────────────────────────────────────────────────────────────────
        console.log('\n--- 5. a post\'s id names no money ---');
        const post = (id: unknown) => call(vic, '/api/marketplace/posts', { id, type: 'offer', category: 'other', title: 'Firewood', description: 'test', credits: 1, authorPublicKey: vic.pk });
        const postIds: [unknown, string][] = [
            [projectA, 'a project\'s id'], [deal, 'a deal\'s id'], [`escrow_${deal}`, 'escrow_<deal>'], [joKey, 'a settlement\'s key'],
            [link, 'an enterprise\'s key'], ['COMMONS_POOL', 'the Commons'], [7, 'a number'], [['x'], 'a list'],
        ];
        for (const [id, what] of postIds) {
            const r = await post(id);
            assert(r.status === 400 && /nothing else has/.test(r.body?.error ?? '') && postsBy(vic.pk) === 0,
                `5. Vic posts with ${what} as its id: 400, and no post is made (${show(r)})`);
        }
        const fresh = uuid();
        const posted = await post(fresh);
        assert(posted.status === 200 && posted.body?.post?.id === fresh && postsBy(vic.pk) === 1,
            `5. a fresh UUID, what the phone app sends, still posts under that id (${show(posted)})`);

        // ── The boot migration ────────────────────────────────────────────────────────────────────────────────
        console.log('\n--- 6. a restart moves nothing out of an escrow a post\'s id names ---');
        their.close();
        await node.stop();
        // Planted while the node is stopped: a post whose id is project B's (the old route took it), and a pending deal on it
        // whose escrow is empty (an escrow drained as in step 3, before this fix).
        const w = new Database(path.join(dir, 'state.db'));
        const pendingDeal = uuid();
        w.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status) VALUES (?, 'offer', 'other', 'Planted', 'test', 5, ?, 'pending')`).run(projectB, vic.pk);
        w.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at) VALUES (?, ?, ?, ?, 5, 'pending', ?)`)
            .run(pendingDeal, projectB, mallory.pk, vic.pk, new Date().toISOString());
        w.close();
        node = await startNode(dir, seed);
        their = new Database(path.join(dir, 'state.db'), { readonly: true, fileMustExist: true });
        assert(balOf(`escrow_${projectB}`) === 30 && balOf(`escrow_${pendingDeal}`) === 0,
            `6. after the restart, project B's escrow still holds its 30, and the empty deal took none of it (${balOf(`escrow_${projectB}`)}, ${balOf(`escrow_${pendingDeal}`)})`);
        assert(!/Escrow wallet key migration/.test(node.output()), '6. and the boot log has no escrow-key migration');
    } finally {
        try { their.close(); } catch { /* already closed */ }
        await node.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    console.log('A settlement\'s key, and a caller-chosen id, never name another account\'s money\n');
    await engineChecks();
    await httpChecks();
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ settlement-key checks PASSED.');
}

if (process.argv.includes(CHILD_FLAG)) {
    runChild().catch((e) => { console.error('child failed:', e); process.exit(1); });
} else {
    main().then(() => process.exit(process.exitCode ?? 0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
}
