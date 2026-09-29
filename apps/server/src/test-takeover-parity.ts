/**
 * Test Suite: a promoted standby behaves exactly like the main server it replaces, or the difference is a known gap
 * (the net: PR 0 of scratch/global-node/DESIGN-standby-takeover-gaps-opus.md, §5.1).
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts), serving its real HTTPS server
 * (https-server.ts, `serve`); members act through it with signed requests, the admin with the password. The standby
 * pulls through its real puller from the main server's real backup routes, and takes over through the real path.
 *
 *  1. The main server M builds a community through its routes: trades, a Commons balance, an enterprise with a purpose
 *     and a place, a group, an event and an RSVP, a block, an accepted non-zero audit baseline.
 *  2. Its standby S takes its first copy with the loop's own first pull (before G9's fix only an operator's force-resync
 *     got a new standby one).
 *  3. More of the community, over two deltas: new members, a transfer from an account that held Beans at the first copy,
 *     granted credit, a voucher and vouched members at 50 and 25, a
 *     group of one, a trade in escrow, a resolved dispute, a recategorised listing and one that needs cash, holiday, a notification
 *     opt-out, push tokens, a frozen member, a keeper with a pledge, a keeper's wage owed, the enterprise paused.
 *  4. More, then a whole copy: the vouch at 25 withdrawn, the group of one left by its lead, a project pot, a winding-up enterprise, an unused invite and re-key code, a cached peer
 *     listing, the community's name, place, contacts, directory switches and thresholds, a Decision open and one about
 *     to pass. Then the last writes (the removal passes into its grace period, a chat photo, a message with empty
 *     metadata, a pending request, a rating with no comment, an empty bio and archetype, a group renamed) and a last
 *     delta, and the pricing guide's hourly cycle on M (the nodes' own timer for it is off: it fired or not by the
 *     runner's speed).
 *  5. M is killed; T, a copy of M's data directory at S's last copy, starts on its own port.
 *  6. S takes over with the recovery code (the preview, the confirm, the restart).
 *  7. Database parity: every table the manifest (engine/replication-manifest.ts) says a standby copies, or should
 *     (a known gap), row by row in the columns it compares; and every community setting it names.
 *  8. Behaviour parity: the same signed calls against T and S, the answers compared after normalising times, new ids and
 *     ports: reads (the board as a guest, a member and a keeper; a phone's full sync and a delta; balances; the
 *     enterprise; each member's own view; the pricing guide after each server's hourly cycle; the directory; notices)
 *     and writes (accept a listing from before; a keeper posts for the enterprise; request a holiday member's listing; a
 *     vouch; a frozen member's poll;
 *     approve a pending request; redeem the unused invite; the Decision sweep eight days on; a push of each category;
 *     the ledger audit a take-over runs).
 *  9. KNOWN_GAPS, strict: every difference is listed with its gap id, and every listed one still differs. A fix PR
 *     deletes its lines.
 *
 * Money moves in every copy, accounts that held Beans at the first copy included: before G0's fix, every copy after one of
 * those moved was refused, so this net moved only accounts that held nothing then.
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-takeover-parity.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, post, copyDir, runNodeChild, serveCommands, type NodeProc } from './takeover-test-harness.js';
import { lockedDm } from './dm-test-payload.js';
import {
    diffDatabases, diffSettings, normaliseAnswer, idsIn, firstDifferences, checkKnownGaps,
    type DbDump, type SettingsDump, type Differences, type KnownGap,
} from './takeover-parity-compare.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the nodes' own self-signed certificates

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Parity-Main-Pw-4471!';
const PW_STANDBY = 'Parity-Standby-Pw-902!';
const NEIGHBOUR_URL = 'https://neighbours.example';

/**
 * Every difference between the promoted standby and its twin on main today, by the design's gap id (§2). The suite
 * fails on a difference not listed here, and on a listed one that no longer differs: the PR that fixes a gap deletes
 * its lines. Where a difference has more than one cause (a behaviour read), `gap` names each: a fix PR takes its id out,
 * and the last one deletes the line, which the suite then requires.
 *
 * G0 (the ledger), G1 (listings another community's), G2 (a member's and an enterprise's standing: the members row,
 * preferences, keepers and pledges), G5 (the community's own settings) and G9 (a new standby's first pull, which this
 * suite found) are closed, and so are G1b's listing, deal, photo and project columns and G3's tables (in-flight money and
 * governance, on the plain-table path): a difference in any of them is new. G3 is not closed whole: its one setting, the
 * Commons project proposals still waiting for a decision (node_config `commons_projects`, a `community` gap in
 * engine/replication-manifest.ts NODE_CONFIG_KEYS), stays behind on a take-over, and the preview names it. This scenario
 * makes no such proposal, so nothing here differs by it; one that did would need its line here.
 */
