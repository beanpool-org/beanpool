/**
 * A re-keyed member's succession statements (group chats, scratch/global-node/DESIGN-group-chat-line-display-fable.md §5,
 * Marty's picks of 11 Oct 2026). A re-key replaces a member's key; their old group lines stay signed by the old key, and
 * the node's `invalidated_keys.rekeyed_to` link is only the node's word. So the member's NEW key signs, once, that the old
 * key was theirs (core makeKeySuccession), the node stores it beside the row and serves it with the roster (`formerKeys`),
 * and the apps name an old line by a verified chain, never by the node's link (core walkKeySuccession).
 *
 * The node can neither make nor change a statement: it is signed by the member's current key over the old key, the new
 * key and the date. It is set once and never changed: a re-key's second statement is refused (409), and key-move leaves
 * every `invalidated_keys` row as it is (key-move.ts), so a chain Ana₁ → Ana₂ → Ana₃ stays two rows.
 */
import { db } from '../db/db.js';
import { KEY_SUCCESSION_MAX, verifyKeySuccession, type FormerKey } from '@beanpool/core';
import { bumpMembersVersion } from './versions.js';
import { accountsDeletedAmong } from './message-tombstone.js';

const PUBKEY_HEX = /^[0-9a-f]{64}$/;

export type KeySuccessionAnswer = { status: 201 | 400 | 404 | 409; body: Record<string, unknown> };

/**
 * POST /api/community/me/key-succession `{ oldPubkey, at, sig }`, signed by `signer`, the member's new key: stored only for
 * a completed re-key of `oldPubkey` to `signer` (404 otherwise, the same for every other case so it says nothing about
 * whose key it is), when the statement verifies (400), and only once (409).
 */
export function recordKeySuccession(signer: string, raw: unknown): KeySuccessionAnswer {
    const b = (raw ?? {}) as { oldPubkey?: unknown; at?: unknown; sig?: unknown };
    const oldPubkey = typeof b.oldPubkey === 'string' ? b.oldPubkey.toLowerCase() : '';
    if (!PUBKEY_HEX.test(oldPubkey) || typeof b.at !== 'string' || b.at.length > 40 || !Number.isFinite(Date.parse(b.at))
        || typeof b.sig !== 'string' || b.sig.length > 128) {
        return { status: 400, body: { error: 'Send oldPubkey (64 hex characters), at (the date you sign) and sig (base64).' } };
    }
    const row = db.prepare(`SELECT succession_sig FROM invalidated_keys WHERE public_key = ? AND reason = 'rekeyed' AND rekeyed_to = ?`)
        .get(oldPubkey, signer.toLowerCase()) as { succession_sig: string | null } | undefined;
    if (!row) return { status: 404, body: { error: 'This key has no re-key to the key that signed this.' } };
    if (row.succession_sig !== null) return { status: 409, body: { error: 'This re-key is already confirmed. A confirmation is never changed.' } };
    const statement: FormerKey = { pubkey: oldPubkey, at: b.at, sig: b.sig };
    if (!verifyKeySuccession(statement, signer.toLowerCase())) {
        return { status: 400, body: { error: 'The signature does not verify: it must be your current key\'s, over this old key and this date.' } };
    }
    const now = new Date().toISOString();
    const changed = db.prepare(`UPDATE invalidated_keys SET succession_sig = ?, succession_at = ?, succession_stored_at = ?
                                WHERE public_key = ? AND succession_sig IS NULL`).run(b.sig, b.at, now, oldPubkey).changes;
    if (changed !== 1) return { status: 409, body: { error: 'This re-key is already confirmed. A confirmation is never changed.' } };
    // The rosters serve the chain (formerKeysOf): their snapshots are keyed on the members' version.
    bumpMembersVersion();
    return { status: 201, body: { success: true, oldPubkey, at: b.at } };
}

/**
 * The keys a completed re-key replaced with `pubkey`, newest first (GET /api/community/me `rekeyedFrom`): each with the
 * date the node stamped it, and whether this key has signed its statement. An app asks its member to confirm an
 * unattested one at sign-in (§6's prompt): an admin-path re-key, or one an older app completed.
 */
export function rekeyedFromOf(pubkey: string): { pubkey: string; at: string; attested: boolean }[] {
    const rows = db.prepare(`SELECT public_key, invalidated_at, succession_sig FROM invalidated_keys
                             WHERE reason = 'rekeyed' AND rekeyed_to = ? ORDER BY invalidated_at DESC`).all(pubkey.toLowerCase()) as any[];
    return rows.map((r) => ({ pubkey: r.public_key, at: r.invalidated_at, attested: r.succession_sig !== null }));
}

/**
 * Every member's served chain of former keys, read once (a roster names many members): from each key back through
 * `rekeyed_to`, attested rows only, newest first, at most KEY_SUCCESSION_MAX. The walk stops at the first row with no
 * statement: a chain broken there could not be followed past it by any app (core walkKeySuccession).
 */
