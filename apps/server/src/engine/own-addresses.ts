/**
 * This community's own names: the hosts a member's signature may name here (request binding, @beanpool/core
 * request-signing.ts). A format-2 request names the host the app connected to; this node accepts it only when that host
 * is one of these, and every other node refuses it (engine/member-signature.ts, 421 wrong_community).
 *
 * The set is the union of, and ONLY of, config this node already trusts:
 *   1. the hostname of resolvePublicNodeUrl(): the registrar's `publicAddress.hostname`, else `<name>.beanpool.org`,
 *      else CF_RECORD_NAME; and CF_RECORD_NAME as well whenever it is set: a name this node published is never
 *      un-published by a claim or by an own address, set before or after it (rename S1, design
 *      scratch/fable-design/DESIGN-rename-primary-name-fable.md §2; S2 review 4305409688);
 *   2. env BEANPOOL_ADDRESSES, a comma list (custom domains, a reverse proxy's names);
 *   3. the addresses an owner or admin confirmed in Settings, and the address a claim replaced (keepReplacedAddress)
 *      (node_config `ownerAddresses`, carried in the take-over envelope beside `publicAddress`, so a promoted standby
 *      keeps them);
 *   4. every BeanPool registrar name this key has held, current and former, whatever the registrar last said of it
 *      (node_config `registrarNames`, engine/registrar-names.ts; carried in the take-over envelope too). No registrar
 *      answer takes one away: not `none` (a registrar that lost its data answers that to every key), not `released`,
 *      `revoked`, `blocked` or `paused`, not a live answer naming another name (the old one is kept as former), and not
 *      this node's own Take offline during the hold. A community never loses its own name through a check, a bug or a
 *      stale registrar (Marty, 2026-09-24). A former name counts as one of 1–4, so a node whose only name went former
 *      is never `unconfigured`. Only the current one is published: a former name is accepted, never advertised;
 *      `/api/community/info` lists former names apart (formerAddresses), with where the community lives now
 *      (primaryAddress), so the web app opened at one can say it has moved (lost-name L4);
 *   5. loopback (localhost, 127.0.0.1, [::1]), a private-range address, a `.local` name and the Android emulator's
 *      10.0.2.2, ONLY on a node with none of 1–4 (a developer's, LAN or development node). A loopback name the
 *      operator listed in 2 doesn't count as one of 1–4 here: it names no community, only whichever machine an app
 *      runs on.
 *
 * A LOST name is refused, whichever of 1–4 it comes from (the mark is per host), and never published, but it still counts
 * as one of 1–4: a node whose only name was lost is never `unconfigured` (which would accept any host until the switch).
 * Only services/registrar-name-watch.ts marks a name lost (engine/registrar-names.ts `lost`), and only on:
 *   - proof: the registrar names another key as the name's holder AND an origin reached through the name answers as
 *     someone other than this server, on every counting round of a confirmation period (minutes when both name the same
 *     key, a full day otherwise), with this server's own key never answering there in between. Never on the
 *     registrar's word alone, never on silence, never while the name still leads here (Marty, 2026-09-28, answer 1);
 *   - this node's own release: 30 days after Take offline (or a longer recorded hold), once the registrar no longer
 *     holds it for this key (answer 2).
 * Only registrar names can be marked: the fleet's names (CF_RECORD_NAME) are `reserved` at the registrar and custom
 * domains unknown to it, so neither is ever lost. This server's own key answering at the name, or the registrar giving
 * it to this key again, clears the mark.
 *
 * A node with any of 1–4 treats a signature for loopback as it treats any other host's: another community's (421).
 * Loopback was once this community's on every node, so a signature for 127.0.0.1 was good at every community in the
 * world, and anything that got a member's app to sign for it (a URL-parsing gap, an app on the phone listening on
 * 127.0.0.1) could collect requests valid everywhere (#1224's deciding pass; director's call 2026-09-27). Nobody
 * legitimate needs it there: members reach a named node by its names. An operator who opens a named node's web app at
 * localhost (through an SSH tunnel) lists that name in BEANPOOL_ADDRESSES (2), never a silent default; it is then
 * accepted, and still never published. Listing it never makes a node that knows none of its names a named one
 * (4113741087): that node accepts loopback without it, and counting it as a name would refuse its members' apps at
 * once, for the domain they use and for its home-network address, with nothing in Settings to confirm.
 *
 * Never learned from the Host header, X-Forwarded-Host or SNI: the node's ports are reachable directly
 * (docker-compose publishes 443 and 8443), so anyone can send any Host. Nor by probing itself: a hostile node in front
 * could pass only the probe through.
 *
 * A node with none of 1–4 (a self-hoster behind a proxy with no config) doesn't know its names. It is `unconfigured`:
 * member-signature.ts accepts any host there until the switch, logs it and counts it, and Settings lets the owner
 * confirm one (decision 3a, 2026-09-27): with one tap only the host Settings itself is open at; every other host is
 * shown with its counts and confirmed only once ticked; another community's beanpool.org name never. A node that
 * holds the BeanPool directory also warns when it lists a host as a community's (engine/address-offers.ts).
 */

