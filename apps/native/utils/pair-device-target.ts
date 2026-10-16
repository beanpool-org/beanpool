/**
 * Where "Use your account on another device" may send the account (fable-security-signin finding 1; the deciding
 * review of #1983, BLOCKING 1).
 *
 * The QR names the server that relays the account. The relay's number matching (pairing-relay.ts) only holds on an
 * honest server: a hand-made QR naming the sender's own server could skip it. So the phone sends the key and the
 * 12 words only to a server it already uses (the community it is on, or one in its saved list), the way the Settings
 * QR sign-in only signs in to the phone's own community. Moving to a brand-new community's server by QR is therefore
 * not possible; the 12 words still are.
 *
 * Two rules make "a server it already uses" mean one host on every parser (node-url.ts explains why: iOS's NSURL reads
 * `https://mullum.example\@evil.test` as evil.test, while the WHATWG URL that compared it reads mullum.example):
 *  1. The QR is read by a strict grammar, never by a URL parser: `beanpool://pair?` and exactly the parameters
 *     session, pub and node, each once; `node` a plain https origin in its one canonical spelling (lower case ASCII
 *     host or bracketed IPv6, a port only when it isn't 443, at most one trailing slash). No login, `\`, percent
 *     escape, whitespace, control character, path, query or fragment. Anything else is refused outright.
 *  2. The account goes to the matched SAVED address, rebuilt from its canonical origin (plainOriginOf): never the
 *     scanned text. The QR only chooses among the phone's own servers; it never spells the address that is used.
 *
 * https only. The QR's `node` must be https and only https saved addresses are targets, so a phone on an http server
 * (the emulator's `http://10.0.2.2:3000`, a LAN dev node) can't use this flow: a dev page's QR is refused as
 * unreadable, and one naming no server says "Connect to your community first.". Every live node is https; the 12
 * words still work anywhere. The screen relies on this: it keeps no cleartext check of its own.
 */
import { plainOriginOf } from './node-url';
import { GLOBAL_NODE_URL } from './global-node-url';

export interface PairingQr {
    sessionId: string;
    desktopPubHex: string;
    /** The QR's server, as it spelled it ('' when it names none: the phone's own community). Only ever compared. */
    nodeUrl: string;
}

const PAIR_PREFIX = 'beanpool://pair?';
/** A plain https origin in its canonical spelling, with at most one trailing slash. Lower case only. */
const CANONICAL_HTTPS_ORIGIN = /^https:\/\/(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[(?=(?:[0-9a-f.]*:){2})[0-9a-f:.]+\])(?::[1-9]\d{0,4})?\/?$/;

/** The pairing QR, read strictly (rule 1), or null: refused, nothing sent. */
export function parsePairingQr(raw: unknown): PairingQr | null {
    if (typeof raw !== 'string' || raw.length > 600 || !raw.startsWith(PAIR_PREFIX)) return null;
    const query = raw.slice(PAIR_PREFIX.length);
    // Only the characters these three values are made of, plus the separators and node's own escapes (%3A, %2F).
    if (!/^[A-Za-z0-9=&%._-]+$/.test(query)) return null;
    const params = new Map<string, string>();
    for (const part of query.split('&')) {
        const eq = part.indexOf('=');
        if (eq <= 0) return null;
        const key = part.slice(0, eq);
        if ((key !== 'session' && key !== 'pub' && key !== 'node') || params.has(key)) return null;
        let value: string;
        try {
            value = decodeURIComponent(part.slice(eq + 1));
        } catch {
            return null;
        }
        params.set(key, value);
    }
    const sessionId = params.get('session') ?? '';
    const desktopPubHex = params.get('pub') ?? '';
    const nodeUrl = params.get('node') ?? '';
    if (!/^[0-9a-f]{16,64}$/.test(sessionId) || !/^[0-9a-f]{64}$/.test(desktopPubHex)) return null;
    if (nodeUrl && !CANONICAL_HTTPS_ORIGIN.test(nodeUrl)) return null;
    return { sessionId, desktopPubHex, nodeUrl };
}

/**
 * A code meant for this screen (`beanpool://pair`, in any case, around any spaces) that the grammar refuses: the
 * screen says so, so a bad code doesn't look like a camera that hasn't focused. Any other QR is not one: ignored.
 */
export function isUnreadablePairingQr(raw: unknown): boolean {
    return typeof raw === 'string' && raw.trim().toLowerCase().startsWith('beanpool://pair') && parsePairingQr(raw) === null;
}

/**
 * What one code means to the pairing screen, read the same way however it arrived: the camera on the screen, or a
 * `beanpool://pair` link the phone's camera app (or any other) opened (utils/pair-link.ts, app/+native-intent.ts).
 *  - 'pairing': the strict grammar read it; the screen still asks transferTarget where it may go, and sends nothing
 *    before the member's tap, the phone's unlock and the two digits.
 *  - 'unreadable': refused, said so, nothing sent. Any link is, when the grammar refuses it: a link was opened on
 *    purpose, so it is never silently dropped.
 *  - 'ignore': some other QR in the camera's view.
 */
