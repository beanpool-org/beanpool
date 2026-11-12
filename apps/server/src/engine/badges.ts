/**
 * Tier badges (Marty, 12 Nov 2026, board card tier-credit-lever, answer A: "tiers badge only"). A tier is recognition: it
 * gives no credit. An owner or admin may give a member a badge (Resident, Steward or Elder) or take it back (Newcomer), and
 * a genesis invite gives its joiner one (engine/invites.ts). Nothing here reads or writes a credit line, a floor or
 * members.earned_credit_c: credit comes only from the known floor, vouches and gifts, and real trades. The tier a member
 * shows is the higher of their badge and what they did (@beanpool/engine trust.ts, core withBadge).
 *
 * Nobody gives themselves a badge (refused in words, as the known floor's `own_floor`). Each change is a line in
 * known_floor_log (action 'badge': who, whom, from, to, when), the log every owner and admin reads, and the member gets a
 * kept notice ("@Ada gave you the Resident badge."), told live and as a push once it has committed (the credit notices'
 * path, engine/credit-notices.ts). A change that changes nothing writes, logs and tells nothing.
 */
import { genesisBadgeFor, tierIndexForName, word, wordsFor, type BadgeTier, type GenesisInviteType, type TierName } from '@beanpool/core';
import { getMember, memberBadge } from '@beanpool/engine';
import { db, deletePlainRows } from '../db/db.js';
import { writeKnownFloorLog } from '../config/known-floor.js';
import { keepNotice } from './kept-notices.js';
import type { TellVoucher, VoucherNotice } from './vouchers.js';
import { broadcast } from '../state-engine.js';

// A sentence with values in it, in English as a template literal wrote it, marked for the words layer (member-words.ts).
const { t: tr } = wordsFor('en');

export const BADGE_WORDS = {
    title: word('Your badge'),
    noCredit: word('A badge is recognition only: it gives no credit.'),
    ownBadge: word('Another owner or admin gives you a badge: nobody gives themselves one.'),
    notMember: word('Only an active member of this community can be given a badge.'),
    badTier: word('Choose a badge: Newcomer, Resident, Steward or Elder.'),
} as const;

const gave = (name: string, tier: BadgeTier) => tr('@{name} gave you the {tier} badge.', { name, tier });
const tookBack = (name: string, tier: BadgeTier) => tr('@{name} took back the {tier} badge.', { name, tier });

export class BadgeError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
    }
}

const TIERS: readonly TierName[] = ['Newcomer', 'Resident', 'Steward', 'Elder'];

/** The badge a member holds now, or 'Newcomer' for none: the log's words for it. */
const shown = (badge: BadgeTier | null): TierName => badge ?? 'Newcomer';

/**
 * Writes the badge (or takes it back for 'Newcomer'), its log line and the member's kept notice, inside the caller's
 * transaction. Returns the notice to tell once it has committed, or undefined when nothing changed.
 */
function writeBadge(actor: string, member: string, tier: TierName): VoucherNotice | undefined {
    const before = memberBadge(db, member);
    const after: BadgeTier | null = tier === 'Newcomer' ? null : tier;
    if (before === after) return undefined;
    if (after) {
        db.prepare(`INSERT INTO member_badges (member_pubkey, tier, set_by, set_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
                    ON CONFLICT(member_pubkey) DO UPDATE SET tier = excluded.tier, set_by = excluded.set_by, set_at = excluded.set_at`)
            .run(member, after, actor);
    } else {
        deletePlainRows('member_badges', 'member_pubkey = ?', member);
    }
    writeKnownFloorLog(actor, 'badge', member, shown(before), shown(after));
    const name = getMember(db, actor)?.callsign ?? '';
    const said = after ? gave(name, after) : tookBack(name, before as BadgeTier);
    const title = BADGE_WORDS.title;
    const body = `${said} ${BADGE_WORDS.noCredit}`;
    const data = { kind: 'badge', by: actor, tier: shown(after), from: shown(before) };
    return { to: member, title, body, data, id: keepNotice(member, title, body, data) };
}

/**
 * An owner's or admin's badge for a member: `tier` 'Resident', 'Steward' or 'Elder' gives it, 'Newcomer' takes the badge
 * back. Only for an active member (never an enterprise: its tier is its line's), and never the actor's own. Once it has
 * committed every app is told the member changed (profile_updated) and the member by `tell`. Returns the member's badge now.
 */
export function setMemberBadge(actor: string, member: string, tier: unknown, tell?: TellVoucher): { memberPubkey: string; badge: TierName; changed: boolean } {
    if (typeof tier !== 'string' || !TIERS.includes(tier as TierName)) throw new BadgeError(400, 'bad_tier', BADGE_WORDS.badTier);
    const m = getMember(db, member);
    if (!m || (m.status ?? 'active') !== 'active' || m.isTreasury) throw new BadgeError(404, 'not_member', BADGE_WORDS.notMember);
    if (actor === member) throw new BadgeError(403, 'own_badge', BADGE_WORDS.ownBadge);
    const notice = db.transaction(() => writeBadge(actor, member, tier as TierName))();
    if (notice) {
        // Every member's app re-reads them: the tier their cards and profile show has changed.
        broadcast({ type: 'profile_updated', publicKey: member });
        if (tell) {
            try { tell(notice); } catch (e) { console.warn('[Badges] A notice failed:', (e as Error)?.message || e); }
        }
    }
    return { memberPubkey: member, badge: shown(memberBadge(db, member)), changed: !!notice };
}

/**
 * A genesis invite's badge for its joiner (engine/invites.ts, inside the join's transaction): recognition only, no credit.
 * Given in the name of whoever made the invite; the joiner's kept notice is their record of it (a member this new has no
 * socket open and no push token yet). A standard invite gives none.
 */
export function giveGenesisBadge(inviteMaker: string, joiner: string, type: GenesisInviteType): BadgeTier | null {
    const badge = genesisBadgeFor(type);
    if (!badge || tierIndexForName(badge) <= 0 || inviteMaker === joiner) return null;
    writeBadge(inviteMaker, joiner, badge);
    return badge;
}
