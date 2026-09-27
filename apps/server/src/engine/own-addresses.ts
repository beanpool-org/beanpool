/**
 * This community's own names: the hosts a member's signature may name here (request binding, @beanpool/core
 * request-signing.ts). A format-2 request names the host the app connected to; this node accepts it only when that host
 * is one of these, and every other node refuses it (engine/member-signature.ts, 421 wrong_community).
 *
 * The set is the union of, and ONLY of, config this node already trusts:
 *   1. the hostname of resolvePublicNodeUrl(): the registrar's `publicAddress.hostname`, else `<name>.beanpool.org`,
 *      else CF_RECORD_NAME;
 *   2. env BEANPOOL_ADDRESSES, a comma list (custom domains, a reverse proxy's names);
 *   3. the addresses an owner or admin confirmed in Settings (node_config `ownerAddresses`, carried in the take-over
 *      envelope beside `publicAddress`, so a promoted standby keeps them);
 *   4. the registrar's name for this key while the stored registrar status still gives it (`publicAddress.name` as a
 *      beanpool.org host, when the status is live or pending). The registrar keeps no record of a former name today,
 *      so a renamed node keeps its old name only if an owner confirms it (3);
 *   5. loopback (localhost, 127.0.0.1, [::1]), a private-range address, a `.local` name and the Android emulator's
 *      10.0.2.2, ONLY on a node with none of 1–4 (a developer's, LAN or development node). A loopback name the
 *      operator listed in 2 doesn't count as one of 1–4 here: it names no community, only whichever machine an app
 *      runs on.
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
import { audienceOf } from '@beanpool/core';
import { getNodeConfig, resolvePublicNodeUrl } from '../state-engine.js';
import { logger } from '../logger.js';

export type AddressSource = 'public-address' | 'env' | 'owner' | 'registrar';

export interface OwnAddress {
    address: string;
    source: AddressSource;
}

/** How a host a request was signed for stands here. */
export type AudienceStanding = 'own' | 'unconfigured' | 'foreign';

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]', '::1'];

/** An address as a host in the one form signatures carry (audienceOf), or null for anything that is not one. */
export function normalizeAddress(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    const host = audienceOf(input);
    return host && host.length <= 253 ? host : null;
}

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

/** The owner-confirmed addresses as stored in node_config (3). */
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

function registrarAddress(): string | null {
    const pa: any = (getNodeConfig() as any).publicAddress;
    if (!pa || typeof pa !== 'object' || typeof pa.name !== 'string' || !pa.name.trim()) return null;
    if (pa.status !== 'live' && pa.status !== 'pending') return null;
    const n = pa.name.trim();
    return normalizeAddress(n.includes('.') ? n : `${n}.beanpool.org`);
}

let cache: { at: number; list: OwnAddress[] } | null = null;
const CACHE_MS = 1_000;

/** Forget the cached list, after a change a later request must see at once (an owner confirming an address). */
export function forgetOwnAddresses(): void {
    cache = null;
}

/** The configured names (1–4), each once, with where it came from. Loopback is here only when the operator listed it. */
export function configuredAddresses(now = Date.now()): OwnAddress[] {
    if (cache && now - cache.at < CACHE_MS) return cache.list;
    const list: OwnAddress[] = [];
    const add = (address: string | null, source: AddressSource) => {
        if (address && !list.some((a) => a.address === address)) list.push({ address, source });
    };
    const url = resolvePublicNodeUrl();
    add(url ? normalizeAddress(url) : null, 'public-address');
    for (const a of envAddresses()) add(a, 'env');
    for (const a of ownerConfirmedAddresses()) add(a, 'owner');
    add(registrarAddress(), 'registrar');
    cache = { at: now, list };
    return list;
}

/** The zone the BeanPool registrar names communities in: `<name>.beanpool.org` (registrarAddress, resolvePublicNodeUrl). */
export const BEANPOOL_ZONE = 'beanpool.org';

/**
 * A name in the registrar's zone: beanpool.org itself or any name under it. One that isn't among this node's
 * configured names (its own registrar name is item 1 or 4) is another community's, or free to be claimed by one.
 */
export function isBeanPoolName(host: string): boolean {
    return host === BEANPOOL_ZONE || host.endsWith(`.${BEANPOOL_ZONE}`);
}

/** A host on this machine: localhost, 127.0.0.0/8, [::1]. */
export function isLoopbackHost(host: string): boolean {
    return LOOPBACK.includes(host) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** A configured name that names this community: any but a loopback name the operator listed (5). */
const namesThisCommunity = (a: OwnAddress) => !isLoopbackHost(a.address);

/**
 * Whether this node knows any of its names. A loopback name listed in BEANPOOL_ADDRESSES doesn't count (5): with only
 * that, the node is still `unconfigured`, and Settings offers the addresses apps reached it at.
 */
export function knowsItsNames(): boolean {
    return configuredAddresses().some(namesThisCommunity);
}

/**
 * A host on this machine or the local network: loopback, private IPv4 ranges, IPv6 unique-local and link-local,
 * `.local`. This community's (5) only on a node that knows none of its names.
 */
export function isLocalNetworkHost(host: string): boolean {
    if (isLoopbackHost(host) || host.endsWith('.local')) return true;
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
    }
    return /^\[(fc|fd|fe8|fe9|fea|feb)[0-9a-f]*:/.test(host);
}

/**
 * Whether a request signed for `host` is for this community: `own` for one of its names, or on a node that knows none
 * of them for a host on this machine or its network; `unconfigured` for any other host on such a node; `foreign`
 * otherwise, loopback included on a node with a name.
 */
export function audienceStanding(host: string): AudienceStanding {
    // Only a host in the one form apps sign (audienceOf: lower case, no port, no trailing dot) can be anyone's name.
    if (normalizeAddress(host) !== host) return 'foreign';
    const configured = configuredAddresses();
    if (configured.some((a) => a.address === host)) return 'own';
    if (configured.some(namesThisCommunity)) return 'foreign';
    return isLocalNetworkHost(host) ? 'own' : 'unconfigured';
}

/**
 * Every name a member's app may sign for here, for `/api/community/info`. Public by nature. A loopback name the operator
 * listed (BEANPOOL_ADDRESSES=localhost, for an SSH tunnel) is accepted here but left out: it names no community, only
 * whichever machine an app runs on. Settings' list shows it, with its source.
 */
export function publishedAddresses(): string[] {
    return configuredAddresses().filter(namesThisCommunity).map((a) => a.address);
}