import { domainToASCII } from 'node:url';
import { ADDRESS_LIST_MAX, ADDRESS_SPARES_MAX, addressOf, isListableAddress } from '@beanpool/core';
import { getNodeConfig, resolvePublicNodeUrl, updateNodeConfig, PUBLIC_URL_RULES } from '../state-engine.js';
import { HOLDING_STATUSES, registrarNames, registrarNamesVersion } from './registrar-names.js';
import { isCertifiableHost, isIpLiteral, isLocalNetworkHost, isLoopbackHost, normalizeAddress, preferredAddress, reachableFromInternet } from './host-kinds.js';
import { logger } from '../logger.js';
// A type alone: services/registrar-name-watch.ts imports this module, so nothing of it is loaded from here.
import type { NameStanding } from '../services/registrar-name-watch.js';

// The shapes of a host live in host-kinds.ts (pure, so `beanpool claim` reads them too); here as they always were.
export { BEANPOOL_ZONE, isBeanPoolName, isCertifiableHost, isLocalNetworkHost, isLoopbackHost, normalizeAddress } from './host-kinds.js';

export type AddressSource = 'public-address' | 'env' | 'owner' | 'registrar';

export interface OwnAddress {
    address: string;
    source: AddressSource;
    /** A registrar name this key held before (4): accepted, never published. */
    former?: true;
    /** Lost (see above): refused and never published, still one of this community's names. */
    lost?: true;
    /** The host CF_RECORD_NAME sets (2), by hand on the server, with no claim of it held. */
    hardCoded?: true;
}

/** How a host a request was signed for stands here. */
export type AudienceStanding = 'own' | 'unconfigured' | 'foreign';

const warnedEnvEntries = new Set<string>();

/**
 * An entry of BEANPOOL_ADDRESSES that is not an address is left out, and members' apps that reach this community by it
 * are refused (421 wrong_community): at once on a node with another name, otherwise after the switch. Named in the log
 * once, so the operator can see why (4113047023).
 */
function warnDroppedEnvEntry(entry: string): void {
    if (warnedEnvEntries.has(entry)) return;
    warnedEnvEntries.add(entry);
    const ascii = domainToASCII(entry);
    const punycode = ascii && ascii !== entry.toLowerCase() && normalizeAddress(ascii) ? ` (here, ${ascii})` : '';
    const bracketed = `[${entry}]`;
    const ipv6 = !entry.startsWith('[') && entry.split(':').length > 2 && normalizeAddress(bracketed) ? ` An IPv6 address is written in brackets: ${bracketed}.` : '';
    logger.warn('AUTH', `BEANPOOL_ADDRESSES: ${JSON.stringify(entry)} is not an address, so it is left out, and members' apps `
        + `that reach this community by it are refused. A name with letters outside a-z must be written in its punycode `
        + `form, xn--…${punycode}; a port is digits only.${ipv6}`);
}

