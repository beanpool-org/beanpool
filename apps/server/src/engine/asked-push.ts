/**
 * "Someone in your community asked for something you're into." (scratch/fable-design/DESIGN-cold-start-trades-fable.md
 * §2.1, §2.3, §2.4; slice N3. Marty, 4 Nov: "All Fable's picks": on by default, at most one a day, starred categories
 * only, said on the What are you into? card, a switch in Settings → Notifications.)
 *
 * When a member posts a Need, the members who starred its category are told, with the push kind `market.asked`. Its words
 * are fixed (@beanpool/core push-notice.ts): no name, no title, no price, no category, so a lock screen anyone reads shows
 * nothing of the asker or the Need. A tap opens the Need through the notice's details, which only the recipient reads
 * (engine/push-notices.ts) and which hold the Need's id and nothing else; the Need shows what it shows any member.
 *
 * Who is told ({@link askedRecipients}), every rule checked here, on this server:
 *  - a member here: `members.status` 'active' (never a suspended, paused, pruned or refused account), not a visitor's row,
 *    not an enterprise's account, and not on holiday;
 *  - who starred the Need's category (their interests, engine/home-preferences.ts), read as the Market reads a category
 *    (core normalizeCategory);
 *  - not its author, nor the member who posted it for an enterprise;
 *  - nobody who has blocked the author or that member, and nobody either of them has blocked (engine/member-blocks.ts);
 *  - with "When a neighbour asks for something I'm into" on (`notify_asked`, on until the member turns it off) and
 *    Marketplace Activity on (`notify_marketplace`, the category the push rides, which the dispatcher reads as well);
 *  - with a phone registered here;
 *  - and told of no other Need in the last {@link ASKED_PUSH_GAP_SECONDS}: at most one a day each.
 *
 * Which Needs ({@link needAsksNeighbours}): one for the whole community (a group's or a direct Need is for those it names,
 * and a push would tell others it exists), made here by a person's own hand (not a copy of a listing from another
 * community, not an owner's assistant: `created_via`), on a community that sends these at all (core askedPushSent: local,
 * Beans on; the global community gets the Asked near you card, not the buzz).
 *
 * The daily cap is a stamp per recipient, kept with their preferences ({@link ASKED_PUSH_STAMP_KEY}, whole seconds),
 * written for everyone chosen in the same transaction that chose them and before anything is sent: two Needs at once
 * never both reach one member, and a send that fails costs that member a push, never adds one. Not a setting: no app can
 * send it (setMemberPreferences refuses any key it doesn't name), nobody is served it, and it goes with the member's other
 * preferences on a re-key or a deletion. Not the notices kept for the recipient (push_notices) either: those are thinned
 * to a member's newest hundred, so a busy chat could have taken the day's mark.
 */
import { askedPushSent, normalizeCategory, pushNoticeWords, type PushNoticeKind } from '@beanpool/core';
import { db } from '../db/db.js';
import { getNodeProfile, getProfileSwitches } from '../config/node-profile.js';
import { getNodeRole } from '../config/node-role.js';
import { readStoredInterests } from './home-preferences.js';
import { blockersOf, hasBlocked } from './member-blocks.js';

/** The member's switch for this push (Settings → Notifications): on unless they turned it off. */
export const ASKED_PUSH_PREF = 'notify_asked';
/** When this member was last told of a neighbour's Need, in whole seconds: the daily cap. Written here alone. */
export const ASKED_PUSH_STAMP_KEY = 'asked_push.sentAt';
/** At most one `market.asked` a member in this long. */
export const ASKED_PUSH_GAP_SECONDS = 24 * 60 * 60;

type PushFn = (
    targetPubkeys: string[], actorPubkey: string, title: string, body: string, data: Record<string, any>,
    categoryId: 'marketplace', kind: PushNoticeKind,
) => number;

/** What of a new post decides whether it asks the neighbours. */
export interface AskedNeed {
    id: string;
    type: string;
    status?: string | null;
    category?: string | null;
    /** The account it is posted under: a member's, or an enterprise's. */
    author: string;
    /** The member who posted it for an enterprise, when one did. */
    actor?: string | null;
    audienceScope?: string | null;
    /** Copied from a listing in another community (engine/event-copy.ts), or a linked community's. */
    copied?: boolean;
    /** `assistant:<grant id>`: an owner's assistant made it. */
    createdVia?: string | null;
}

