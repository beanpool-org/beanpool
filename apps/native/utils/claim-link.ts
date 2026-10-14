/**
 * The claim link and the claim code's shape (utils/node-claim.ts has the claim itself). Kept apart, with nothing but
 * node-url.ts and core's audienceOf, so app/+native-intent.ts can route a `beanpool://claim` link without loading the
 * signer.
 */
import { audienceOf } from '@beanpool/core';
import { isPlainNodeAddress, normalizeNodeUrl, plainOriginOf, shouldBlockCleartextNodeUrl } from './node-url';

export const CLAIM_CODE_ID = /^[0-9a-f]{8}$/;
const CODE_ID = CLAIM_CODE_ID;
const CODE = /^claim-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/;

/** A whole claim code, `claim-` and four groups of four hex digits, in any case and with spaces around. */
export function isClaimCode(code: unknown): code is string {
    return typeof code === 'string' && CODE.test(code.trim().toLowerCase());
}

/**
 * What the code field holds after a keystroke, a paste or a scan: the hex digits after `claim-`, grouped `a1b2-c3d4-…`,
 * at most 16. The field shows `claim-` itself. A pasted whole code (`claim-a1b2-…`) loses its prefix first, so its
 * `a` and `c`… are not read as digits.
 */
export function claimCodeDigits(raw: string): string {
    const s = String(raw ?? '').trim().toLowerCase().replace(/^claim-?/, '');
    const hex = s.replace(/[^0-9a-f]/g, '').slice(0, 16);
    return (hex.match(/.{1,4}/g) ?? []).join('-');
}

/** The whole code from the field's digits, or null while it is not complete. */
export function claimCodeFromDigits(digits: string): string | null {
    const code = `claim-${claimCodeDigits(digits)}`;
    return CODE.test(code) ? code : null;
}

/**
 * A node address from a claim link or a typed field, as an origin (`scheme://host[:port]`), or null when it is not one
 * the app will connect to and sign for: not a plain address (node-url.ts: no login `@`, no `\`, no whitespace), a
 * scheme other than http(s), or cleartext to a public host. A bare name becomes `<name>.beanpool.org`, as everywhere.
 */
export function claimNodeOrigin(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s || /\s/.test(s)) return null;
    // Any other scheme (javascript:, beanpool:, file:…), but not a host followed by its port.
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s) && !/^https?:\/\//i.test(s)) return null;
    const url = normalizeNodeUrl(s);
    if (!isPlainNodeAddress(url) || !/^https?:/i.test(url)) return null;
    const origin = plainOriginOf(url);
    if (!origin || shouldBlockCleartextNodeUrl(origin) || !audienceOf(origin)) return null;
    return origin;
}

/**
 * Find a community's search box: the origin to ask GET /api/local/claim, only when what was typed is an address (a dot,
 * a colon or a scheme in it), never a bare word: a word is a name to search for, and asking `<word>.beanpool.org` on
 * every keystroke would tell that server what the member typed.
 */
export function claimProbeOrigin(typed: unknown): string | null {
    if (typeof typed !== 'string') return null;
    const s = typed.trim();
    if (!/[.:/]/.test(s)) return null;
    return claimNodeOrigin(s);
}

export interface ClaimLink {
    /** The node's origin, or null when the link named none (or a bad one): the screen then asks for the address. */
    node: string | null;
    /** True when the link named a node the app refused, so the screen can say so rather than silently ask. */
    nodeRefused: boolean;
    codeId: string | null;
    /** The code, only when the link carries a whole one (the terminal QR does; the manager's never does). */
    code: string | null;
}

/**
 * `beanpool://claim?node=…[&id=…][&code=…]`, the link `beanpool claim` prints as a terminal QR and the manager's
 * unclaimed card shows. Null for any other link. Every field is checked on its own; a bad one is dropped.
 */
export function parseClaimLink(link: unknown): ClaimLink | null {
    if (typeof link !== 'string') return null;
    const m = /^beanpool:\/\/\/?claim\/?(?:\?([^#]*))?(?:#.*)?$/i.exec(link.trim());
    if (!m) return null;
    const params = new Map<string, string>();
    for (const part of (m[1] ?? '').split('&')) {
        if (!part) continue;
        const eq = part.indexOf('=');
        const k = eq < 0 ? part : part.slice(0, eq);
        let v = eq < 0 ? '' : part.slice(eq + 1);
        try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch { v = ''; }
        if (!params.has(k)) params.set(k, v);
    }
    const rawNode = params.get('node');
    const node = rawNode ? claimNodeOrigin(rawNode) : null;
    const id = (params.get('id') ?? '').trim().toLowerCase();
    const code = (params.get('code') ?? '').trim().toLowerCase();
    return {
        node,
        nodeRefused: !!rawNode && !node,
        codeId: CODE_ID.test(id) ? id : null,
        code: CODE.test(code) ? code : null,
    };
}

/**
 * The route for a link the system hands the app (app/+native-intent.ts), when it is a claim link: `beanpool://claim?…`
 * or the bare `claim?…` / `/claim?…` path form. Null for every other link.
 */
export function claimRouteFromSystemPath(path: unknown): string | null {
    if (typeof path !== 'string') return null;
    const m = /^(?:beanpool:\/\/\/?|\/)?claim\/?(\?[^#]*)?(?:#.*)?$/i.exec(path.trim());
    if (!m) return null;
    const link = parseClaimLink(`beanpool://claim${m[1] ?? ''}`);
    return link ? claimRouteFor(link) : null;
}

/** The in-app route a claim link opens (app/claim-community.tsx), with only the checked fields. */
export function claimRouteFor(link: ClaimLink): string {
    const q: string[] = [];
    if (link.node) q.push(`node=${encodeURIComponent(link.node)}`);
    if (link.nodeRefused) q.push('refused=1');
    if (link.codeId) q.push(`id=${link.codeId}`);
    if (link.code) q.push(`code=${link.code}`);
    return `/claim-community${q.length ? `?${q.join('&')}` : ''}`;
}

/**
 * What a QR scanned on the claim screen fills: a claim link's code (only for this node: a link naming another node fills
 * nothing), or a bare claim code. Null when the scan holds neither.
 */
export function claimCodeFromScan(raw: unknown, origin: string): string | null {
    if (typeof raw !== 'string') return null;
    const link = parseClaimLink(raw);
    if (link) return link.code && (!link.node || link.node === origin) ? link.code : null;
    return isClaimCode(raw) ? raw.trim().toLowerCase() : null;
}
