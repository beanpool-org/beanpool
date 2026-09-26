// One key, one spelling.
//
// A member's key is 32 bytes, and this community keeps it as 64 hexadecimal characters in lower case. Every client
// writes it that way (both apps hex-encode with toString(16)). But a key's MEANING ignores case and the node's hex
// decoder (Buffer.from(…, 'hex')) is forgiving: it reads `AB12…` as `ab12…`, and stops at the first character that is
// not hex, so `ab12…zz` and a 65th character decode to the same 32 bytes. Every lookup on members.public_key is
// case-sensitive, so each of those spellings was a different key here: an unsigned `/api/invite/redeem` naming a
// member's key in capitals made a second member row for it, with a name the caller picked, and the key's holder could
// sign as that spelling and act, and vote, as a second member.
//
// So a key is taken in this one spelling at every door and by every writer of members.public_key:
//  - a key someone NAMES (a body field, a peer's message) is refused unless it is already in that spelling
//    (isMemberKeySpelling): it is never silently lower-cased into someone else's;
//  - a key a request's own signature PROVES (the signature middleware's signer, a redeem signed by the key it names)
//    is taken in that spelling (provenKeySpelling), and anything but 64 hexadecimal characters is refused;
//  - a key named INSIDE what is signed, whose signature is then checked against it (an offline ticket's inviter), or a
//    key a stored row names as someone who acts (an invite code's maker), must already be in that spelling: a row
//    under another spelling acts for nobody.

import { isSyntheticAccount } from '@beanpool/core';
import { isMemberKeySpelling } from '@beanpool/engine';
import { db } from '../db/db.js';

const MEMBER_KEY_ANY_CASE = /^[0-9a-fA-F]{64}$/;

export const BAD_KEY_CODE = 'bad_key';
/** A key named in a request (a body field, a peer's message) that is not in the one spelling. */
export const BAD_KEY_ERROR = 'That key isn’t written the way this community keeps keys: 64 characters, 0-9 and a-f in lower case, with nothing before or after.';
/** The signer's key is not 64 hexadecimal characters (routes/open-join.ts and routes/knocks.ts give the same answer). */
export const BAD_SIGNER_KEY_ERROR = 'The key that signed this request is not a member key: it must be 64 hexadecimal characters.';

/**
 * Whether `key` is a member key in the one spelling this community keeps: 64 characters, 0-9 and a-f in lower case.
 * Kept in the engine, whose offline-ticket check and invite test hold a key named inside a ticket or a code to it too.
 */
export { isMemberKeySpelling };

/**
 * The key a request's own signature proves, in the one spelling: `signer` lower-cased when it is 64 hexadecimal
 * characters in any case, and null for anything else (a prefix, a suffix, a space, too short or too long), which the
 * hex decoder would otherwise have read as some other key. Only for a key the request's signature verified against; a
 * key someone else named is held to isMemberKeySpelling.
 */
export function provenKeySpelling(signer: unknown): string | null {
    return typeof signer === 'string' && MEMBER_KEY_ANY_CASE.test(signer) ? signer.toLowerCase() : null;
}

/** The refusal thrown by a writer handed a key in another spelling: 400 bad_key, before anything is written. */
export function badKeyError(): Error & { status: number; statusCode: number; code: string } {
    return Object.assign(new Error(BAD_KEY_ERROR), { status: 400, statusCode: 400, code: BAD_KEY_CODE });
}

/**
 * Whether `key` may be named as the other side of a send or a conversation: a key in the one spelling, or an account
 * that is no person's and has a row under exactly that id (an enterprise or a Commons project, keyed on its id). A
 * person's row under any other spelling was made by a door before this rule, and nobody can sign as it now
 * (reportMisspeltMemberKeys), so Beans or a message sent to it would reach no one.
 */
