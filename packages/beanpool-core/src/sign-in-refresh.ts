/**
 * Which of a member's sign-ins Account Protection offers to Refresh, on the phone and on the web alike (recovery without a
 * typed name, slice S4: scratch design DESIGN-recovery-no-callsign-fable.md §8; Marty's decision 2 of 9 Nov 2026, his yes
 * of 15 Nov).
 *
 * A community's server finds a member's account from a sign-in alone by the copy's find hash (apps/server/src/engine/
 * recovery-find.ts). A copy made before the find hash has none until its member's first restore heals it, by a scan that
 * goes once live servers count no such copy. The member's own signed `POST /api/recovery/shares/status` says which of
 * their sign-ins' copies have one (`findableSso`, beside `enrolledSso`); Refresh runs the ordinary Connect for one that
 * hasn't, which makes a fresh copy for that sign-in in place of the old one and writes its find hash.
 *
 * Only from the server's own word: a server from before S4 sends no `findableSso`, and then nothing is offered (a guess
 * would offer a Connect to every member of an older server, where it could not make anything findable).
 */
import { word } from './words.js';

/** The words both apps show beside a sign-in to refresh, and after it. Marked here, translated where they are shown. */
export const SIGN_IN_REFRESH_WORDS = {
    /** Under the sign-in, while its copy can't be found from the sign-in alone. */
    line: word("This sign-in's copy was made before your community's server could find your account from a sign-in alone. Refresh it once, so it keeps bringing your account back."),
    /** The button: it runs the ordinary Connect for that sign-in. */
    button: word('Refresh', "a sign-in's copy of your account, so the server can find it"),
    /** Its accessible name, with the sign-in's name. */
    label: word('Refresh your {provider} copy'),
    /** The web, once the sign-in came back and the copy was made again (the phone's Connect sheet says its own). */
    done: word('{provider} is refreshed. Signing in with it brings this account back, with nothing to type.'),
    /** The web, when the community didn't take the fresh copy: the old one stays as it was. */
    failed: word("Couldn't refresh {provider}, so nothing changed. Try again in a minute."),
} as const;

/**
 * The sign-ins whose copy at this community the server can't find from the sign-in alone yet: in `enrolledSso` and not in
 * `findableSso` of the status answer, each once, in the server's order. Empty for anything but a status answer that has
 * both lists (an older server, no answer, a proxy's page).
 */
export function signInsToRefresh(status: unknown): string[] {
    if (!status || typeof status !== 'object') return [];
    const { enrolledSso, findableSso } = status as { enrolledSso?: unknown; findableSso?: unknown };
    if (!Array.isArray(enrolledSso) || !Array.isArray(findableSso)) return [];
    const findable = new Set(findableSso.filter((p): p is string => typeof p === 'string'));
    return [...new Set(enrolledSso.filter((p): p is string => typeof p === 'string' && p.length > 0 && !findable.has(p)))];
}
