/**
 * The QR code a node's /settings page shows for "Sign in with your phone", and the BeanPool app's reading of it.
 *
 *   beanpool-settings-signin:v1?node=<origin, URL-encoded>&p=<pairing id, 64 hex>&c=<short code, 6 chars>
 *
 * Only public things: which node, which pairing, and the short code both screens show for comparison. The secret
 * that makes the sign-in redeemable stays in the browser's httpOnly cookie (apps/server/src/settings-signin-pairing.ts).
 * Not a web link on purpose: a phone's own camera app has nothing to open, so the only way through is the BeanPool
 * app, where the member key and the phone's unlock are.
 */

export const SETTINGS_SIGNIN_QR_PREFIX = 'beanpool-settings-signin:v1?';

const CODE_RE = /^[A-HJ-NP-Z2-9]{6}$/;
const ID_RE = /^[0-9a-f]{64}$/;

export interface SettingsSigninQr {
    /** The node's origin, e.g. https://mullum.beanpool.org (no path, no trailing slash). */
    nodeUrl: string;
    pairingId: string;
    shortCode: string;
}

/** `https://Node.Example:443/settings/` → `https://node.example`. Null for anything that is not http(s). */
export function nodeOrigin(url: string): string | null {
    try {
        const u = new URL(String(url).trim());
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        if (!u.hostname) return null;
        return u.origin.toLowerCase();
    } catch {
        return null;
    }
}

export function buildSettingsSigninQr(q: SettingsSigninQr): string {
    const origin = nodeOrigin(q.nodeUrl);
    if (!origin) throw new Error('nodeUrl must be an http(s) URL');
    return `${SETTINGS_SIGNIN_QR_PREFIX}node=${encodeURIComponent(origin)}&p=${q.pairingId}&c=${q.shortCode}`;
}

export type ParsedSettingsSigninQr =
    | ({ ok: true } & SettingsSigninQr)
    /** not-signin: some other QR (an invite, a device link, a web page). malformed: ours, but damaged. */
    | { ok: false; reason: 'not-signin' | 'malformed' };

export function parseSettingsSigninQr(text: unknown): ParsedSettingsSigninQr {
    if (typeof text !== 'string') return { ok: false, reason: 'not-signin' };
    const raw = text.trim();
    if (!raw.toLowerCase().startsWith(SETTINGS_SIGNIN_QR_PREFIX)) return { ok: false, reason: 'not-signin' };
    if (raw.length > 400) return { ok: false, reason: 'malformed' };
    let params: URLSearchParams;
    try {
        params = new URLSearchParams(raw.slice(SETTINGS_SIGNIN_QR_PREFIX.length));
    } catch {
        return { ok: false, reason: 'malformed' };
    }
    const nodeUrl = nodeOrigin(params.get('node') || '');
    const pairingId = (params.get('p') || '').toLowerCase();
    const shortCode = (params.get('c') || '').toUpperCase();
    if (!nodeUrl || !ID_RE.test(pairingId) || !CODE_RE.test(shortCode)) return { ok: false, reason: 'malformed' };
    return { ok: true, nodeUrl, pairingId, shortCode };
}

/** Same node? Compared by origin, so a trailing slash or a path makes no difference. */
export function isSameNode(a: string, b: string): boolean {
    const x = nodeOrigin(a);
    const y = nodeOrigin(b);
    return !!x && x === y;
}