function envAddresses(): string[] {
    const out: string[] = [];
    for (const part of String(process.env.BEANPOOL_ADDRESSES || '').split(',')) {
        const entry = part.trim();
        if (!entry) continue;
        const host = normalizeAddress(entry);
        if (host) out.push(host);
        else warnDroppedEnvEntry(entry);
    }
    return out;
}

/** At start: name each BEANPOOL_ADDRESSES entry that is not an address, before any member's app is refused over it. */
export function checkEnvAddresses(): void {
    envAddresses();
}

/** More than any real community needs; a bound on what one Settings session, or `beanpool claim`, can write to (3). */
export const MAX_OWNER_ADDRESSES = 20;

/** The owner-confirmed addresses as stored in node_config (3): the host of each, the form a signature names. */
export function ownerConfirmedAddresses(): string[] {
    const stored = (getNodeConfig() as any).ownerAddresses;
    if (!Array.isArray(stored)) return [];
    const out: string[] = [];
    for (const a of stored) {
        const host = normalizeAddress(a);
        if (host && !out.includes(host)) out.push(host);
    }
    return out;
}

/**
 * `entry` in core's one spelling (addressOf) when it names a port other than 443 (`host:port`), else null: the one place
 * here that tells a port apart from its host, through core's spelling (normalizeAddress, core's audienceOf, is the host).
 */
function portedSpelling(entry: unknown): string | null {
    if (typeof entry !== 'string') return null;
    const spelled = addressOf(entry.trim());
    const host = normalizeAddress(entry);
    return spelled && host && spelled !== addressOf(host) ? spelled : null;
}

/**
 * The owner-confirmed list (3) as stored, one entry per host: the host, or core's one spelling `host:port` where the entry
 * names a port (a standby's own spare that a take-over made an address, services/takeover.ts). Every writer of
 * `ownerAddresses` starts from this, never from the hosts alone, so a port is never lost when another address is added or
 * removed, and the signed list spells that address with its port (portedUrls).
 */
export function ownerAddressEntries(): string[] {
    const stored = (getNodeConfig() as any).ownerAddresses;
    if (!Array.isArray(stored)) return [];
    const out: string[] = [];
    const hosts = new Set<string>();
    for (const a of stored) {
        const host = normalizeAddress(a);
        if (!host || hosts.has(host)) continue;
        hosts.add(host);
        out.push(portedSpelling(a) ?? host);
    }
    return out;
}

/**
 * `entries` (ownerAddressEntries) with each of `spellings` (addresses in core's one spelling) in: an entry for the same host
 * gives way, so the address is kept exactly as given, port included.
 */
export function withOwnerAddresses(entries: readonly string[], spellings: readonly string[]): string[] {
    const hosts = new Set(spellings.map((a) => normalizeAddress(a)));
    return [...entries.filter((e) => !hosts.has(normalizeAddress(e))), ...spellings];
}

/** `entries` (ownerAddressEntries) without the one for `host`, whatever its port. */
export function withoutOwnerAddress(entries: readonly string[], host: string): string[] {
    return entries.filter((e) => normalizeAddress(e) !== host);
}

let cache: { at: number; version: number; list: OwnAddress[] } | null = null;
const CACHE_MS = 1_000;

/** Forget the cached list, after a change a later request must see at once (an owner confirming an address). */
export function forgetOwnAddresses(): void {
    cache = null;
}

