/**
 * Test Suite: a standby's ledger is its main server's, exactly, and a new standby makes its own first copy (G0 and G9 of
 * scratch/global-node/DESIGN-standby-takeover-gaps-opus.md; §5.3's G0 suite).
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts) serving its real HTTPS server; members
 * act through it with signed requests, the admin with the password. The standby pulls through its real puller
 * (services/backup-puller.ts `pullNow`, the loop's own step) from the main server's real backup routes, through a door
 * here that can serve the next copy it asks for from a payload the main server signed, or refuse it. Nothing leaves this
 * machine.
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
 *  6. A whole copy with a key SQLite stores as another string (half a surrogate pair): the key is never written, the
 *     check counts it as unreadable, and it asks for no force-resync (before, the force-resync it asked for was a seed).
 *     The whole-copy check fails on a copy whose sum is right and whose accounts are not; it records the mismatch and
 *     asks for one force-resync, and no second one within the hour after.
 *  7. The conservation guard still refuses a payload signed by M that makes Beans, drops an account holding them, or
 *     names one account twice to hide a shift. A copy that names only the Commons, holding the ledger's total, doesn't
 *     make the next copy a seed: one minting 1000 for a new key after it is refused, and the next real copy lands.
 *  8. A copy that throws after its accounts section is written (a forged later row here; a disk error there would do the
 *     same) leaves the standby's rows AND the ledger it holds in memory at its last good copy, so its own Commons flush
 *     writes nothing that isn't that copy's, and the next real pull lands (before, memory kept the refused copy's pot, the
 *     flush wrote it into the accounts, and every later copy was refused by the conservation guard, for good).
 *  9. A standby left as today's importer left it (every balance 0, stamped with its own clock, an account for SYSTEM, no
 *     record of the importer's format) heals in one pull.
 * 10. The take-over's promotion audit, on a copy of S: its ledger is M's as last copied; and on the same copy with every
 *     balance 0, or with no accounts at all, it says the ledger is not M's (before, both said "ok").
 * 11. On a second pair whose ledger sums to 0: a copy M0 signs naming no account carries no ledger, and the copy after it,
 *     minting 1000 for a new key, is refused; the standby keeps M0's ledger and the next real copy lands (before, the
 *     first emptied the ledger and the second went in as a seed).
 * 12. The force-resync a mismatch asks for is not a seed: a mint served to it is refused, and the next copies, across a
 *     restart, are held to the ledger's total before its clear until M's real copy lands.
 * 13. The format re-seed is used up when it clears: one whose fetch the main server refuses is asked for again at the
 *     next pull (before, not until the next boot); one whose import fails is not, and the next pull, a seed, lands.
 * 14. On M0's ledger: the guard measures the ledger's total after a copy's writes against before, as SQLite sums it (with
 *     compensation), not a running sum of doubles in the copy's order. The review's pair (+1e20, Eve 1000, −1e20, then
 *     Eve alone) and 1000 Beans hidden in 2,500 accounts between 20,000 of ±9e11 that cancel are refused (before, each
 *     measured 0 and landed). A balance that parses to Infinity, or ±1e15, is refused before anything is written.
 * 15. A copy naming no account that re-keys a member: memory follows the rows, so a read of the old key and the standby's
 *     own flush move nothing, and the next copy lands (before, memory kept the old key: the flush wrote a Commons credit
 *     with no debit, and every later copy was refused). An account list whose every entry is unreadable names no account:
 *     it changes none, the whole-copy check reads no ledger in it, and a held force-resync refuses it.
 * 16. A standby's own demurrage flush writes nothing: its trades are its main server's after a copy (before, a decay it
 *     flushed over another window than the main server's stayed in its history through every copy). A standby holding
 *     such a trade under the last importer format re-seeds at its first pull, and its trades are its main server's.
 * 17. A standby makes no Bean move of its own (director, 2026-09-28). On it, a member who owes 2,100 Beans deleting their
 *     own account (the review's sequence, 4117546944), a send, a trade's approval and a new request, and a payment from
 *     the Commons are each refused, by its routes (409 standby) and by its engine under them, with nothing written: its
 *     rows still sum to its main server's, and so after a read that applies demurrage, two moves and its own flush. Every
 *     route that moves Beans or steps a trade answers the same; a read still answers. Its next copy lands. The same moves
 *     on the main server work, and the copy carrying them lands with no trade of the standby's own (before, the delete
 *     left the standby's rows 2,102.34 Beans over its main server's and every copy after it was refused).
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-ledger-copy.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
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

/**
 * No node reaches anything but this machine: a push to Expo is answered here, and so is the update check's ask of GitHub
 * for the latest release (routes/settings.ts, 30 s after a node serves, as test-2fa-covers-admin-routes answers it);
 * anything else is refused and counted.
 */
