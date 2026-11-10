/**
 * What a member reads on each invite they have made (People → Invites, on the phone and on the web; DESIGN-invites-vouching-
 * review-fable.md §3 asks 3 and 5, slice I1). One place for the words, so the two apps say the same thing:
 *
 *   who it is for   the name sealed in the names list (opened on a phone that holds the list's keys), else the note the maker
 *                   typed ("For: CJ"), else the code; "Name on the phone" where a name needs the list's key and this is the web
 *   what it carries "200 vouch · voucher budget 1,000 · confirms them as known", or "Plain invite" when it carries nothing
 *   how long        "23 days left", red at 3 or fewer
 *
 * Why (Marty, 10 Nov, Byron): the card after Generate said only "Share this cryptographic code" and Pending showed a bare
 * code, so a second, plain invite was made beside the bound one for the same person.
 *
 * Nothing here reads the node or the names list: the caller passes the name it opened, if it opened one. A code made for a
 * request to join (`forKnock`) keeps the applicant's key in its note, so that note is never shown as a name.
 */
import { t, tn, formatCount } from './words.js';

/** How long an invite works. `checkInvite` (engine) refuses an older one, the hourly prune deletes it, and `expiresAt` is made from this. */
export const INVITE_LIFE_DAYS = 30;
export const INVITE_LIFE_MS = INVITE_LIFE_DAYS * 24 * 60 * 60 * 1000;

