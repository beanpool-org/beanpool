/**
 * "Invited by" on a member's profile, one set of words for the phone and the web (scratch/fable-design/
 * DESIGN-invites-vouching-review-fable.md §3 ask 2, slice I3; Marty, 10 Nov 2026: every member sees who invited whom, with
 * the inviter's role word, and a member can switch it off for other members in Settings → Privacy).
 *
 * The server's trust profile (POST /api/trust/profile, state-engine.ts resolveVouchedInBy) says who:
 *  - `member`: a member of this community, named, with their role here now (`owner`, `admin` or none);
 *  - `founder`: the member the community began with;
 *  - `card`: a seed invite made with the owners' password, so no one person is named.
 * It leaves the line out (null) for a plain member when the member switched it off, and everywhere invites are off.
 *
 * There is no "invited by the system admin" any more: an owner or admin who invites someone is named like anyone else.
 */
import { t, tn } from './words.js';

export interface InvitedBy {
    kind: 'member' | 'founder' | 'card';
    publicKey: string | null;
    callsign: string | null;
    avatarUrl: string | null;
    tier: string | null;
    role?: 'owner' | 'admin' | null;
}

/** The inviter line's two lines: `title` names who, `sub` says what it means (null where the title says it all). */
export interface InvitedByLines {
    title: string;
    sub: string | null;
}

/**
 * The words for the inviter line. `self`: the member is reading their own profile ("You were invited by @Olive · owner").
 * `tierWords` is the inviter's level in the reader's words (the apps' own tier names), shown under a member inviter.
 */
export function invitedByLines(by: InvitedBy, self: boolean, tierWords?: (tier: string | null) => string): InvitedByLines {
    if (by.kind === 'founder') {
        return { title: t('Founding member'), sub: t('Here since the community began') };
    }
    if (by.kind === 'card') {
        return {
            title: self ? t('You were invited with an owner’s invite card') : t('Invited with an owner’s invite card'),
            sub: t('An owner of this community made it'),
        };
    }
    const name = by.callsign ?? '';
    const title = by.role === 'owner'
        ? (self ? t('🌱 You were invited by {name} · owner', { name }) : t('🌱 Invited by {name} · owner', { name }))
        : by.role === 'admin'
            ? (self ? t('🌱 You were invited by {name} · admin', { name }) : t('🌱 Invited by {name} · admin', { name }))
            : (self ? t('🌱 You were invited by {name}', { name }) : t('🌱 Invited by {name}', { name }));
    const sub = tierWords ? t('{tier} tier · tap to reach out', { tier: tierWords(by.tier) }) : null;
    return { title, sub };
}

/** "Brought in 3 people ›": for an owner or admin on anyone, and for the member on their own profile (the server decides). */
export function broughtInWords(n: number): string {
    return tn(n, 'Brought in {n} person ›', 'Brought in {n} people ›');
}

/** One person in a Brought in list: still a member here, or not. */
export function broughtInStatusWords(status: string | null | undefined): string {
    return status === 'pruned' ? t('No longer a member') : t('Still here');
}

/** The switch in Settings → Privacy, and what it does, the same on both apps. */
export function showInviterSwitchWords(): { label: string; hint: string } {
    return {
        label: t('Show who invited me to other members'),
        hint: t('Owners, admins and the person who invited you always see it.'),
    };
}