export function isNameableAccount(key: unknown): key is string {
    if (isMemberKeySpelling(key)) return true;
    if (typeof key !== 'string' || !key) return false;
    const row = db.prepare('SELECT is_treasury FROM members WHERE public_key = ?').get(key) as { is_treasury: number | null } | undefined;
    return !!row?.is_treasury;
}

/** A person's row whose key is in another spelling (reportMisspeltMemberKeys). */
export interface MisspeltMemberKey {
    publicKey: string;
    callsign: string;
    status: string | null;
    isVisitor: boolean;
    balance: number;
    nodeRole: string | null;
    /** The callsign of the row under the same key in the one spelling, when there is one. */
    sameKeyAs: string | null;
}

/**
 * Every person's row (not an enterprise, a project, or a reserved id such as SYSTEM or the admin inbox's `system`)
 * whose key is not in the one spelling: made before this rule by a door that stored the key it was sent (an invite
 * redeem, an offline ticket, a send or a message to a key with no row, a federation peer). Read only: such a row is a
 * person's data, so nothing is merged or deleted here.
 */
export function findMisspeltMemberKeys(): MisspeltMemberKey[] {
    const rows = db.prepare(`
        SELECT m.public_key, m.callsign, m.status, m.is_visitor,
               (SELECT balance FROM accounts a WHERE a.public_key = m.public_key) AS balance,
               (SELECT role FROM node_roles r WHERE r.member_pubkey = m.public_key) AS node_role,
               (SELECT t.callsign FROM members t WHERE t.public_key = lower(m.public_key) AND t.public_key != m.public_key) AS same_key_as
        FROM members m
        WHERE COALESCE(m.is_treasury, 0) = 0
          AND (length(m.public_key) != 64 OR m.public_key GLOB '*[^0-9a-f]*')
        ORDER BY m.joined_at
    `).all() as any[];
    return rows.filter(r => !isSyntheticAccount(r.public_key)).map(r => ({
        publicKey: r.public_key,
        callsign: r.callsign,
        status: r.status ?? null,
        isVisitor: !!r.is_visitor,
        balance: Number(r.balance ?? 0),
        nodeRole: r.node_role ?? null,
        sameKeyAs: r.same_key_as ?? null,
    }));
}

/**
 * The boot check: logs each person's row whose key is in another spelling, and what an operator should do, and changes
 * nothing. Nobody can sign as such a row any more (the signature middleware takes the signer in the one spelling), so
 * it acts for no one; it still shows in the People list and counts as a member until it is removed. Never throws.
 */
export function reportMisspeltMemberKeys(log: (line: string) => void = line => console.warn(line)): MisspeltMemberKey[] {
    let found: MisspeltMemberKey[];
    try {
        found = findMisspeltMemberKeys();
    } catch (e) {
        console.warn('[MemberKeys] could not check how member keys are written:', (e as Error)?.message || e);
        return [];
    }
    if (found.length === 0) return found;
    log(`⚠️ [MemberKeys] ${found.length} member row(s) have a key written another way than the one this community keeps `
        + '(64 characters, 0-9 and a-f in lower case). A door before this version stored the key as it was sent. '
        + 'Nobody can sign as these rows now, and nothing has been changed:');
    for (const m of found) {
        const shown = m.publicKey.length > 16 ? `${m.publicKey.slice(0, 16)}…` : m.publicKey;
        log(`   - "${m.callsign}" (key ${JSON.stringify(shown)}, ${m.isVisitor ? 'visitor' : 'member'}, ${m.status ?? 'active'}, `
            + `${m.balance} Beans${m.nodeRole ? `, holds the ${m.nodeRole} role` : ''})`
            + (m.sameKeyAs ? ` is the same key as "${m.sameKeyAs}", spelt another way.` : '.'));
    }
    log('   What to do: remove each one in Settings → People → Remove (a closed account keeps its row and its history; '
        + 'Beans it holds go to the Commons pool, as for any removal). Don’t use Re-key or Offboard on these rows: they '
        + 'refuse a key in another spelling. Nothing else is needed: the member whose key it is keeps their own row.');
    return found;
}
