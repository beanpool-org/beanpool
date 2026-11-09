import { communityAddressIn, inviteCodeIn } from '@beanpool/core';
import { assertPlainNodeAddress } from './node-url';
import { withNodeScheme } from './node-address-scheme';

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
 * What a pasted invite holds, however much of the message was pasted (core invite-text.ts): the code alone, never the
 * message's other words, and the community's address from its link, else from the message's last line ("Community
 * address: byron.beanpool.org"), else null. A paste of the code alone names no community: the invite step asks for it.
 * Throws UnsafeNodeAddressError, like {@link extractNodeOrigin}, for an address that isn't plain `host[:port]`.
 */
export function readInviteText(raw: string): { code: string | null; origin: string | null } {
    const code = inviteCodeIn(raw);
    const linked = extractNodeOrigin(raw);
    if (linked) return { code, origin: linked };
    const bare = communityAddressIn(raw);
    if (!bare) return { code, origin: null };
    const origin = withNodeScheme(bare);
    assertPlainNodeAddress(origin);
    return { code, origin };
}

/**
 * Whether a paste or a scan is an invite for the invite step: a code anywhere in it (a link's `invite=`, an `INV-xxxx-xxxx`
 * inside a message), or a short code in an older shape that the step normalises. A message with the code in it is one,
 * whether or not its link was pasted too; before 9 Nov only a paste that started with the code or held a link was.
 */
export function holdsInvite(raw: string): boolean {
    const content = String(raw ?? '').trim();
    return content.startsWith('BP-') || content.startsWith('INV-') || inviteCodeIn(content) !== null;
}

/**
 * The community address a deep link names (app/_layout.tsx "Switch Nodes?"): its first http(s) address, else its
 * `server=` value, read only when needed. A bare host gets its scheme from withNodeScheme (utils/node-address-scheme.ts):
 * http:// only for localhost and a private/LAN IPv4 address, https:// otherwise, a public IPv4 address included.
 * Null when it names none. Throws UnsafeNodeAddressError, like {@link extractNodeOrigin}, for an address that isn't
 * plain `host[:port]`: the deep link must be refused, not followed to the community the phone is already on.
 */
export function deepLinkNodeOrigin(link: string, serverParam: () => string | undefined): string | null {
    const origin = extractNodeOrigin(link);
    if (origin) return origin;
    const raw = serverParam();
    if (!raw) return null;
    const decoded = withNodeScheme(decodeURIComponent(raw));
    if (!decoded) return null;
    assertPlainNodeAddress(decoded);
    return decoded;
}

/**
 * The community People's invite box redeems at (app/(tabs)/people.tsx handleRedeem): the address the invite names, else
 * the address typed beside it (its scheme from withNodeScheme), else the community the phone is on. Throws
 * UnsafeNodeAddressError, like {@link extractNodeOrigin}, for an invite naming an address that isn't plain. A typed one
 * is checked where the phone moves (utils/join-another-community.ts).
 */
export function redeemTargetUrl(rawInvite: string, typedNodeUrl: string, anchorUrl: string): string {
    return extractNodeOrigin(rawInvite) ?? (withNodeScheme(typedNodeUrl) || anchorUrl);
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
