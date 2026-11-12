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
import { isPrivateHost } from './cleartext-address.js';

export const USE_ON_COMPUTER_WORDS = {
    /** The phone's line whole; {address} is the community's address as the phone uses it. What Share sends and a screen reader reads. */
    phoneLine: word('Use BeanPool on a computer: open {address}'),
    /**
     * The same line up to the address, for the phone's screen: the address is one unbreakable word, longer than a narrow
     * column at large text, so it is drawn on its own line under this, without its `https://`, and breaks only after a dot
     * (addressToShow, addressBreakPoints). A language writes it so that the address on the line below completes it.
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

// A bare host as a node's info names its own addresses (the phone reads them the same way: apps/native utils/node-profile.ts
// OWN_HOST): letters, digits, hyphens and dots, an optional port, nothing else.
const OWN_HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/;
const IPV4_HOST = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?$/;

/** What a community's info answer (GET /api/community/info) says of its own names: only these two are read here. */
export interface CommunityOwnAddresses {
    /** Where the community lives now, a bare host. Used only when it is one of `addresses`. */
    primaryAddress?: unknown;
    /** Every name and number the community answers to, bare hosts. */
    addresses?: unknown;
}

/**
 * The address a member opens on a computer: the community's MAIN address, not the one this app happens to be on. A Byron
 * member whose phone is still on mullum.beanpool.org was told to open mullum, when the community's main name is
 * byron.beanpool.org (its info answers `primaryAddress` byron, `addresses` [byron, mullum]; Marty's director, 13 Nov 2026).
 * Display only: it never changes which node an app talks to.
 *
 * `current` is the address the app holds (the phone's community address; the web app's own origin) and `info` what the
 * community last said of its names. The main address is used only when the community publishes one AND it is one of its own
 * `addresses`, so a host the community did not name is never shown. Otherwise `current`, as the row always said:
 * - no answer, or one that names no main address, or one outside `addresses`;
 * - a plain-http `current` (a home network's): it is the address that works from where the member is, and the main name
 *   may not be reachable there;
 * - a number where `current` is a name (the phone's own rule for following a move: utils/address-follow.ts followCandidate);
 * - a home network's name or number where `current` is reached from the Internet.
 *
 * The main address is https, the scheme every published name is served on. Null when `current` is no http(s) address.
 */
export function mainAddressToOpen(current: unknown, info: CommunityOwnAddresses | null | undefined): string | null {
    const own = addressToOpenOnAComputer(current);
    if (!own || !own.startsWith('https://')) return own;
    const primary = typeof info?.primaryAddress === 'string' ? info.primaryAddress.trim().toLowerCase() : '';
    if (!primary || !OWN_HOST.test(primary)) return own;
    const named = Array.isArray(info?.addresses)
        && (info.addresses as unknown[]).some((a) => typeof a === 'string' && a.trim().toLowerCase() === primary);
    if (!named) return own;
    const ownHost = own.slice('https://'.length);
    if (IPV4_HOST.test(primary) && !IPV4_HOST.test(ownHost)) return own;
    // A home network's name (`.local`, a private number) where `current` is reached from the Internet: a computer elsewhere could not
    // open it (the web banner's own rule, lib/former-address.ts nonPrimaryAddressNotice).
    if (isPrivateHost(primary) && !isPrivateHost(ownHost)) return own;
    return addressToOpenOnAComputer(`https://${primary}`) ?? own;
}

/**
 * The address as the row draws it: without `https://` (every published name is https, and the scheme is the part that
 * wraps a narrow column badly), with `http://` kept for a plain-http address such as a home network's, and a port kept.
 * Only the label: Copy and Share give the whole address, scheme included.
 */
export function addressToShow(address: string): string {
    return address.replace(/^https:\/\//i, '');
}

/**
 * The label cut where a line may break: after each dot, never inside a name. An app draws the pieces one after another
 * so a narrow column wraps between them (`castlemaine.` / `beanpool.org`) and breaks inside a piece only if that piece
 * alone is wider than the column. No invisible character is put into the address; the pieces put back are the label.
 */
export function addressBreakPoints(label: string): string[] {
    return label.match(/[^.]*\.|[^.]+$/g) ?? [];
}
