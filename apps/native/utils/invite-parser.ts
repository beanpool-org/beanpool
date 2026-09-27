import { assertPlainNodeAddress } from './node-url';

/**
 * The community address in `raw` (an invite link, a deep link, a shared message: "Join my BeanPool community node:
 * https://…"), as `scheme://host[:port]`, or null when it names none.
 *
 * Throws UnsafeNodeAddressError when the address it names isn't plain `host[:port]` (a login, `\`, a
 * percent-encoded or control character: node-url.ts `isPlainNodeAddress`). On iOS such an address reaches a
 * different host than the one the app would sign for. Returning null instead would quietly use whatever community
 * the phone is already on. Punctuation that ends a sentence around a bare address ("…at https://a.org.") isn't part
 * of it.
 */
export function extractNodeOrigin(raw: string): string | null {
    const m = /https?:\/\/[^/?#\s]+/i.exec(raw.trim());
    if (!m) return null;
    const origin = m[0].replace(/[.,;:!)'">]+$/, '');
    assertPlainNodeAddress(origin);
    return origin;
}

/**
 * The community address a deep link names (app/_layout.tsx "Switch Nodes?"): its first http(s) address, else its
 * `server=` value, read only when needed. A bare host gets http:// for an IP or localhost and https:// otherwise.
 * Null when it names none. Throws UnsafeNodeAddressError, like {@link extractNodeOrigin}, for an address that isn't
 * plain `host[:port]`: the deep link must be refused, not followed to the community the phone is already on.
 */
export function deepLinkNodeOrigin(link: string, serverParam: () => string | undefined): string | null {
    const origin = extractNodeOrigin(link);
    if (origin) return origin;
    const raw = serverParam();
    if (!raw) return null;
    let decoded = decodeURIComponent(raw).trim();
    if (!decoded) return null;
    if (!decoded.startsWith('http')) {
        const isIpOrLocal = /^(?:\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(decoded) || decoded.startsWith('localhost');
        decoded = (isIpOrLocal ? 'http://' : 'https://') + decoded;
    }
    assertPlainNodeAddress(decoded);
    return decoded;
}

export function extractInviteToken(raw: string): string {
    const trimmed = raw.trim();
    
    // 1. Explicit invite= param takes highest precedence
    const inviteMatch = trimmed.match(/[?&]invite=([^&\s]+)/);
    if (inviteMatch) return decodeURIComponent(inviteMatch[1]);
    
    // 2. Look for expected pattern anywhere in the string
    const patternMatch = trimmed.match(/(?:INV|BP)-[A-Z0-9]{4}-[A-Z0-9]{4}/i);
    if (patternMatch) return patternMatch[0];
    
    // 3. Fallback: URL path tail parsing
    if (trimmed.includes('http')) {
        const urlParts = trimmed.split('?')[0].split('/');
        const lastPart = urlParts[urlParts.length - 1];
        if (lastPart.length >= 8 && /^[A-Z0-9-]+$/i.test(lastPart)) return lastPart;
    }
    
    return trimmed; // Give up, return raw
}

export function normaliseInviteCode(raw: string): string {
    const extracted = extractInviteToken(raw);
    const trimmed = extracted.trim();
    
    // If it's a long offline ticket, leave it alone
    if (trimmed.length > 20 && trimmed.startsWith('BP-')) return trimmed;
    
    // Remove formatting characters
    const clean = extracted.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    
    if (clean.startsWith('INV')) {
        const body = clean.slice(3);
        if (body.length < 8) return extracted.trim().toUpperCase();
        return `INV-${body.slice(0, 4)}-${body.slice(4, 8)}`;
    }
    
    if (clean.length === 8) {
        return `INV-${clean.slice(0, 4)}-${clean.slice(4, 8)}`;
    }
    
    return trimmed.toUpperCase();
}
