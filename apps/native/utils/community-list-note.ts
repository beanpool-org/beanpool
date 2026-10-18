/**
 * The line above People → Community on a community that says `membersOnDemand` (DESIGN-global-members-by-area §2.3),
 * and what the list says when it is empty. Never "Loading" for a list that will not load: with no area there is nothing
 * near to show, and offline the cards held are what there is. One letter typed asks the node nothing (a search is 2 or
 * more): the cards held, with the words for that ('short'), never the offline ones while the phone is online.
 */
import { formatDate, t, tn } from '@beanpool/core';

export type CommunityListNote = 'near' | 'search' | 'noArea' | 'held' | 'short' | 'spent' | 'spentNear';

export function communityListNote(note: CommunityListNote, typed: string): string {
    switch (note) {
        case 'near': return t('Near you: the 50 closest members. Search a name to find anyone else.');
        case 'search': return t('Members whose name starts with “{typed}”.', { typed: typed.trim() });
        case 'noArea': return t("Set your area to see who's near you. Search a name to find anyone.");
        case 'held': return t("People you've dealt with. Connect to search everyone.");
        case 'short': return t("People you've dealt with. Type at least 2 letters to search everyone.");
        // The node's day budget (where anyone can join): online, so never "Connect".
        case 'spent': return t("People you've dealt with. You've looked people up as often as one account can today. Try again later.");
        // Only "near you" is spent: a search by name still works, as the node's own refusal says.
        case 'spentNear': return t("People you've dealt with. You've looked up who's near you as often as one account can today. Search a name to find anyone.");
    }
}

/**
 * The New message picker on a community that says `membersOnDemand`: its list is the cards held (recents, friends, the
 * people this member has dealt with) plus what the node answered a search of 2 letters or more. `node` is what became of
 * that search: 'none' (nothing asked), 'answered', or 'unreachable' (offline, busy, refused). Never "sync to populate":
 * no sync fills a directory here.
 */
export function pickerHeading(typed: string): string {
    return typed.trim() ? t('🔍 Results') : t("People you've dealt with");
}

export function pickerEmpty(typed: string, node: 'none' | 'answered' | 'unreachable'): { title: string; subtitle: string } {
    const q = typed.trim();
    if (q === '') return { title: t('No one here yet'), subtitle: t('Type 2 letters of a name to find anyone in the community.') };
    if (q.length < 2) return { title: t('No one you have dealt with matches'), subtitle: t('Type at least 2 letters of a name to search everyone.') };
    if (node === 'unreachable') return { title: t('No one you have dealt with matches'), subtitle: t('Connect to search everyone.') };
    return { title: t('No members match your search'), subtitle: t('Try a different name.') };
}

export function communityListEmpty(note: CommunityListNote | null, typed: string): string {
    if (note === 'search') return t('No members match your search.');
    if (note === 'near') return t('No one near you yet.');
    if (note === 'noArea') return t('Type at least 2 letters of a name.');
    if (note === 'held') return typed.trim() ? t('No one you have dealt with matches. Connect to search everyone.') : t('No one yet. Connect to search everyone.');
    if (note === 'short') return t('No one you have dealt with matches. Type at least 2 letters to search everyone.');
    if (note === 'spent') return t('No one you have dealt with matches. Try the search again later.');
    if (note === 'spentNear') return t('No one you have dealt with yet. Search a name to find anyone.');
    return typed ? t('No members match your search.') : t('Loading community...');
}

/**
 * A member row's second line on People → Community and in the New message picker: when they joined, in the member's
 * language ("Joined today", "Joined 3d ago", "Joined 2w ago", then the date as core writes dates, "Joined 3 Oct 2026").
 */
export function joinedWords(dateStr: string | null | undefined, now: Date = new Date()): string {
    const d = dateStr ? new Date(dateStr) : null;
    if (!d || !Number.isFinite(d.getTime())) return t('Member');
    const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
    if (diffDays < 1) return t('Joined today');
    // English writes one form for both; a language with more forms has them.
    if (diffDays < 7) return tn(diffDays, 'Joined {n}d ago', 'Joined {n}d ago');
    if (diffDays < 30) return tn(Math.floor(diffDays / 7), 'Joined {n}w ago', 'Joined {n}w ago');
    return t('Joined {date}', { date: formatDate(d, 'day-month-year') });
}
