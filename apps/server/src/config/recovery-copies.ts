/**
 * Where members' copies go: the community's rule (vault rethink VR2; scratch/fable-design/DESIGN-vault-rethink-fable.md
 * §5.3, Marty's pick 5, 27 Oct). A copy is a member's key (and 12 words) locked to a sign-in they link, so a sign-in
 * brings the account back on a new phone. Which build an app is decided where it went until now (the phone's
 * utils/vault-config.ts): a build with BeanPool's key vault sent every copy there, whatever community it was used in,
 * and the community had no say. This is its say.
 *
 *   - `vault` (the default, what every build did until now): a member's phone keeps its sign-in copy at BeanPool's key
 *     vault. Nothing on this server ever calls the vault: the phone deposits there, signed by the member's own key.
 *   - `server`: the copies are kept here, under the recovery seal (services/recovery-seal-key.ts), as a phone built
 *     without a vault keeps them: the phone asks this server for the nonce and deposits here, and asks the vault nothing
 *     for it. It still asks the vault, with the member's own key, whether it holds a copy of theirs (the move card offers
 *     to move one here), and moves or removes one there when the member asks. This server never calls the vault.
 *   - `none`: this community keeps no copies and its screens offer none, at the vault or here. Members' 12 words are
 *     their way back here, and an admin can re-key one to a new key.
 *
 * ## What the rule changes, and what it doesn't
 *
 * Only where NEW copies go, from this community's screens. A copy a member already has is theirs: one key is a member of
 * many communities, and a copy made through community A also opens community B, so no community removes it. Changed to
 * `none`, the copies this server already keeps stay until each member removes theirs (the signed delete, which every
 * rule keeps, as it keeps the status, the restore and the recovery sessions). Members are told of a change by the
 * notice How this community works sends (config/community-shape-write.ts), and the phone's card says what it means for
 * theirs.
 *
 * This server holds the rule where it can: under `none` it stores no new copy (the sign-in copy route and its nonce
 * refuse with `no_copies_here`; a join or an added sign-in at the open door still stands, without one), and the open
 * door takes a key vault ticket only under `vault` (routes/open-join.ts), so a phone joining here is never bound to a
 * deposit at the vault. A phone the server can't hold is one that deposits at the vault by itself: an app from before
 * the rule, in a build with a vault, still does wherever it is used. The rule is said in /api/community/info as
 * `recoveryCopies`, which an app from before it ignores.
 *
 * ## What travels
 *
 * A node_config row (`recovery_copies`), one of the community's own settings (config/community-settings.ts): a standby
 * keeps the main server's, and a take-over or a hand promotion installs it. The default is no row, so the record holds
 * only what a community changed and a copy of it installs "none" as the default. Changed only under How this community
 * works, by an owner (config/community-shape-write.ts).
 */
import { word } from '@beanpool/core';
import { db } from '../db/db.js';

export type RecoveryCopies = 'vault' | 'server' | 'none';

export const RECOVERY_COPIES_KEY = 'recovery_copies';
export const DEFAULT_RECOVERY_COPIES: RecoveryCopies = 'vault';
/** Every rule, the default first. */
export const RECOVERY_COPIES_RULES: readonly RecoveryCopies[] = ['vault', 'server', 'none'];

export function isRecoveryCopies(v: unknown): v is RecoveryCopies {
    return v === 'vault' || v === 'server' || v === 'none';
}

let warnedBadRow: string | null = null;

/**
 * A `recovery_copies` row's value as the rule it sets (null: no row). A row holding anything else reads as the default,
 * what every build did before the rule, and the log says so once: the community's behaviour never becomes something
 * nobody chose.
 */
export function recoveryCopiesFromRow(value: string | null): RecoveryCopies {
    if (value === null || isRecoveryCopies(value)) return value ?? DEFAULT_RECOVERY_COPIES;
    if (warnedBadRow !== value) {
        warnedBadRow = value;
        console.warn(`⚠️  node_config ${RECOVERY_COPIES_KEY}=${JSON.stringify(value)} is not a rule (vault, server or none), so members' copies go to BeanPool's key vault here, the default.`);
    }
    return DEFAULT_RECOVERY_COPIES;
}

/** This community's rule: its row, or the default when there is none. */
export function recoveryCopies(): RecoveryCopies {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(RECOVERY_COPIES_KEY) as { value: string | null } | undefined;
    return recoveryCopiesFromRow(row?.value ?? null);
}

/** Set the rule. The default removes the row, so the record holds only what a community changed. */
export function setRecoveryCopies(rule: RecoveryCopies): void {
    if (!isRecoveryCopies(rule)) throw new Error(`${String(rule)} is not a rule for members' copies`);
    if (rule === DEFAULT_RECOVERY_COPIES) db.prepare('DELETE FROM node_config WHERE key = ?').run(RECOVERY_COPIES_KEY);
    else db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(RECOVERY_COPIES_KEY, rule);
}

/** The code a refusal under `none` carries, which an app reads to say the community's sentence. */
export const NO_COPIES_HERE = 'no_copies_here';
/** What a member reads when this server keeps no copies: nothing was kept, and the words are still the way back. */
export const NO_COPIES_HERE_MESSAGE = word("This community keeps no copies of members' accounts, so nothing was kept here. Your 12 words are your way back here.");

/** Whether this server keeps no new copies (`none`). */
export function keepsNoCopies(): boolean {
    return recoveryCopies() === 'none';
}