export function formerKeysReader(): (memberPubkey: string) => FormerKey[] {
    const rows = db.prepare(`SELECT public_key, rekeyed_to, succession_at, succession_sig FROM invalidated_keys
                             WHERE reason = 'rekeyed' AND rekeyed_to IS NOT NULL ORDER BY invalidated_at DESC`).all() as any[];
    const bySuccessor = new Map<string, any>();
    for (const r of rows) if (!bySuccessor.has(r.rekeyed_to)) bySuccessor.set(r.rekeyed_to, r);
    return (memberPubkey: string) => {
        const chain: FormerKey[] = [];
        const seen = new Set<string>([memberPubkey]);
        let successor = memberPubkey;
        while (chain.length < KEY_SUCCESSION_MAX) {
            const r = bySuccessor.get(successor);
            if (!r || r.succession_sig === null || seen.has(r.public_key)) break;
            chain.push({ pubkey: r.public_key, at: r.succession_at, sig: r.succession_sig });
            seen.add(r.public_key);
            successor = r.public_key;
        }
        return chain;
    };
}

/**
 * Each statement's verdict, by everything its signature covers: a member's DM list is read on every sync. Keyed as JSON,
 * never joined with a separator: `at` holds colons, so a row with `at` cut at one and the rest moved onto `sig` would
 * join to a verified statement's key and be served from here unchecked (#1871 review NB2).
 */
const verdicts = new Map<string, boolean>();
const VERDICTS_MAX = 4096;
function statementVerifies(former: FormerKey, successor: string): boolean {
    const key = JSON.stringify([successor, former.pubkey, former.at, former.sig]);
    let ok = verdicts.get(key);
    if (ok === undefined) {
        ok = verifyKeySuccession(former, successor);
        if (verdicts.size >= VERDICTS_MAX) verdicts.clear();
        verdicts.set(key, ok);
    }
    return ok;
}

/**
 * formerKeysReader's chains with every link checked as it is served: the first statement that does not verify against
 * the key after it is dropped with every older one, where core walkKeySuccession would stop too. The node checks a
 * statement when it takes it (recordKeySuccession), but a standby's copy takes them by merge unchecked (key-move.ts).
 */
export function verifiedFormerKeysReader(): (memberPubkey: string) => FormerKey[] {
    const formerKeysOf = formerKeysReader();
    return (memberPubkey: string) => {
        const chain = formerKeysOf(memberPubkey);
        let successor = memberPubkey;
        for (let i = 0; i < chain.length; i++) {
            if (!statementVerifies(chain[i], successor)) return chain.slice(0, i);
            successor = chain[i].pubkey;
        }
        return chain;
    };
}

/**
 * A DM names its people's former keys (DESIGN-dm-peer-key-pin-fable.md §3.3, §5 slice 3, P11): `formerKeys`, by
 * participant, each the chain of signed statements the node holds from their re-keys, newest first, with the date each
 * statement signed. A phone that pinned Ben₁ and is now told the DM is with Ben₂ words its banner with that date ("the
 * account was re-keyed on 3 Oct"), after verifying the chain itself; the pin never moves on it.
 *
 * Only on a DM, only to `viewer` when they are in it, and only for a participant with a chain: a DM in which nobody has
 * re-keyed is served exactly as before, and an app from before the field reads past it.
 *
 * Never for a participant who deleted their account (#1871 review NB4): the deletion takes these keys out of the logs and
 * push notices (state-engine.ts purgeMemberSelf), no phone can seal to that account again, and its `invalidated_keys`
 * rows stay only so the old keys are still refused.
 */
export function withDmFormerKeys<T extends { type?: string; participants?: readonly string[] }>(
    conversations: T[], viewer: string | undefined,
): (T & { formerKeys?: Record<string, FormerKey[]> })[] {
    if (!viewer) return conversations;
    let formerKeysOf: ((memberPubkey: string) => FormerKey[]) | null = null;
    const chains = conversations.map((c) => {
        if (c.type !== 'dm' || !Array.isArray(c.participants) || !c.participants.includes(viewer)) return [];
        formerKeysOf ??= verifiedFormerKeysReader();
        const of = formerKeysOf;
        return c.participants.map((p) => [p, of(p)] as const).filter(([, chain]) => chain.length > 0);
    });
    const named = chains.flatMap((ps) => ps.map(([p]) => p));
    if (named.length === 0) return conversations;
    const deleted = new Set(accountsDeletedAmong(named));
    return conversations.map((c, i) => {
        const kept = chains[i].filter(([p]) => !deleted.has(p));
        return kept.length > 0 ? { ...c, formerKeys: Object.fromEntries(kept) } : c;
    });
}