const KNOWN_GAPS: KnownGap[] = [
    // G1b: columns dropped inside tables that do replicate (the groups, chat and ratings ones this net found).
    { key: 'db:groups.lead_pubkey', gap: 'G1b', why: "a group whose last convenor left keeps its old lead on the standby (the import keeps a lead over the main server's null)" },
    { key: 'db:conversations.name', gap: 'G1b', why: "a renamed group's chat keeps its old name until a whole copy (a rename moves no stamp; a delta picks conversations by created_at)" },
    { key: 'db:messages.metadata', gap: 'G1b', why: "a message sent with empty metadata is null on the standby where the main server holds '' (the import writes `|| null`)" },
    { key: 'db:ratings.comment', gap: 'G1b', why: "a rating with no comment is null on the standby where the main server holds '' (the import writes `|| null`); both apps read either as none" },


    // G4: members' devices and conveniences.
    { key: 'db:push_tokens (not copied)', gap: 'G4', why: 'no push reaches anyone' },
    { key: 'db:message_attachments (not copied)', gap: 'G4', why: 'every chat photo from before is gone' },
    { key: 'db:activity_feed (not copied)', gap: 'G4', why: 'the activity waterfall starts empty' },
    { key: 'db:pricing_guide_items (not copied)', gap: 'G4', why: 'each server seeds its own guide at its first boot' },
    { key: 'http:the pricing guide', gap: 'G4', why: "the guide main priced is not copied, so each server's hourly cycle starts from its own prices" },
    { key: 'http:a push of each category', gap: 'G4', why: 'no phone to push to' },
];

// ── The node processes' commands ───────────────────────────────────────────────────────────

/**
 * No node in this suite reaches anything but localhost: a push to Expo is answered here as accepted, and anything else
 * off this machine is refused. Counted, so the suite can say so.
 */
function guardFetch(): { blocked: string[]; pushes: number } {
    const seen = { blocked: [] as string[], pushes: 0 };
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return real(input, init);
        if (url.hostname === 'exp.host') {
            seen.pushes++;
            return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        seen.blocked.push(url.hostname);
        throw new Error(`the parity suite reaches nothing off this machine (${url.hostname})`);
    }) as typeof fetch;
    return seen;
}