/** Whether this new post is a Need that tells the neighbours who starred its category (the module's header). */
export function needAsksNeighbours(need: AskedNeed): boolean {
    if (need.type !== 'need' || (need.status != null && need.status !== 'active')) return false;
    if ((need.audienceScope ?? 'public') !== 'public') return false;
    if (need.copied || (typeof need.createdVia === 'string' && need.createdVia !== '')) return false;
    return askedPushSent(getNodeProfile(), getProfileSwitches().beans);
}

/**
 * The members to tell of this Need, with nothing stamped and nothing sent (the module's header). Reads only.
 * `now`: whole seconds.
 */
export function askedRecipients(need: AskedNeed, now: number = Math.floor(Date.now() / 1000)): string[] {
    const category = normalizeCategory(need.category);
    const rows = db.prepare(`
        SELECT mp.public_key AS pk, mp.pref_value AS interests
        FROM member_preferences mp
        JOIN members m ON m.public_key = mp.public_key
        WHERE mp.pref_key = 'interests' AND mp.pref_value LIKE ?
          AND m.status = 'active' AND COALESCE(m.is_visitor, 0) = 0 AND COALESCE(m.is_treasury, 0) = 0
          AND EXISTS (SELECT 1 FROM push_tokens pt WHERE pt.public_key = mp.public_key)
          AND NOT EXISTS (SELECT 1 FROM member_preferences off WHERE off.public_key = mp.public_key
                          AND off.pref_key IN (?, 'notify_marketplace') AND off.pref_value = 'false')
          AND NOT EXISTS (SELECT 1 FROM member_preferences away WHERE away.public_key = mp.public_key
                          AND away.pref_key = 'holiday_mode' AND away.pref_value = 'true')
          AND NOT EXISTS (SELECT 1 FROM member_preferences told WHERE told.public_key = mp.public_key
                          AND told.pref_key = ? AND CAST(told.pref_value AS INTEGER) > ?)
    `).all(`%"${category}"%`, ASKED_PUSH_PREF, ASKED_PUSH_STAMP_KEY, now - ASKED_PUSH_GAP_SECONDS) as { pk: string; interests: string }[];
    if (rows.length === 0) return [];
    const posters = [...new Set([need.author, need.actor].filter((k): k is string => typeof k === 'string' && k !== ''))];
    const blockers = new Set(posters.flatMap(k => [...blockersOf(k)]));
    return rows
        .filter(r => !posters.includes(r.pk) && !blockers.has(r.pk) && !posters.some(p => hasBlocked(p, r.pk)))
        .filter(r => readStoredInterests(r.interests)?.includes(category) === true)
        .map(r => r.pk);
}

/**
 * Tells the members who starred this new Need's category (the module's header): chooses them and stamps each in one
 * transaction, then hands them to the dispatcher. Answers how many were chosen. A standby sends nothing and stamps nothing.
 * Never throws: a Need is posted whatever happens here.
 */
export function noticeNeedAsked(need: AskedNeed, push: PushFn, now: number = Math.floor(Date.now() / 1000)): number {
    try {
        if (getNodeRole() === 'backup' || !needAsksNeighbours(need)) return 0;
        const stamp = db.prepare('INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, ?, ?)');
        const chosen = db.transaction(() => {
            const pks = askedRecipients(need, now);
            for (const pk of pks) stamp.run(pk, ASKED_PUSH_STAMP_KEY, String(now));
            return pks;
        })();
        if (chosen.length === 0) return 0;
        const { title, body } = pushNoticeWords('market.asked');
        // The details hold where a tap lands and nothing else: no name, no title, no price.
        push(chosen, need.actor || need.author, title, body, { screen: 'post', postId: need.id }, 'marketplace', 'market.asked');
        // A count only: who was told stays out of the log.
        console.log(`[Push] A new Need told ${chosen.length} member(s) who starred its category`);
        return chosen.length;
    } catch (e: any) {
        console.warn('[Push] Could not tell the neighbours of a new Need:', e?.message || e);
        return 0;
    }
}
