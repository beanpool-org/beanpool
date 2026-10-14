// Gateway configuration — node self-protection layer.
//
// Controls access to the node API: CORS allowed origins, admin IP allowlists,
// feature toggles, and rate limiting. These are bootstrap-level security
// settings that the node enforces independently of any external manager.
//
// Phase 3 of the architecture vision. Stub for now — will be populated when
// gateway configuration is implemented.

export interface GatewayConfig {
    /** Origins allowed to make cross-origin API requests (for detached PWA hosting). */
    corsAllowedOrigins: string[];

    /** IP addresses or CIDR ranges allowed to access admin endpoints. Empty = all allowed. */
    adminIpAllowlist: string[];

    /** Feature toggles — enable/disable major subsystems. */
    features: {
        marketplace: boolean;
        messaging: boolean;
        federation: boolean;
        invites: boolean;
        servePwa: boolean;
    };

    /** Rate limiting — per-IP request throttling. */
    rateLimiting: {
        enabled: boolean;
        maxRequestsPerMinute: number;
    };
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
    // #131: Empty by default (secure-by-default). CORS only applies to cross-origin browser requests.
    // The built-in Settings UI and Manager Dashboard connect to the same origin (port 8443), so
    // same-origin requests are never blocked. Only add origins here for detached PWA hosting scenarios.
    corsAllowedOrigins: [],
    adminIpAllowlist: [],
    features: {
        marketplace: true,
        messaging: true,
        federation: true,
        invites: true,
        servePwa: true,
    },
    // #132: Rate limiting enabled by default to protect against brute-force and DoS.
    // 120 req/min is generous for legitimate clients while throttling scripted attacks.
    // Admin control-plane routes (/api/local/admin/*) are already exempt from this limit.
    rateLimiting: {
        enabled: true,
        maxRequestsPerMinute: 120,
    },
};

/**
 * Whether the admin IP allow-list lets `ip` reach the admin surface (https-server.ts enforces it): an exact address, `*`,
 * 127.0.0.1 or localhost for the loopback, or a prefix ending in `*`. An empty list lets everyone.
 */
export function adminIpAllowed(list: readonly string[], ip: string): boolean {
    if (list.length === 0) return true;
    return list.some(allowedIp => {
        const norm = String(allowedIp).trim();
        if (ip === norm || norm === '*') return true;
        if ((norm === '127.0.0.1' || norm === 'localhost') && (ip === '127.0.0.1' || ip === '::1')) return true;
        if (norm.endsWith('*') && ip.startsWith(norm.slice(0, -1))) return true;
        return false;
    });
}

/**
 * Why a new admin IP allow-list is refused, or null (amendment 1 to design case 18): it must be a list of addresses, and
 * one that would shut out the address the change comes from is refused, so an owner never locks themselves out of
 * Settings. Left out (undefined) changes nothing and is never refused.
 */
export function gatewayAllowlistRefusal(list: unknown, callerIp: string): string | null {
    if (list === undefined) return null;
    if (!Array.isArray(list) || !list.every(v => typeof v === 'string')) return 'adminIpAllowlist must be a list of addresses';
    if (!adminIpAllowed(list, callerIp)) {
        return `That allow-list would shut out the address you are using now (${callerIp}). Add it to the list, or leave the list empty.`;
    }
    return null;
}