/** At or under this many days left, the time is drawn red. */
export const INVITE_URGENT_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** An invite as `GET /api/invite/mine/:publicKey` gives it to its maker, or as the phone keeps it (an offline ticket has none of the node's fields). */
export interface InviteRowSource {
    code: string;
    createdAt: string;
    usedBy?: string | null;
    usedAt?: string | null;
    /** The maker's note, clear text on the node. Where `forKnock`, it is the applicant's key. */
    intendedFor?: string | null;
    namesEntryId?: string | null;
    vouchAmount?: number | null;
    voucherLevel?: number | null;
    expiresAt?: string | null;
    forKnock?: boolean;
    /** The callsign of whoever joined with it, once used. */
    usedByCallsign?: string | null;
}

/** When the invite stops working: the node's `expiresAt`, else 30 days after it was made (an offline ticket). NaN when neither is a date. */
export function inviteExpiryMs(inv: Pick<InviteRowSource, 'createdAt' | 'expiresAt'>): number {
    const said = inv.expiresAt ? Date.parse(inv.expiresAt) : NaN;
    return Number.isFinite(said) ? said : Date.parse(inv.createdAt) + INVITE_LIFE_MS;
}

/** Whether it is past its 30 days: it joins nobody, and the node deletes it within the hour. */
export function inviteLapsed(inv: Pick<InviteRowSource, 'createdAt' | 'expiresAt'>, now: number): boolean {
    const end = inviteExpiryMs(inv);
    return Number.isFinite(end) && end <= now;
}

/** Codes nobody has used and that still work: what "Pending" counts. */
export function pendingInvites<T extends InviteRowSource>(all: readonly T[], now: number): T[] {
    return all.filter((i) => !i.usedBy && !inviteLapsed(i, now));
}

/** Codes someone joined with, newest first: what "Joined" counts. */
export function joinedInvites<T extends InviteRowSource>(all: readonly T[]): T[] {
    return all.filter((i) => !!i.usedBy).sort((a, b) => Date.parse(b.usedAt ?? '') - Date.parse(a.usedAt ?? '') || 0);
}

export interface InviteWhoOptions {
    /** The name opened from the names list for this invite's entry (on a phone that holds the keys); undefined when not opened. */
    name?: string | null;
    /** True where a name can't be opened at all (the web app holds no list key): a bound invite then says the name is on the phone. */
    nameOnPhone?: boolean;
}

/** Who the invite is for, in one line. */
export function inviteWho(inv: InviteRowSource, o: InviteWhoOptions = {}): string {
    const name = o.name?.trim();
    if (inv.namesEntryId && name) return name;
    if (inv.namesEntryId && o.nameOnPhone) return t('Name on the phone');
    if (inv.forKnock) return t('For someone who asked to join');
    const note = inv.intendedFor?.trim();
    if (note) return t('For: {name}', { name: note });
    return inv.code;
}

/** What the invite carries, in one line: "200 vouch · voucher budget 1,000 · confirms them as known". */
export function inviteCarries(inv: InviteRowSource): string {
    const parts: string[] = [];
    if (inv.vouchAmount) parts.push(t('{amount} vouch', { amount: formatCount(inv.vouchAmount) }));
    if (inv.voucherLevel) parts.push(t('voucher budget {amount}', { amount: formatCount(inv.voucherLevel) }));
    if (inv.namesEntryId) parts.push(t('confirms them as known'));
    return parts.length ? parts.join(' · ') : t('Plain invite');
}

/** "23 days left", and whether it is time to draw it red; null when the invite has no readable date. */
export function inviteTimeLeft(inv: Pick<InviteRowSource, 'createdAt' | 'expiresAt'>, now: number): { text: string; urgent: boolean } | null {
    const end = inviteExpiryMs(inv);
    if (!Number.isFinite(end)) return null;
    const days = Math.max(1, Math.ceil((end - now) / DAY_MS));
    return {
        text: t('{time} left', { time: tn(days, '{n} day', '{n} days', { n: formatCount(days) }) }),
        urgent: days <= INVITE_URGENT_DAYS,
    };
}

/** The made card's one line, after Generate: "Invite for Sam". */
export function inviteMadeTitle(who: string | null | undefined): string {
    const name = who?.trim();
    return name ? t('Invite for {name}', { name }) : t('Invite made');
}

/**
 * Revoke's confirm (invites-vouching I2, DESIGN §3 ask 3): "Revoke this invite? Whoever has the link can't use it. Dee Dee's
 * name stays on the names list, not confirmed." The names-list sentence only for an invite bound to an entry; its name where
 * this device opened it, else "The name" (the web, which holds no list key).
 */
export function inviteRevokeAsk(inv: Pick<InviteRowSource, 'namesEntryId'>, name?: string | null): { title: string; body: string } {
    const who = name?.trim();
    const body = !inv.namesEntryId
        ? t('Whoever has the link can’t use it.')
        : who
            ? t('Whoever has the link can’t use it. {name}’s name stays on the names list, not confirmed.', { name: who })
            : t('Whoever has the link can’t use it. The name stays on the names list, not confirmed.');
    return { title: t('Revoke this invite?'), body };
}

/** The words on Revoke's buttons and its outcome. */
export const inviteRevokeWords = {
    revoke: (): string => t('Revoke'),
    cancel: (): string => t('Cancel'),
    revoking: (): string => t('Revoking…'),
    failed: (): string => t('Couldn’t revoke this invite. Check your connection and try again.'),
};

/**
 * Whether Revoke is offered on an invite: one the community holds (a code it made), unused. An offline ticket (`BP-…`) is
 * made on the phone and first reaches the community when someone joins with it, so the community has nothing to revoke.
 */
export function inviteRevocable(inv: Pick<InviteRowSource, 'code' | 'usedBy'>): boolean {
    return !inv.usedBy && !inv.code.startsWith('BP-');
}

/**
 * A names-list entry's line while an invite for it is out (invites-vouching I2): "Invite out by @marty · 23 days left".
 * Null once it is used or past its 30 days. `maker` is the callsign, without the @.
 */
export function inviteOutLine(inv: Pick<InviteRowSource, 'createdAt' | 'expiresAt' | 'usedBy'>, maker: string | null | undefined, now: number): string | null {
    if (inv.usedBy || inviteLapsed(inv, now)) return null;
    const left = inviteTimeLeft(inv, now);
    const by = maker?.trim() ? t('Invite out by @{callsign}', { callsign: maker.trim() }) : t('Invite out');
    return left ? `${by} · ${left.text}` : by;
}

/** A folded section's heading: "Pending (3)", "Joined (2)". */
export const pendingHeading = (count: number): string => t('Pending ({count})', { count: formatCount(count) });
export const joinedHeading = (count: number): string => t('Joined ({count})', { count: formatCount(count) });

/**
 * Whether each fold on the page is open, kept for the session (until the app is closed or the page reloaded) and closed at
 * first. Module state: People can unmount and mount again as a member moves about; a fold they opened stays open.
 */
const open = new Map<string, boolean>();
export const inviteFolds = {
    isOpen: (key: string): boolean => open.get(key) === true,
    set: (key: string, value: boolean): void => { open.set(key, value); },
    /** For tests: back to first render. */
    clear: (): void => { open.clear(); },
};
