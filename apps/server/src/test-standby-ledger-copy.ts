/**
 * Test Suite: a standby's ledger is its main server's, exactly, and a new standby makes its own first copy (G0 and G9 of
 * scratch/global-node/DESIGN-standby-takeover-gaps-opus.md; §5.3's G0 suite).
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts) serving its real HTTPS server; members
 * act through it with signed requests, the admin with the password. The standby pulls through its real puller
 * (services/backup-puller.ts `pullNow`, the loop's own step) from the main server's real backup routes. Nothing leaves
 * this machine.
 *
 *  1. The main server M: members, a trade that paid the Commons its fee, a transfer, Beans held in escrow, a project pot
 *     (a crowdfund pledge, whose trades name the project), and a non-zero accepted audit baseline (the test node's -9.82
 *     kind: an old bug's drift, accepted by the admin).
 *  2. A brand-new standby S takes its first copy with the loop's own pull, no operator (G9: refused before, on the
 *     callsign index, because every server's boot made a BeanPool enterprise of its own). Its accounts are M's, row for
 *     row and column for column, and so are the ledger columns of its trades (`tax_fee`, `project_id`).
 *  3. Trades after the first copy, moving accounts that held Beans at it, and the project deleted (its pledges refunded,
 *     its trades no longer naming it): a delta brings them (before, every later copy was refused once one of those moved).
 *  4. A whole copy: the same, and the whole-copy check compares every account.
 *  5. S restarts as a standby: it makes no BeanPool of its own and leaves M's as it is; the next pull lands.
 *  6. The whole-copy check fails on a copy whose sum is right and whose accounts are not; it records the mismatch and
 *     asks for one force-resync, and no second one within the hour after.
 *  7. The conservation guard still refuses a payload signed by M that makes Beans, drops an account holding them, or
 *     names one account twice to hide a shift.
 *  8. A copy that throws after its accounts section is written (a forged later row here; a disk error there would do the
 *     same) leaves the standby's rows AND the ledger it holds in memory at its last good copy, so its own Commons flush
 *     writes nothing that isn't that copy's, and the next real pull lands (before, memory kept the refused copy's pot, the
 *     flush wrote it into the accounts, and every later copy was refused by the conservation guard, for good).
 *  9. A standby left as today's importer left it (every balance 0, stamped with its own clock, an account for SYSTEM, no
 *     record of the importer's format) heals in one pull.
 * 10. The take-over's promotion audit, on a copy of S: its ledger is M's as last copied; and on the same copy with every
 *     balance 0, or with no accounts at all, it says the ledger is not M's (before, both said "ok").
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-ledger-copy.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { spawnNode, copyDir, runNodeChild, serveCommands, type NodeProc } from './takeover-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the nodes' own self-signed certificates

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Ledger-Copy-Main-Pw-3318!';
const PW_STANDBY = 'Ledger-Copy-Standby-Pw-775!';

// ── The node processes' commands ───────────────────────────────────────────────────────────

/** No node reaches anything but this machine: a push to Expo is answered here, anything else refused and counted. */
function guardFetch(): { blocked: string[] } {
    const seen = { blocked: [] as string[] };
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return real(input, init);
        if (url.hostname === 'exp.host') return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        seen.blocked.push(url.hostname);
        throw new Error(`this suite reaches nothing off this machine (${url.hostname})`);
    }) as typeof fetch;
    return seen;
}