export type PairingRead = { kind: 'pairing'; qr: PairingQr } | { kind: 'unreadable' } | { kind: 'ignore' };

export function readPairingCode(raw: unknown, source: 'camera' | 'link'): PairingRead {
    const qr = parsePairingQr(raw);
    if (qr) return { kind: 'pairing', qr };
    return source === 'link' || isUnreadablePairingQr(raw) ? { kind: 'unreadable' } : { kind: 'ignore' };
}

export type TransferTarget =
    /** `nodeUrl`: the phone's own saved address for that server, in its canonical origin. Where the account goes. */
    | { kind: 'ok'; nodeUrl: string }
    /** The QR names a server this phone does not use. `appHost`: the one it is on, to name in the refusal. */
    | { kind: 'foreign'; scannedHost: string; appHost: string | null }
    /** No server in the QR and none on the phone. */
    | { kind: 'no-node' };

/** The phone's server as it is sent to: an https address the phone saved, in its canonical origin. */
function knownOrigin(url: string | null | undefined): string | null {
    const origin = plainOriginOf(url);
    return origin && origin.startsWith('https://') ? origin : null;
}

/**
 * @param scannedNodeUrl the QR's `node=` from parsePairingQr; empty means "this phone's community"
 * @param appNodeUrl the community this phone is on (`beanpool_anchor_url`)
 * @param savedNodeUrls the phone's saved communities (utils/nodes getSavedNodes)
 */
export function transferTarget(scannedNodeUrl: string, appNodeUrl: string | null, savedNodeUrls: readonly string[]): TransferTarget {
    const own = knownOrigin(appNodeUrl);
    if (!scannedNodeUrl) return own ? { kind: 'ok', nodeUrl: own } : { kind: 'no-node' };
    const scanned = CANONICAL_HTTPS_ORIGIN.test(scannedNodeUrl) ? scannedNodeUrl.replace(/\/$/, '') : null;
    // Equal strings: the QR's canonical spelling is exactly the saved server's canonical origin. No other spelling of
    // it (a port of 443, upper case, another IP form) is the same server here.
    const match = scanned ? [own, ...savedNodeUrls.map(knownOrigin)].find((o) => o !== null && o === scanned) : undefined;
    if (match) return { kind: 'ok', nodeUrl: match };
    return { kind: 'foreign', scannedHost: scanned ? scanned.slice('https://'.length) : '', appHost: own ? own.slice('https://'.length) : null };
}

/** Every address the screen sends to for one pairing: built from the matched saved origin and the session id only. */
export function pairingRequestUrls(target: Extract<TransferTarget, { kind: 'ok' }>, sessionId: string): { probe: string; transfer: string; cancel: string } {
    return {
        probe: `${target.nodeUrl}/api/pair/poll?session=${encodeURIComponent(sessionId)}`,
        transfer: `${target.nodeUrl}/api/pair/transfer`,
        cancel: `${target.nodeUrl}/api/pair/cancel`,
    };
}

/**
 * The other way through a refusal (Marty, 16 Oct: "why can't he add global as a second node to his phone?"): join the
 * global community on this phone first, through its own door (app/join-global.tsx, with its sign-in and checks), then
 * scan again. That door joins GLOBAL_NODE_URL, never the QR's text, and its relay is ours, so the digits still guard it.
 *
 * Only global: no button for any other server (the deciding review of #2025, B1). A join there would make the sender's
 * server one this phone uses, and the next scan of the same code would send the key and the 12 words to it, sealed to
 * the sender's own key: the digits protect nothing on a dishonest relay. The refusal, at the moment the app said no,
 * must not hand the member that server's address and a loop back to the scan. The rule above is unchanged: the QR
 * never adds a server, and the refused QR is not reused.
 */
export type RefusalJoin = { kind: 'global'; href: { pathname: '/join-global'; params: { then: typeof PAIR_AGAIN } } };

/** Where a join started from the pairing screen's refusal comes back to: a fixed name, never a route read from a link. */
export const PAIR_AGAIN = 'pair-device';

export function refusalJoin(target: TransferTarget | undefined): RefusalJoin | null {
    if (!target || target.kind !== 'foreign' || !target.scannedHost) return null;
    if (`https://${target.scannedHost}` !== GLOBAL_NODE_URL) return null;
    return { kind: 'global', href: { pathname: '/join-global', params: { then: PAIR_AGAIN } } };
}

/** The screen after a join: back to the pairing screen when the join started from its refusal, else `otherwise`. */
export function afterJoinRedirect(then: unknown, otherwise: string): string {
    return then === PAIR_AGAIN ? '/pair-device' : otherwise;
}
