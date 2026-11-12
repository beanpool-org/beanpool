/**
 * "Use BeanPool on a computer": the one plain line both apps give a member who asks whether BeanPool has a desktop app
 * (Jay, a Byron member, 13 Nov 2026: Settings "didn't get me anywhere ... wasn't up on everything enough to know if the
 * desktop app was just this here in the browser"). There is no desktop app. BeanPool on a computer is the web app, at the
 * community's own address, in any browser, with the same account.
 *
 * The phone (apps/native components/UseOnComputerRow.tsx, Settings → Account & identity, for every member) says it with
 * the address its own community uses; the web app (apps/pwa SettingsPage.tsx) says it with the address it is served from.
 * The two lines are written here so a language translates each once and the two apps never drift apart. The guide says
 * the same in its own words (getting-started/web-app.md, about/faq.md).
 *
 * Not the owners' "Manage this community from a computer" row (apps/native components/NodeAdminEntry.tsx), which signs a
 * computer's browser into the community's Settings page and is for owners, admins and moderators only. An owner sees both.
 */
import { word } from './words.js';

export const USE_ON_COMPUTER_WORDS = {
    /** The phone's line whole; {address} is the community's address as the phone uses it. What Share sends and a screen reader reads. */
    phoneLine: word('Use BeanPool on a computer: open {address}'),
    /**
     * The same line up to the address, for the phone's screen: the address is one unbreakable word, longer than a narrow
     * column at large text, so it is drawn on its own line under this and wraps by letter. A language writes it so that the
     * address on the line below completes it.
     */
    phoneLead: word('Use BeanPool on a computer: open'),
    /** The web app's line; {address} is the address this page is served from. */
    webLine: word('BeanPool works in any browser: open {address} on any computer or phone'),
} as const;

// The scheme and host: no login (an `@` before the path), no spaces. Written without `URL`, whose parts a phone's JavaScript
// does not all provide (the phone reads its community's address the same way, apps/native utils/community-origin.ts).
const ORIGIN = /^(https?):\/\/([^/?#@\s]+)(?=[/?#]|$)/i;
const LONGEST_ADDRESS = 300;

/**
 * The address a member opens on a computer, from the one their app holds for the community: its scheme and host (and port
 * if it has one), lower-cased, with no path, query, fragment or trailing slash. Null when `raw` is no http(s) address
 * (a missing one, a string with a login in it, anything that is not an address): the line is then left out, never shown
 * with a blank or broken address.
 */
export function addressToOpenOnAComputer(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > LONGEST_ADDRESS) return null;
    const m = ORIGIN.exec(trimmed);
    return m ? `${m[1].toLowerCase()}://${m[2].toLowerCase()}` : null;
}
