/**
 * Shared types and dependencies for route modules.
 * Each route module receives a RouteDeps object instead of importing
 * module-level globals — keeps routes testable and decoupled.
 */

import type Koa from 'koa';

export interface ActiveConnectionInfo {
    id: string;
    type: 'sync' | 'admin';
    ip: string;
    userAgent: string;
    connectedAt: number;
    msgSentCount: number;
    msgRecvCount: number;
    lastActivityAt: number;
    callsign?: string;
}

/**
 * Shared dependencies passed to each route factory function.
 * This avoids module-level singleton coupling and keeps routes testable.
 */
export interface RouteDeps {
    /** Async admin password verification (with tarpit on failure) */
    checkAdminAuth: (ctx: any) => Promise<boolean>;
    /** Per-IP rate limiter for auth endpoints */
    rateLimit: (ctx: Koa.Context) => boolean;
    /** Clamp a client-supplied limit to [1, MAX_PAGE_LIMIT] */
    clampLimit: (v: unknown, def?: number) => number;
    /** Clamp a client-supplied offset to >= 0 */
    clampOffset: (v: unknown) => number;
    /** Active WebSocket connection info map */
    activeConnections: Map<string, ActiveConnectionInfo>;
    /** Compute WS analytics (connected, sync, admin counts) */
    calculateAnalytics: () => any;
    /** Whether ENFORCE_READ_AUTH is enabled */
    enforceReadAuth: boolean;
}
