/**
 * `beanpool recover` (node sign-in design, step 4; decision D5): run on the server, it makes a member an owner when every
 * owner's key is gone. It replaces the old documented recovery, deleting data/local-config.json, which also lost the
 * community's name and contacts, 2FA, the gateway settings, the money thresholds, break-glass mode, the backup settings
 * and the replication token. This touches none of them: it writes one node_roles row and nothing else.
 *
 * Whoever can run it already holds the server's shell, and so the database and every file of the node: it hands over
 * no authority the shell did not have. It is never silent: the community is told, in a critical announcement, and the
 * node's log keeps a SECURITY line.
 *
 * Two halves, because the command runs as its own process beside the live node (`docker compose exec`):
 *   - recoverOwner, in the command's process: its own connection to state.db (never db/db.ts, whose import swaps a
 *     standby's staged copy in at boot, which must happen only in the node), the grant, a break-glass code printed once,
 *     and a notice file left in the data dir.
 *   - deliverRecoverNotices, in the node, at boot and every few seconds: each notice becomes the announcement and the
 *     log line, once. A node that is stopped when the command runs announces it when it starts.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { getMember, isVisitorKey } from '@beanpool/engine';
import { generateBreakGlassCode, hashBreakGlassCode } from './break-glass-code.js';

/** node_roles.granted_by for a grant made by this command. */
export const RECOVER_ACTOR = 'server:recover';
const NOTICE_PREFIX = 'recover-notice-';

export function dataDir(): string {
    return process.env.BEANPOOL_DATA_DIR || path.join(process.cwd(), 'data');
}

interface RecoverNotice {
    pubkey: string;
    callsign: string;
    alreadyOwner: boolean;
    at: string;
}

export type RecoverResult =
    | { ok: true; pubkey: string; callsign: string; alreadyOwner: boolean; breakGlassCode: string }
    | { ok: false; reason: string };

/** A member's key (64 hex digits) or @callsign, to the one active member it names. */
function resolveMember(conn: Database.Database, who: string): { pubkey: string } | { reason: string } {
    const text = who.trim();
    if (/^[0-9a-fA-F]{64}$/.test(text)) return { pubkey: text.toLowerCase() };
    const callsign = text.replace(/^@/, '');
    if (!callsign) return { reason: 'Give a member public key (64 hex digits) or @callsign.' };
    // As the unique index reads callsigns (db/db.ts idx_members_callsign_unique): a pruned or migrated row may share one.
    const rows = conn.prepare(`SELECT public_key FROM members WHERE lower(callsign) = lower(?) AND is_visitor = 0
        AND status NOT IN ('migrated', 'pruned')`).all(callsign) as { public_key: string }[];
    if (rows.length === 0) return { reason: `There is no member @${callsign} on this server.` };
    if (rows.length > 1) return { reason: `More than one member is called @${callsign}; give the public key instead.` };
    return { pubkey: rows[0].public_key };
}

/**
 * Makes `who` an owner (the same refusals as a grant from Settings: engine/node-roles.ts grantNodeRole), gives them a
 * fresh break-glass code (a code printed by an earlier run stops working) and leaves a notice for the node.
 */