function guardFetch(): { blocked: string[] } {
    const seen = { blocked: [] as string[] };
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return real(input, init);
        if (url.hostname === 'exp.host') return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url.hostname === 'api.github.com' && url.pathname.startsWith('/repos/beanpool-org/beanpool/')) return new Response('{}', { status: 404 });
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
                posts: (db.prepare('SELECT COUNT(*) AS c FROM posts').get() as { c: number }).c,
                format: cfg('replica_format'),
                mismatch: cfg('replica_ledger_mismatch'),
                held: cfg('replica_held_sum'),
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
         * the account set. Signed with M's own key, so only the conservation guard stands between it and a standby. And
         * the copies that went before one in a review's probes: an account set that names nothing, or only the Commons
         * holding the ledger's total (each moves no Beans), and a key SQLite stores as another string.
         */
        forge: async (a: {
            kind: 'mint' | 'drop' | 'twice' | 'throws-later' | 'empty' | 'commons-only' | 'commons-mint' | 'surrogate' | 'add' | 'unreadable-only';
            publicKey?: string;
            /** For `add`: accounts put in after the real ones, in this order. A balance of null here is sent as Infinity. */
            add?: { publicKey: string; balance: number | null }[];
        }) => {
            const { exportSyncState, signSyncPayload } = await import('./state-engine.js');
            const { getPrivateKey } = await import('./p2p.js');
            const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
            const payload: any = await exportSyncState(peerIdFromPrivateKey(getPrivateKey()).toString());
            delete payload.signature;
            delete payload.publicKey;
            if (a.kind === 'mint') payload.accounts = payload.accounts.map((x: any) => (x.publicKey === a.publicKey ? { ...x, balance: x.balance + 50 } : x));
            else if (a.kind === 'drop') payload.accounts = payload.accounts.filter((x: any) => x.publicKey !== a.publicKey);
            else if (a.kind === 'empty') payload.accounts = [];
            else if (a.kind === 'add') {
                // Signed as JSON.stringify writes Infinity (null), which is what the standby checks the signature against:
                // a body carrying 1e400 there parses to Infinity and still verifies (the orchestrator's door sends it).
                for (const x of a.add ?? []) {
                    payload.accounts.push({ publicKey: x.publicKey, balance: x.balance === null ? Infinity : x.balance, lastUpdatedAt: new Date().toISOString(), lastDemurrageEpoch: 0 });
                }
            } else if (a.kind === 'unreadable-only') {
                // An account list whose every entry has no key this server can store: none, and half a surrogate pair.
                payload.accounts = [
                    { publicKey: '', balance: 0, lastUpdatedAt: new Date().toISOString(), lastDemurrageEpoch: 0 },
                    { publicKey: 'zz\ud800', balance: 0, lastUpdatedAt: new Date().toISOString(), lastDemurrageEpoch: 0 },
                ];
            }
            else if (a.kind === 'commons-only' || a.kind === 'commons-mint') {
                // The Commons holding what every account holds between them, and no other account; then, for the mint, a
                // new key holding 1000 beside it.
                const total = payload.accounts.reduce((t: number, x: any) => t + x.balance, 0);
                const commons = payload.accounts.find((x: any) => x.publicKey === 'COMMONS_POOL');
                payload.accounts = [{ ...commons, balance: total }];
                if (a.kind === 'commons-mint') {
                    payload.accounts.push({ publicKey: crypto.randomBytes(32).toString('hex'), balance: 1000, lastUpdatedAt: new Date().toISOString(), lastDemurrageEpoch: 0 });
                }
            } else if (a.kind === 'surrogate') {
                // Half of a surrogate pair: SQLite stores the key with U+FFFD in its place, another string.
                payload.accounts.push({ publicKey: 'mallory\ud800', balance: 0, lastUpdatedAt: new Date().toISOString(), lastDemurrageEpoch: 0 });
            } else if (a.kind === 'throws-later') {
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
         * The main server's ledger as it can be: Beans moved between two accounts (the sum kept), and an account last read
         * `epochsAgo` days ago, so demurrage is due on it. Memory follows, as at a boot.
         */
        'plant-ledger': async (a: { moves: { publicKey: string; add: number; epochsAgo?: number }[] }) => {
            const { db } = await import('./db/db.js');
            const { reconcileLedgerFromDb } = await import('./state-engine.js');
            const today = Math.floor(Date.now() / 86_400_000);
            for (const m of a.moves) {
                db.prepare('UPDATE accounts SET balance = balance + ? WHERE public_key = ?').run(m.add, m.publicKey);
                if (typeof m.epochsAgo === 'number') db.prepare('UPDATE accounts SET last_demurrage_epoch = ? WHERE public_key = ?').run(today - m.epochsAgo, m.publicKey);
            }
            reconcileLedgerFromDb();
            return today;
        },
        /** A read of a balance, as a route makes it (demurrage due is applied in memory); `daysAgo` reads on an earlier day. */
        'read-balance': async (a: { publicKey: string; daysAgo?: number }) => {
            const { getBalance } = await import('./state-engine.js');
            const realNow = Date.now;
            if (a.daysAgo) Date.now = () => realNow() - a.daysAgo! * 86_400_000;
            try { return getBalance(a.publicKey).balance; } finally { Date.now = realNow; }
        },
        /** The ledger this server holds in memory: every account (no demurrage applied by the read) and the Commons pot. */
        'memory-ledger': async () => {
            const { ledger } = await import('./engine/ledger.js');
            const { getCommonsBalanceExact } = await import('./state-engine.js');
            return {
                accounts: ledger.getAllAccounts().map((x) => ({ public_key: x.id, balance: x.balance, last_demurrage_epoch: x.lastDemurrageEpoch }))
                    .sort((p, q) => (p.public_key < q.public_key ? -1 : 1)),
                pot: getCommonsBalanceExact(),
            };
        },
        /** The main server replaces a member's key (an operator's re-enrolment, engine/member-wizards.ts). */
        rekey: async (a: { oldPk: string; newPk: string }) => {
            const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
            const { code } = issueRekeyCode(a.oldPk, 'owner:password');
            return completeRekey(a.oldPk, a.newPk, code, 'owner:password').success;
        },
        /**
         * A Bean move asked of this server's engine itself, under its routes: a member's own delete, a send, a trade's
         * approval (the Beans go into escrow), a payment from the Commons. What it threw, if it did.
         */
        'engine-move': async (a: { kind: 'purge' | 'transfer' | 'approve' | 'commons-pay'; publicKey: string; to?: string; amount?: number; transactionId?: string }) => {
            const se = await import('./state-engine.js');
            try {
                if (a.kind === 'purge') se.purgeMemberSelf(a.publicKey);
                else if (a.kind === 'transfer') { if (!se.transfer(a.publicKey, a.to!, a.amount!, 'a send', 'direct', true)) return { ok: false, error: 'refused (null)' }; }
                else if (a.kind === 'approve') se.approvePostRequest(a.transactionId!, a.publicKey);
                else if (!se.payFromCommons(a.publicKey, a.amount!, 'a commons payment', { allowDeficit: true })) return { ok: false, error: 'refused (null)' };
                return { ok: true };
            } catch (e: any) {
                return { ok: false, name: e?.name ?? null, code: e?.code ?? null, status: e?.status ?? null, error: e?.message || String(e) };
            }
        },
        /** A trade as this server holds it. */
        trade: async (a: { id: string }) => {
            const { db } = await import('./db/db.js');
            return db.prepare('SELECT id, status, credits FROM marketplace_transactions WHERE id = ?').get(a.id) ?? null;
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

type Ledger = { accounts: any[]; sum: number; transactions: any[]; beanpool: any[]; members: number; posts: number; format: string | null; mismatch: string | null; held: string | null };

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

type Memory = { accounts: { public_key: string; balance: number; last_demurrage_epoch: number }[]; pot: number };
/** Where the ledger a server holds in memory differs from its rows: every account, and the Commons pot. */
function memoryVsRows(mem: Memory, rows: Ledger): string[] {
    const out: string[] = [];
    const inMemory = new Map(mem.accounts.map((a) => [a.public_key, a]));
    const inRows = new Set(rows.accounts.map((r) => r.public_key));
    for (const r of rows.accounts) {
        const m = inMemory.get(r.public_key);
        if (!m) { out.push(`${r.public_key.slice(0, 12)} not in memory`); continue; }
        if (m.balance !== r.balance) out.push(`${r.public_key.slice(0, 12)}.balance: memory ${m.balance}, row ${r.balance}`);
        if (m.last_demurrage_epoch !== r.last_demurrage_epoch) out.push(`${r.public_key.slice(0, 12)}.epoch: memory ${m.last_demurrage_epoch}, row ${r.last_demurrage_epoch}`);
    }
    for (const k of inMemory.keys()) if (!inRows.has(k)) out.push(`${k.slice(0, 12)} only in memory (${inMemory.get(k)!.balance})`);
    const potRow = rows.accounts.find((a) => a.public_key === 'COMMONS_POOL')?.balance;
    if (mem.pot !== potRow) out.push(`pot: memory ${mem.pot}, row ${potRow}`);
    return out;
}

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

/**
 * The main server as its standbys reach it: every request passed to its real backup routes, on this machine, except that
 * a step can have the next copy a standby asks for (a delta or a whole one) answered with a payload M signed, or refused
 * with a status, as a main server can send them. The standby's own puller fetches, checks and imports it.
 */
/** A copy the door answers with: a payload M signed as JSON, or its text as sent (`raw`), or a status alone. */
type DoorAnswer = { status: number; body?: unknown; raw?: string };
interface MainServerDoor { url: string; next: (answer: DoorAnswer) => void; waiting: () => number; close: () => Promise<void> }
async function mainServerDoor(target: string): Promise<MainServerDoor> {
    const queued: DoorAnswer[] = [];
    const server = http.createServer((req, res) => {
        void (async () => {
            try {
                const answer = req.url?.startsWith('/api/local/admin/sync-') ? queued.shift() : undefined;
                if (answer) {
                    res.writeHead(answer.status, { 'Content-Type': 'application/json', 'X-Node-Role': 'primary' });
                    res.end(answer.raw ?? (answer.body === undefined ? JSON.stringify({ error: 'refused by this step' }) : JSON.stringify(answer.body)));
                    return;
                }
                const chunks: Buffer[] = [];
                for await (const c of req) chunks.push(c as Buffer);
                const headers: Record<string, string> = {};
                for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && (k.startsWith('x-') || k === 'content-type')) headers[k] = v;
                const r = await fetch(target + req.url, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
                const out: Record<string, string> = { 'Content-Type': r.headers.get('content-type') ?? 'application/json' };
                const role = r.headers.get('x-node-role');
                if (role) out['X-Node-Role'] = role;
                res.writeHead(r.status, out);
                res.end(Buffer.from(await r.arrayBuffer()));
            } catch (e: any) {
                res.writeHead(502);
                res.end(String(e?.message || e));
            }
        })();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        next: (answer) => { queued.push(answer); },
        waiting: () => queued.length,
        close: () => new Promise<void>((r) => server.close(() => r())),
    };
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dir = (n: string) => path.join(root, n);
    const nodes: NodeProc[] = [];
    const doors: MainServerDoor[] = [];
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
        // Every standby here reaches M through this door, so a step can serve it a copy M signed (a pass-through otherwise).
        const door = await mainServerDoor(main.base);
        doors.push(door);
        await standby.send('setup-standby', { primaryUrl: door.url, replicationToken, primaryPeerId: main.ready.peerId });
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
        console.log('\n— 6. a whole copy with a key SQLite stores as another string —');
        // First, while no force-resync has been asked for in this process (one within six hours isn't): a whole copy M
        // signs with one more account, under a key holding half of a surrogate pair. Stored, it came back as another string,
        // so the check found two accounts differing on the copy just imported and asked for a force-resync, and that one
        // was a seed the guard didn't hold. A main server can ask for a whole copy whenever it likes.
        door.next({ status: 200, body: await main.send('forge', { kind: 'surrogate' }) });
        const sur = await standby.send('pull', { whole: true });
        const surNote = JSON.parse((await standby.send('ledger') as Ledger).mismatch ?? 'null');
        s = await standby.send('ledger');
        const m6s: Ledger = await main.send('ledger');
        assert(sur.ok === true && sur.whole === true && sur.consistency?.ledger?.unreadable === 1 && sur.consistency?.ledger?.differing === 0,
            `the check counts that key as unreadable, and no account as differing (${JSON.stringify({ ok: sur.ok, error: sur.error, ledger: sur.consistency?.ledger })})`);
        assert(surNote && surNote.resync !== 'scheduled', `it asks for no force-resync (${JSON.stringify(surNote)})`);
        assert(ledgerDiff(m6s, s).length === 0 && !s.accounts.some((a) => a.public_key.startsWith('mallory')),
            `the key is never written: S's ledger is M's (differences ${first(ledgerDiff(m6s, s))})`);
        const afterSur = await standby.send('pull', {});
        assert(afterSur.ok === true && afterSur.mode === 'delta', `the next pull is a delta, not a force-resync (${JSON.stringify({ ok: afterSur.ok, mode: afterSur.mode, error: afterSur.error })})`);

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

        // A copy M signs that names only the Commons, holding the ledger's total, on this ledger that doesn't sum to 0: it
        // moves no Beans, so the guard lets it in. It left the ledger one account, and a ledger of one account was a seed:
        // the next copy, minting 1000 for a new key, went in unchecked, and every real copy after it was refused. The
        // puller now says what a seed is, from this standby's own records.
        console.log('\n— 7. a copy that names only the Commons, then one that mints —');
        door.next({ status: 200, body: await main.send('forge', { kind: 'commons-only' }) });
        const only = await standby.send('pull', {});
        const afterOnly: Ledger = await standby.send('ledger');
        console.log(`  (the Commons-only copy: ${only.ok ? 'imported' : only.error}; S now holds ${afterOnly.accounts.length} account(s), summing to ${afterOnly.sum})`);
        door.next({ status: 200, body: await main.send('forge', { kind: 'commons-mint' }) });
        const mint7 = await standby.send('pull', {});
        const m7: Ledger = await main.send('ledger');
        s = await standby.send('ledger');
        assert(mint7.ok === false && /Conservation violation/.test(mint7.error ?? ''), `the copy after it, minting 1000 for a new key, is refused (${mint7.ok ? 'imported' : mint7.error})`);
        assert(Math.abs(s.sum - m7.sum) < 1e-6 && !s.accounts.some((a) => Math.abs(a.balance - 1000) < 1e-9),
            `S's ledger still sums to M's, and holds no minted account (S ${s.sum}, M ${m7.sum})`);
        const real7 = await standby.send('pull', {});
        s = await standby.send('ledger');
        assert(real7.ok === true && ledgerDiff(m7, s).length === 0,
            `the next real copy lands, and S's ledger is M's (${JSON.stringify({ ok: real7.ok, mode: real7.mode, error: real7.error })}; differences ${first(ledgerDiff(m7, s))})`);

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

        // ── 11. A copy that names no account, on a ledger that sums to 0 ──
        console.log('\n— 11. on a ledger that sums to 0: a copy that names no account, then one that mints —');
        const main0 = await spawnNode(SCRIPT, dir('main0'), env(PW_MAIN, 'primary'));
        nodes.push(main0);
        const token0 = crypto.randomBytes(32).toString('hex');
        const [gwen0, yan] = ['Gwen', 'Yan'].map(newId);
        await main0.send('setup-primary', { replicationToken: token0, genesis: gwen0.pk });
        const z = `https://localhost:${await main0.send('serve')}`;
        const Z_ = (who: Id, route: string, body: unknown = {}) => api(z, 'POST', route, { as: who, body });
        built('M0: Gwen sets a profile photo', await Z_(gwen0, '/api/profile/update', { avatar: TINY_PNG }));
        const inv0 = built('M0: Gwen makes an invite for Yan', await Z_(gwen0, '/api/invite/generate', { publicKey: gwen0.pk }));
        built('M0: Yan joins with it', await api(z, 'POST', '/api/invite/redeem', { body: { code: inv0.invite?.code ?? inv0.code, publicKey: yan.pk, callsign: 'Yan' } }));
        built('M0: Yan sets a profile photo', await Z_(yan, '/api/profile/update', { avatar: TINY_PNG }));
        built('M0: the admin makes Gwen an Elder', await api(z, 'POST', `/api/local/admin/users/${gwen0.pk}/elder`, { admin: PW_MAIN, body: { grant: true } }));
        const offer0 = async (who: Id, title: string, credits: number) => built(`M0: ${who.name} offers ${title}`, await Z_(who, '/api/marketplace/posts', {
            type: 'offer', category: 'food', title, description: `${title}, from ${who.name}`, credits, priceType: 'fixed', authorPublicKey: who.pk,
        })).post;
        await offer0(gwen0, 'Jam', 3);
        const eggs = await offer0(yan, 'Eggs', 12);
        const tx0 = built('M0: Gwen asks for the eggs', await Z_(gwen0, '/api/marketplace/posts/request', { postId: eggs.id, buyerPublicKey: gwen0.pk })).transaction;
        built('M0: Yan approves', await Z_(yan, '/api/marketplace/transactions/approve', { transactionId: tx0.id, authorPublicKey: yan.pk }));
        built('M0: Gwen confirms: Yan is paid, the Commons takes its fee', await Z_(gwen0, '/api/marketplace/transactions/complete', { transactionId: tx0.id, confirmerPublicKey: gwen0.pk }));
        built('M0: Yan gives Gwen 2 Beans back', await Z_(yan, '/api/ledger/transfer', { to: gwen0.pk, amount: 2, memo: 'for the jar' }));
        const z1: Ledger = await main0.send('ledger');
        require_(Math.abs(z1.sum) < 1e-9 && z1.accounts.some((a) => a.balance > 1), `M0: a ledger that sums to 0, with Beans held (${JSON.stringify(z1.accounts.map((a) => a.balance))})`);
        fs.mkdirSync(dir('standby0'), { recursive: true });
        fs.copyFileSync(path.join(dir('main0'), 'genesis.json'), path.join(dir('standby0'), 'genesis.json'));
        const standby0 = await spawnNode(SCRIPT, dir('standby0'), env(PW_STANDBY, 'backup'));
        nodes.push(standby0);
        const door0 = await mainServerDoor(main0.base);
        doors.push(door0);
        await standby0.send('setup-standby', { primaryUrl: door0.url, replicationToken: token0, primaryPeerId: main0.ready.peerId });
        const first0 = await standby0.send('pull', {});
        let s0l: Ledger = await standby0.send('ledger');
        require_(first0.ok === true && ledgerDiff(z1, s0l).length === 0, `S0's first copy is M0's ledger (${first0.ok ? 'imported' : first0.error}; differences ${first(ledgerDiff(z1, s0l))})`);
        door0.next({ status: 200, body: await main0.send('forge', { kind: 'empty' }) });
        const empty11 = await standby0.send('pull', {});
        s0l = await standby0.send('ledger');
        assert(ledgerDiff(z1, s0l).length === 0,
            `a copy M0 signs that names no account carries no ledger: S0's ledger stays M0's (${empty11.ok ? 'imported' : empty11.error}; differences ${first(ledgerDiff(z1, s0l))})`);
        door0.next({ status: 200, body: await main0.send('forge', { kind: 'commons-mint' }) });
        const mint11 = await standby0.send('pull', {});
        s0l = await standby0.send('ledger');
        assert(mint11.ok === false && /Conservation violation/.test(mint11.error ?? ''), `the copy after it, minting 1000 for a new key, is refused (${mint11.ok ? 'imported' : mint11.error})`);
        assert(ledgerDiff(z1, s0l).length === 0, `S0 keeps M0's real ledger (differences ${first(ledgerDiff(z1, s0l))})`);
        const real11 = await standby0.send('pull', {});
        s0l = await standby0.send('ledger');
        const z2: Ledger = await main0.send('ledger');
        assert(real11.ok === true && ledgerDiff(z2, s0l).length === 0,
            `the next real copy lands, and S0's ledger is M0's (${JSON.stringify({ ok: real11.ok, mode: real11.mode, error: real11.error })}; differences ${first(ledgerDiff(z2, s0l))})`);
        refused.push(...(await standby0.send('fetches')).blocked, ...(await main0.send('fetches')).blocked);

        // ── 12. The force-resync a mismatch asks for is held to the ledger before its clear ──
        console.log('\n— 12. the force-resync after a copy that didn\'t match is not a seed —');
        copyDir(dir('audit'), dir('held'));
        let heldS = await spawnNode(SCRIPT, dir('held'), env(PW_STANDBY, 'backup'));
        nodes.push(heldS);
        // It copies M's latest first. (Its boot's escrow sweep once deleted the empty escrow accounts M still holds; a
        // standby's boot sweeps nothing now: its accounts are M's, state-engine.ts sweepSettledEscrowAccounts.)
        require_((await heldS.send('pull', {})).ok === true, 'the restarted copy of S pulls');
        const m12: Ledger = await main.send('ledger');
        await heldS.send('plant-balance', { publicKey: ann.pk, add: 4 });
        await heldS.send('plant-balance', { publicKey: bo.pk, add: -4 });
        const c12 = await heldS.send('check-copy');
        const n12 = JSON.parse((await heldS.send('ledger') as Ledger).mismatch ?? 'null');
        require_(c12.consistency?.ledger?.differing === 2 && n12?.resync === 'scheduled', `a whole copy that doesn't match asks for a force-resync (${JSON.stringify(n12)})`);
        door.next({ status: 200, body: await main.send('forge', { kind: 'mint', publicKey: kip.pk }) });
        const heldMint = await heldS.send('pull', {});
        let h: Ledger = await heldS.send('ledger');
        assert(heldMint.mode === 'resync' && heldMint.ok === false && /Conservation violation/.test(heldMint.error ?? ''),
            `that force-resync, served a copy M signed that gives Kip 50 Beans from nowhere, refuses it (${JSON.stringify({ mode: heldMint.mode, ok: heldMint.ok, error: heldMint.error })})`);
        assert(h.held !== null && Math.abs(Number(h.held) - m12.sum) < 1e-6,
            `the total it holds copies to is the ledger's before its clear, kept until one lands (${h.held}; M ${m12.sum})`);
        await heldS.send('persist'); // its own flush, into the cleared rows
        await heldS.send('checkpoint');
        refused.push(...(await heldS.send('fetches')).blocked);
        await heldS.kill('SIGTERM');
        heldS = await spawnNode(SCRIPT, dir('held'), env(PW_STANDBY, 'backup'));
        nodes.push(heldS);
        door.next({ status: 200, body: await main.send('forge', { kind: 'mint', publicKey: kip.pk }) });
        const heldMint2 = await heldS.send('pull', {});
        assert(heldMint2.ok === false && /Conservation violation/.test(heldMint2.error ?? ''),
            `after a restart the next copy is still held: the same mint is refused (${JSON.stringify({ mode: heldMint2.mode, ok: heldMint2.ok, error: heldMint2.error })})`);
        door.next({ status: 200, body: await main.send('forge', { kind: 'empty' }) });
        const heldEmpty = await heldS.send('pull', {});
        assert(heldEmpty.ok === false, `and so is a copy that names no account, which would keep the ledger the clear emptied (${heldEmpty.ok ? 'imported' : heldEmpty.error})`);
        const heldReal = await heldS.send('pull', {});
        h = await heldS.send('ledger');
        const m12b: Ledger = await main.send('ledger');
        assert(heldReal.ok === true && ledgerDiff(m12b, h).length === 0 && h.held === null,
            `M's real copy lands, the ledger is M's, and nothing is held any more (${JSON.stringify({ ok: heldReal.ok, mode: heldReal.mode, error: heldReal.error, held: h.held })}; differences ${first(ledgerDiff(m12b, h))})`);
        refused.push(...(await heldS.send('fetches')).blocked);
        await heldS.kill('SIGTERM');

        // ── 13. The format re-seed is used up when it clears ──
        console.log('\n— 13. the format re-seed: a refused fetch asks for it again; a failed import uses it up —');
        const noFormat = (db: Database.Database) => { db.prepare("DELETE FROM node_config WHERE key = 'replica_format'").run(); };
        copyDir(dir('audit'), dir('reseed'));
        withDb(dir('reseed'), noFormat);
        const reseed = await spawnNode(SCRIPT, dir('reseed'), env(PW_STANDBY, 'backup'));
        nodes.push(reseed);
        door.next({ status: 503 }); // the main server restarting with the same update
        const busy = await reseed.send('pull', {});
        require_(busy.ok === false && busy.mode === 'resync', `the first pull is the format re-seed, and the main server refuses it (${JSON.stringify({ ok: busy.ok, mode: busy.mode, error: busy.error })})`);
        const again13 = await reseed.send('pull', {});
        const r13: Ledger = await reseed.send('ledger');
        const m13: Ledger = await main.send('ledger');
        assert(again13.ok === true && again13.mode === 'resync' && Number(r13.format) >= 1 && ledgerDiff(m13, r13).length === 0,
            `the next pull asks for it again, it lands, and the format is recorded (${JSON.stringify({ ok: again13.ok, mode: again13.mode, error: again13.error, format: r13.format })}; differences ${first(ledgerDiff(m13, r13))})`);
        refused.push(...(await reseed.send('fetches')).blocked);
        await reseed.kill('SIGTERM');
        copyDir(dir('audit'), dir('reseed-throws'));
        withDb(dir('reseed-throws'), noFormat);
        const reseedT = await spawnNode(SCRIPT, dir('reseed-throws'), env(PW_STANDBY, 'backup'));
        nodes.push(reseedT);
        door.next({ status: 200, body: await main.send('forge', { kind: 'throws-later', publicKey: ann.pk }) });
        const broke = await reseedT.send('pull', {});
        require_(broke.ok === false && broke.mode === 'resync', `the format re-seed's import fails after its clear (${JSON.stringify({ ok: broke.ok, mode: broke.mode, error: broke.error })})`);
        await reseedT.send('persist'); // its own flush, into the cleared rows
        const after13 = await reseedT.send('pull', {});
        const t13: Ledger = await reseedT.send('ledger');
        assert(after13.ok === true && after13.mode === 'full' && Number(t13.format) >= 1 && ledgerDiff(m13, t13).length === 0,
            `it is used up all the same: the next pull is a whole copy, not another clear, and, no copy having landed since the clear, a seed that lands (${JSON.stringify({ ok: after13.ok, mode: after13.mode, error: after13.error, format: t13.format })}; differences ${first(ledgerDiff(m13, t13))})`);
        refused.push(...(await reseedT.send('fetches')).blocked);
        await reseedT.kill('SIGTERM');

        // ── 14. The guard measures the ledger's real total; a balance no ledger holds is refused ──
        console.log('\n— 14. on M0\'s ledger, which sums to 0: copies that hide a mint from a running sum, and balances no ledger holds —');
        const hexKey = () => crypto.randomBytes(32).toString('hex');
        const pull0 = async (answer: DoorAnswer, whole = false) => { door0.next(answer); return standby0.send('pull', { whole }); };
        const eve = hexKey();
        // The review's pair (4116975493): +1e20, Eve 1000 and −1e20 measured 0 in the guard's running sum of doubles, and the
        // copy after it, dropping the two big accounts, measured 0 too. The standby held 1000 Beans M0's ledger doesn't have.
        const bigPair = await pull0({ status: 200, body: await main0.send('forge', { kind: 'add', add: [{ publicKey: hexKey(), balance: 1e20 }, { publicKey: eve, balance: 1000 }, { publicKey: hexKey(), balance: -1e20 }] }) });
        const evePair = await pull0({ status: 200, body: await main0.send('forge', { kind: 'add', add: [{ publicKey: eve, balance: 1000 }] }) });
        let z14: Ledger = await main0.send('ledger');
        s0l = await standby0.send('ledger');
        assert(bigPair.ok === false && evePair.ok === false, `the review's pair of copies is refused, both (${JSON.stringify([bigPair.error ?? 'imported', evePair.error ?? 'imported'])})`);
        assert(ledgerDiff(z14, s0l).length === 0 && Math.abs(s0l.sum) < 1e-9,
            `S0's ledger stays M0's, summing to 0, with no Beans for Eve (S0 sums to ${s0l.sum}; differences ${first(ledgerDiff(z14, s0l))})`);
        // The same trick inside any bound on a balance: 10,000 accounts holding 9e11 take a running sum to 9e15, where a
        // double's step is 1, so 2,500 accounts holding 0.4 each add nothing to it, and 10,000 at −9e11 bring it back to 0.
        const many = (n: number, balance: number) => Array.from({ length: n }, () => ({ publicKey: hexKey(), balance }));
        const hidden = await pull0({ status: 200, body: await main0.send('forge', { kind: 'add', add: [...many(10_000, 9e11), ...many(2_500, 0.4), ...many(10_000, -9e11)] }) });
        z14 = await main0.send('ledger');
        s0l = await standby0.send('ledger');
        assert(hidden.ok === false && /Conservation violation: import shifted total balance by 1000\.0000/.test(hidden.error ?? ''),
            `a copy that hides 1000 Beans in 2,500 accounts between 20,000 that cancel is refused, measured at 1000 (${hidden.ok ? 'imported' : hidden.error})`);
        assert(ledgerDiff(z14, s0l).length === 0, `S0's ledger stays M0's (S0 sums to ${s0l.sum}; differences ${first(ledgerDiff(z14, s0l))})`);
        // A balance no ledger holds, before anything is written: one that parses to Infinity (1e400, which the signature
        // doesn't see: it is checked against JSON.stringify's text, where Infinity is null), and a pair of ±1e15 that cancel.
        built('M0: Gwen lists plums (a change the next copy carries)', await Z_(gwen0, '/api/marketplace/posts', {
            type: 'offer', category: 'food', title: 'Plums', description: 'Plums, from Gwen', credits: 2, priceType: 'fixed', authorPublicKey: gwen0.pk,
        }));
        const inf = hexKey();
        const infRaw = JSON.stringify(await main0.send('forge', { kind: 'add', add: [{ publicKey: inf, balance: null }] }))
            .replace(`"publicKey":"${inf}","balance":null`, `"publicKey":"${inf}","balance":1e400`);
        require_(infRaw.includes('1e400'), 'a copy M0 signed that carries a balance of 1e400');
        const infinite = await pull0({ status: 200, raw: infRaw });
        const absurd = await pull0({ status: 200, body: await main0.send('forge', { kind: 'add', add: [{ publicKey: hexKey(), balance: 1e15 }, { publicKey: hexKey(), balance: -1e15 }] }) });
        const after14: Ledger = await standby0.send('ledger');
        assert(infinite.ok === false && /beyond what any ledger holds/.test(infinite.error ?? ''), `a balance that parses to Infinity is refused (${infinite.ok ? 'imported' : infinite.error})`);
        assert(absurd.ok === false && /beyond what any ledger holds/.test(absurd.error ?? ''), `so are two of ±1e15 that cancel (${absurd.ok ? 'imported' : absurd.error})`);
        // As a conservation violation, which the puller logs at SECURITY (services/backup-puller.ts), not as a pull to retry.
        assert(/Conservation violation/.test(infinite.error ?? '') && /Conservation violation/.test(absurd.error ?? ''),
            `both are refused as conservation violations (${infinite.error}; ${absurd.error})`);
        assert(ledgerDiff(s0l, after14).length === 0 && after14.posts === s0l.posts,
            `neither wrote anything: S0's ledger is as it was, and it doesn't hold Gwen's plums (differences ${first(ledgerDiff(s0l, after14))}; listings ${s0l.posts} → ${after14.posts})`);
        const real14 = await standby0.send('pull', {});
        z14 = await main0.send('ledger');
        s0l = await standby0.send('ledger');
        assert(real14.ok === true && ledgerDiff(z14, s0l).length === 0 && s0l.posts === after14.posts + 1,
            `the next real copy lands: S0's ledger is M0's, and the plums are there (${JSON.stringify({ ok: real14.ok, mode: real14.mode, error: real14.error })}; differences ${first(ledgerDiff(z14, s0l))})`);

        // ── 15. A copy naming no account that re-keys a member ──
        console.log('\n— 15. a copy naming no account that re-keys a member: the standby\'s memory follows its rows —');
        const yan2 = newId('Yan');
        // Yan holds 500 more, not read since long ago (the review's probe: demurrage due on a read).
        await main0.send('plant-ledger', { moves: [{ publicKey: gwen0.pk, add: -500 }, { publicKey: yan.pk, add: 500, epochsAgo: 20_000 }] });
        const p15 = await standby0.send('pull', {});
        let r15: Ledger = await standby0.send('ledger');
        require_(p15.ok === true && ledgerDiff(await main0.send('ledger'), r15).length === 0, `S0 copies it (${p15.ok ? 'imported' : p15.error})`);
        require_(await main0.send('rekey', { oldPk: yan.pk, newPk: yan2.pk }), 'M0 replaces Yan\'s key');
        const rekeyed = await pull0({ status: 200, body: await main0.send('forge', { kind: 'empty' }) });
        r15 = await standby0.send('ledger');
        const yanRow = r15.accounts.find((a) => a.public_key === yan2.pk);
        assert(rekeyed.ok === true && !!yanRow && yanRow.balance > 500 && !r15.accounts.some((a) => a.public_key === yan.pk),
            `the copy lands, and S0's rows hold Yan's account under the new key (${rekeyed.ok ? 'imported' : rekeyed.error}; ${JSON.stringify(yanRow ?? null)})`);
        assert(memoryVsRows(await standby0.send('memory-ledger'), r15).length === 0,
            `S0's memory is its rows: Yan's account under the new key and none under the old (differences ${first(memoryVsRows(await standby0.send('memory-ledger'), r15))})`);
        await standby0.send('read-balance', { publicKey: yan.pk });
        await standby0.send('persist');
        const flushed15: Ledger = await standby0.send('ledger');
        assert(Math.abs(flushed15.sum) < 1e-9 && ledgerDiff(r15, flushed15).length === 0,
            `a read of the old key and S0's own flush move nothing: its rows still sum to M0's 0 (${flushed15.sum}; differences ${first(ledgerDiff(r15, flushed15))})`);
        const next15 = await standby0.send('pull', {});
        let z15: Ledger = await main0.send('ledger');
        r15 = await standby0.send('ledger');
        assert(next15.ok === true && ledgerDiff(z15, r15).length === 0,
            `the next real copy lands, and S0's ledger is M0's (${JSON.stringify({ ok: next15.ok, mode: next15.mode, error: next15.error })}; differences ${first(ledgerDiff(z15, r15))})`);
        assert(memoryVsRows(await standby0.send('memory-ledger'), r15).length === 0, 'and its memory is its rows');

        console.log('\n— 15. an account list whose every entry is unreadable names no account —');
        // Every entry without a key this server can store (none, half a surrogate pair): a copy naming no account, which
        // carries no ledger. Read as a ledger naming nobody, it emptied S0's, a ledger that sums to 0 let that past the
        // guard, and it released a hold whose total was 0 (4116975147's round, "Not a finding").
        const unreadable = await pull0({ status: 200, body: await main0.send('forge', { kind: 'unreadable-only' }) }, true);
        r15 = await standby0.send('ledger');
        z15 = await main0.send('ledger');
        assert(unreadable.ok === true && ledgerDiff(z15, r15).length === 0,
            `a whole copy carrying only such entries lands and changes no account: S0's ledger stays M0's (${unreadable.ok ? 'imported' : unreadable.error}; differences ${first(ledgerDiff(z15, r15))})`);
        const note15 = JSON.parse(r15.mismatch ?? 'null');
        const after15 = await standby0.send('pull', {});
        assert(unreadable.consistency?.ledger === null && note15?.resync !== 'scheduled' && after15.mode === 'delta',
            `the whole-copy check reads no ledger in it either, and asks for no force-resync (${JSON.stringify({ ledger: unreadable.consistency?.ledger, note: note15, next: after15.mode })})`);
        await standby0.send('plant-balance', { publicKey: gwen0.pk, add: 4 });
        await standby0.send('plant-balance', { publicKey: yan2.pk, add: -4 });
        const c15 = await standby0.send('check-copy');
        const n15 = JSON.parse((await standby0.send('ledger') as Ledger).mismatch ?? 'null');
        require_(c15.consistency?.ledger?.differing === 2 && n15?.resync === 'scheduled', `a whole copy that doesn't match asks for a force-resync (${JSON.stringify(n15)})`);
        const heldUnreadable = await pull0({ status: 200, body: await main0.send('forge', { kind: 'unreadable-only' }) });
        r15 = await standby0.send('ledger');
        assert(heldUnreadable.mode === 'resync' && heldUnreadable.ok === false && r15.held !== null,
            `that force-resync, served such a copy, refuses it: it carries no ledger to put back the one the clear took, whose total was 0 (${JSON.stringify({ mode: heldUnreadable.mode, ok: heldUnreadable.ok, error: heldUnreadable.error, held: r15.held })})`);
        const heldReal15 = await standby0.send('pull', {});
        r15 = await standby0.send('ledger');
        z15 = await main0.send('ledger');
        assert(heldReal15.ok === true && ledgerDiff(z15, r15).length === 0 && r15.held === null,
            `M0's real copy lands, and nothing is held any more (${JSON.stringify({ ok: heldReal15.ok, mode: heldReal15.mode, error: heldReal15.error, held: r15.held })}; differences ${first(ledgerDiff(z15, r15))})`);

        // ── 16. The standby's own demurrage ──
        console.log('\n— 16. a standby\'s own demurrage flush: no trade of its own stays through a copy —');
        // Yan holds Beans last read 40 days ago. M0 reads her balance on a day 20 days ago and again today (two decays, two
        // rows); S0 reads it today, between them, over the whole 40 days, and flushes (a row M0 never made).
        await main0.send('plant-ledger', { moves: [{ publicKey: gwen0.pk, add: -400 }, { publicKey: yan2.pk, add: 400, epochsAgo: 40 }] });
        require_((await standby0.send('pull', {})).ok === true, 'S0 copies it');
        await main0.send('read-balance', { publicKey: yan2.pk, daysAgo: 20 });
        await main0.send('persist');
        await standby0.send('read-balance', { publicKey: yan2.pk });
        await standby0.send('persist');
        await main0.send('read-balance', { publicKey: yan2.pk });
        await main0.send('persist');
        const z16: Ledger = await main0.send('ledger');
        const decays = z16.transactions.filter((t) => t.id.startsWith(`demurrage_${yan2.pk.slice(0, 16)}_`));
        require_(decays.length === 2, `M0 holds two demurrage trades for Yan, one per read (${decays.map((t) => t.id.slice(27)).join(', ')})`);
        const p16 = await standby0.send('pull', {});
        const r16: Ledger = await standby0.send('ledger');
        assert(p16.ok === true && ledgerDiff(z16, r16).length === 0,
            `the next copy lands, and S0's trades are M0's, with no demurrage trade of its own (${JSON.stringify({ ok: p16.ok, error: p16.error })}; differences ${first(ledgerDiff(z16, r16))})`);
        assert(memoryVsRows(await standby0.send('memory-ledger'), r16).length === 0, 'and its memory is its rows');

        // A standby updated from the last format holds such trades already, and no copy removes them: the format goes up
        // (engine/sync.ts REPLICA_FORMAT), and its first pull after the update is the re-seed that clears them.
        console.log('\n— 16. a standby that flushed demurrage of its own under the last format heals at its first pull —');
        await standby0.send('checkpoint');
        refused.push(...(await standby0.send('fetches')).blocked);
        await standby0.kill('SIGTERM');
        copyDir(dir('standby0'), dir('format1'));
        withDb(dir('format1'), (db) => {
            // Format 2 (#1272's listings): the last one whose standby still flushed demurrage of its own.
            db.prepare("UPDATE node_config SET value = '2' WHERE key = 'replica_format'").run();
            db.prepare(`INSERT INTO transactions (id, from_pubkey, to_pubkey, amount, tax_fee, memo, timestamp) VALUES (?, ?, 'COMMONS_POOL', 1.5, 0, 'Circulation fee (demurrage, 40d)', ?)`)
                .run(`demurrage_${yan2.pk.slice(0, 16)}_1_41`, yan2.pk, new Date().toISOString());
        });
        const format1 = await spawnNode(SCRIPT, dir('format1'), env(PW_STANDBY, 'backup'));
        nodes.push(format1);
        const healed16 = await format1.send('pull', {});
        const f16: Ledger = await format1.send('ledger');
        const z16b: Ledger = await main0.send('ledger');
        assert(healed16.ok === true && healed16.mode === 'resync' && Number(f16.format) > 2 && ledgerDiff(z16b, f16).length === 0,
            `its first pull is the format re-seed, and its trades are M0's (${JSON.stringify({ ok: healed16.ok, mode: healed16.mode, error: healed16.error, format: f16.format })}; differences ${first(ledgerDiff(z16b, f16))})`);

        // ── 17. A standby makes no Bean move of its own ──
        console.log('\n— 17. on a standby, a member in debt deleting their own account, a send, a trade and a Commons payment are refused —');
        // The review's sequence (4117546944): a member who owes Beans deletes their own account on the standby. The Commons'
        // payment of their debt wrote their credit, the flush that wrote the pot's debit writes nothing on a standby, and the
        // rows summed to 2,102.34 over the main server's: every copy after it was refused. Now every Bean move refuses there
        // before it writes, through its routes (409 standby) and in its engine under them.
        const zed = newId('Zed');
        const invZ = built('M0: Gwen makes an invite for Zed', await Z_(gwen0, '/api/invite/generate', { publicKey: gwen0.pk }));
        built('M0: Zed joins with it', await api(z, 'POST', '/api/invite/redeem', { body: { code: invZ.invite?.code ?? invZ.code, publicKey: zed.pk, callsign: 'Zed' } }));
        built('M0: Zed sets a profile photo', await Z_(zed, '/api/profile/update', { avatar: TINY_PNG }));
        await offer0(yan2, 'Pears', 3);
        const figs = await offer0(gwen0, 'Figs', 4);
        const tx17 = built('M0: Yan asks for Gwen\'s figs', await Z_(yan2, '/api/marketplace/posts/request', { postId: figs.id, buyerPublicKey: yan2.pk })).transaction;
        // Zed owes 2,100 Beans; Yan holds them, last read 60 days ago, so a read applies demurrage (the review's second probe).
        await main0.send('plant-ledger', { moves: [{ publicKey: zed.pk, add: -2100 }, { publicKey: yan2.pk, add: 2100, epochsAgo: 60 }] });
        require_((await format1.send('pull', {})).ok === true, 'S0 copies it');
        const f = `https://localhost:${await format1.send('serve')}`;
        const z17: Ledger = await main0.send('ledger');
        const before17: Ledger = await format1.send('ledger');
        require_(ledgerDiff(z17, before17).length === 0 && (before17.accounts.find((a) => a.public_key === zed.pk)?.balance ?? 0) < -2000
            && (await format1.send('trade', { id: tx17.id }))?.status === 'requested',
            `S0 holds M0's ledger, Zed owing 2,100 Beans, and Yan's request (differences ${first(ledgerDiff(z17, before17))})`);
        const F_ = (who: Id, route: string, body: unknown = {}) => api(f, 'POST', route, { as: who, body });
        const standbyRefusal = (a: Answer) => a.status === 409 && a.body?.code === 'standby' && /standby copy of the community/.test(a.body?.error ?? '');
        const engineRefusal = (r: any) => r?.ok === false && r.name === 'StandbyLedgerError' && r.code === 'standby' && r.status === 409;
        const unchanged = async (what: string) => {
            const now: Ledger = await format1.send('ledger');
            assert(ledgerDiff(before17, now).length === 0 && Math.abs(now.sum - z17.sum) < 1e-9,
                `${what}: nothing is written, and S0's rows still sum to M0's (${now.sum}, M0 ${z17.sum}; differences ${first(ledgerDiff(before17, now))})`);
        };

        const purgeHttp = await F_(zed, '/api/member/purge');
        assert(standbyRefusal(purgeHttp), `Zed, who owes 2,100 Beans, deleting their own account on S0 is refused: 409 standby (${brief(purgeHttp)})`);
        const purgeEngine = await format1.send('engine-move', { kind: 'purge', publicKey: zed.pk });
        assert(engineRefusal(purgeEngine), `and so is the same delete asked of S0's engine, under its routes (${JSON.stringify(purgeEngine)})`);
        await unchanged('the delete');

        const sendHttp = await F_(yan2, '/api/ledger/transfer', { to: gwen0.pk, amount: 5, memo: 'on the standby' });
        const sendEngine = await format1.send('engine-move', { kind: 'transfer', publicKey: yan2.pk, to: gwen0.pk, amount: 5 });
        assert(standbyRefusal(sendHttp) && engineRefusal(sendEngine), `a send on S0 is refused, by its route and by its engine (${brief(sendHttp)}; ${JSON.stringify(sendEngine)})`);
        await unchanged('the send');

        const approveHttp = await F_(gwen0, '/api/marketplace/transactions/approve', { transactionId: tx17.id, authorPublicKey: gwen0.pk });
        const approveEngine = await format1.send('engine-move', { kind: 'approve', transactionId: tx17.id, publicKey: gwen0.pk });
        const requestHttp = await F_(yan2, '/api/marketplace/posts/request', { postId: figs.id, buyerPublicKey: yan2.pk });
        assert(standbyRefusal(approveHttp) && engineRefusal(approveEngine) && standbyRefusal(requestHttp),
            `a trade's steps on S0 are refused: Gwen approving Yan's request (the Beans into escrow), by route and by engine, and a new request (${brief(approveHttp)}; ${JSON.stringify(approveEngine)}; ${brief(requestHttp)})`);
        const trade17 = await format1.send('trade', { id: tx17.id });
        assert(trade17?.status === 'requested', `the trade is as M0 holds it, still asked for (${JSON.stringify(trade17)})`);
        await unchanged('the trade');

        const payEngine = await format1.send('engine-move', { kind: 'commons-pay', publicKey: gwen0.pk, amount: 50 });
        const pruneHttp = await api(f, 'POST', `/api/local/admin/users/${zed.pk}/prune`, { admin: PW_STANDBY, body: {} });
        assert(engineRefusal(payEngine) && standbyRefusal(pruneHttp),
            `a payment from the Commons on S0 is refused, and so is an admin's prune, which pays a debt from it (${JSON.stringify(payEngine)}; ${brief(pruneHttp)})`);
        await unchanged('the Commons payment');

        // The review's second probe: a read that applies demurrage in memory, a move, then another; now both are refused
        // before any transaction opens, so nothing puts back a pot holding that decay, and S0's own flush writes nothing.
        await format1.send('read-balance', { publicKey: yan2.pk });
        const afterRead1 = await format1.send('engine-move', { kind: 'transfer', publicKey: yan2.pk, to: zed.pk, amount: 1e9 });
        const afterRead2 = await format1.send('engine-move', { kind: 'transfer', publicKey: yan2.pk, to: gwen0.pk, amount: 1 });
        await format1.send('persist');
        assert(engineRefusal(afterRead1) && engineRefusal(afterRead2), `after a read with 60 days of demurrage due, S0's moves are refused (${JSON.stringify([afterRead1.error, afterRead2.error])})`);
        await unchanged('a read, two moves and S0\'s own flush');

        // Every route that moves Beans or steps a trade answers the same, before its handler; a read still answers.
        const moneyRoutes: [Id | 'admin', string][] = [
            [yan2, '/api/marketplace/posts/accept'], [yan2, '/api/marketplace/transactions/complete'], [yan2, '/api/marketplace/transactions/cancel'],
            [gwen0, '/api/marketplace/transactions/reject'], [yan2, '/api/marketplace/transactions/cancel-request'],
            [yan2, `/api/crowdfund/projects/${figs.id}/pledge`], [yan2, '/api/crowdfund/projects/delete'], [yan2, `/api/treasury/${gwen0.pk}/pledge`],
            [yan2, `/api/enterprise/${gwen0.pk}/sweep`], [yan2, '/api/commons/decisions'], [yan2, '/api/member/re-enroll'],
            [yan2, '/api/federation/purchase'], ['admin', `/api/local/admin/posts/${figs.id}/delete`], ['admin', '/api/local/admin/disputes/x/resolve'],
            ['admin', `/api/local/admin/branches/${zed.pk}/prune`], ['admin', '/api/local/admin/reports/x/action'],
            ['admin', '/api/local/admin/decisions/x/halt'], ['admin', '/api/local/admin/decisions/x/accelerate'],
        ];
        const notRefused: string[] = [];
        for (const [who, route] of moneyRoutes) {
            const r = who === 'admin' ? await api(f, 'POST', route, { admin: PW_STANDBY, body: {} }) : await F_(who, route, {});
            if (!standbyRefusal(r)) notRefused.push(`${route} ${brief(r)}`);
        }
        assert(notRefused.length === 0, `every route that moves Beans or steps a trade answers 409 standby on S0 (${notRefused.length} did not: ${notRefused.join(' | ') || 'none'})`);
        const read17 = await api(f, 'GET', `/api/ledger/balance/${yan2.pk}`, { as: yan2 });
        assert(read17.status === 200 && typeof read17.body?.balance === 'number', `a read still answers on S0 (${brief(read17)})`);
        // The admin's Decisions list is a POST that only reads (#1268 review 4118052544): it answers on a standby too.
        const decisions17 = await api(f, 'POST', '/api/local/admin/decisions', { admin: PW_STANDBY, body: {} });
        assert(decisions17.status === 200 && Array.isArray(decisions17.body?.decisions), `the admin's Decisions list still answers on S0 (${brief(decisions17)})`);
        await unchanged('all of them');

        const next17 = await format1.send('pull', {});
        let s17: Ledger = await format1.send('ledger');
        assert(next17.ok === true && ledgerDiff(await main0.send('ledger'), s17).length === 0,
            `S0's next copy lands (${JSON.stringify({ ok: next17.ok, mode: next17.mode, error: next17.error })}; differences ${first(ledgerDiff(await main0.send('ledger'), s17))})`);
        assert(memoryVsRows(await format1.send('memory-ledger'), s17).length === 0, 'and its memory is its rows');

        // The same moves on the main server still work, and the copy that carries them lands.
        console.log('\n— 17. the same moves on the main server still work, and S0 copies them —');
        built('M0: Gwen approves Yan\'s request: the Beans are held', await Z_(gwen0, '/api/marketplace/transactions/approve', { transactionId: tx17.id, authorPublicKey: gwen0.pk }));
        built('M0: Yan confirms: Gwen is paid', await Z_(yan2, '/api/marketplace/transactions/complete', { transactionId: tx17.id, confirmerPublicKey: yan2.pk }));
        built('M0: Yan gives Gwen 5 Beans', await Z_(yan2, '/api/ledger/transfer', { to: gwen0.pk, amount: 5, memo: 'on the main server' }));
        require_(await main0.send('grant', { publicKey: gwen0.pk, amount: 7 }), 'M0: the Commons pays Gwen 7 Beans');
        built('M0: Zed, who owes 2,100 Beans, deletes their own account', await Z_(zed, '/api/member/purge'));
        const z17b: Ledger = await main0.send('ledger');
        require_(Math.abs(z17b.sum - z17.sum) < 1e-6 && z17b.transactions.length > z17.transactions.length,
            `M0: its ledger moved, and still sums to what it did (${z17.sum} → ${z17b.sum})`);
        const landed17 = await format1.send('pull', {});
        s17 = await format1.send('ledger');
        assert(landed17.ok === true && ledgerDiff(z17b, s17).length === 0 && Math.abs(s17.sum - z17b.sum) < 1e-9,
            `the next copy lands, and S0's ledger is M0's, with no trade of its own (${JSON.stringify({ ok: landed17.ok, mode: landed17.mode, error: landed17.error })}; differences ${first(ledgerDiff(z17b, s17))})`);
        assert(memoryVsRows(await format1.send('memory-ledger'), s17).length === 0, 'and its memory is its rows');
        refused.push(...(await format1.send('fetches')).blocked, ...(await main0.send('fetches')).blocked);

        assert(door.waiting() === 0 && door0.waiting() === 0, 'every copy a step served was asked for');

        refused.push(...(await main.send('fetches')).blocked);
        assert(refused.length === 0, `nothing reached off this machine (refused: ${refused.join(', ') || 'none'})`);
    } finally {
        for (const n of nodes) await n.kill();
        for (const d of doors) await d.close();
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