/** The configured names (1–4), each once, with where it came from. Loopback is here only when the operator listed it. */
export function configuredAddresses(now = Date.now()): OwnAddress[] {
    // A registrar answer the node recorded (registrar-names.ts) is seen by the next request, not a second later.
    const version = registrarNamesVersion();
    if (cache && cache.version === version && now - cache.at < CACHE_MS) return cache.list;
    const list: OwnAddress[] = [];
    const config = getNodeConfig();
    const names = registrarNames(config);
    // Per host, whichever source names it.
    const lost = new Set(names.filter((r) => r.lost).map((r) => r.address));
    const given = resolvePublicNodeUrl(PUBLIC_URL_RULES.community, { ...config, publicAddress: null });
    const set = given ? normalizeAddress(given) : null;
    // A fleet name this key also claimed is a name it holds: Make main there is the way back after a rename.
    const hardCoded = names.some((r) => r.address === set && HOLDING_STATUSES.has(r.status)) ? null : set;
    const add = (address: string | null, source: AddressSource, former = false) => {
        if (!address || list.some((a) => a.address === address)) return;
        list.push({
            address, source, ...(former ? { former: true as const } : {}), ...(lost.has(address) ? { lost: true as const } : {}),
            ...(address === hardCoded ? { hardCoded: true as const } : {}),
        });
    };
    const url = resolvePublicNodeUrl(PUBLIC_URL_RULES.community, config);
    add(url ? normalizeAddress(url) : null, 'public-address');
    add(set, 'public-address');
    for (const a of envAddresses()) add(a, 'env');
    for (const a of ownerConfirmedAddresses()) add(a, 'owner');
    for (const r of names) add(r.address, 'registrar', r.role === 'former');
    cache = { at: now, version, list };
    return list;
}

/** A configured name that names this community: any but a loopback name the operator listed (5). */
const namesThisCommunity = (a: OwnAddress) => !isLoopbackHost(a.address);

/**
 * Whether this node knows any of its names. A loopback name listed in BEANPOOL_ADDRESSES doesn't count (5): with only
 * that, the node is still `unconfigured`, and Settings offers the addresses apps reached it at. A lost name counts.
 */
export function knowsItsNames(): boolean {
    return configuredAddresses().some(namesThisCommunity);
}

/**
 * Whether a request signed for `host` is for this community: `own` for one of its names, or on a node that knows none
 * of them for a host on this machine or its network; `unconfigured` for any other host on such a node; `foreign`
 * otherwise, loopback included on a node with a name, and a lost name (isLostAddress says which).
 */
export function audienceStanding(host: string): AudienceStanding {
    // Only a host in the one form apps sign (audienceOf: lower case, no port, no trailing dot) can be anyone's name.
    if (normalizeAddress(host) !== host) return 'foreign';
    const configured = configuredAddresses();
    if (configured.some((a) => a.address === host && !a.lost)) return 'own';
    if (configured.some(namesThisCommunity)) return 'foreign';
    return isLocalNetworkHost(host) ? 'own' : 'unconfigured';
}

/**
 * The names this community goes by, for `/api/community/info`. Public by nature. A loopback name the operator listed
 * (BEANPOOL_ADDRESSES=localhost, for an SSH tunnel) is accepted here but left out: it names no community, only
 * whichever machine an app runs on. So is a former registrar name (4): members' apps that still use it are accepted,
 * but no app is sent to it. So is a lost name. Settings' list shows all three, with their source.
 */
export function publishedAddresses(): string[] {
    return configuredAddresses().filter((a) => namesThisCommunity(a) && !a.former && !a.lost).map((a) => a.address);
}

/**
 * The published names members can be sent to now: all of them but a current registrar name the registrar doesn't say is
 * live (a gated rename still pending, paused, revoked), which has no route yet, though a real node also has it as
 * publicAddress (item 1) (#1275 review 4118422613).
 */
function reachableAddresses(): string[] {
    const notLive = new Set(registrarNames().filter((r) => r.role === 'current' && r.status !== 'live').map((r) => r.address));
    return publishedAddresses().filter((a) => !notLive.has(a));
}

/**
 * Whether this community is published anywhere but `host`, so a claim of `host` changes where members and newcomers are
 * sent, and asks the owner's fresh proof (routes/public-address.ts; design §6).
 */
export function publishedBesides(host: string): boolean {
    return reachableAddresses().some((a) => a !== host);
}

/** Whether `host` is one of this community's names that is lost (above): refused, and counted as such (member-signature.ts). */
export function isLostAddress(host: string): boolean {
    return configuredAddresses().some((a) => a.address === host && a.lost);
}