async function child(): Promise<void> {
    const fetches = guardFetch();
    await runNodeChild({
        ...serveCommands,
        /**
         * The real server, without the pricing guide's own timer (pricing-aggregator.ts: a first cycle 5 s after boot, then
         * hourly). Whether it had fired by the read was the runner's speed; the scenario runs the cycle itself instead.
         */
        serve: async () => {
            const port = await serveCommands.serve({});
            const { stopPricingAggregatorWorker } = await import('./pricing-aggregator.js');
            stopPricingAggregatorWorker();
            return port;
        },
        /** One cycle of the pricing guide's hourly worker: it prices each item from the listings this server counts. */
        'pricing-cycle': async () => {
            const { runPricingAggregationCycle } = await import('./pricing-aggregator.js');
            return runPricingAggregationCycle();
        },
        'setup-primary': async (a: { replicationToken: string; genesis: string }) => {
            const { seedGenesisMember } = await import('./engine/members.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { makeRecoveryCode, flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            seedGenesisMember(a.genesis, 'Gwen');
            setReplicationToken(a.replicationToken);
            const made = await makeRecoveryCode();
            await flushTakeoverChecks();
            return { code: made.code };
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
            const { pullNow, getBackupStatus, pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            const before = getBackupStatus().lastFullReconcileAt;
            if (a.whole) process.env.BACKUP_RECONCILE_EVERY_MS = '1';
            await new Promise((r) => setTimeout(r, 5));
            const result = await pullNow();
            process.env.BACKUP_RECONCILE_EVERY_MS = '86400000';
            const envelope = await pullTakeoverEnvelopeNow();
            return { ...result, whole: getBackupStatus().lastFullReconcileAt !== before, envelope };
        },
        /** Every table the manifest compares, in its compared columns, ordered by its key. */
        dump: async () => {
            const { db } = await import('./db/db.js');
            const { TABLES, BOOT_STAMPED, comparedColumns } = await import('./engine/replication-manifest.js');
            const q = (n: string) => `"${n.replace(/"/g, '""')}"`;
            const out: DbDump = {};
            for (const table of Object.keys(TABLES)) {
                const info = db.prepare('SELECT name, pk FROM pragma_table_info(?)').all(table) as { name: string; pk: number }[];
                if (info.length === 0) continue;
                const columns = comparedColumns(table, info.map((c) => c.name));
                if (!columns) continue;
                const entry = TABLES[table] as { kind: string; key?: string[]; gap?: string };
                const key = entry.key ?? info.filter((c) => c.pk > 0).sort((x, y) => x.pk - y.pk).map((c) => c.name);
                // A boot-stamped row's stamp reads as such (the manifest's BOOT_STAMPED): two servers boot at other times.
                const select = [...new Set([...key, ...columns])].map((c) => {
                    const stamped = BOOT_STAMPED.filter((b) => b.table === table && b.column === c);
                    return stamped.length === 0 ? q(c)
                        : `CASE WHEN ${stamped.map((b) => `(${b.where})`).join(' OR ')} THEN '<stamped at boot>' ELSE ${q(c)} END AS ${q(c)}`;
                }).join(', ');
                const rows = db.prepare(`SELECT ${select} FROM ${q(table)} ORDER BY ${key.map(q).join(', ')}`).all() as Record<string, unknown>[];
                out[table] = { key, columns, rows, ...(entry.kind === 'local' && entry.gap ? { notCopied: entry.gap } : {}) };
            }
            return out;
        },
        /** The settings as this server uses them: local-config.json with its defaults, node_config, and the node_config row. */
        settings: async (): Promise<SettingsDump> => {
            const { db } = await import('./db/db.js');
            const { getLocalConfig } = await import('./config/local-config.js');
            const { getNodeConfig } = await import('./state-engine.js');
            const file = path.join(process.env.BEANPOOL_DATA_DIR!, 'local-config.json');
            const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : {};
            const rows = db.prepare('SELECT key, value FROM node_config ORDER BY key').all() as { key: string; value: string }[];
            return {
                localConfig: getLocalConfig() as unknown as Record<string, unknown>,
                localConfigKeys: Object.keys(raw),
                nodeConfig: Object.fromEntries(rows.map((r) => [r.key, r.value])),
                nodeConfigBlob: getNodeConfig() as unknown as Record<string, unknown>,
            };
        },
        /** A push of each category to every member, as the push service is handed it (dispatchPushNotification's count). */
        'push-counts': async () => {
            const { db } = await import('./db/db.js');
            const { dispatchPushNotification } = await import('./state-engine.js');
            const everyone = (db.prepare("SELECT public_key FROM members WHERE is_visitor = 0 ORDER BY public_key").all() as { public_key: string }[])
                .map((r) => r.public_key);
            const counts: Record<string, number> = {};
            for (const category of ['chat', 'marketplace', 'escrow', 'recovery'] as const) {
                counts[category] = dispatchPushNotification(everyone, 'SYSTEM', 'Parity', 'A push of each category', {}, category);
            }
            return counts;
        },
        /** The Decision sweep the minute tick runs (index.ts): no route runs it. */
        'decision-tick': async (a: { asOf?: number }) => {
            const { tickDecisions } = await import('./decisions-engine.js');
            return tickDecisions(a.asOf);
        },
        /** The ledger conservation audit a take-over runs (promotionSanityCheck), run now. */
        'ledger-audit': async () => {
            const { promotionSanityCheck } = await import('./state-engine.js');
            return promotionSanityCheck();
        },
        /** A peer's listing in the cache, as the federation pull writes it (no route: the libp2p pull loop). */
        'cache-peer-listing': async (a: { peerId: string; listing: Record<string, unknown> }) => {
            const { cacheRemoteListings } = await import('./federation-listings.js');
            return cacheRemoteListings(a.peerId, NEIGHBOUR_URL, [a.listing]);
        },
        /**
         * An old bug's drift, as a raw write, so the community can accept a non-zero audit baseline (the test node's -9.82
         * kind). The in-memory ledger is re-read after it, as db.ts's raw writes do.
         */
        drift: async (a: { publicKey: string; amount: number }) => {
            const { db } = await import('./db/db.js');
            const { reconcileLedgerFromDb } = await import('./state-engine.js');
            db.prepare('UPDATE accounts SET balance = balance + ? WHERE public_key = ?').run(a.amount, a.publicKey);
            reconcileLedgerFromDb();
            return true;
        },
        /** The force-resync an operator runs from Settings: clear the copied tables, then a whole copy. */
        resync: async () => {
            const { requestResync } = await import('./services/backup-puller.js');
            return requestResync();
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

/**
 * A call to a node's real HTTPS server: signed by `as` (the format before request binding, which every node still takes;
 * the signature covers the path, never the query), with the admin password in `admin`, or neither.
 */
async function api(base: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', route: string, opts: { as?: Id; admin?: string; body?: unknown } = {}): Promise<Answer> {
    const raw = method === 'GET' ? '' : JSON.stringify(opts.body ?? {});
    const headers: Record<string, string> = {};
    if (opts.as) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const signedPath = route.split('?')[0];
        headers['X-Public-Key'] = opts.as.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${signedPath}\n${ts}\n${nonce}\n${raw}`), opts.as.priv).toString('base64');
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
/** A scenario step the community needs: it must be accepted, or nothing after it means anything. */
function built(what: string, a: Answer): any {
    require_(a.status >= 200 && a.status < 300, `M: ${what} (${brief(a)})`);
    return a.body;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dirs = { main: path.join(root, 'main'), standby: path.join(root, 'standby'), twin: path.join(root, 'twin') };
    const nodes: NodeProc[] = [];
    const started = Date.now();
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const env = (pw: string, role: string) => ({ ADMIN_PASSWORD: pw, NODE_ROLE: role, NODE_ENV: 'test', BACKUP_RECONCILE_EVERY_MS: '86400000' });
    const gwen = newId('Gwen');
    const [ann, bo, cy, dee, kip, rex] = ['Ann', 'Bo', 'Cy', 'Dee', 'Kip', 'Rex'].map(newId);
    const [eve, fay] = ['Eve', 'Fay'].map(newId);
    const [hal, lou] = ['Hal', 'Lou'].map(newId);
    const pulls: { phase: string; ok: boolean; whole: boolean; error?: string }[] = [];
    // Every difference found, by key (takeover-parity-compare.ts), with a few examples of each.
    const differences: Differences = new Map();

    try {
        // ── 1. M, and the community's first part ──
        console.log('\n— 1. the main server builds a community —');
        const main = await spawnNode(SCRIPT, dirs.main, env(PW_MAIN, 'primary'));
        nodes.push(main);
        const setup = await main.send('setup-primary', { replicationToken, genesis: gwen.pk });
        const m = `https://localhost:${await main.send('serve')}`;
        const A = (path_: string, body: unknown) => api(m, 'POST', path_, { admin: PW_MAIN, body });
        const S_ = (who: Id, path_: string, body: unknown = {}) => api(m, 'POST', path_, { as: who, body });

        const join = async (who: Id) => {
            const inv = built(`Gwen makes an invite for ${who.name}`, await S_(gwen, '/api/invite/generate', { publicKey: gwen.pk }));
            const code = inv.invite?.code ?? inv.code;
            built(`${who.name} joins with it`, await api(m, 'POST', '/api/invite/redeem', { body: { code, publicKey: who.pk, callsign: who.name } }));
            built(`${who.name} sets a profile photo`, await S_(who, '/api/profile/update', { avatar: TINY_PNG }));
        };
        built('Gwen sets a profile photo', await S_(gwen, '/api/profile/update', { avatar: TINY_PNG }));
        for (const who of [ann, bo, cy, dee, kip, rex]) await join(who);

        const offer = async (who: Id, title: string, credits: number, extra: Record<string, unknown> = {}) =>
            built(`${who.name} offers ${title}`, await S_(who, '/api/marketplace/posts', {
                type: 'offer', category: 'food', title, description: `${title}, from ${who.name}`, credits, priceType: 'fixed',
                authorPublicKey: who.pk, ...extra,
            })).post;
        const deal = async (buyer: Id, seller: Id, postId: string, finish: boolean) => {
            const tx = built(`${buyer.name} asks for ${seller.name}'s listing`, await S_(buyer, '/api/marketplace/posts/request', { postId, buyerPublicKey: buyer.pk })).transaction;
            built(`${seller.name} approves: the Beans are held`, await S_(seller, '/api/marketplace/transactions/approve', { transactionId: tx.id, authorPublicKey: seller.pk }));
            if (finish) built(`${buyer.name} confirms: the Beans are released`, await S_(buyer, '/api/marketplace/transactions/complete', { transactionId: tx.id, confirmerPublicKey: buyer.pk }));
            return tx.id as string;
        };

        built('the admin makes Gwen an Elder (a credit line to buy with)', await A(`/api/local/admin/users/${gwen.pk}/elder`, { grant: true }));
        await offer(gwen, 'Sourdough', 4); // a buyer lists an offer first (the offer covenant)
        const annOffer = await offer(ann, 'Honey', 20);
        await deal(gwen, ann, annOffer.id, true);
        built('Ann gives Bo 5 Beans', await S_(ann, '/api/ledger/transfer', { to: bo.pk, amount: 5, memo: 'for the seedlings' }));
        const boOffer = await offer(bo, 'Seedlings', 3);
        const cyOffer = await offer(cy, 'Bike repair', 6, { repeatable: true });
        await offer(dee, 'Firewood', 5);
        const probe = built('Cy starts an enterprise, Probe Co, with a purpose and a place', await S_(cy, '/api/treasury', {
            name: 'Probe Co', purpose: 'Repairs for the street', lat: -28.55, lng: 153.5, avatar: TINY_PNG,
        }));
        built('the admin makes Kip a keeper of Probe Co', await A(`/api/local/admin/treasury/${probe.publicKey}/operators`, { pubkey: kip.pk }));
        const group = built('Ann starts a group', await S_(ann, '/api/groups', { name: 'Gardeners', description: 'People who grow things' }));
        const groupId = group.group?.id ?? group.id;
        built('Bo joins it', await S_(bo, `/api/groups/${groupId}/join`));
        const start = new Date(Date.now() + 3 * 86400_000);
        const event = built('Cy hosts an event', await S_(cy, '/api/marketplace/posts', {
            type: 'event', title: 'Street picnic', description: 'Bring a plate', authorPublicKey: cy.pk, lat: -28.55, lng: 153.5,
            eventStartAt: start.toISOString(), eventEndAt: new Date(start.getTime() + 3600_000).toISOString(), eventPlaceName: 'The park',
        })).post;
        built('Dee is going', await S_(dee, `/api/marketplace/posts/${event.id}/rsvp`, { status: 'going' }));
        built('Rex blocks Kip', await S_(rex, '/api/blocks', { targetPubkey: kip.pk }));
        built('an old bug left 0.1 Beans of drift', { status: (await main.send('drift', { publicKey: gwen.pk, amount: 0.1 })) ? 200 : 500, body: {} });
        built('the admin accepts it as the audit baseline', await A('/api/local/admin/ledger-rebaseline', { reason: 'Drift from an old bug, checked by hand' }));

        // ── 2. S, and its first copy ──
        console.log('\n— 2. the standby takes its first copy —');
        fs.mkdirSync(dirs.standby, { recursive: true });
        fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dirs.standby, 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dirs.standby, env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const pull = async (phase: string, whole = false) => {
            const p = await standby.send('pull', { whole });
            pulls.push({ phase, ok: p.ok, whole: p.whole, error: p.error });
            console.log(`  pull (${phase}): ${p.ok ? 'imported' : `REFUSED ${p.error}`}${p.whole ? ', a whole copy' : ''}; envelope ${p.envelope}`);
            return p;
        };
        // The loop's own first pull, then, only if it is refused, the force-resync an operator runs from Settings, so the rest
        // has a copy to compare. A refusal is a difference, never a known gap: G9 (on the callsign index, the standby's own
        // BeanPool) is closed.
        const seedPull = await standby.send('pull', {});
        if (!seedPull.ok) differences.set("pull:a new standby's first pull", [String(seedPull.error)]);
        console.log(`  pull (the loop's first): ${seedPull.ok ? 'imported' : `REFUSED ${seedPull.error}`}`);
        if (!seedPull.ok) {
            const resync = await standby.send('resync');
            pulls.push({ phase: 'first copy (force-resync)', ok: resync.ok, whole: true, error: resync.error });
            console.log(`  pull (force-resync): ${resync.ok ? 'imported' : `REFUSED ${resync.error}`}`);
        } else {
            pulls.push({ phase: 'first copy', ok: true, whole: true });
        }

        // ── 3. More of the community, then a delta ──
        console.log('\n— 3. more of the community, then a delta —');
        for (const who of [eve, fay, hal, lou]) await join(who);
        built('Ann, who held Beans at the first copy, gives Bo 2', await S_(ann, '/api/ledger/transfer', { to: bo.pk, amount: 2, memo: 'for the compost' }));
        await pull('the new members');
        for (const who of [cy, hal]) built(`the admin makes ${who.name} an Elder`, await A(`/api/local/admin/users/${who.pk}/elder`, { grant: true }));
        const knitters = built('Hal starts a group on his own', await S_(hal, '/api/groups', { name: 'Knitters', description: 'Anyone who knits' }));
        const knittersId = knitters.group?.id ?? knitters.id;
        built('the admin makes Bo a voucher', await A(`/api/local/admin/users/${bo.pk}/voucher`, { grant: true }));
        built('Bo vouches for Eve', await S_(bo, '/api/profile/vouch', { targetPubkey: eve.pk, level: 2 }));
        built('and for Lou', await S_(bo, '/api/profile/vouch', { targetPubkey: lou.pk, level: 1 }));
        await offer(eve, 'Mending', 2);
        const deeCash = await offer(dee, 'Kindling', 3, { cashAlsoNeeded: true });
        await deal(cy, dee, deeCash.id, false); // held in escrow, and still there at the take-over
        const disputed = await deal(eve, cy, cyOffer.id, false);
        built('the admin resolves a dispute over it', await A(`/api/local/admin/disputes/${disputed}/resolve`, { action: 'release_to_seller', reason: 'The repair was done' }));
        built('Bo recategorises his listing', await S_(bo, '/api/marketplace/posts/update', { id: boOffer.id, authorPublicKey: bo.pk, category: 'garden' }));
        built('Bo goes on holiday', await S_(bo, '/api/members/holiday', { enabled: true }));
        built('Ann switches off marketplace pushes', await S_(ann, '/api/members/preferences', { publicKey: ann.pk, preferences: { notify_marketplace: false } }));
        built('Ann registers her phone', await S_(ann, '/api/push-tokens', { publicKey: ann.pk, token: 'ExponentPushToken[parity-ann]', platform: 'android' }));
        built('Cy registers his phone', await S_(cy, '/api/push-tokens', { publicKey: cy.pk, token: 'ExponentPushToken[parity-cy]', platform: 'ios' }));
        built('the admin freezes Fay\'s credit', await A(`/api/local/admin/users/${fay.pk}/freeze`, { freeze: true }));
        const tuneUp = await offer(kip, 'Tune-up', 10, { repeatable: true });
        const tuneUpDeal = await deal(cy, kip, tuneUp.id, true);
        built('Kip pledges backing to Probe Co', await S_(kip, `/api/treasury/${probe.publicKey}/pledge`, { type: 'backing', amount: 2 }));
        // Probe Co hiring its own keeper while it holds nothing: refused, and the wage is owed (engine/escrow.ts isPayeeKeeper).
        built('Cy lists an offer for Probe Co', await S_(cy, `/api/treasury/${probe.publicKey}/offer`, {
            title: 'Bike check', description: 'At the workshop', credits: 3, category: 'tools',
        }));
        const job = built('and a job it needs done', await S_(cy, `/api/treasury/${probe.publicKey}/need`, {
            title: 'Workshop tidy', description: 'Sort the parts bins', credits: 2, category: 'tools',
        }));
        const bid = built('Kip offers to do it', await S_(kip, '/api/marketplace/posts/request', { postId: (job.post ?? job).id, buyerPublicKey: kip.pk })).transaction;
        const wage = await S_(cy, `/api/treasury/${probe.publicKey}/approve`, { transactionId: bid.id });
        require_(wage.status === 403 && /only be paid from profit/.test(wage.body?.error ?? ''),
            `M: Cy approves it for Probe Co, which holds nothing: refused, and Kip's wage is owed (${brief(wage)})`);
        built('Cy pauses Probe Co', await S_(cy, `/api/treasury/${probe.publicKey}/pause`));
        const seed = built('Eve starts a project with a goal', await S_(eve, '/api/treasury', { name: 'Seed Fund', purpose: 'A seed library', lifecycle: 'bounded', goalAmount: 100 }));
        await pull('the escrow, the dispute, standing');

        // ── 4. More, then a whole copy ──
        console.log('\n— 4. more, then a whole copy —');
        built('Bo withdraws his vouch for Lou, which the last pull copied', await S_(bo, '/api/profile/unvouch', { targetPubkey: lou.pk }));
        built('Hal, its lead and only member, leaves Knitters: it has no lead now', await api(m, 'DELETE', `/api/groups/${knittersId}/members/${hal.pk}`, { as: hal }));
        built('Kip puts 2 Beans in the project pot', await S_(kip, `/api/treasury/${seed.publicKey}/pledge`, { amount: 2 }));
        const wind = built('Dee starts an enterprise, Wind Co', await S_(dee, '/api/treasury', { name: 'Wind Co', purpose: 'Closing down soon' }));
        built('Dee starts winding it up', await S_(dee, `/api/treasury/${wind.publicKey}/wind-up/initiate`));
        const unusedInvite = built('Gwen makes an invite nobody uses yet', await S_(gwen, '/api/invite/generate', { publicKey: gwen.pk }));
        built('the admin issues Lou a re-key code he has not used', await A(`/api/local/admin/members/${lou.pk}/rekey/issue-code`, {}));
        const peer = await main.send('cache-peer-listing', {
            peerId: '12D3KooWParityNeighbourPeer0000000000000000000000',
            listing: { id: 'nb-1', type: 'offer', category: 'food', title: 'Neighbour jam', description: 'From next door', credits: 2,
                priceType: 'fixed', authorPublicKey: newId('Nia').pk, authorCallsign: 'Nia', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        });
        require_(peer.cached === 1, `M: a linked community's listing is in the cache (${JSON.stringify(peer)})`);
        built('the community names itself and its place', await A('/api/local/update-identity', {
            callsign: 'parityville', communityName: 'Parityville', lat: -28.55, lng: 153.5, contactEmail: 'hello@parityville.example', contactPhone: '+61 2 5550 1234',
        }));
        built('it publishes its contact email but not its phone, and keeps its members out of the directory', await A('/api/local/admin/node/config', {
            publishContactEmail: true, publishContactPhone: false, publishMembers: false, serviceRadius: { lat: -28.55, lng: 153.5, radiusKm: 12 },
        }));
        built('and sets its own thresholds', await A('/api/admin/thresholds', { circulationEpochDays: 45 }));
        built('Gwen proposes a Decision', await S_(gwen, '/api/commons/decisions', {
            title: 'Make Cy a voucher', description: 'Cy has helped half the street', touches: 'member', effect: 'grant_voucher', subject: cy.pk,
        }));
        const removal = built('Ann proposes removing Rex, closing in a few seconds', await S_(ann, '/api/commons/decisions', {
            title: 'Remove Rex', description: 'Rex has not been seen in a year', touches: 'member', effect: 'remove_member', subject: rex.pk,
            closesAt: new Date(Date.now() + 2500).toISOString(),
        })).decision;
        for (const v of [gwen, ann, bo, cy, dee]) built(`${v.name} votes for it`, await S_(v, `/api/commons/decisions/${removal.id}/vote`, { support: true }));
        const wholeCopy = await pull('the whole copy', true);

        // ── 5. The last writes, then a last delta ──
        console.log('\n— 5. the last writes, then a last delta —');
        const cursorBefore = new Date().toISOString();
        await sleep(Math.max(0, new Date(removal.closesAt).getTime() - Date.now() + 200));
        const tick = await main.send('decision-tick');
        const graced = await api(m, 'GET', `/api/commons/decisions/${removal.id}`, { as: gwen });
        require_(graced.body?.decision?.status === 'execution_pending_grace',
            `M: the removal passed and waits out its grace period (${graced.body?.decision?.status}; sweep ${JSON.stringify(tick)})`);
        const convo = built('Ann starts a chat with Bo', await S_(ann, '/api/messages/conversation', { type: 'dm', participants: [ann.pk, bo.pk], createdBy: ann.pk }));
        const convoId = convo.conversation?.id ?? convo.id;
        const jpeg = lockedDm(64); // a DM photo goes in encrypted, its caption and its bytes alike
        built('and sends a photo', await S_(ann, '/api/messages/send', {
            conversationId: convoId, authorPubkey: ann.pk, ...lockedDm(),
            type: 'image', attachment: { data: jpeg.ciphertext, nonce: jpeg.nonce, mime: 'image/jpeg' },
        }));
        built('Bo answers, with the empty metadata a hand-made request can send', await S_(bo, '/api/messages/send', {
            conversationId: convoId, authorPubkey: bo.pk, ...lockedDm(), metadata: '',
        }));
        await offer(hal, 'Dog walking', 2);
        const pending = built('Hal asks for Dee\'s firewood (not approved yet)', await S_(hal, '/api/marketplace/posts/request', { postId: (await offer(dee, 'Kindling bundle', 1)).id, buyerPublicKey: hal.pk })).transaction;
        built('Cy rates Kip for the tune-up, with no comment', await S_(cy, '/api/ratings', { targetPubkey: kip.pk, stars: 5, transactionId: tuneUpDeal }));
        built('Eve saves an empty bio and archetype', await S_(eve, '/api/profile/update', { bio: '', archetype: '' }));
        built('Ann renames Gardeners, which the whole copy copied', await api(m, 'PATCH', `/api/groups/${groupId}`, { as: ann, body: { name: 'Growers' } }));
        await pull('the last delta');
        // A main server that has been up an hour has priced its guide from its community's listings.
        const priced = await main.send('pricing-cycle');
        require_(priced.updatedCount > 0, `M: the pricing guide's hourly cycle prices items from the community's listings (${JSON.stringify(priced)})`);

        // ── 6. M dies; its twin T starts from its data directory ──
        console.log('\n— 6. the main server is killed; its twin starts from a copy of its data —');
        const fetchesM = await main.send('fetches'); // what it refused while it built the community
        await main.send('checkpoint');
        await main.kill('SIGKILL');
        copyDir(dirs.main, dirs.twin);
        const twin = await spawnNode(SCRIPT, dirs.twin, env(PW_MAIN, 'primary'));
        nodes.push(twin);

        // ── 7. The take-over ──
        console.log('\n— 7. the standby takes over with the recovery code —');
        const opened = await post(standby.base, '/api/local/admin/takeover/open', { code: setup.code }, { 'X-Admin-Password': PW_STANDBY });
        require_(opened.status === 200 && opened.body.success, `the code opens the keys (${opened.status} ${JSON.stringify(opened.body).slice(0, 160)})`);
        const fetchesS0 = await standby.send('fetches'); // what it refused while it copied, before it restarts itself
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, { 'X-Admin-Password': PW_STANDBY });
        require_(confirmed.status === 200, `confirm (${confirmed.status})`);
        require_(await standby.exited === 0, 'the standby restarts itself');
        standby = await spawnNode(SCRIPT, dirs.standby, env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        require_(standby.ready.role === 'primary' && standby.ready.peerId === main.ready.peerId && standby.ready.auditRan === true,
            `promoted: the main server's PeerId, and its audit ran (${JSON.stringify({ role: standby.ready.role, audit: standby.ready.auditRan })})`);
        const s = `https://localhost:${await standby.send('serve')}`;
        const t = `https://localhost:${await twin.send('serve')}`;

        // ── 8. Database and settings parity ──
        console.log('\n— 8. database and settings parity —');
        const dumpT = await twin.send('dump') as DbDump;
        const dumpS = await standby.send('dump') as DbDump;
        diffDatabases(dumpT, dumpS, differences);
        const manifest = await import('./engine/replication-manifest.js');
        diffSettings(await twin.send('settings'), await standby.send('settings'), {
            localConfig: (f) => manifest.LOCAL_CONFIG_FIELDS[f],
            nodeConfigKey: (k) => manifest.nodeConfigKeyEntry(k),
            nodeConfigBlob: (f) => manifest.NODE_CONFIG_BLOB_FIELDS[f],
            mustMatch: manifest.settingMustMatch,
        }, differences);
        assert(Object.keys(dumpT).length > 30, `(${Object.keys(dumpT).length} tables compared, ${Object.values(dumpT).reduce((n, d) => n + d.rows.length, 0)} rows on the twin)`);

        // ── 9. Behaviour parity ──
        console.log('\n— 9. behaviour parity —');
        const knownIds = idsIn(dumpT);
        const both = async (name: string, run: (base: string, node: NodeProc) => Promise<unknown>) => {
            const onT = await run(t, twin);
            const onS = await run(s, standby);
            const a = normaliseAnswer(onT, knownIds);
            const b = normaliseAnswer(onS, knownIds);
            if (JSON.stringify(a) === JSON.stringify(b)) return;
            // Each side's status and error first, when the answer has them: what a member is told.
            const said = (x: any) => (x && typeof x === 'object' && 'status' in x ? `${x.status}${x.body?.error ? ` "${String(x.body.error).slice(0, 90)}"` : ''}` : null);
            const head = said(onT) !== null && said(onT) !== said(onS) ? [`twin ${said(onT)}; promoted ${said(onS)}`] : [];
            differences.set(`http:${name}`, [...head, ...firstDifferences(a, b, '$', [], 6)]);
        };
        const get = (who: Id | undefined, route: string) => (base: string) => api(base, 'GET', route, { as: who });
        const postAs = (who: Id, route: string, body: unknown = {}) => (base: string) => api(base, 'POST', route, { as: who, body });
        const everyone = [gwen, ann, bo, cy, dee, kip, rex, eve, fay, hal, lou];

        await both('the board, as a guest', get(undefined, '/api/marketplace/posts'));
        await both('the board, as a member', get(eve, '/api/marketplace/posts'));
        await both('the board, as a keeper', get(kip, '/api/marketplace/posts'));
        await both("a phone's full sync", get(dee, '/api/marketplace/posts?sync=true'));
        await both("a phone's delta from before the take-over", get(dee, `/api/marketplace/posts?sync=true&updatedAfter=${encodeURIComponent(cursorBefore)}`));
        await both('every balance', async (base) => Object.fromEntries(await Promise.all(
            [...everyone.map((w) => [w.name, w.pk]), ['Probe Co', probe.publicKey], ['Seed Fund', seed.publicKey], ['Wind Co', wind.publicKey]]
                .map(async ([n, pk]) => [n, (await api(base, 'GET', `/api/ledger/balance/${pk}`, { as: gwen })).body]))));
        await both("the enterprise's page", get(kip, `/api/treasury/${probe.publicKey}`));
        await both("each member's own view (probation, standing)", async (base) => Object.fromEntries(await Promise.all(
            everyone.map(async (w) => [w.name, await api(base, 'GET', '/api/community/me', { as: w })]))));
        // An hour on: each server's hourly cycle has run again over the listings it counts as its own.
        await both('the pricing guide', async (base, node) => {
            await node.send('pricing-cycle');
            return get(ann, '/api/pricing-guide')(base);
        });
        await both('the community, as the directory and apps see it', async (base) => ({
            local: await api(base, 'GET', '/api/local/community-info'),
            info: await api(base, 'GET', '/api/community/info', { as: ann }),
            directory: await api(base, 'GET', '/api/directory/info', { as: ann }),
        }));
        await both('notices', get(fay, '/api/notices'));

        await both('accept a listing from before the take-over', postAs(kip, '/api/marketplace/posts/request', { postId: cyOffer.id, buyerPublicKey: kip.pk }));
        await both('a keeper posts for the enterprise', postAs(kip, `/api/treasury/${probe.publicKey}/offer`, {
            title: 'Puncture kits', description: 'Made in the workshop', credits: 2, category: 'tools',
        }));
        await both("request a holiday member's listing", postAs(eve, '/api/marketplace/posts/request', { postId: boOffer.id, buyerPublicKey: eve.pk }));
        await both('a vouch by the voucher', postAs(bo, '/api/profile/vouch', { targetPubkey: hal.pk, level: 1 }));
        await both("a frozen member's poll", postAs(fay, '/api/marketplace/posts', {
            type: 'poll', title: 'Picnic date?', description: 'Pick one', authorPublicKey: fay.pk, credits: 0,
            pollOptions: ['Saturday', 'Sunday'],
        }));
        await both('approve the pending request', postAs(dee, '/api/marketplace/transactions/approve', { transactionId: pending.id, authorPublicKey: dee.pk }));
        const joiner = newId('Ivy');
        await both('redeem the unused invite', (base) => api(base, 'POST', '/api/invite/redeem', {
            body: { code: unusedInvite.invite?.code ?? unusedInvite.code, publicKey: joiner.pk, callsign: 'Ivy' },
        }));
        // As the minute tick would run it eight days on: the removal's grace period is over, the open Decision closed.
        const eightDaysOn = Date.now() + 8 * 86400_000;
        await both('the Decision sweep, eight days on', (_b, node) => node.send('decision-tick', { asOf: eightDaysOn }));
        await both('a push of each category', (_b, node) => node.send('push-counts'));
        await both('the ledger audit a take-over runs', (_b, node) => node.send('ledger-audit'));

        // ── 10. Known gaps, strict ──
        console.log('\n— 10. every difference, against KNOWN_GAPS —');
        const pullsLanded = pulls.every((p) => p.ok);
        const deltas = pulls.filter((p) => p.phase !== 'the whole copy' && !p.phase.startsWith('first copy'));
        // What the step-4 pull itself did, not what the first copy is assumed to be: a whole copy runs another import.
        assert(pullsLanded && wholeCopy.whole === true && deltas.length === 3 && deltas.every((p) => !p.whole),
            `every pull landed; step 4's was a whole copy and the other three deltas (${JSON.stringify(pulls)})`);
        for (const [key, examples] of [...differences.entries()].sort()) {
            const known = KNOWN_GAPS.find((g) => g.key === key);
            console.log(`  ${known ? `[${known.gap}]` : '[NEW]'} ${key}`);
            for (const e of examples) console.log(`        ${e}`);
        }
        const check = checkKnownGaps(differences, KNOWN_GAPS);
        assert(check.unlisted.length === 0, `every difference is a known gap (unlisted: ${check.unlisted.join(' | ') || 'none'})`);
        assert(check.noLongerDiffer.length === 0,
            `every known gap still differs: a fixed one deletes its line (no longer differ: ${check.noLongerDiffer.map((g) => `${g.gap} ${g.key}`).join(' | ') || 'none'})`);
        assert(check.listedTwice.length === 0, `each known gap is listed once (${check.listedTwice.join(', ') || 'ok'})`);
        const fetchesT = await twin.send('fetches');
        const fetchesS = await standby.send('fetches');
        const refused = [fetchesM, fetchesS0, fetchesT, fetchesS].flatMap((f) => f.blocked);
        assert(refused.length === 0, `nothing reached off this machine, from any of its processes (refused: ${refused.join(', ') || 'none'})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed in ${Math.round((Date.now() - started) / 1000)} s.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ A promoted standby differs from its main server only by the known gaps.');
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
