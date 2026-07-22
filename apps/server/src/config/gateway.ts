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
    corsAllowedOrigins: ['*'],
    adminIpAllowlist: [],
    features: {
        marketplace: true,
        messaging: true,
        federation: true,
        invites: true,
        servePwa: true,
    },
    rateLimiting: {
        enabled: false,
        maxRequestsPerMinute: 600,
    },
};