/**
 * The owner's main address (node_config `mainAddress`, Settings → Addresses → Make main; design
 * scratch/fable-design/DESIGN-several-addresses-fable.md §2.1), while it may be main (mainAddressRefusal says why not):
 * published with a route (reachableAddresses), answering from outside while the community has any address that does,
 * and a bare number only while the community has no name to send anyone to (a number does not outlive its server). Null
 * when the owner never chose, or chose an address that can't be main now: then primaryAddress keeps today's rule, so a
 * community that never chose behaves as it always did, and a home-network main chosen before the community had a name
 * gives way to the name the moment it has one.
 */
export function chosenMainAddress(): string | null {
    const chosen = normalizeAddress(getNodeConfig().mainAddress);
    return chosen && !notMainNow(chosen, reachableAddresses()) ? chosen : null;
}

/** A name, not a number, that people outside the home network can reach: what a bare number never stands above. */
const isInternetName = (a: string) => !isIpLiteral(a) && reachableFromInternet(a);

/**
 * Why `host`, one of `reachable`, can't be main beside the others, or null. The main answers from outside (design §2.1):
 * a home-network address (`.local`, `.lan`, `.home.arpa`, a one-word name, 192.168.x, 10.x, fc00::/7) is main only while
 * the community has nothing the Internet can reach, and a number only while it has no name.
 */
function notMainNow(host: string, reachable: readonly string[]): string | null {
    if (!reachable.includes(host)) return `${host} has no route yet (waiting for approval, or paused). It can be made main once it is live.`;
    if (!reachableFromInternet(host) && reachable.some(reachableFromInternet)) {
        return `${host} can't be reached from outside its own network (a home network's name or number). The main address must work from anywhere, and this community has an address that does.`;
    }
    if (isIpLiteral(host) && reachable.some(isInternetName)) {
        return `${host} is a number, and this community has a name. A number stops working when the server changes, so a name stays the main address.`;
    }
    return null;
}

/**
 * Why `host` can't be made main now, in words for the owner, or null when it can (routes/app-addresses.ts: /main answers
 * with it, and Settings' report says it of each row, so the two never disagree). Any published address with a route that
 * answers from outside may be: a beanpool.org name, an own domain, a hand-set name, and a bare number while the community
 * has no name. A home-network address only while the community has nothing the Internet can reach (lights-out refuses
 * /main itself). Never a former, lost or loopback name (none is published), nor a name still waiting for approval.
 *
 * Nor a beanpool.org name the address service doesn't simply give this community, whatever the record says (`standings`:
 * services/registrar-name-watch.ts nameStandings, passed in because that module imports this one). The record keeps a name
 * `live` until the watch marks it lost, 10 minutes to a day after the address service first names another key as its
 * holder, and in that time the name may lead to that community's server: made main, it would send new members, invites,
 * the directory and search engines there (several-addresses S6, #3240's deciding review). Only choosing it is refused on
 * the address service's word: a name already main stays main, and keeps being accepted, until the watch's proof marks it
 * lost (never on that word alone, Marty 2026-09-28).
 */
export function mainAddressRefusal(host: string, standings: ReadonlyMap<string, Pick<NameStanding, 'registrarSays'>>): string | null {
    if (!publishedAddresses().includes(host)) {
        return configuredAddresses().some((a) => a.address === host)
            ? `${host} is not an address this community sends people to (a former or lost name), so it can't be the main one.`
            : `${host} is not one of this community's addresses. Add it first, then make it the main one.`;
    }
    const notNow = notMainNow(host, reachableAddresses());
    if (notNow) return notNow;
    const says = standings.get(host)?.registrarSays ?? null;
    if (says === 'other') {
        return `The address service says another community holds ${host}, so it can't be the main address: new members and invites sent there could reach that community instead.`;
    }
    if (says === 'free') {
        return `The address service says no community holds ${host}, so it can't be the main address until the address service gives it to this community again.`;
    }
    if (says) return `The address service doesn't say ${host} is this community's now, so it can't be the main address.`;
    return null;
}