async function child(): Promise<void> {
    const fetches = guardFetch();
    await runNodeChild({
        ...serveCommands,
        'setup-primary': async (a: { replicationToken: string; genesis: string }) => {
            const { seedGenesisMember } = await import('./engine/members.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            seedGenesisMember(a.genesis, 'Gwen');
            setReplicationToken(a.replicationToken);
            return true;
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { addConnector } = await import('./connector-manager.js');
            const { updateLocalConfig } = await import('./config/local-config.js');
            addConnector(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`, 'mirror', 'main-server', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        /** One pull of the kind the loop makes next; `whole` asks the loop's routine whole copy (a full pull, no clear). */
        pull: async (a: { whole?: boolean }) => {
            const { pullNow, getBackupStatus } = await import('./services/backup-puller.js');
            const before = getBackupStatus() as any;
            if (a.whole) process.env.BACKUP_RECONCILE_EVERY_MS = '1';
            await new Promise((r) => setTimeout(r, 5));
            const result = await pullNow();
            process.env.BACKUP_RECONCILE_EVERY_MS = '86400000';
            const after = getBackupStatus() as any;
            return { ...result, whole: after.lastFullReconcileAt !== before.lastFullReconcileAt, mode: after.lastPullMode ?? null, consistency: after.consistency };
        },
        /** The force-resync an operator runs from Settings. */
        resync: async () => {
            const { requestResync } = await import('./services/backup-puller.js');
            return requestResync();
        },
        /** The ledger as this server holds it: every account, every column; the trades' ledger columns; the BeanPool rows. */
        ledger: async () => {
            const { db } = await import('./db/db.js');
            const cfg = (k: string) => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(k) as { value: string } | undefined)?.value ?? null;
            return {
                accounts: db.prepare('SELECT public_key, balance, last_updated_at, last_demurrage_epoch FROM accounts ORDER BY public_key').all(),
                sum: (db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM accounts').get() as { s: number }).s,
                transactions: db.prepare('SELECT id, from_pubkey, to_pubkey, amount, tax_fee, project_id, memo, timestamp FROM transactions ORDER BY id').all(),
                beanpool: db.prepare("SELECT public_key, callsign FROM members WHERE callsign LIKE 'BeanPool%' ORDER BY public_key").all(),
                members: (db.prepare('SELECT COUNT(*) AS c FROM members').get() as { c: number }).c,
                format: cfg('replica_format'),
                mismatch: cfg('replica_ledger_mismatch'),
            };
        },
        /** An old bug's drift, as a raw write, for the admin to accept as the audit baseline (the test node's -9.82 kind). */
        drift: async (a: { publicKey: string; amount: number }) => {
            const { db } = await import('./db/db.js');
            const { reconcileLedgerFromDb } = await import('./state-engine.js');
            db.prepare('UPDATE accounts SET balance = balance + ? WHERE public_key = ?').run(a.amount, a.publicKey);
            reconcileLedgerFromDb();
            return true;
        },
        /**
         * A payload M signs that does not conserve: one account given Beans from nowhere, or one holding Beans left out of
         * the account set. Signed with M's own key, so only the conservation guard stands between it and a standby.
         */
        forge: async (a: { kind: 'mint' | 'drop' | 'twice' | 'throws-later'; publicKey: string }) => {
            const { exportSyncState, signSyncPayload } = await import('./state-engine.js');
            const { getPrivateKey } = await import('./p2p.js');
            const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
            const payload: any = await exportSyncState(peerIdFromPrivateKey(getPrivateKey()).toString());
            delete payload.signature;
            delete payload.publicKey;
            if (a.kind === 'mint') payload.accounts = payload.accounts.map((x: any) => (x.publicKey === a.publicKey ? { ...x, balance: x.balance + 50 } : x));
            else if (a.kind === 'drop') payload.accounts = payload.accounts.filter((x: any) => x.publicKey !== a.publicKey);
            else if (a.kind === 'throws-later') {
                // The real ledger, and one trade for no listing: the import throws in the marketplace section, after the
                // accounts section has written the ledger and before the copy commits (as a disk error there would).
                payload.marketplaceTransactions = [...(payload.marketplaceTransactions ?? []), {
                    id: `forged-${crypto.randomUUID()}`, postId: null, buyerPubkey: a.publicKey, sellerPubkey: a.publicKey,
                    credits: 1, status: 'pending', createdAt: new Date().toISOString(),
                }];
            } else {
                // The account named twice: 50 more, then 50 less than it holds. Each one against what the row held before
                // the copy, the two cancel out, and 50 Beans would go.
                const x = payload.accounts.find((y: any) => y.publicKey === a.publicKey);
                payload.accounts = payload.accounts.map((y: any) => (y === x ? { ...x, balance: x.balance + 50 } : y));
                payload.accounts.push({ ...x, balance: x.balance - 50 });
            }
            payload.generatedAt = new Date().toISOString();
            return signSyncPayload(payload);
        },
        /** Import a payload as the puller does, straight into this standby. */
        import: async (a: { payload: any }) => {
            const { importRemoteState } = await import('./state-engine.js');
            try { await importRemoteState(a.payload); return { ok: true }; } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
        },
        /** A grant from the Commons, paid as production pays one (payFromCommons). */
        grant: async (a: { publicKey: string; amount: number }) => {
            const { payFromCommons } = await import('./state-engine.js');
            return !!payFromCommons(a.publicKey, a.amount, 'a commons grant', { allowDeficit: true });
        },
        /** This server's own flush of demurrage and the Commons pot, as its 5-minute timer and ledger audit run it. */
        persist: async () => {
            const { persistDecayAndCommons } = await import('./state-engine.js');
            persistDecayAndCommons();
            return true;
        },
        /** The Commons pot this server holds in memory, which its flush writes to the COMMONS_POOL row. */
        'memory-commons': async () => {
            const { getCommonsBalanceExact } = await import('./state-engine.js');
            return getCommonsBalanceExact();
        },
        /** A raw write on this server's own ledger, as a bug would make it. */
        'plant-balance': async (a: { publicKey: string; add: number }) => {
            const { db } = await import('./db/db.js');
            db.prepare('UPDATE accounts SET balance = balance + ? WHERE public_key = ?').run(a.add, a.publicKey);
            return true;
        },
        /**
         * The whole-copy check, on M's current whole copy fetched with the replication token and not imported: what the
         * puller does after a full pull, where a mismatch is recorded and asks for one force-resync.
         */
        'check-copy': async () => {
            const puller: any = await import('./services/backup-puller.js');
            const { getLocalConfig } = await import('./config/local-config.js');
            const c = getLocalConfig();
            const res = await fetch(`${c.backupPrimaryUrl}/api/local/admin/sync-snapshot`, { headers: { 'X-Replication-Token': c.backupReplicationToken! } });
            const payload = await res.json();
            if (typeof puller.checkWholeCopy !== 'function') {
                const { getReplicaConsistency } = await import('./state-engine.js');
                return { consistency: getReplicaConsistency(payload), checkWholeCopy: false };
            }
            return { consistency: puller.checkWholeCopy(payload), checkWholeCopy: true };
        },
        /** The record the take-over's audit left (services/takeover.ts runPendingPromotionAudit). */
        'audit-record': async () => {
            const { getLocalConfig } = await import('./config/local-config.js');
            return getLocalConfig().lastPromotionAudit ?? null;
        },
        checkpoint: async () => {
            const { db } = await import('./db/db.js');
            db.pragma('wal_checkpoint(TRUNCATE)');
            return true;
        },
        fetches: async () => fetches,
    });
}

// ── The orchestrator ───────────────────────────────────────────────────────────────────────

let testsRun = 0;
let testsPassed = 0;
function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`cannot go on: ${msg}`);
}

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

interface Answer { status: number; body: any }

/** A call to a node's real HTTPS server, signed by `as`, with the admin password in `admin`, or neither. */
async function api(base: string, method: 'GET' | 'POST', route: string, opts: { as?: Id; admin?: string; body?: unknown } = {}): Promise<Answer> {
    const raw = method === 'GET' ? '' : JSON.stringify(opts.body ?? {});
    const headers: Record<string, string> = {};
    if (opts.as) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = opts.as.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${route.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), opts.as.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (opts.admin) headers['X-Admin-Password'] = opts.admin;
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${route}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body };
}

const brief = (a: Answer) => `${a.status} ${JSON.stringify(a.body)?.slice(0, 160)}`;
function built(what: string, a: Answer): any {
    require_(a.status >= 200 && a.status < 300, `M: ${what} (${brief(a)})`);
    return a.body;
}
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';

type Ledger = { accounts: any[]; sum: number; transactions: any[]; beanpool: any[]; members: number; format: string | null; mismatch: string | null };

/** Where two ledgers differ: accounts row for row and column for column, and the trades' ledger columns. */
function ledgerDiff(m: Ledger, s: Ledger): string[] {
    const out: string[] = [];
    const byKey = (rows: any[], k: string) => new Map(rows.map((r) => [r[k], r]));
    const ma = byKey(m.accounts, 'public_key');
    const sa = byKey(s.accounts, 'public_key');
    for (const [k, r] of ma) {
        const o = sa.get(k);
        if (!o) { out.push(`account ${k.slice(0, 12)} missing`); continue; }
        for (const c of ['balance', 'last_updated_at', 'last_demurrage_epoch']) {
            if (JSON.stringify(r[c]) !== JSON.stringify(o[c])) out.push(`account ${k.slice(0, 12)}.${c}: main ${JSON.stringify(r[c])}, standby ${JSON.stringify(o[c])}`);
        }
    }
    for (const k of sa.keys()) if (!ma.has(k)) out.push(`account ${k.slice(0, 12)} extra (${JSON.stringify(sa.get(k).balance)})`);
    const mt = byKey(m.transactions, 'id');
    const st = byKey(s.transactions, 'id');
    for (const [k, r] of mt) {
        const o = st.get(k);
        if (!o) { out.push(`trade ${k.slice(0, 16)} missing`); continue; }
        for (const c of Object.keys(r)) {
            if (JSON.stringify(r[c]) !== JSON.stringify(o[c])) out.push(`trade ${k.slice(0, 16)}.${c}: main ${JSON.stringify(r[c])}, standby ${JSON.stringify(o[c])}`);
        }
    }
    for (const k of st.keys()) if (!mt.has(k)) out.push(`trade ${k.slice(0, 16)} extra`);
    return out;
}
const first = (xs: string[]) => (xs.length === 0 ? 'none' : `${xs.length}: ${xs.slice(0, 4).join(' | ')}`);

/** A stopped node's database, written as a bug or an old importer left it. */
function withDb(dir: string, fn: (db: Database.Database) => void): void {
    const db = new Database(path.join(dir, 'state.db'));
    try { fn(db); } finally { db.close(); }
}
function setLocalConfig(dir: string, patch: Record<string, unknown>): void {
    const file = path.join(dir, 'local-config.json');
    const cur = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
    fs.writeFileSync(file, JSON.stringify({ ...cur, ...patch }, null, 2));
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dir = (n: string) => path.join(root, n);
    const nodes: NodeProc[] = [];
    const started = Date.now();
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const env = (pw: string, role: string) => ({ ADMIN_PASSWORD: pw, NODE_ROLE: role, NODE_ENV: 'test', BACKUP_RECONCILE_EVERY_MS: '86400000' });
    const gwen = newId('Gwen');
    const [ann, bo, cy, dee, kip] = ['Ann', 'Bo', 'Cy', 'Dee', 'Kip'].map(newId);
    const refused: string[] = [];

    try {
        // ── 1. M, and its ledger ──
        console.log('\n— 1. the main server builds a ledger —');
        const main = await spawnNode(SCRIPT, dir('main'), env(PW_MAIN, 'primary'));
        nodes.push(main);
        await main.send('setup-primary', { replicationToken, genesis: gwen.pk });
        const m = `https://localhost:${await main.send('serve')}`;
        const A = (route: string, body: unknown) => api(m, 'POST', route, { admin: PW_MAIN, body });
        const S_ = (who: Id, route: string, body: unknown = {}) => api(m, 'POST', route, { as: who, body });
        built('Gwen sets a profile photo', await S_(gwen, '/api/profile/update', { avatar: TINY_PNG }));
        for (const who of [ann, bo, cy, dee, kip]) {
            const inv = built(`Gwen makes an invite for ${who.name}`, await S_(gwen, '/api/invite/generate', { publicKey: gwen.pk }));
            built(`${who.name} joins with it`, await api(m, 'POST', '/api/invite/redeem', { body: { code: inv.invite?.code ?? inv.code, publicKey: who.pk, callsign: who.name } }));
            built(`${who.name} sets a profile photo`, await S_(who, '/api/profile/update', { avatar: TINY_PNG }));
        }
        const offer = async (who: Id, title: string, credits: number) => built(`${who.name} offers ${title}`, await S_(who, '/api/marketplace/posts', {
            type: 'offer', category: 'food', title, description: `${title}, from ${who.name}`, credits, priceType: 'fixed', authorPublicKey: who.pk,
        })).post;
        const deal = async (buyer: Id, seller: Id, postId: string, finish: boolean) => {
            const tx = built(`${buyer.name} asks for ${seller.name}'s listing`, await S_(buyer, '/api/marketplace/posts/request', { postId, buyerPublicKey: buyer.pk })).transaction;
            built(`${seller.name} approves: the Beans are held`, await S_(seller, '/api/marketplace/transactions/approve', { transactionId: tx.id, authorPublicKey: seller.pk }));
            if (finish) built(`${buyer.name} confirms: the Beans are released`, await S_(buyer, '/api/marketplace/transactions/complete', { transactionId: tx.id, confirmerPublicKey: buyer.pk }));
            return tx.id as string;
        };
        built('the admin makes Gwen an Elder (a credit line to buy with)', await A(`/api/local/admin/users/${gwen.pk}/elder`, { grant: true }));
        built('and Cy', await A(`/api/local/admin/users/${cy.pk}/elder`, { grant: true }));
        await offer(gwen, 'Sourdough', 4); // a buyer lists an offer first (the offer covenant)
        await offer(cy, 'Bike repair', 6);
        await deal(gwen, ann, (await offer(ann, 'Honey', 20)).id, true); // the Commons takes its fee
        built('Ann gives Bo 5 Beans', await S_(ann, '/api/ledger/transfer', { to: bo.pk, amount: 5, memo: 'for the seedlings' }));
        await deal(cy, kip, (await offer(kip, 'Tune-up', 10)).id, true);
        const held = await deal(cy, dee, (await offer(dee, 'Firewood', 7)).id, false); // held in escrow
        const seed = built('Ann starts a project with a goal', await S_(ann, '/api/treasury', { name: 'Seed Fund', purpose: 'A seed library', lifecycle: 'bounded', goalAmount: 100 }));
        built('Kip puts 2 Beans in the project pot', await S_(kip, `/api/treasury/${seed.publicKey}/pledge`, { amount: 2 }));
        built('an old bug left -9.82 Beans of drift', { status: (await main.send('drift', { publicKey: gwen.pk, amount: -9.82 })) ? 200 : 500, body: {} });
        built('the admin accepts it as the audit baseline', await A('/api/local/admin/ledger-rebaseline', { reason: 'Drift from an old bug, checked by hand' }));
        const m1: Ledger = await main.send('ledger');
        const holding = (l: Ledger, prefix: string) => l.accounts.filter((a) => a.public_key.startsWith(prefix) && Math.abs(a.balance) > 0.001);
        require_(holding(m1, 'escrow_').length >= 2 && holding(m1, 'COMMONS_POOL').length === 1 && m1.transactions.some((t) => t.project_id) && m1.transactions.some((t) => t.tax_fee > 0) && Math.abs(m1.sum + 9.82) < 1e-6,
            `M: Beans in escrow and in a project pot, a Commons balance, a fee and a project on its trades, and a ledger that sums to its baseline (${JSON.stringify({ escrows: holding(m1, 'escrow_').length, commons: holding(m1, 'COMMONS_POOL').map((a) => a.balance), sum: m1.sum })})`);
        const mainBeanPool = m1.beanpool.find((r) => r.callsign === 'BeanPool')?.public_key;
        require_(!!mainBeanPool, 'M: its BeanPool enterprise');

        // ── 2. A new standby's own first pull ──
        console.log('\n— 2. a brand-new standby takes its first copy with the loop\'s own pull —');
        fs.mkdirSync(dir('standby'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('standby'), 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const s0: Ledger = await standby.send('ledger');
        assert(s0.beanpool.length === 0, `a standby's boot makes no BeanPool of its own: it will hold the main server's (${JSON.stringify(s0.beanpool)})`);
        const firstPull = await standby.send('pull', {});
        assert(firstPull.ok === true, `the loop's first pull lands, with no operator (G9) (${firstPull.ok ? 'imported' : firstPull.error})`);
        if (!firstPull.ok) {
            // So the rest has a copy to look at: what an operator does today.
            const r = await standby.send('resync');
            console.log(`  (force-resync, as an operator would: ${r.ok ? 'imported' : r.error})`);
        }
        let s: Ledger = await standby.send('ledger');
        assert(ledgerDiff(m1, s).length === 0, `S's first copy is M's ledger, every account and column, and its trades' fee and project (differences ${first(ledgerDiff(m1, s))})`);
        assert(s.beanpool.length === 1 && s.beanpool[0].public_key === mainBeanPool && s.beanpool[0].callsign === 'BeanPool',
            `S holds M's BeanPool and no other (${JSON.stringify(s.beanpool)})`);
        assert(s.format !== null && Number(s.format) >= 1, `the copy records the importer's format it was made with (${s.format})`);

        // ── 3. Trades after the first copy ──
        console.log('\n— 3. trades after the first copy, then a delta —');
        built('Ann, who held Beans at the first copy, gives Cy 3', await S_(ann, '/api/ledger/transfer', { to: cy.pk, amount: 3, memo: 'thanks' }));
        built('Cy confirms the held trade: Dee is paid from escrow', await S_(cy, '/api/marketplace/transactions/complete', { transactionId: held, confirmerPublicKey: cy.pk }));
        built('Kip puts 1 more Bean in the pot', await S_(kip, `/api/treasury/${seed.publicKey}/pledge`, { amount: 1 }));
        // Its trades stop naming it, in a write that moves no trade's stamp: the project's tombstone carries it.
        built('Ann deletes the project: Kip\'s pledges come back', await S_(ann, '/api/crowdfund/projects/delete', { id: seed.publicKey, creatorPubkey: ann.pk }));
        const delta = await standby.send('pull', {});
        const m3: Ledger = await main.send('ledger');
        s = await standby.send('ledger');
        require_(m3.transactions.some((t) => t.from_pubkey === `escrow_${seed.publicKey}`) && !m3.transactions.some((t) => t.project_id),
            'M: the refunds are made, and no trade names the deleted project');
        assert(delta.ok === true && delta.whole === false, `the delta lands (${delta.ok ? 'imported' : delta.error}; whole ${delta.whole})`);
        assert(ledgerDiff(m3, s).length === 0, `S's ledger is M's after it, the trades no longer naming the project (differences ${first(ledgerDiff(m3, s))})`);

        // ── 4. A whole copy ──
        console.log('\n— 4. a whole copy —');
        await deal(gwen, cy, (await offer(cy, 'Puncture kit', 2)).id, true);
        const whole = await standby.send('pull', { whole: true });
        const m4: Ledger = await main.send('ledger');
        s = await standby.send('ledger');
        assert(whole.ok === true && whole.whole === true, `the whole copy lands (${whole.ok ? 'imported' : whole.error}; whole ${whole.whole})`);
        assert(ledgerDiff(m4, s).length === 0, `S's ledger is M's after it (differences ${first(ledgerDiff(m4, s))})`);
        const led = whole.consistency?.ledger;
        assert(whole.consistency?.ok === true && led?.match === true && led?.compared === m4.accounts.length,
            `the whole-copy check compared every account and found them equal (${JSON.stringify(led ?? whole.consistency?.sumBalances)})`);

        // ── 5. S restarts as a standby ──
        console.log('\n— 5. the standby restarts —');
        await standby.send('checkpoint');
        await standby.kill('SIGTERM');
        standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        s = await standby.send('ledger');
        assert(s.beanpool.length === 1 && s.beanpool[0].public_key === mainBeanPool && s.beanpool[0].callsign === 'BeanPool',
            `its boot makes no BeanPool of its own and leaves M's as it is (${JSON.stringify(s.beanpool)})`);
        built('Kip gives Dee 1 Bean', await S_(kip, '/api/ledger/transfer', { to: dee.pk, amount: 1, memo: 'kindling' }));
        const afterRestart = await standby.send('pull', {});
        const m5: Ledger = await main.send('ledger');
        s = await standby.send('ledger');
        assert(afterRestart.ok === true && ledgerDiff(m5, s).length === 0,
            `its next pull lands and its ledger is M's (${afterRestart.ok ? 'imported' : afterRestart.error}; differences ${first(ledgerDiff(m5, s))})`);

        // ── 6. The whole-copy check can fail ──
        console.log('\n— 6. a copy whose sum is right and whose accounts are not —');
        await standby.send('plant-balance', { publicKey: ann.pk, add: 4 });
        await standby.send('plant-balance', { publicKey: bo.pk, add: -4 });
        const checked = await standby.send('check-copy');
        const c6 = checked.consistency;
        assert(c6.sumBalances?.match === true && c6.ok === false && c6.ledger?.match === false && c6.ledger?.differing === 2,
            `the whole-copy check finds two accounts that differ where the sum agrees (${JSON.stringify({ sum: c6.sumBalances, ledger: c6.ledger, ok: c6.ok })})`);
        const recorded: Ledger = await standby.send('ledger');
        const note = recorded.mismatch ? JSON.parse(recorded.mismatch) : null;
        assert(checked.checkWholeCopy === true && note?.differing === 2 && note?.resync === 'scheduled',
            `the mismatch is recorded, and asks for a force-resync (${recorded.mismatch})`);
        const healing = await standby.send('pull', {});
        s = await standby.send('ledger');
        const m6: Ledger = await main.send('ledger');
        assert(healing.ok === true && healing.mode === 'resync' && ledgerDiff(m6, s).length === 0,
            `the next pull is that force-resync, and the ledger is M's again (${JSON.stringify({ ok: healing.ok, mode: healing.mode, error: healing.error })}; differences ${first(ledgerDiff(m6, s))})`);
        await standby.send('plant-balance', { publicKey: ann.pk, add: 1 });
        await standby.send('plant-balance', { publicKey: bo.pk, add: -1 });
        const again = await standby.send('check-copy');
        const againNote = JSON.parse((await standby.send('ledger') as Ledger).mismatch ?? 'null');
        const quiet = await standby.send('pull', {});
        assert(again.consistency?.ledger?.match === false && againNote?.resync !== 'scheduled' && quiet.ok === true && quiet.mode === 'delta',
            `a second mismatch within hours is recorded without another force-resync (${JSON.stringify({ resync: againNote?.resync, mode: quiet.mode })})`);
        s = await standby.send('ledger');
        const m6b: Ledger = await main.send('ledger');
        assert(ledgerDiff(m6b, s).length === 0, `the delta itself writes M's accounts back (differences ${first(ledgerDiff(m6b, s))})`);

        // ── 7. The conservation guard ──
        console.log('\n— 7. the conservation guard —');
        const before7: Ledger = await standby.send('ledger');
        const minted = await standby.send('import', { payload: await main.send('forge', { kind: 'mint', publicKey: kip.pk }) });
        assert(minted.ok === false && /Conservation violation/.test(minted.error), `a payload M signed that gives Kip 50 Beans from nowhere is refused (${minted.error})`);
        const dropped = await standby.send('import', { payload: await main.send('forge', { kind: 'drop', publicKey: ann.pk }) });
        assert(dropped.ok === false && /Conservation violation/.test(dropped.error), `one that leaves out Ann's account, which holds Beans, is refused (${dropped.error ?? 'imported'})`);
        const twice = await standby.send('import', { payload: await main.send('forge', { kind: 'twice', publicKey: cy.pk }) });
        assert(twice.ok === false && /Conservation violation/.test(twice.error), `one that names Cy twice, 50 up then 50 down, is refused (${twice.error ?? 'imported'})`);
        const after7: Ledger = await standby.send('ledger');
        assert(ledgerDiff(before7, after7).length === 0, `none of them changed the standby's ledger (differences ${first(ledgerDiff(before7, after7))})`);

        // ── 8. A copy that throws after its accounts are written ──
        console.log('\n— 8. a copy that throws after the accounts section, the standby\'s own flush, then a real pull —');
        built('the Commons grants Gwen 5 Beans', { status: (await main.send('grant', { publicKey: gwen.pk, amount: 5 })) ? 200 : 500, body: {} });
        const before8: Ledger = await standby.send('ledger');
        const commonsRow = (l: Ledger) => l.accounts.find((a) => a.public_key === 'COMMONS_POOL')?.balance ?? null;
        const thrown = await standby.send('import', { payload: await main.send('forge', { kind: 'throws-later', publicKey: ann.pk }) });
        require_(thrown.ok === false && !/Conservation violation/.test(thrown.error),
            `M's real ledger with one trade for no listing throws after the accounts section, past the guard (${thrown.error ?? 'imported'})`);
        const after8: Ledger = await standby.send('ledger');
        const memPot = await standby.send('memory-commons');
        assert(ledgerDiff(before8, after8).length === 0, `the copy rolled back: S's rows are its last good copy (differences ${first(ledgerDiff(before8, after8))})`);
        assert(Math.abs(memPot - (commonsRow(after8) ?? NaN)) < 1e-9,
            `and so is the Commons pot S holds in memory, not the refused copy's (memory ${memPot}, row ${commonsRow(after8)}, the copy's ${commonsRow(await main.send('ledger'))})`);
        await standby.send('persist');
        const flushed: Ledger = await standby.send('ledger');
        assert(Math.abs(flushed.sum - before8.sum) < 1e-9, `S's own flush leaves its ledger summing to its last good copy's (${before8.sum} → ${flushed.sum})`);
        const landed = await standby.send('pull', {});
        const m8: Ledger = await main.send('ledger');
        s = await standby.send('ledger');
        assert(landed.ok === true && ledgerDiff(m8, s).length === 0,
            `the next real pull lands and S's ledger is M's, the grant included (${JSON.stringify({ ok: landed.ok, mode: landed.mode, error: landed.error })}; differences ${first(ledgerDiff(m8, s))})`);
        const potNow = await standby.send('memory-commons');
        assert(Math.abs(potNow - (commonsRow(s) ?? NaN)) < 1e-9, `and the pot S holds in memory is the copy's (memory ${potNow}, row ${commonsRow(s)})`);

        // ── 9. A standby as today's importer left it ──
        console.log('\n— 9. a standby left all-zero by the old importer heals in one pull —');
        await standby.send('checkpoint');
        refused.push(...(await standby.send('fetches')).blocked);
        await standby.kill('SIGTERM');
        copyDir(dir('standby'), dir('audit'));
        copyDir(dir('standby'), dir('old'));
        withDb(dir('old'), (db) => {
            // The old members import: a zero account for each member, stamped with the standby's clock, SYSTEM's too; the
            // accounts import then kept those over the main server's older rows. And no record of the importer's format.
            const now = new Date().toISOString();
            db.prepare('UPDATE accounts SET balance = 0, last_updated_at = ?, last_demurrage_epoch = 0').run(now);
            db.prepare("INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES ('SYSTEM', 0, 0)").run();
            db.prepare("DELETE FROM node_config WHERE key IN ('replica_format', 'replica_ledger_mismatch')").run();
        });
        const old = await spawnNode(SCRIPT, dir('old'), env(PW_STANDBY, 'backup'));
        nodes.push(old);
        const heal = await old.send('pull', {});
        const m9: Ledger = await main.send('ledger');
        const o9: Ledger = await old.send('ledger');
        assert(heal.ok === true && ledgerDiff(m9, o9).length === 0,
            `its next pull heals it: every account is M's (${JSON.stringify({ ok: heal.ok, mode: heal.mode, error: heal.error })}; differences ${first(ledgerDiff(m9, o9))})`);
        assert(o9.format !== null && Number(o9.format) >= 1, `and it records the importer's format (${o9.format})`);
        refused.push(...(await old.send('fetches')).blocked);
        await old.kill('SIGTERM');

        // ── 10. The take-over's promotion audit ──
        console.log('\n— 10. the take-over\'s promotion audit —');
        // The state a take-over's confirm leaves before its restart (services/takeover.ts: nodeRole primary, the audit
        // pending), so the restart runs the audit as a take-over's does (resumeTakeoverAtBoot → runPendingPromotionAudit).
        const promote = async (name: string, plant?: (db: Database.Database) => void) => {
            copyDir(dir('audit'), dir(name));
            if (plant) withDb(dir(name), plant);
            setLocalConfig(dir(name), { nodeRole: 'primary', promotionAuditPending: true });
            const n = await spawnNode(SCRIPT, dir(name), env(PW_STANDBY, 'backup'));
            nodes.push(n);
            const rec = await n.send('audit-record');
            refused.push(...(await n.send('fetches')).blocked);
            await n.kill('SIGTERM');
            return { ran: n.ready.auditRan === true, rec };
        };
        const ok9 = await promote('promoted-ok');
        assert(ok9.ran && ok9.rec?.copy?.match === true,
            `on the copy as it is, the audit finds the ledger is M's as last copied (${JSON.stringify(ok9.rec)})`);
        const zero9 = await promote('promoted-zero', (db) => db.prepare('UPDATE accounts SET balance = 0').run());
        assert(zero9.ran && zero9.rec?.ok === false && zero9.rec?.copy?.match === false,
            `with every balance 0 it does not say ok: the ledger is not M's (${JSON.stringify(zero9.rec)})`);
        const empty9 = await promote('promoted-empty', (db) => db.prepare('DELETE FROM accounts').run());
        assert(empty9.ran && empty9.rec?.ok === false && empty9.rec?.copy?.match === false,
            `with no accounts at all it does not say ok either (${JSON.stringify(empty9.rec)})`);

        refused.push(...(await main.send('fetches')).blocked);
        assert(refused.length === 0, `nothing reached off this machine (refused: ${refused.join(', ') || 'none'})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed in ${Math.round((Date.now() - started) / 1000)} s.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ A standby holds its main server\'s ledger exactly, from its own first pull.');
}

if (process.argv.includes('--child')) {
    child().catch((e) => {
        console.error('child failed:', e);
        process.exit(1);
    });
} else {
    main().then(() => process.exit(0)).catch((e) => {
        console.error('❌ Test failed:', e?.message || e);
        process.exit(1);
    });
}