export function recoverOwner(who: string, dir = dataDir()): RecoverResult {
    const dbPath = path.join(dir, 'state.db');
    if (!fs.existsSync(dbPath)) return { ok: false, reason: `No node database at ${dbPath}. Run this inside the node's container, or set BEANPOOL_DATA_DIR.` };
    const conn = new Database(dbPath, { fileMustExist: true });
    try {
        conn.pragma('busy_timeout = 10000');
        const found = resolveMember(conn, who);
        if ('reason' in found) return { ok: false, reason: found.reason };
        const member = getMember(conn as any, found.pubkey);
        if (!member || isVisitorKey(conn as any, found.pubkey)) return { ok: false, reason: 'There is no member with that key on this server. They must join first (an invite), then run this again.' };
        if (member.callsign?.toUpperCase() === 'SYSTEM') return { ok: false, reason: 'The SYSTEM account cannot hold a node role.' };
        if (member.isTreasury) return { ok: false, reason: 'A treasury account cannot hold a node role.' };
        if (member.status !== 'active') return { ok: false, reason: `Only an active member can be an owner; @${member.callsign} is ${member.status}.` };

        const code = generateBreakGlassCode();
        const hash = hashBreakGlassCode(code);
        const alreadyOwner = conn.transaction(() => {
            const was = conn.prepare('SELECT role FROM node_roles WHERE member_pubkey = ?').get(found.pubkey) as { role: string } | undefined;
            conn.prepare(`INSERT INTO node_roles (member_pubkey, role, granted_by, break_glass_hash) VALUES (?, 'owner', ?, ?)
                ON CONFLICT(member_pubkey) DO UPDATE SET role = 'owner', break_glass_hash = excluded.break_glass_hash,
                    session_epoch = CASE WHEN node_roles.role = 'owner' THEN node_roles.session_epoch ELSE node_roles.session_epoch + 1 END,
                    granted_by = CASE WHEN node_roles.role = 'owner' THEN node_roles.granted_by ELSE excluded.granted_by END,
                    granted_at = CASE WHEN node_roles.role = 'owner' THEN node_roles.granted_at ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END`)
                .run(found.pubkey, RECOVER_ACTOR, hash);
            // When and from what the code was made, for Settings (#1531), if the node has run since those columns came.
            const cols = (conn.prepare('PRAGMA table_info(node_roles)').all() as { name: string }[]).map(c => c.name);
            if (cols.includes('break_glass_made_at') && cols.includes('break_glass_made_by')) {
                conn.prepare(`UPDATE node_roles SET break_glass_made_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), break_glass_made_by = 'recover'
                    WHERE member_pubkey = ?`).run(found.pubkey);
            }
            // As grantNodeRole does on a role change: the member's row moves, so phones' delta reads carry the new role
            // (the node's own caches follow when it delivers the notice).
            if (was?.role !== 'owner') conn.prepare('UPDATE members SET profile_updated_at = ? WHERE public_key = ?').run(new Date().toISOString(), found.pubkey);
            return was?.role === 'owner';
        // IMMEDIATE: take the write lock at the start, so beside a node that is writing this waits out the busy timeout
        // instead of failing at once with SQLITE_BUSY (a DEFERRED read-then-write can't upgrade in WAL).
        }).immediate();

        const notice: RecoverNotice = { pubkey: found.pubkey, callsign: member.callsign || found.pubkey.slice(0, 8), alreadyOwner, at: new Date().toISOString() };
        const name = `${NOTICE_PREFIX}${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
        const tmp = path.join(dir, `.${name}.tmp`);
        fs.writeFileSync(tmp, JSON.stringify(notice), { mode: 0o600 });
        fs.renameSync(tmp, path.join(dir, name));
        return { ok: true, pubkey: found.pubkey, callsign: notice.callsign, alreadyOwner, breakGlassCode: code };
    } finally {
        conn.close();
    }
}

export interface DeliverDeps {
    announce: (title: string, body: string, severity: 'critical') => void;
    log: (message: string) => void;
    /** The node's caches that follow node_roles (member listings, the take-over inputs). */
    changed?: () => void;
}

/** Each notice the command left: the announcement and the log line, once. Returns how many were delivered. Never throws. */
export function deliverRecoverNotices(deps: DeliverDeps, dir = dataDir()): number {
    let files: string[];
    try {
        files = fs.readdirSync(dir).filter(f => f.startsWith(NOTICE_PREFIX) && f.endsWith('.json')).sort();
    } catch {
        return 0;
    }
    let delivered = 0;
    for (const f of files) {
        const file = path.join(dir, f);
        let notice: RecoverNotice | null = null;
        try {
            notice = JSON.parse(fs.readFileSync(file, 'utf8'));
            // Gone before it is announced: a crash between the two loses one announcement, never repeats one.
            fs.unlinkSync(file);
        } catch (e: any) {
            try { fs.unlinkSync(file); } catch { /* already gone */ }
            deps.log(`[RECOVER] An unreadable notice ${f} from beanpool recover was removed (${e?.message ?? e}); check node_roles for owners granted by ${RECOVER_ACTOR}`);
            continue;
        }
        if (!notice || typeof notice.pubkey !== 'string') continue;
        const who = `@${notice.callsign}`;
        const body = notice.alreadyOwner
            ? `Someone with access to this community's server ran "beanpool recover" and gave ${who}, an owner, a new break-glass code.`
            : `Someone with access to this community's server ran "beanpool recover" and made ${who} an owner of this community.`;
        try {
            deps.changed?.();
            deps.announce('Owner added from the server', body, 'critical');
        } catch { /* the log line below still records it */ }
        deps.log(`[RECOVER] ${body} (pubkey: ${notice.pubkey.slice(0, 12)}…, at ${notice.at})`);
        delivered++;
    }
    return delivered;
}

/** In the node: deliver at boot and every 5 s. Never blocks the boot. */
export function startRecoverNoticeWatch(deps: DeliverDeps): void {
    try { deliverRecoverNotices(deps); } catch { /* never blocks boot */ }
    setInterval(() => { try { deliverRecoverNotices(deps); } catch { /* next tick */ } }, 5_000).unref();
}
