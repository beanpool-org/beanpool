/**
 * "Scan from this browser" (front doors S9): a member signed in on the web brings the account to this phone without
 * typing the 12 words. The browser shows `beanpool://pair-in?session=…&pub=…&node=…` (apps/pwa BringToPhone); this phone
 * offers a fresh X25519 key to that community's relay, SHOWS the four digits the relay gives it, and the member types
 * them in the browser. Only then does the browser seal the account to this phone's key (apps/server pairing-relay.ts).
 *
 * What the phone checks, in order (app/pair-in.tsx):
 *  1. The code, by a strict grammar, never a URL parser (as pair-device-target.ts reads the other way's): exactly
 *     session, pub and node, each once; node a plain https origin in its one canonical spelling, and required: a phone
 *     with no account has no community of its own to fall back on.
 *  2. The seal opens only with the QR's `pub` (@beanpool/core openPairingPayloadOnPhone): an account sealed by any other
 *     key, a relay's swap included, does not open.
 *  3. The account is its 12 words, and they must make the public key it names (recoveryWordsMatchPublicKey). The phone
 *     never takes a private key from the relay: it restores from the words, through the one gate every 12-word restore
 *     passes (restore-account.ts restoreFromWords), which never replaces another account on the phone.
 *  4. The member sees whose account it is and from which community, and taps to bring it, before anything is saved.
 */
import { recoveryWordsMatchPublicKey } from '@beanpool/core';
import { CANONICAL_HTTPS_ORIGIN } from './pair-device-target';
import { pairLinkFromRoute } from './pair-link';

export interface PairInQr {
    sessionId: string;
    /** The browser's session key: the only key a seal is opened with. */
    browserPubHex: string;
    /** The community's https origin, no trailing slash. Where the offer, the collect and the restore go. */
    nodeUrl: string;
}

const PAIR_IN_PREFIX = 'beanpool://pair-in?';
const MAX_LINK = 600;

/** The browser's code, read strictly (rule 1), or null: refused, nothing sent. */
export function parsePairInQr(raw: unknown): PairInQr | null {
    if (typeof raw !== 'string' || raw.length > MAX_LINK || !raw.startsWith(PAIR_IN_PREFIX)) return null;
    const query = raw.slice(PAIR_IN_PREFIX.length);
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
    const browserPubHex = params.get('pub') ?? '';
    const node = params.get('node') ?? '';
    if (!/^[0-9a-f]{16,64}$/.test(sessionId) || !/^[0-9a-f]{64}$/.test(browserPubHex)) return null;
    if (!CANONICAL_HTTPS_ORIGIN.test(node)) return null;
    return { sessionId, browserPubHex, nodeUrl: node.replace(/\/$/, '') };
}

/** A code meant for this screen that the grammar refuses: said so, rather than looking like a camera still focusing. */
export function isUnreadablePairInQr(raw: unknown): boolean {
    return typeof raw === 'string' && raw.trim().toLowerCase().startsWith('beanpool://pair-in') && parsePairInQr(raw) === null;
}

/** Every address one pairing sends to: the QR's canonical origin and fixed paths only. */
export function pairInUrls(qr: PairInQr): { offer: string; collect: string; cancel: string } {
    return { offer: `${qr.nodeUrl}/api/pair/offer`, collect: `${qr.nodeUrl}/api/pair/collect`, cancel: `${qr.nodeUrl}/api/pair/cancel` };
}

/** The account the browser sealed, as the phone takes it: the words, the key they must make, and the name to show. */
export interface PairInAccount {
    publicKey: string;
    words: string[];
    /** Shown on the confirm only; the name saved is the community's (restoreFromWords asks it). */
    callsign: string;
}

/** Rule 3: the opened seal, or null when it is not 12 words that make the key it names. */
export function readPairInAccount(opened: unknown): PairInAccount | null {
    if (!opened || typeof opened !== 'object') return null;
    const o = opened as Record<string, unknown>;
    if (o.version !== 1 || typeof o.publicKey !== 'string' || !/^[0-9a-f]{64}$/.test(o.publicKey)) return null;
    if (!Array.isArray(o.mnemonic) || o.mnemonic.length !== 12 || !o.mnemonic.every((w) => typeof w === 'string')) return null;
    const words = (o.mnemonic as string[]).map((w) => w.trim().toLowerCase());
    if (!recoveryWordsMatchPublicKey(words, o.publicKey)) return null;
    const callsign = typeof o.callsign === 'string' ? o.callsign.trim().slice(0, 64) : '';
    return { publicKey: o.publicKey, words, callsign };
}

/** `beanpool://pair-in?…` in the spellings a system hands over (as pair-link.ts reads `pair`); `pair-in` the whole segment. */
const PAIR_IN_PATH = /^(?:beanpool:\/\/\/?|\/)?pair-in\/?(?=[?#]|$)/i;

/** The screen's route for a pair-in link opened from the phone's camera app (`/pair-in?qr=<the link as hex>`), or null. */
export function pairInRouteFromSystemPath(path: unknown): string | null {
    if (typeof path !== 'string') return null;
    const m = PAIR_IN_PATH.exec(path);
    if (!m) return null;
    const link = `beanpool://pair-in${path.slice(m[0].length)}`;
    // Hex, for the reason pair-link.ts gives: the router decodes a query twice, and hex has nothing to decode.
    let hex = '';
    for (let i = 0; i < Math.min(link.length, MAX_LINK + 1); i++) hex += link.charCodeAt(i).toString(16).padStart(4, '0');
    return `/pair-in?qr=${hex}`;
}

/** The link a route's `qr` carries, exactly; '' for anything else (unreadable). */
export function pairInLinkFromRoute(qr: unknown): string {
    return pairLinkFromRoute(qr);
}

/** A pair-in link, so the root layout's invite reader leaves it alone (its `node=` is not an invite's server). */
export function isPairInLink(url: unknown): boolean {
    return typeof url === 'string' && PAIR_IN_PATH.test(url);
}
