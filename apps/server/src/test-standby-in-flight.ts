/**
 * Test Suite: in-flight money and governance replicate to a standby through one generic plain-table path, a standby
 * writes none of it itself, and a promoted standby carries all of it on (G3 of
 * scratch/global-node/DESIGN-standby-takeover-gaps-opus.md; engine/plain-tables.ts, engine/replication-manifest.ts).
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts) serving its real HTTPS server; members
 * act through it with signed requests, the admin with the password. The standby pulls through its real puller
 * (services/backup-puller.ts `pullNow`) from the main server's real backup routes, and takes over with the recovery code
 * through the real path. Federation is on (ENABLE_PEER_CONNECTORS). Nothing leaves this machine.
 *
 * The standby's clock runs an hour ahead of the main server's until the take-over (SQLite's `strftime('now')`, which every
 * stamping trigger writes): a stamp of its own on a copied row would show.
 *
 *  1. The main server M: an enterprise with a lead and keepers, a keeper's wage owed (the enterprise held nothing when it
 *     hired him), invites made and used.
 *  2. The standby S's first copy: every plain table is M's, row for row and stamp for stamp, and its copy is format 5.
 *  3. More on M, then a delta: a keeper request with pledged backing approved into a keeper change in its objection
 *     window; a lead succession vote and a convenor vote, open; a Decision open with three ballots and a removal passed
 *     into its grace period; an owner suspended by an admin (a Decision, her role held aside); a moderator suspended and
 *     lifted again (a role held aside, then deleted, which travels as a tombstone); an unused invite and an unused re-key
 *     code; two recovery releases; a link with another community, with Beans in its treasury.
 *  4. On S, every writer of these tables refuses (the routes with 409 `standby`, the engine's functions before they
 *     write), the reads that close what is due write nothing there, and it makes no link at boot: its plain tables are
 *     exactly as before.
 *  5. A whole copy M signed with a value S's tables refuse, and a row its unique index refuses: the copy lands, the two
 *     are left out and reported, and the next whole copy is M's again. A row M no longer holds (deleted by hand, no
 *     tombstone) goes from S with a whole copy.
 *  6. A standby as a format 4 importer left it, holding an invite of its own: it re-seeds itself once, and the invite goes.
 *  7. M dies; S takes over with the recovery code. Standing (G2: every members column, keepers, pledges) is M's on the
 *     promoted server as it copied it (#1276), and every step here acts on G3's rows.
 *  8. On the promoted S: the keeper change applies after its window and the request is approved; the succession vote
 *     counts the proposer's ballot from M with two new ones and passes; the convenor vote counts M's ballot and a new one
 *     and passes at its deadline; the open Decision counts M's three ballots and a new one, passes and is carried out;
 *     the removal is carried out after its grace; the unkept suspension ends and the owner has her role back; the
 *     keeper's wage is paid, once; the unused invite and the re-key code work; the releases are M's; no second link
 *     treasury, and a link row lost finds its treasury again, by the marker M made with it and S copied (never by name).
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-in-flight.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { spawnNode, post, runNodeChild, serveCommands, type NodeProc } from './takeover-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the nodes' own self-signed certificates

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'InFlight-Main-Pw-7713!';
const PW_STANDBY = 'InFlight-Standby-Pw-2208!';
const AHEAD_MS = 3600_000;
const DAY = 86400_000;
const LINK_PEER = '12D3KooWInFlightLinkedPeer00000000000000000000000';
/** The importer format this change's copy records (engine/sync.ts REPLICA_FORMAT); the one before it, a standby to re-seed. */
const FORMAT = '5';
const FORMAT_BEFORE = '4';

/** The plain tables and their keys, as the manifest names them (engine/replication-manifest.ts). */
const PLAIN = [
    'deferred_wage_claims', 'decisions', 'decision_votes', 'suspended_node_roles', 'enterprise_keeper_requests',
    'enterprise_keeper_changes', 'enterprise_succession_proposals', 'enterprise_succession_votes', 'group_convenor_proposals',
    'group_convenor_votes', 'invite_codes', 'rekey_requests', 'recovery_releases', 'federation_links', 'federation_link_treasuries',
] as const;

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

/** Each plain table as this server holds it, ordered by its key; never a column the manifest keeps off the path. */
async function plainRows(): Promise<Record<string, Record<string, unknown>[]>> {
    const { db } = await import('./db/db.js');
    const out: Record<string, Record<string, unknown>[]> = {};
    for (const t of PLAIN) {
        const key = (db.prepare('SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk').all(t) as { name: string }[]).map((c) => `"${c.name}"`);
        out[t] = (db.prepare(`SELECT * FROM ${t} ORDER BY ${key.join(', ')}`).all() as Record<string, unknown>[]).map((r) => {
            if (t === 'suspended_node_roles') delete r.break_glass_hash;
            return r;
        });
    }
    return out;
}

