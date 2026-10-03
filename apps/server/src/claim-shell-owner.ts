/**
 * `beanpool claim --key <64-hex> --callsign <name>`: the claim with no phone and no HTTP, for the day the node's claim
 * route is out of reach or flooded. The key joins (as the HTTP claim's joiner does, claim-code.ts claimNode, invite code
 * `claim:<id>`) and becomes the owner, granted by `claim:<id>`, in one transaction on the command's own connection
 * (never db/db.ts: recover-command.ts says why). It prints the owner's break-glass code once.
 *
 * The burn, as the HTTP claim's: the claim file is deleted here; the owner row closes every claim at once (each claim
 * path asks the database first, claim-code.ts nodeHasOwner); and the node, which alone writes local-config.json, deletes
 * K and the salt, writes the SECURITY line and tells the community when it takes the notice this leaves
 * (recover-command.ts deliverRecoverNotices, claim-code.ts burnClaimFromShell).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { getMember, isInvalidatedKey, isMemberKeySpelling, isVisitorKey } from '@beanpool/engine';
import { generateBreakGlassCode, hashBreakGlassCode } from './break-glass-code.js';
import type { ClaimIo } from './claim-command.js';

export async function claimFromShell(rawKey: string, rawCallsign: string, claimId: string, io: ClaimIo, dir: string): Promise<number> {
    const key = String(rawKey).trim();
    const callsign = String(rawCallsign).trim().replace(/^@/, '');
    if (!isMemberKeySpelling(key)) { io.err('Nothing was changed. --key takes a member public key: 64 lower-case hex digits (the phone shows it in Settings).'); return 1; }
    if (callsign.length < 2 || callsign.length > 20 || callsign.toUpperCase() === 'SYSTEM') { io.err('Nothing was changed. --callsign takes a name of 2–20 characters.'); return 1; }
    const conn = new Database(path.join(dir, 'state.db'), { fileMustExist: true });
    let code = '';
    try {
        conn.pragma('busy_timeout = 10000');
        if (isInvalidatedKey(conn as any, key)) { io.err('Nothing was changed. That key was replaced by a new one.'); return 1; }
        const refusal = conn.transaction((): string | null => {
            // As engine/node-roles.ts nodeHasOwner: the database says whether the claim is still open.
            const owned = conn.prepare(`SELECT 1 FROM node_roles nr JOIN members m ON nr.member_pubkey = m.public_key
                WHERE nr.role = 'owner' AND m.status = 'active' UNION ALL SELECT 1 FROM suspended_node_roles WHERE role = 'owner' LIMIT 1`).get();
            if (owned) return 'This community already has an owner. Use beanpool recover.';
            if (conn.prepare('SELECT 1 FROM node_roles WHERE member_pubkey = ?').get(key)) return 'That key already holds a role here.';
            const member = getMember(conn as any, key);
            const visitor = !!member && isVisitorKey(conn as any, key);
            if (member && !visitor && member.status !== 'active') return `That key's account here is ${member.status}.`;
            const clash = conn.prepare(`SELECT 1 FROM members WHERE lower(callsign) = lower(?) AND public_key != ?
                AND status NOT IN ('migrated', 'pruned')`).get(callsign, key);
            if (clash) return `The callsign @${callsign} is in use here. Pick another.`;
            const now = new Date().toISOString();
            if (!member) {
                conn.prepare('INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code) VALUES (?, ?, ?, NULL, ?)').run(key, callsign, now, `claim:${claimId}`);
                conn.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(key);
            } else if (visitor) {
                conn.prepare('UPDATE members SET is_visitor = 0, home_node_url = NULL, invited_by = NULL, invite_code = ?, callsign = ?, joined_at = ? WHERE public_key = ?')
                    .run(`claim:${claimId}`, callsign, now, key);
            }
            code = generateBreakGlassCode();
            conn.prepare(`INSERT INTO node_roles (member_pubkey, role, granted_by, break_glass_hash) VALUES (?, 'owner', ?, ?)`).run(key, `claim:${claimId}`, hashBreakGlassCode(code));
            conn.prepare('UPDATE members SET profile_updated_at = ? WHERE public_key = ?').run(now, key);
            return null;
        }).immediate();
        if (refusal) { io.err(`Nothing was changed. ${refusal}`); return 1; }
    } finally {
        conn.close();
    }
    try { fs.unlinkSync(path.join(dir, 'claim-code.txt')); } catch { /* gone already */ }
    const notice = { pubkey: key, callsign, alreadyOwner: false, at: new Date().toISOString(), claimId };
    const name = `recover-notice-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
    const tmp = path.join(dir, `.${name}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(notice), { mode: 0o600 });
    fs.renameSync(tmp, path.join(dir, name));
    io.out(`@${callsign} is now the owner of this community. The claim code is used up.`);
    io.out(`\nTheir break-glass code (shown once, give it only to them): ${code}`);
    io.out('\nThe community will see a notice that its owner was set from the server.');
    return 0;
}
