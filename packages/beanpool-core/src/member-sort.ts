/**
 * People → Community: the list's sorts, the same five on the phone and the web app, in the same order and the same words
 * (Marty, 14 Nov 2026: "make them consistent"). One set of word() keys here, so one catalog entry (core's) serves both
 * apps: the phone draws them in apps/native/app/(tabs)/people.tsx, the web in apps/pwa/src/pages/PeoplePage.tsx.
 *
 * Newest (joined most recently first) is the default. Which of them a viewer is offered is each app's to decide from what
 * that viewer may see: the web offers Trusted only to someone whose credit view shows the figure it orders by
 * (apps/pwa/src/lib/member-sort.ts).
 */
import { word, type WordKey } from './words.js';

export type MemberSort = 'newest' | 'name' | 'friends' | 'trusted' | 'active';

/** The sorts in the order the row shows them; the first is the default. */
export const MEMBER_SORTS: readonly MemberSort[] = Object.freeze(['newest', 'name', 'friends', 'trusted', 'active'] as const);

/** Each sort's name on its pill: word() keys, shown through t(). */
export const MEMBER_SORT_WORDS: Readonly<Record<MemberSort, WordKey>> = Object.freeze({
    newest: word('Newest', 'member sort'),
    name: word('Name', 'member sort'),
    friends: word('Friends', 'member sort'),
    trusted: word('Trusted', 'member sort'),
    active: word('Active', 'member sort'),
});