/**
 * Make main (routes/app-addresses.ts): `host` becomes the owner's main address. The caller has checked mainAddressRefusal
 * and the owner's fresh proof. Returns the main address before.
 */
export function setMainAddress(host: string): string | null {
    const before = primaryAddress();
    updateNodeConfig({ mainAddress: host });
    forgetOwnAddresses();
    return before;
}

/**
 * This community's public address as a URL, for every reader of "where it lives" (design §2.1: the directory push, the
 * search canonical, the community card, the assistant's welcome and origin, alerts): the owner's main address once they
 * chose one, else resolvePublicNodeUrl's answer exactly as before. The resolver's own answer is kept when it already
 * names the main address, so its port survives.
 */
export function mainPublicUrl(): string | null {
    const url = resolvePublicNodeUrl(PUBLIC_URL_RULES.community);
    const main = chosenMainAddress();
    if (!main) return url;
    // A home-network main (allowed only while the community lists nothing the Internet can reach) names nothing a reader
    // outside could open: the directory, search engines and a stranger's card get none, as they did before it was chosen
    // (several-addresses S2, from #3222's round-2 review). The signed list still names it main (addressListContent).
    if (!reachableFromInternet(main)) return null;
    const host = url ? normalizeAddress(url.replace(/^https?:\/\//, '').replace(/\/+$/, '')) : null;
    // Another main at its own port when one is known (portedUrls), as the signed list spells it: the directory and the web
    // link open where the list says.
    return host === main ? url : (portedUrls().get(main) ?? `https://${main}`);
}

/**
 * Every address on the list (publishedAddresses) as a URL, for the doors that must keep answering at each one: the OAuth
 * resource an assistant may name and the Origin /mcp takes (agent/mcp-route.ts, agent/oauth-route.ts). A change of main
 * changes which address is named, never which addresses work (several-addresses S1, review 4580901344). The resolver's
 * URL keeps its port for its host, and mainPublicUrl's for the main; every other address is https://<host>.
 */
export function listedUrls(): string[] {
    const ported = portedUrls();
    return publishedAddresses().map((a) => ported.get(a) ?? `https://${a}`);
}

/**
 * The URL of each host whose port is known, by host; https://<host> for the rest. Every source that can name a port does,
 * in core's one spelling (addressOf): the resolver's URL (the registrar's web address, else CF_RECORD_NAME), CF_RECORD_NAME
 * beside another web address, BEANPOOL_ADDRESSES, and the owner-confirmed list (ownerAddressEntries: a standby's ported
 * spare that a take-over made an address). The first to name a host's port wins, in that order. Several addresses S8
 * round 2 (#3260): no address loses its port between the server, the take-over envelope, the signed list and the phone.
 */
function portedUrls(): Map<string, string> {
    const ported = new Map<string, string>();
    const config = getNodeConfig();
    const fromUrls = [resolvePublicNodeUrl(PUBLIC_URL_RULES.community, config), resolvePublicNodeUrl(PUBLIC_URL_RULES.community, { ...config, publicAddress: null })];
    const entries = [
        ...fromUrls.filter((u): u is string => !!u),
        ...String(process.env.BEANPOOL_ADDRESSES || '').split(','),
        ...ownerAddressEntries(),
    ];
    for (const entry of entries) {
        // By the host as the names above read it from the same entry (normalizeAddress), so spell() finds it.
        const spelled = portedSpelling(entry);
        const host = spelled ? normalizeAddress(entry) : null;
        if (spelled && host && !ported.has(host)) ported.set(host, `https://${spelled}`);
    }
    return ported;
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
let warnedListFull = '';

/**
 * What the signed address list says (services/address-list.ts; design scratch/fable-design/DESIGN-several-addresses-fable.md
 * §2.2): every published address with a route (reachableAddresses: never a former, lost or loopback name, nor a name still
 * waiting for approval), each in core's one spelling of an address (addressOf: `host`, or `host:port` where the main's or
 * the resolver's URL names a port other than 443, so a port survives), none loopback or unspecified (isListableAddress), at
 * most ADDRESS_LIST_MAX of them with the main always among them, in code-unit order; and the main (primaryAddress) in the
 * same spelling. A home-network main stays main here: the list is what a phone on that network follows. Null when there is
 * nothing to list (a node that knows none of its names, or whose names all wait for a route).
 */
export function addressListContent(): { main: string; addresses: string[]; spares: string[] } | null {
    const ported = portedUrls();
    const spell = (host: string): string | null => {
        const a = addressOf(ported.get(host) ?? `https://${host}`);
        return a && isListableAddress(a) ? a : null;
    };
    const hosts = reachableAddresses().filter((h) => spell(h) !== null);
    if (!hosts.length) return null;
    const primary = primaryAddress();
    const main = primary && hosts.includes(primary) ? primary : preferredAddress(hosts)!;
    const listed: string[] = [];
    for (const h of [main, ...hosts.filter((x) => x !== main)]) {
        const a = spell(h)!;
        if (!listed.includes(a)) listed.push(a);
        if (listed.length === ADDRESS_LIST_MAX) break;
    }
    if (hosts.length > ADDRESS_LIST_MAX && warnedListFull !== hosts.join(',')) {
        warnedListFull = hosts.join(',');
        logger.warn('SYS', `[Addresses] This community has ${hosts.length} addresses; its signed list names the main one and `
            + `${ADDRESS_LIST_MAX - 1} others, so members' phones follow only those. Remove the addresses no longer used.`);
    }
    // The owner's spares (addressSpares), apart from the addresses: one that is also an address now (a standby that took
    // over lists its own) is an address, not a spare.
    const spares = addressSpares().filter((s) => !listed.includes(s));
    return { main: spell(main)!, addresses: listed.sort(byCodeUnit), spares };
}

/**
 * Each published address (publishedAddresses) in core's one spelling, port included, as the signed list spells it
 * (addressListContent), whether or not it has a route yet: what this server goes by. The take-over step reads it before it
 * changes anything, to know which carried spare is this server's own, spelling for spelling (services/takeover.ts).
 */
export function ownAddressSpellings(): string[] {
    const ported = portedUrls();
    const out: string[] = [];
    for (const h of publishedAddresses()) {
        const a = addressOf(ported.get(h) ?? `https://${h}`);
        if (a && !out.includes(a)) out.push(a);
    }
    return out;
}

/**
 * The owner's spares (node_config `addressSpares`, Settings → Addresses → Spares; design scratch/fable-design/
 * DESIGN-several-addresses-fable.md §6): where the community would go if this server were lost, a standby's own address,
 * each in core's one spelling (`host`, or `host:port`), none loopback, none twice, at most ADDRESS_SPARES_MAX, in code-unit
 * order. Published in the signed list apart from its addresses. Never one of this community's names: a phone asks a
 * spare only when no listed address answers, and takes it only at a higher take-over count (a standby that took over).
 */
export function addressSpares(): string[] {
    const stored = getNodeConfig().addressSpares;
    if (!Array.isArray(stored)) return [];
    const out: string[] = [];
    for (const s of stored) {
        const a = typeof s === 'string' ? addressOf(s) : null;
        if (a && isListableAddress(a) && !out.includes(a)) out.push(a);
        if (out.length === ADDRESS_SPARES_MAX) break;
    }
    return out.sort(byCodeUnit);
}

/**
 * Where this community lives now, for `/api/community/info`, Settings and every reader of "where it lives"
 * (mainPublicUrl): the owner's main address while it may be main (chosenMainAddress). Otherwise as before an owner chose
 * (lost-name L4, design scratch/registrar/DESIGN-lost-name-audience-opus.md §4.2): its current registrar name while the
 * registrar says it is live, else the first of its other published names, a name before an IP address (design
 * scratch/global-node/DESIGN-https-anywhere-fable.md §3, D3: a name survives a change of server, a number does not, so
 * new members are sent to the name while those holding the IP keep working); null on a node with none (one that knows
 * none of its names, or whose only name it released). Always one of publishedAddresses(), so never a former name or a
 * loopback one. Only a name the Internet can reach comes before an IP, and a public IP before a name or IP on the home
 * network (a `.local` or `.lan` name an operator listed): newcomers sent there from outside would find nothing (S2
 * review 4305346684).
 */
export function primaryAddress(): string | null {
    return chosenMainAddress() ?? defaultMainAddress();
}

/**
 * Where the community lives by today's rule, before any owner's choice (primaryAddress above): the live registrar name,
 * else the first reachable name, a name before a number. What a claim replaces (keepReplacedAddress) whatever the main.
 */
function defaultMainAddress(): string | null {
    const published = publishedAddresses();
    const live = registrarNames().find((r) => r.role === 'current' && r.status === 'live' && published.includes(r.address));
    if (live) return live.address;
    // The next of its names, else none, so the web app says nothing rather than point at a name with no route yet.
    return preferredAddress(reachableAddresses());
}

/**
 * A claim of `claimed` answered: the address it replaces goes on the owner-confirmed list (3). That is where the community
 * lived until now by today's rule (defaultMainAddress: the live registrar name the claim makes former), never the owner's
 * chosen main, which a claim does not move and which is listed already (several-addresses §2.1, "adding an address only
 * adds"; review 4580901426). So a name this node published is never un-published by a claim, and it travels in the
 * take-over envelope to a standby that has no CF_RECORD_NAME of it (design §2). Called before the claim is recorded and
 * stored, while the old name is still the live one; a name that was only waiting or paused is not, and is not copied. Past
 * MAX_OWNER_ADDRESSES too: that bounds what a Settings session or `beanpool claim` adds, and this keeps a name the
 * community already goes by. Returns the address replaced, or null when the claim replaces none.
 */
export function keepReplacedAddress(claimed: string): string | null {
    const replaced = defaultMainAddress();
    if (!replaced || replaced === claimed) return null;
    if (!ownerConfirmedAddresses().includes(replaced)) {
        updateNodeConfig({ ownerAddresses: [...ownerAddressEntries(), replaced] });
        forgetOwnAddresses();
    }
    return replaced;
}

/**
 * A registrar name this community let go (Release, Take offline) comes off the owner-confirmed list: a claim may have put it
 * there (keepReplacedAddress), and a name let go is never published or sent to. It is accepted through its hold from the
 * record of names (4), as any former name is.
 */
export function dropReleasedAddress(host: string | null): void {
    if (!host || !ownerConfirmedAddresses().includes(host)) return;
    updateNodeConfig({ ownerAddresses: withoutOwnerAddress(ownerAddressEntries(), host) });
    forgetOwnAddresses();
}

/**
 * The hosts this server holds a certificate of its own for (services/acme/schedule.ts, design
 * scratch/global-node/DESIGN-https-anywhere-fable.md §1): every name it accepts members' signatures for (1–4) that a public
 * CA can certify (isCertifiableHost), in the order of configuredAddresses. Never a former or lost name, never a
 * beanpool.org one, loopback, a private-range address or a `.local` name. Each is ordered on its own.
 */
export function tlsIdentifiers(): string[] {
    return configuredAddresses().filter((a) => !a.former && !a.lost && isCertifiableHost(a.address)).map((a) => a.address);
}

/**
 * The BeanPool names this community had before (4), for `/api/community/info`: only so that the web app, opened at one
 * of them, can say where the community lives now (primaryAddress; design §6). Never an address to send an app to:
 * they are accepted here and never published. One that is also set on the server or confirmed in Settings is one of
 * this community's names in use (published), not a former one, and isn't here.
 */
export function formerAddresses(): string[] {
    return configuredAddresses().filter((a) => a.former).map((a) => a.address);
}