async function child(): Promise<void> {
    const fetches = guardFetch();
    await runNodeChild({
        ...serveCommands,
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
        /** This server's SQLite clock `aheadMs` ahead: `strftime(…, 'now')`, which every stamping trigger writes. */
        'skew-clock': async (a: { aheadMs: number }) => {
            const { db } = await import('./db/db.js');
            const plain = new Database(':memory:');
            db.function('strftime', { varargs: true, deterministic: false }, (format: unknown, time: unknown, ...modifiers: unknown[]) => {
                const at = time === 'now' ? new Date(Date.now() + a.aheadMs).toISOString().replace('T', ' ').replace('Z', '') : time;
                return plain.prepare(`SELECT strftime(?, ?${modifiers.map(() => ', ?').join('')})`).pluck().get(format, at, ...modifiers);
            });
            return (db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now`).get() as { now: string }).now;
        },
        /** One pull of the kind the loop makes next, then the take-over envelope; `whole` asks the routine whole copy. */
        pull: async (a: { whole?: boolean }) => {
            const { pullNow, getBackupStatus, pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            const before = getBackupStatus().lastFullReconcileAt;
            if (a.whole) process.env.BACKUP_RECONCILE_EVERY_MS = '1';
            await new Promise((r) => setTimeout(r, 5));
            const result = await pullNow();
            process.env.BACKUP_RECONCILE_EVERY_MS = '86400000';
            const after = getBackupStatus();
            const envelope = await pullTakeoverEnvelopeNow();
            return { ...result, whole: after.lastFullReconcileAt !== before, mode: after.lastPullMode ?? null, envelope };
        },
        rows: async () => {
            const { db } = await import('./db/db.js');
            const format = (db.prepare(`SELECT value FROM node_config WHERE key = 'replica_format'`).get() as { value: string } | undefined)?.value ?? null;
            return { tables: await plainRows(), format };
        },
        /**
         * A member who hasn't used the node for `days`. Their row moves too, so a copy holds that last activity, as a copy of
         * a month's quiet does: a standby's last activity for a member is never later than its main server's.
         */
        'age-activity': async (a: { publicKey: string; days: number }) => {
            const { db } = await import('./db/db.js');
            db.prepare(`UPDATE members SET last_active_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE public_key = ?`)
                .run(new Date(Date.now() - a.days * DAY).toISOString(), a.publicKey);
            return true;
        },
        /**
         * A community that has been here `days`: every row joined then (a copy takes the change), so its trades read as an
         * established community's, not a new cluster trading only with itself (engine trust.ts runWashTradingAnalysis).
         */
        'age-members': async (a: { days: number }) => {
            const { db } = await import('./db/db.js');
            return db.prepare(`UPDATE members SET joined_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
                .run(new Date(Date.now() - a.days * DAY).toISOString()).changes;
        },
        /** A group its members joined `days` ago: who may vote on its convenor is who was in it before the convenor went quiet. */
        'age-group': async (a: { groupId: string; days: number }) => {
            const { db } = await import('./db/db.js');
            const at = new Date(Date.now() - a.days * DAY).toISOString();
            db.prepare('UPDATE groups SET created_at = ? WHERE id = ?').run(at, a.groupId);
            return db.prepare('UPDATE group_members SET joined_at = ? WHERE group_id = ?').run(at, a.groupId).changes;
        },
        /** The minute ticks (state-engine.ts initStateEngine), each run as of `asOf`. */
        'tick-keepers': async (a: { asOf: number }) => (await import('./state-engine.js')).tickEnterpriseKeepers(a.asOf),
        'tick-decisions': async (a: { asOf: number }) => (await import('./decisions-engine.js')).tickDecisions(a.asOf),
        'tick-groups': async (a: { asOf: number }) => (await import('./state-engine.js')).tickGroupSuccession(a.asOf),
        /** A link with another community: a peer connector with a credit cap, converged as a boot does (index.ts). */
        'link-peer': async (a: { cap: number }) => {
            const { addConnector, setConnectorCreditCap, getConnectors } = await import('./connector-manager.js');
            const { reconcileFederationLinks, getFederationLink } = await import('./federation-link.js');
            const { createTreasury } = await import('./state-engine.js');
            const address = `/ip4/127.0.0.1/tcp/4999/p2p/${LINK_PEER}`;
            if (!getConnectors().some((c: any) => c.address === address)) addConnector(address, 'peer', 'Eastgippy', undefined, false);
            setConnectorCreditCap(address, a.cap);
            const created = reconcileFederationLinks(createTreasury);
            return { created, link: getFederationLink(LINK_PEER) };
        },
        /** Every enterprise named as a link, the link rows, and each one's balance. */
        links: async () => {
            const { db } = await import('./db/db.js');
            return {
                treasuries: db.prepare(`SELECT m.public_key, m.callsign, a.balance FROM members m LEFT JOIN accounts a ON a.public_key = m.public_key
                                        WHERE m.callsign LIKE '%Link%' ORDER BY m.rowid`).all(),
                rows: db.prepare('SELECT peer_id, treasury_pubkey, commission_ceiling FROM federation_links ORDER BY peer_id').all(),
                markers: db.prepare('SELECT treasury_pubkey, peer_id, created_at FROM federation_link_treasuries ORDER BY treasury_pubkey').all(),
            };
        },
        'drop-link-row': async () => {
            const { db } = await import('./db/db.js');
            return db.prepare('DELETE FROM federation_links WHERE peer_id = ?').run(LINK_PEER).changes;
        },
        /**
         * A recovery fragment released, as recordRelease writes it (engine/recovery-release.ts): locked with this server's
         * seal key to the release, the log and not its session (no route makes one without a member's recovery).
         */
        'record-release': async (a: { collectionId: string; shareId: number; releasedBy: string | null }) => {
            const { db } = await import('./db/db.js');
            const { sealRecoveryFields, releaseRowAad } = await import('./services/recovery-seal-key.js');
            const sealed = sealRecoveryFields({
                encryptedShare: crypto.randomBytes(48).toString('base64'), shareIv: crypto.randomBytes(12).toString('base64'),
                shareTag: crypto.randomBytes(16).toString('base64'), kdfParams: null,
            }, releaseRowAad(a.collectionId, a.shareId, 'hub'));
            db.prepare(`INSERT INTO recovery_releases (collection_id, share_id, holder_type, share_index, payload, payload_iv, payload_tag,
                        ephemeral_pubkey, kdf_params, released_by, released_at)
                        VALUES (?, ?, 'hub', 1, ?, ?, ?, NULL, ?, ?, ?)`)
                .run(a.collectionId, a.shareId, sealed.encryptedShare, sealed.shareIv, sealed.shareTag, sealed.kdfParams, a.releasedBy, new Date().toISOString());
            return true;
        },
        /** A row gone from a plain table with no tombstone: a delete an older version made, or one by hand. */
        'forget-release': async (a: { shareId: number }) => {
            const { db } = await import('./db/db.js');
            return db.prepare('DELETE FROM recovery_releases WHERE share_id = ?').run(a.shareId).changes;
        },
        /**
         * M's whole copy, signed with its own key, with a value no table here takes (a keeper request's status its CHECK
         * refuses) and a second open Decision by an author who has one (the unique index on open ones refuses it).
         */
        forge: async (a: { requestId: string; author: string }) => {
            const { exportSyncState, signSyncPayload } = await import('./state-engine.js');
            const { getPrivateKey } = await import('./p2p.js');
            const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
            const payload: any = await exportSyncState(peerIdFromPrivateKey(getPrivateKey()).toString());
            delete payload.signature;
            delete payload.publicKey;
            const later = new Date(Date.now() + 1000).toISOString();
            payload.plainTables.enterprise_keeper_requests = payload.plainTables.enterprise_keeper_requests
                .map((r: any) => (r.id === a.requestId ? { ...r, status: 'maybe', updated_at: later } : r));
            const open = payload.plainTables.decisions.find((d: any) => d.author_pubkey === a.author && d.status === 'open');
            payload.plainTables.decisions.push({ ...open, id: `forged-${crypto.randomUUID()}`, title: 'A second open one', updated_at: later });
            payload.generatedAt = new Date().toISOString();
            return signSyncPayload(payload);
        },
        /** Import a payload as the puller does, straight into this standby: `whole` as a snapshot, else as a delta. */
        import: async (a: { payload: any; whole?: boolean }) => {
            const { importRemoteState } = await import('./state-engine.js');
            try {
                const r = await importRemoteState(a.payload, { full: a.whole === true });
                return { ok: true, leftOut: (r as any).plainTablesLeftOut ?? null };
            } catch (e: any) {
                return { ok: false, error: e?.message || String(e) };
            }
        },
        /**
         * Every writer of the plain tables, called on this server as a route would call it: each answer (a refusal's code, or
         * what it returned), and every plain table before and after.
         */
        'call-writers': async (a: { ids: Record<string, string> }) => {
            const before = await plainRows();
            const se = await import('./state-engine.js');
            const de = await import('./decisions-engine.js');
            const inv = await import('./engine/invites.js');
            const wiz = await import('./engine/member-wizards.js');
            const rel = await import('./engine/recovery-release.js');
            const fl = await import('./federation-link.js');
            const id = a.ids;
            const calls: [string, () => unknown][] = [
                ['createDecision', () => de.createDecision({ authorPubkey: id.dee, title: 'On a standby', description: 'Never', touches: 'member', effect: 'grant_voucher', subject: id.kip } as any)],
                ['castDecisionVote', () => de.castDecisionVote(id.decision, id.dee, true)],
                ['tickDecisions', () => de.tickDecisions(Date.now() + 30 * DAY)],
                ['adminEmergencySuspend', () => de.adminEmergencySuspend(id.kip, 'owner:password', 'On a standby')],
                ['adminLiftSuspension', () => de.adminLiftSuspension(id.lou, 'owner:password')],
                ['requestToJoinEnterprise', () => se.requestToJoinEnterprise(id.probe, id.moe, 0)],
                ['approveKeeperRequest', () => se.approveKeeperRequest(id.request, id.cy)],
                ['tickEnterpriseKeepers', () => se.tickEnterpriseKeepers(Date.now() + 30 * DAY)],
                ['voteLeadSuccession', () => se.voteLeadSuccession(id.succession, id.bo, 'yes')],
                ['processDeferredWageClaims', () => se.processDeferredWageClaims(id.probe)],
                ['voteGroupConvenor', () => se.voteGroupConvenor(id.convenorVote, id.kip, 'yes')],
                ['tickGroupSuccession', () => se.tickGroupSuccession(Date.now() + 30 * DAY)],
                ['generateInvite', () => inv.generateInvite(id.gwen)],
                ['redeemInvite', () => inv.redeemInvite(() => {}, id.invite, crypto.randomBytes(32).toString('hex'), 'Stranger')],
                ['issueRekeyCode', () => wiz.issueRekeyCode(id.kip, 'owner:password')],
                ['completeRekey', () => wiz.completeRekey(id.pam, crypto.randomBytes(32).toString('hex'), id.rekeyCode, 'owner:password')],
                ['releaseHubFragment', () => rel.releaseHubFragment('no-such-collection')],
                ['setCommissionCeiling', () => fl.setCommissionCeiling(LINK_PEER, 5)],
                ['ensureFederationLink', () => fl.ensureFederationLink('12D3KooWAnotherPeer000000000000000000000000000000', 'Another', se.createTreasury)],
            ];
            const answers: Record<string, string> = {};
            for (const [name, call] of calls) {
                try {
                    const r = call();
                    answers[name] = `returned ${JSON.stringify(r)?.slice(0, 80)}`;
                } catch (e: any) {
                    answers[name] = e?.code === 'standby' ? 'standby' : `threw ${e?.message?.slice(0, 80)}`;
                }
            }
            // The boot's convergence of links, and the reads and the activity hook that close what is due on a main server.
            const links = fl.reconcileFederationLinks(se.createTreasury);
            const reads: Record<string, string> = {};
            for (const [name, read] of [
                ['getSuccessionProposals', () => se.getSuccessionProposals(id.probe)],
                ['getKeeperChanges', () => se.getKeeperChanges(id.probe)],
                ['getGroupSuccession', () => se.getGroupSuccession(id.group, id.bo)],
                ['getRekeyStatus', () => wiz.getRekeyStatus(id.pam)],
                ['recordActivity', async () => (await import('./engine/members.js')).recordActivity(id.ann)],
            ] as [string, () => unknown][]) {
                try { await read(); reads[name] = 'answered'; } catch (e: any) { reads[name] = `threw ${e?.message?.slice(0, 80)}`; }
            }
            const after = await plainRows();
            const changed = PLAIN.filter((t) => JSON.stringify(before[t]) !== JSON.stringify(after[t]));
            return { answers, links, reads, changed };
        },
        /**
         * Members' standing, keepers and pledges as this server holds them (G2's tables and columns, which #1276 copies):
         * every members column but `last_active_at` (travels only with another change, by design), in key order.
         */
        standing: async () => {
            const { db } = await import('./db/db.js');
            const members = (db.prepare('SELECT * FROM members ORDER BY public_key').all() as Record<string, unknown>[])
                .map(({ last_active_at: _, ...row }) => row);
            return {
                members,
                operators: db.prepare('SELECT * FROM treasury_operators ORDER BY treasury_pubkey, member_pubkey').all(),
                pledges: db.prepare('SELECT * FROM enterprise_pledges ORDER BY id').all(),
            };
        },
        /** What the outcomes read: a Decision, a member, an enterprise's keepers, node roles, a claim, trades. */
        facts: async (a: { ids: Record<string, string> }) => {
            const { db } = await import('./db/db.js');
            const id = a.ids;
            const one = (sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as any;
            return {
                decision: one('SELECT status FROM decisions WHERE id = ?', id.decision)?.status ?? null,
                ballots: (one('SELECT COUNT(*) AS n FROM decision_votes WHERE decision_id = ?', id.decision) as any).n,
                removal: one('SELECT status FROM decisions WHERE id = ?', id.removal)?.status ?? null,
                suspension: one('SELECT status FROM decisions WHERE id = ?', id.suspension)?.status ?? null,
                rex: one('SELECT status FROM members WHERE public_key = ?', id.rex)?.status ?? null,
                lou: one('SELECT status FROM members WHERE public_key = ?', id.lou)?.status ?? null,
                louRole: one('SELECT role FROM node_roles WHERE member_pubkey = ?', id.lou)?.role ?? null,
                held: (one('SELECT COUNT(*) AS n FROM suspended_node_roles') as any).n,
                cyVouches: one('SELECT can_vouch FROM members WHERE public_key = ?', id.cy)?.can_vouch ?? null,
                change: one('SELECT status, reason FROM enterprise_keeper_changes WHERE request_id = ?', id.request) ?? null,
                request: one('SELECT status FROM enterprise_keeper_requests WHERE id = ?', id.request)?.status ?? null,
                niaKeeps: !!one('SELECT 1 FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?', id.probe, id.nia),
                succession: one('SELECT status FROM enterprise_succession_proposals WHERE id = ?', id.succession)?.status ?? null,
                lead: one("SELECT member_pubkey FROM treasury_operators WHERE treasury_pubkey = ? AND role = 'lead'", id.probe)?.member_pubkey ?? null,
                convenorVote: one('SELECT status FROM group_convenor_proposals WHERE id = ?', id.convenorVote)?.status ?? null,
                convenorClosed: one('SELECT closed_reason FROM group_convenor_proposals WHERE id = ?', id.convenorVote)?.closed_reason ?? null,
                convenor: one("SELECT member_pubkey FROM group_members WHERE group_id = ? AND role = 'convenor' AND status = 'active'", id.group)?.member_pubkey ?? null,
                claim: one('SELECT status, paid_at FROM deferred_wage_claims WHERE id = ?', id.claim) ?? null,
                payouts: (one("SELECT COUNT(*) AS n FROM transactions WHERE memo LIKE 'Deferred wage claim payout%' AND to_pubkey = ?", id.kip) as any).n,
                kipBalance: one('SELECT balance FROM accounts WHERE public_key = ?', id.kip)?.balance ?? null,
            };
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';

type Tables = Record<string, Record<string, unknown>[]>;

/** Where S's plain tables differ from M's: each table, row for row and column for column. */
function tablesDiff(m: Tables, s: Tables): string[] {
    const out: string[] = [];
    for (const t of PLAIN) {
        const k = (r: Record<string, unknown>) => JSON.stringify(Object.values(r).slice(0, 2));
        const ms = new Map(m[t].map((r) => [k(r), r]));
        const ss = new Map(s[t].map((r) => [k(r), r]));
        for (const [key, r] of ms) {
            const o = ss.get(key);
            if (!o) { out.push(`${t} ${key.slice(0, 30)} missing`); continue; }
            for (const c of Object.keys(r)) {
                if (JSON.stringify(r[c]) !== JSON.stringify(o[c])) out.push(`${t} ${key.slice(0, 30)}.${c}: main ${JSON.stringify(r[c])?.slice(0, 30)}, standby ${JSON.stringify(o[c])?.slice(0, 30)}`);
            }
        }
        for (const key of ss.keys()) if (!ms.has(key)) out.push(`${t} ${key.slice(0, 30)} extra`);
    }
    return out;
}
const first = (xs: string[]) => (xs.length === 0 ? 'none' : `${xs.length}: ${xs.slice(0, 4).join(' | ')}`);
const count = (t: Tables) => PLAIN.map((n) => `${n.replace(/^(enterprise_|group_)/, '')} ${t[n].length}`).join(', ');

function withDb(dir: string, fn: (db: Database.Database) => void): void {
    const db = new Database(path.join(dir, 'state.db'));
    try { fn(db); } finally { db.close(); }
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    if (process.env.ENABLE_PEER_CONNECTORS !== 'true') throw new Error('Run with ENABLE_PEER_CONNECTORS=true: the link with another community needs it');
    const dir = (n: string) => path.join(root, n);
    const nodes: NodeProc[] = [];
    const started = Date.now();
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const env = (pw: string, role: string) => ({ ADMIN_PASSWORD: pw, NODE_ROLE: role, NODE_ENV: 'test', BACKUP_RECONCILE_EVERY_MS: '86400000' });
    const gwen = newId('Gwen');
    const [ann, bo, cy, dee, kip, rex, lou, nia, pam, moe] = ['Ann', 'Bo', 'Cy', 'Dee', 'Kip', 'Rex', 'Lou', 'Nia', 'Pam', 'Moe'].map(newId);
    const refused: string[] = [];

    try {
        // ── 1. M ──
        console.log('\n— 1. the main server: an enterprise, its keepers, a wage owed, invites —');
        const main = await spawnNode(SCRIPT, dir('main'), env(PW_MAIN, 'primary'));
        nodes.push(main);
        const setup = await main.send('setup-primary', { replicationToken, genesis: gwen.pk });
        const m = `https://localhost:${await main.send('serve')}`;
        const A = (route: string, body: unknown) => api(m, 'POST', route, { admin: PW_MAIN, body });
        const S_ = (who: Id, route: string, body: unknown = {}) => api(m, 'POST', route, { as: who, body });
        const invite = async () => {
            const inv = built('Gwen makes an invite', await S_(gwen, '/api/invite/generate', { publicKey: gwen.pk }));
            return (inv.invite?.code ?? inv.code) as string;
        };
        built('Gwen sets a profile photo', await S_(gwen, '/api/profile/update', { avatar: TINY_PNG }));
        for (const who of [ann, bo, cy, dee, kip, rex, lou, nia, pam, moe]) {
            built(`${who.name} joins`, await api(m, 'POST', '/api/invite/redeem', { body: { code: await invite(), publicKey: who.pk, callsign: who.name } }));
            built(`${who.name} sets a profile photo`, await S_(who, '/api/profile/update', { avatar: TINY_PNG }));
        }
        for (const who of [gwen, cy, nia]) built(`the admin makes ${who.name} an Elder`, await A(`/api/local/admin/users/${who.pk}/elder`, { grant: true }));
        const offer = async (who: Id, title: string, credits: number) => built(`${who.name} offers ${title}`, await S_(who, '/api/marketplace/posts', {
            type: 'offer', category: 'food', title, description: `${title}, from ${who.name}`, credits, priceType: 'fixed', authorPublicKey: who.pk,
        })).post;
        const deal = async (buyer: Id, seller: Id, postId: string) => {
            const tx = built(`${buyer.name} asks for ${seller.name}'s listing`, await S_(buyer, '/api/marketplace/posts/request', { postId, buyerPublicKey: buyer.pk })).transaction;
            built(`${seller.name} approves: the Beans are held`, await S_(seller, '/api/marketplace/transactions/approve', { transactionId: tx.id, authorPublicKey: seller.pk }));
            built(`${buyer.name} confirms: the Beans are released`, await S_(buyer, '/api/marketplace/transactions/complete', { transactionId: tx.id, confirmerPublicKey: buyer.pk }));
        };
        await offer(gwen, 'Sourdough', 4); // a buyer lists an offer first (the offer covenant)
        await deal(gwen, kip, (await offer(kip, 'Tune-up', 10)).id); // Kip has Beans
        await deal(gwen, ann, (await offer(ann, 'Honey', 10)).id); // and Ann, to buy with later
        await deal(gwen, nia, (await offer(nia, 'Jam', 6)).id); // and Nia, whose earned credit backs a pledge
        const probe = built('Cy starts an enterprise, Probe Co', await S_(cy, '/api/treasury', { name: 'Probe Co', purpose: 'Repairs for the street', avatar: TINY_PNG }));
        for (const who of [kip, bo, dee]) built(`the admin makes ${who.name} a keeper of Probe Co`, await A(`/api/local/admin/treasury/${probe.publicKey}/operators`, { pubkey: who.pk }));
        built('Kip pledges backing to Probe Co (its credit floor, to hire with)', await S_(kip, `/api/treasury/${probe.publicKey}/pledge`, { type: 'backing', amount: 2 }));
        // Probe Co hiring its own keeper while it holds nothing: refused, and the wage is owed (engine/escrow.ts isPayeeKeeper).
        const bikeCheck = built('Cy lists an offer for Probe Co', await S_(cy, `/api/treasury/${probe.publicKey}/offer`, {
            title: 'Bike check', description: 'At the workshop', credits: 3, category: 'tools', repeatable: true,
        }));
        const job = built('and a job it needs done', await S_(cy, `/api/treasury/${probe.publicKey}/need`, {
            title: 'Workshop tidy', description: 'Sort the parts bins', credits: 2, category: 'tools',
        }));
        const bid = built('Kip offers to do it', await S_(kip, '/api/marketplace/posts/request', { postId: (job.post ?? job).id, buyerPublicKey: kip.pk })).transaction;
        const wage = await S_(cy, `/api/treasury/${probe.publicKey}/approve`, { transactionId: bid.id });
        require_(wage.status === 403 && /only be paid from profit/.test(wage.body?.error ?? ''),
            `M: Cy approves it for Probe Co, which holds nothing: refused, and Kip's wage is owed (${brief(wage)})`);
        await main.send('age-members', { days: 90 });
        const m1: Tables = (await main.send('rows')).tables;
        const claim = m1.deferred_wage_claims.find((c) => c.keeper_pubkey === kip.pk && c.status === 'pending');
        require_(!!claim && m1.invite_codes.length >= 10, `M: Kip's wage owed, and the invites (${count(m1)})`);

        // ── 2. S's first copy ──
        console.log('\n— 2. the standby, its clock an hour ahead, takes its first copy —');
        fs.mkdirSync(dir('standby'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('standby'), 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const skewed = await standby.send('skew-clock', { aheadMs: AHEAD_MS });
        require_(Date.parse(skewed) - Date.now() > AHEAD_MS - 60_000, `S: its SQLite clock reads an hour ahead (${skewed})`);
        const firstPull = await standby.send('pull', {});
        require_(firstPull.ok === true, `S: the loop's first pull lands (${firstPull.ok ? firstPull.mode : firstPull.error})`);
        let s: { tables: Tables; format: string | null } = await standby.send('rows');
        assert(tablesDiff(m1, s.tables).length === 0, `every plain table is M's, row for row and stamp for stamp (${count(s.tables)}; differences ${first(tablesDiff(m1, s.tables))})`);
        assert(s.format === FORMAT, `and its copy is one this importer made, format ${FORMAT} (${s.format})`);

        // ── 3. More on M, then a delta ──
        console.log('\n— 3. keeper and succession votes, Decisions, a suspension, codes, releases, a link; then a delta —');
        const asked = built('Nia asks to keep Probe Co, pledging 1 Bean of backing', await S_(nia, `/api/treasury/${probe.publicKey}/keepers/request`, { pledgedBacking: 1 }));
        const requestId = asked.request?.id as string;
        const approved = built('Cy approves: a keeper change, open to objection for 3 days', await S_(cy, `/api/treasury/${probe.publicKey}/keepers/requests/${requestId}/approve`, {}));
        require_(JSON.stringify(approved).includes('pending'), `M: the change waits out its objection window (${JSON.stringify(approved).slice(0, 160)})`);
        const group = built('Ann starts a group', await S_(ann, '/api/groups', { name: 'Gardeners', description: 'People who grow things' }));
        const groupId = (group.group?.id ?? group.id) as string;
        for (const who of [bo, dee, kip]) built(`${who.name} joins it`, await S_(who, `/api/groups/${groupId}/join`));
        await main.send('age-group', { groupId, days: 40 });
        // The lead and the convenor go quiet for a month; nothing either signs after this.
        await main.send('age-activity', { publicKey: cy.pk, days: 31 });
        await main.send('age-activity', { publicKey: ann.pk, days: 31 });
        const succession = built('Kip proposes himself as Probe Co\'s lead (his yes: 1 of 3)', await S_(kip, `/api/treasury/${probe.publicKey}/succession/propose`, { candidatePubkey: kip.pk }));
        const successionId = (succession.proposal?.id ?? succession.id) as string;
        require_(succession.executed === false, `M: the succession vote is open (${JSON.stringify(succession).slice(0, 160)})`);
        const convenor = built('Bo proposes Dee as the group\'s convenor', await S_(bo, `/api/groups/${groupId}/succession/propose`, { candidatePubkey: dee.pk }));
        const convenorVoteId = (convenor.proposal?.id ?? convenor.id) as string;
        require_(convenor.executed === false, `M: the convenor vote is open (${JSON.stringify(convenor).slice(0, 160)})`);
        const grant = built('Gwen proposes making Cy a voucher', await S_(gwen, '/api/commons/decisions', {
            title: 'Make Cy a voucher', description: 'Cy has helped half the street', touches: 'member', effect: 'grant_voucher', subject: cy.pk,
        })).decision;
        for (const v of [gwen, bo, nia]) built(`${v.name} votes for it`, await S_(v, `/api/commons/decisions/${grant.id}/vote`, { support: true }));
        const removal = built('Kip proposes removing Rex, closing in a few seconds', await S_(kip, '/api/commons/decisions', {
            title: 'Remove Rex', description: 'Rex has not been seen in a year', touches: 'member', effect: 'remove_member', subject: rex.pk,
            closesAt: new Date(Date.now() + 2500).toISOString(),
        })).decision;
        for (const v of [gwen, kip, nia, bo]) built(`${v.name} votes for it`, await S_(v, `/api/commons/decisions/${removal.id}/vote`, { support: true }));
        built('the admin makes Lou an owner', await A('/api/local/admin/node-roles', { pubkey: lou.pk, role: 'owner' }));
        const suspended = built('and suspends her: a vote on keeping it opens, her role held aside', await A(`/api/local/admin/users/${lou.pk}/suspend`, { reason: 'An emergency on the street' }));
        const suspensionId = suspended.decision?.id as string;
        built('the admin makes Moe a moderator', await A('/api/local/admin/node-roles', { pubkey: moe.pk, role: 'moderator' }));
        built('suspends him', await A(`/api/local/admin/users/${moe.pk}/suspend`, { reason: 'A mistake by the admin' }));
        built('and lifts it again: his role comes back, the row held for it goes', await A(`/api/local/admin/users/${moe.pk}/status`, { status: 'active' }));
        const unused = await invite();
        const rekey = built('the admin issues Pam a re-key code she hasn\'t used', await A(`/api/local/admin/members/${pam.pk}/rekey/issue-code`, {}));
        const rekeyCode = (rekey.code ?? rekey.request?.code ?? rekey.rekeyCode) as string;
        require_(typeof rekeyCode === 'string' && rekeyCode.length > 0, `M: the code (${JSON.stringify(rekey).slice(0, 120)})`);
        await main.send('record-release', { collectionId: 'collection-1', shareId: 1, releasedBy: null });
        await main.send('record-release', { collectionId: 'collection-1', shareId: 2, releasedBy: bo.pk });
        const linked = await main.send('link-peer', { cap: 50 });
        require_(linked.created === 1 && !!linked.link?.treasuryPubkey, `M: a link with Eastgippy, and its treasury (${JSON.stringify(linked).slice(0, 160)})`);
        built('Kip puts 3 Beans in the link\'s treasury', await S_(kip, '/api/ledger/transfer', { to: linked.link.treasuryPubkey, amount: 3, memo: 'for favours' }));
        await sleep(Math.max(0, new Date(removal.closesAt).getTime() - Date.now() + 200));
        await main.send('tick-decisions', {});
        const m3: Tables = (await main.send('rows')).tables;
        require_(m3.federation_link_treasuries.length === 1 && m3.federation_link_treasuries[0].treasury_pubkey === linked.link.treasuryPubkey
            && m3.federation_link_treasuries[0].peer_id === LINK_PEER, `M: the link's treasury is marked as made for Eastgippy (${JSON.stringify(m3.federation_link_treasuries)})`);
        const removalRow = m3.decisions.find((d) => d.id === removal.id);
        require_(removalRow?.status === 'execution_pending_grace', `M: the removal passed and waits out its grace period (${removalRow?.status})`);
        require_(m3.suspended_node_roles.length === 1 && m3.suspended_node_roles[0].member_pubkey === lou.pk,
            `M: one role held aside, Lou's; Moe's went when his suspension was lifted (${JSON.stringify(m3.suspended_node_roles.map((r) => r.role))})`);
        const delta = await standby.send('pull', {});
        require_(delta.ok === true && delta.mode === 'delta', `S: a delta (${delta.ok ? delta.mode : delta.error})`);
        s = await standby.send('rows');
        assert(tablesDiff(m3, s.tables).length === 0, `every plain table is M's again, the delete of Moe's held role included (${count(s.tables)}; differences ${first(tablesDiff(m3, s.tables))})`);
        assert(s.tables.decision_votes.filter((v) => v.decision_id === grant.id).length === 3, 'the open Decision\'s three ballots are here, as M holds them');
        const ids: Record<string, string> = {
            gwen: gwen.pk, ann: ann.pk, bo: bo.pk, cy: cy.pk, dee: dee.pk, kip: kip.pk, rex: rex.pk, lou: lou.pk, nia: nia.pk, pam: pam.pk,
            moe: moe.pk, probe: probe.publicKey, request: requestId, succession: successionId, group: groupId, convenorVote: convenorVoteId,
            decision: grant.id, removal: removal.id, suspension: suspensionId, invite: unused, rekeyCode, claim: String(claim!.id),
        };

        // ── 4. On S, nothing of these is written ──
        console.log('\n— 4. the standby writes none of it itself —');
        const sv = `https://localhost:${await standby.send('serve')}`;
        const onS = (who: Id | null, route: string, body: unknown = {}) => api(sv, 'POST', route, who ? { as: who, body } : { admin: PW_STANDBY, body });
        const routes: [string, Promise<Answer>][] = [
            ['an invite made', onS(gwen, '/api/invite/generate', { publicKey: gwen.pk })],
            ['an invite redeemed', api(sv, 'POST', '/api/invite/redeem', { body: { code: unused, publicKey: newId('X').pk, callsign: 'Stranger' } })],
            ['a keeper request', onS(moe, `/api/treasury/${probe.publicKey}/keepers/request`, { pledgedBacking: 0 })],
            ['a keeper request approved', onS(cy, `/api/enterprise/${probe.publicKey}/keepers/requests/${requestId}/approve`)],
            ['a succession vote', onS(bo, `/api/treasury/${probe.publicKey}/succession/${successionId}/vote`, { choice: 'yes' })],
            ['a convenor vote', onS(kip, `/api/groups/${groupId}/succession/${convenorVoteId}/vote`, { choice: 'yes' })],
            ['a Decision vote', onS(dee, `/api/commons/decisions/${grant.id}/vote`, { support: true })],
            ['an admin suspension', onS(null, `/api/local/admin/users/${kip.pk}/suspend`, { reason: 'On a standby' })],
            ['a re-key code', onS(null, `/api/local/admin/members/${kip.pk}/rekey/issue-code`)],
            ['a link\'s ceiling', onS(null, '/api/local/federation/links/ceiling', { peerId: LINK_PEER, ceiling: 5 })],
        ];
        for (const [what, call] of routes) {
            const r = await call;
            assert(r.status === 409 && r.body?.code === 'standby', `S refuses ${what} with 409 standby (${brief(r)})`);
        }
        const writers = await standby.send('call-writers', { ids });
        const wrote = Object.entries(writers.answers as Record<string, string>).filter(([, v]) => v !== 'standby');
        assert(wrote.length === 0, `every writer of these tables refuses on S before it writes (${wrote.length ? wrote.map(([k, v]) => `${k}: ${v}`).join('; ') : `${Object.keys(writers.answers).length} refused`})`);
        assert(writers.links === 0, `the boot's convergence of links makes none on S (${writers.links})`);
        assert(Object.values(writers.reads).every((v) => v === 'answered'), `the reads that close what is due still answer on S (${JSON.stringify(writers.reads)})`);
        assert(writers.changed.length === 0, `and S's plain tables are exactly as before (changed: ${writers.changed.join(', ') || 'none'})`);

        // ── 5. A copy with values S refuses; a row M no longer holds ──
        console.log('\n— 5. a value S refuses never wedges a copy; a whole copy deletes a row M no longer holds —');
        const forged = await standby.send('import', { payload: await main.send('forge', { requestId, author: gwen.pk }), whole: true });
        assert(forged.ok === true && Array.isArray(forged.leftOut)
            && forged.leftOut.some((x: string) => x === `enterprise_keeper_requests:${requestId}.status`)
            && forged.leftOut.some((x: string) => x.startsWith('decisions:forged-')),
            `a whole copy with a status the table refuses and a second open Decision by Gwen lands, both left out and reported (${forged.ok ? JSON.stringify(forged.leftOut) : forged.error})`);
        s = await standby.send('rows');
        assert(s.tables.enterprise_keeper_requests.find((r) => r.id === requestId)?.status === 'pending' && !s.tables.decisions.some((d) => String(d.id).startsWith('forged-')),
            'S keeps the request\'s status it had, and writes no second open Decision');
        await main.send('forget-release', { shareId: 2 });
        const whole = await standby.send('pull', { whole: true });
        require_(whole.ok === true && whole.whole === true, `S: a whole copy (${whole.ok ? whole.mode : whole.error})`);
        const m5: Tables = (await main.send('rows')).tables;
        s = await standby.send('rows');
        assert(m5.recovery_releases.length === 1 && tablesDiff(m5, s.tables).length === 0,
            `and S is M's again: the release M no longer holds is gone, and the rest is M's (differences ${first(tablesDiff(m5, s.tables))})`);
        refused.push(...(await standby.send('fetches')).blocked);
        await standby.kill('SIGTERM');

        // ── 6. A format 4 standby re-seeds once ──
        console.log('\n— 6. a standby from before this format re-seeds itself once —');
        withDb(dir('standby'), (db) => {
            db.pragma('foreign_keys = OFF');
            db.prepare(`INSERT INTO invite_codes (code, created_by, created_at, updated_at) VALUES ('STANDBY-OWN', ?, ?, ?)`)
                .run(gwen.pk, new Date().toISOString(), new Date().toISOString());
            db.prepare(`INSERT OR REPLACE INTO node_config (key, value) VALUES ('replica_format', ?)`).run(FORMAT_BEFORE);
        });
        standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        const planted = await standby.send('rows');
        require_(planted.format === FORMAT_BEFORE && planted.tables.invite_codes.some((r: any) => r.code === 'STANDBY-OWN'), `S: format ${FORMAT_BEFORE}, with an invite of its own`);
        const reseed = await standby.send('pull', {});
        s = await standby.send('rows');
        assert(reseed.ok === true && reseed.mode === 'resync' && s.format === FORMAT, `its next pull re-seeds it, once, to format ${FORMAT} (${reseed.ok ? reseed.mode : reseed.error}; format ${s.format})`);
        assert(!s.tables.invite_codes.some((r: any) => r.code === 'STANDBY-OWN') && tablesDiff(m5, s.tables).length === 0,
            `its own invite is gone, and every plain table is M's (differences ${first(tablesDiff(m5, s.tables))})`);
        const after = await standby.send('pull', {});
        assert(after.ok === true && after.mode === 'delta', `the pull after is a delta (${after.ok ? after.mode : after.error})`);

        // ── 7. The take-over ──
        console.log('\n— 7. M dies; S takes over with the recovery code —');
        const last = await standby.send('pull', {});
        require_(last.ok === true && last.envelope !== undefined, `S: a last pull, and the take-over envelope (${last.ok ? last.mode : last.error})`);
        const onMain: Tables = (await main.send('rows')).tables;
        const standingOnMain = await main.send('standing');
        s = await standby.send('rows');
        require_(tablesDiff(onMain, s.tables).length === 0, `S holds M's plain tables at its last copy (differences ${first(tablesDiff(onMain, s.tables))})`);
        refused.push(...(await main.send('fetches')).blocked);
        await main.send('checkpoint');
        await main.kill('SIGKILL');
        const opened = await post(standby.base, '/api/local/admin/takeover/open', { code: setup.code }, { 'X-Admin-Password': PW_STANDBY });
        require_(opened.status === 200 && opened.body.success, `the code opens the keys (${opened.status} ${JSON.stringify(opened.body).slice(0, 160)})`);
        const missing: string[] = opened.body.preview.missing ?? [];
        assert(!missing.some((line) => /Decisions|invites|keeper changes/.test(line)), `the preview no longer says Decisions, invites or keeper changes will be missing (${JSON.stringify(missing).slice(0, 200)})`);
        refused.push(...(await standby.send('fetches')).blocked);
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, { 'X-Admin-Password': PW_STANDBY });
        require_(confirmed.status === 200, `confirm (${confirmed.status})`);
        require_(await standby.exited === 0, 'the standby restarts itself');
        standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        require_(standby.ready.role === 'primary' && standby.ready.peerId === main.ready.peerId, `promoted, with M's PeerId (${standby.ready.role})`);
        // Standing is G2's, which #1276 copies: the promoted server holds M's, every column of it, with nothing written by
        // hand (before #1276 was in, this suite wrote it here).
        const standingHere = await standby.send('standing');
        const standingDiff = (['members', 'operators', 'pledges'] as const).filter((k) => JSON.stringify(standingOnMain[k]) !== JSON.stringify(standingHere[k]));
        assert(standingDiff.length === 0, `the promoted server's members, keepers and pledges are M's, as it copied them (differing: ${standingDiff.join(', ') || 'none'})`);
        const p = `https://localhost:${await standby.send('serve')}`;
        const P_ = (who: Id, route: string, body: unknown = {}) => api(p, 'POST', route, { as: who, body });
        const PA = (route: string, body: unknown) => api(p, 'POST', route, { admin: PW_MAIN, body });

        // ── 8. The promoted server carries it all on ──
        console.log('\n— 8. the promoted server carries it all on —');
        const keepers = await standby.send('tick-keepers', { asOf: Date.now() + 4 * DAY });
        let f = await standby.send('facts', { ids });
        assert(keepers.applied === 1 && f.change?.status === 'applied' && f.request === 'approved' && f.niaKeeps,
            `the keeper change applies after its window: Nia keeps Probe Co, her request approved (${JSON.stringify(keepers)}; ${JSON.stringify(f.change)}, ${f.request})`);
        const boVotes = await P_(bo, `/api/treasury/${probe.publicKey}/succession/${successionId}/vote`, { choice: 'yes' });
        f = await standby.send('facts', { ids });
        assert(boVotes.status === 200 && f.succession === 'active', `Bo votes yes on the succession vote: 2 of 4 keepers, still open (${brief(boVotes)}; ${f.succession})`);
        const deeVotesLead = await P_(dee, `/api/treasury/${probe.publicKey}/succession/${successionId}/vote`, { choice: 'yes' });
        f = await standby.send('facts', { ids });
        assert(deeVotesLead.status === 200 && f.succession === 'passed' && f.lead === kip.pk,
            `Dee's yes with Bo's and Kip's from before the take-over pass it: Kip leads Probe Co (${brief(deeVotesLead)}; ${f.succession})`);
        const kipVotes = await P_(kip, `/api/groups/${groupId}/succession/${convenorVoteId}/vote`, { choice: 'yes' });
        const groups = await standby.send('tick-groups', { asOf: Date.now() + 15 * DAY });
        f = await standby.send('facts', { ids });
        assert(kipVotes.status === 200 && f.convenorVote === 'passed' && f.convenor === dee.pk,
            `the convenor vote counts Bo's ballot and Kip's and passes at its deadline: Dee convenes (${brief(kipVotes)}; ${JSON.stringify(groups)}; ${f.convenorVote} ${f.convenorClosed})`);
        const deeVotes = await P_(dee, `/api/commons/decisions/${grant.id}/vote`, { support: true });
        assert(deeVotes.status === 200, `Dee votes on the open Decision on the promoted server (${brief(deeVotes)})`);
        const early = await standby.send('tick-decisions', { asOf: Date.now() + DAY });
        f = await standby.send('facts', { ids });
        assert(f.removal === 'execution_pending_grace' && f.rex !== 'pruned' && f.decision === 'open',
            `a day on, the removal still waits out its grace and the vote is open (${JSON.stringify(early)}; ${f.removal}, Rex ${f.rex}, ${f.decision})`);
        const sweep = await standby.send('tick-decisions', { asOf: Date.now() + 8 * DAY });
        f = await standby.send('facts', { ids });
        assert(f.ballots === 4 && f.decision === 'executed' && f.cyVouches === 1,
            `eight days on, the Decision counts M's three ballots and Dee's, passes and is carried out: Cy vouches (${f.ballots}; ${f.decision}; ${JSON.stringify(sweep)})`);
        assert(f.removal === 'executed' && f.rex === 'pruned', `the removal is carried out after its grace (${f.removal}; Rex ${f.rex})`);
        assert(f.suspension !== 'open' && f.lou === 'active' && f.louRole === 'owner' && f.held === 0,
            `the suspension nobody kept ends: Lou is active and an owner again (${f.suspension}; ${f.lou}, ${f.louRole}; held ${f.held})`);
        // Bought by someone who keeps nothing there: a keeper's purchase earns an enterprise no surplus (Rule 6).
        const sale = built('Gwen asks for Probe Co\'s bike check', await P_(gwen, '/api/marketplace/posts/request', { postId: (bikeCheck.post ?? bikeCheck).id, buyerPublicKey: gwen.pk })).transaction;
        built('Kip approves it for Probe Co', await P_(kip, `/api/treasury/${probe.publicKey}/approve`, { transactionId: sale.id }));
        built('Gwen confirms: Probe Co earns 3 Beans', await P_(gwen, '/api/marketplace/transactions/complete', { transactionId: sale.id, confirmerPublicKey: gwen.pk }));
        f = await standby.send('facts', { ids });
        assert(f.claim?.status === 'paid' && f.payouts === 1, `Kip's wage owed from before the take-over is paid (${JSON.stringify(f.claim)}; ${f.payouts} payout)`);
        const again = built('Ann asks for another, now the convenor vote is settled', await P_(ann, '/api/marketplace/posts/request', { postId: (bikeCheck.post ?? bikeCheck).id, buyerPublicKey: ann.pk })).transaction;
        built('Kip approves it', await P_(kip, `/api/treasury/${probe.publicKey}/approve`, { transactionId: again.id }));
        built('Ann confirms', await P_(ann, '/api/marketplace/transactions/complete', { transactionId: again.id, confirmerPublicKey: ann.pk }));
        f = await standby.send('facts', { ids });
        assert(f.payouts === 1, `and only once: a later sale pays it no second time (${f.payouts} payout)`);
        const oli = newId('Oli');
        const redeemed = await api(p, 'POST', '/api/invite/redeem', { body: { code: unused, publicKey: oli.pk, callsign: 'Oli' } });
        assert(redeemed.status === 200 && redeemed.body?.success !== false, `Oli joins with the invite Gwen made before the take-over (${brief(redeemed)})`);
        const newPam = newId('Pam2');
        const rekeyed = await PA(`/api/local/admin/members/${pam.pk}/rekey/complete`, { code: rekeyCode, newPubkey: newPam.pk });
        assert(rekeyed.status === 200, `Pam's replacement phone takes over her account with the code issued before the take-over (${brief(rekeyed)})`);
        s = await standby.send('rows');
        assert(JSON.stringify(s.tables.recovery_releases) === JSON.stringify(onMain.recovery_releases),
            `the releases are M's, every column (${s.tables.recovery_releases.length})`);
        const converged = await standby.send('link-peer', { cap: 50 });
        const links = await standby.send('links');
        assert(converged.created === 0 && links.treasuries.length === 1 && links.treasuries[0].public_key === linked.link.treasuryPubkey
            && links.treasuries[0].balance === 3 && links.rows.length === 1,
            `the boot's convergence makes no second link treasury: one, M's, with its 3 Beans (${JSON.stringify(links).slice(0, 200)})`);
        await standby.send('drop-link-row');
        const refound = await standby.send('link-peer', { cap: 50 });
        const relinked = await standby.send('links');
        assert(refound.created === 0 && relinked.treasuries.length === 1 && relinked.rows.length === 1
            && relinked.rows[0].treasury_pubkey === linked.link.treasuryPubkey,
            `a link row lost finds its treasury again, not a second one (${JSON.stringify(relinked).slice(0, 200)})`);
        assert(JSON.stringify(relinked.markers) === JSON.stringify(onMain.federation_link_treasuries.map((r) => ({ treasury_pubkey: r.treasury_pubkey, peer_id: r.peer_id, created_at: r.created_at }))),
            `found by the marker M made with it, which S copied: the only one, unchanged (${JSON.stringify(relinked.markers).slice(0, 200)})`);
        refused.push(...(await standby.send('fetches')).blocked);
        assert(refused.length === 0, `nothing reached off this machine (refused: ${refused.join(', ') || 'none'})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed in ${Math.round((Date.now() - started) / 1000)} s.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ In-flight money and governance are the main server\'s on a standby, and a promoted one carries them on.');
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
