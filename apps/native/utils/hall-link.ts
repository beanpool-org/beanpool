/**
 * Lights-out H2: the hall poster's link, `beanpool://hall?at=192.168.8.1:8080&for=byron.beanpool.org&id=<short key>`, and
 * a typed laptop number (utils/hall.ts has the door itself). Kept apart, with nothing but node-url.ts, hall-state.ts's
 * address rule and core's audienceOf, so app/+native-intent.ts can route the link without loading the signer.
 */
import { audienceOf } from '@beanpool/core';
import { hallOriginOf } from './hall-state';
import { normalizeNodeUrl } from './node-url';

/** What a hall link or a typed number names. `for` and `id` are only ever compared or shown, never signed for. */
export interface HallLink {
    /** The laptop's address as an origin (utils/hall-state.ts hallOriginOf: a private address only). */
    at: string;
    /** The community's name the poster says, when it says one: must equal the phone's own, or nothing moves. */
    for: string | null;
    /** The node key's short form the poster prints, for a careful person to compare. Shown, never trusted. */
    id: string | null;
}

/** A typed or scanned laptop address (`192.168.8.1:8080`, `http://192.168.8.1`), as the hall origin, or null. */
export function hallAddressOf(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s || /\s/.test(s)) return null;
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s) && !/^https?:\/\//i.test(s)) return null;
    // A number with no scheme is plain http (node-url.ts normalizeNodeUrl gives a private IPv4 address http by itself).
    const withPort = /^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}(?:\/.*)?$/.test(s) ? `http://${s}` : s;
    return hallOriginOf(normalizeNodeUrl(withPort));
}

/** A bare host as audienceOf writes it, or null. */
function bareHost(raw: unknown): string | null {
    if (typeof raw !== 'string' || !raw || /[/:@?#\\\s]/.test(raw)) return null;
    const host = audienceOf(raw);
    return host === raw ? host : null;
}

const HALL_PATH = /^(?:beanpool:\/\/\/?|\/)?hall\/?(\?[^#]*)?(?:#.*)?$/i;

/** `beanpool://hall?at=…&for=…&id=…` (the poster's QR), read strictly, or null when it isn't one. */
export function parseHallLink(raw: unknown): HallLink | null {
    if (typeof raw !== 'string') return null;
    const m = HALL_PATH.exec(raw.trim());
    if (!m) return null;
    let q: URLSearchParams;
    try {
        q = new URLSearchParams((m[1] ?? '').slice(1));
    } catch {
        return null;
    }
    const at = hallAddressOf(q.get('at'));
    if (!at) return null;
    const forRaw = q.get('for');
    const forHost = forRaw === null ? null : bareHost(forRaw.toLowerCase());
    if (forRaw !== null && !forHost) return null;
    const idRaw = q.get('id');
    const id = idRaw && /^[1-9A-HJ-NP-Za-km-z.…-]{4,64}$/.test(idRaw) ? idRaw : null;
    return { at, for: forHost, id };
}

/** The route a hall link opens (app/hall.tsx), with only the fields that passed their checks. */
export function hallRouteFor(link: HallLink): `/hall?${string}` {
    const q = [`at=${encodeURIComponent(link.at)}`];
    if (link.for) q.push(`for=${encodeURIComponent(link.for)}`);
    if (link.id) q.push(`id=${encodeURIComponent(link.id)}`);
    return `/hall?${q.join('&')}`;
}

/**
 * The route for a system path (app/+native-intent.ts): a whole hall link opens the hall screen with it; a bare or
 * unreadable `beanpool://hall` opens the screen to type the number. Null for anything else.
 */
export function hallRouteFromSystemPath(path: unknown): string | null {
    if (typeof path !== 'string') return null;
    const s = path.trim();
    if (!HALL_PATH.test(s)) return null;
    const link = parseHallLink(s);
    return link ? hallRouteFor(link) : '/hall';
}
