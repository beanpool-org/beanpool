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
 *   5. loopback, always (localhost, 127.0.0.1, ::1): only an app on the same machine connects there;
 *   6. a private-range address, a `.local` name and the Android emulator's 10.0.2.2, ONLY on a node with none of 1–4
 *      (a LAN or development node).
 *
 * Never learned from the Host header, X-Forwarded-Host or SNI: the node's ports are reachable directly
 * (docker-compose publishes 443 and 8443), so anyone can send any Host. Nor by probing itself: a hostile node in front
 * could pass only the probe through.
 *
 * A node with none of 1–4 (a self-hoster behind a proxy with no config) doesn't know its name. It is `unconfigured`:
 * member-signature.ts accepts any host there until the switch, logs it and counts it, and Settings offers each one to
 * the owner to confirm with one tap (decision 3a, 2026-09-27).
 */

import { audienceOf } from '@beanpool/core';
import { getNodeConfig, resolvePublicNodeUrl } from '../state-engine.js';

export type AddressSource = 'public-address' | 'env' | 'owner' | 'registrar' | 'loopback';

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

function envAddresses(): string[] {
    const out: string[] = [];
    for (const part of String(process.env.BEANPOOL_ADDRESSES || '').split(',')) {
        const host = normalizeAddress(part.trim());
        if (host) out.push(host);
    }
    return out;
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

/** The configured names (1–4), each once, with where it came from. Loopback is not in this list; it is always accepted. */
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

/** A host on this machine or the local network: private IPv4 ranges, IPv6 unique-local and link-local, `.local`. */
export function isLocalNetworkHost(host: string): boolean {
    if (LOOPBACK.includes(host) || host.endsWith('.local')) return true;
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
    }
    return /^\[(fc|fd|fe8|fe9|fea|feb)[0-9a-f]*:/.test(host);
}

/**
 * Whether a request signed for `host` is for this community: `own` for one of its names, `unconfigured` for any other
 * host on a node that knows none of its names, `foreign` otherwise.
 */
export function audienceStanding(host: string): AudienceStanding {
    if (LOOPBACK.includes(host)) return 'own';
    const configured = configuredAddresses();
    if (configured.some((a) => a.address === host)) return 'own';
    if (configured.length > 0) return 'foreign';
    return isLocalNetworkHost(host) ? 'own' : 'unconfigured';
}

/** Every name a member's app may sign for here, for `/api/community/info` and Settings. Public by nature. */
export function publishedAddresses(): string[] {
    return configuredAddresses().map((a) => a.address);
}
