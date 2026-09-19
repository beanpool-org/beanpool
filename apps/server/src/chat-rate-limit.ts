import type Koa from 'koa';
import { clientLimiterKey } from './client-ip.js';

/**
 * Throttle for chat lines in rooms that push to many people: group chats (both send routes) and event chats.
 *
 * Its own bucket, keyed by the signed member, not the IP. The auth-attempt limiter is per IP and also guards
 * recovery lookup, verify-password and pairing, so members chatting behind one NAT (a hall's wifi, carrier NAT)
 * would lock each other out of recovery. A request with no signed member falls back to its IP here, still
 * apart from the auth bucket.
 */
export const CHAT_LINES_PER_MINUTE = 30;
const WINDOW_MS = 60_000;

const chatLines = new Map<string, { count: number; resetAt: number }>();

export function chatRateLimit(ctx: Koa.Context, memberPubkey: string | null | undefined): boolean {
    const key = memberPubkey ? `m:${memberPubkey}` : `ip:${clientLimiterKey(ctx)}`;
    const now = Date.now();
    if (chatLines.size > 2000) pruneChatLines(now);
    const entry = chatLines.get(key);
    if (entry && now < entry.resetAt) {
        if (entry.count >= CHAT_LINES_PER_MINUTE) {
            const waitSec = Math.ceil((entry.resetAt - now) / 1000);
            ctx.status = 429;
            ctx.body = { error: `You're sending messages too fast. Try again in ${waitSec}s` };
            return false;
        }
        entry.count++;
    } else {
        chatLines.set(key, { count: 1, resetAt: now + WINDOW_MS });
    }
    return true;
}

/** Drop windows that have closed (the server's periodic cleaner). */
export function pruneChatLines(now = Date.now()): void {
    for (const [k, v] of chatLines) {
        if (now >= v.resetAt) chatLines.delete(k);
    }
}

/** Tests only: forget every bucket. */
export function resetChatRateLimit(): void {
    chatLines.clear();
}
