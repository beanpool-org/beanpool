/**
 * The phone's communities, faked for the push tests (push-leave.test.ts, push-registration-retry.test.ts): fetch is a
 * fake community per address, which keeps push rows as the server does (apps/server state-engine.ts registerPushToken /
 * applyPushLeave, pinned over HTTP by test-push-leave-statement.ts) and checks each signature from @beanpool/core's
 * definitions and noble, never the app's. Nothing contacts a node.
 *
 * The test file stubs `fetch` (vi.stubGlobal) before it makes one.
 */
import { vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { audienceOf } from '@beanpool/core';
import { boundSignatureValid } from './server-signature-check';

export const PHONE_TOKEN = 'ExponentPushToken[kims-phone]';

const bytes = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.length);

/** The leave statement's signed bytes, written out here: 0xFF, then `beanpool-push-leave/2\nHOST\nKEY\nTOKEN\nSTAMP`. */
export function statementValid(host: string, key: string, token: string, leftAt: unknown, signature: unknown): boolean {
    if (typeof signature !== 'string' || typeof leftAt !== 'number') return false;
    const text = Buffer.from(`beanpool-push-leave/2\n${host}\n${key}\n${token}\n${leftAt}`, 'utf8');
    try {
        return ed25519.verify(bytes(Buffer.from(signature, 'base64')), new Uint8Array([0xff, ...text]), bytes(Buffer.from(key, 'hex')));
    } catch {
        return false;
    }
}

export interface Sent {
    community: string;
    path: string;
    method: string;
    headers: Record<string, string>;
    body: any;
    rawBody: string;
    /** When the community acted on it (a held request acts when it is let through), in the order of `log`. */
    actedAt?: number;
}

/**
 * The phone's communities: each keeps push rows by (key, token) with the phone's stamp, and the leaves it applied, as
 * the server does. `answer` decides what a request meets on the way: 'up', 'down' (a network error), a status the
 * community answers without acting (e.g. 421, 500), 'hold' (it waits until released, then acts), 'portal' (a captive
 * portal answers 200 with its sign-in page, and the community never sees it), or 'silent' (no answer ever: the request
 * ends only when the phone gives up on it).
 */
export class Communities {
    rows = new Map<string, Map<string, number | null>>();
    leaves = new Map<string, Map<string, number>>();
    sent: Sent[] = [];
    log: string[] = [];
    answer: (s: Sent) => 'up' | 'down' | 'hold' | 'portal' | 'silent' | number = () => 'up';
    held: Array<() => void> = [];

    constructor() {
        vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            const rawBody = String(init?.body ?? '');
            const s: Sent = {
                community: url.origin, path: url.pathname, method: init?.method ?? 'GET',
                headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(rawBody || '{}'), rawBody,
            };
            this.sent.push(s);
            const a = this.answer(s);
            if (a === 'down') throw new TypeError('Network request failed');
            if (a === 'silent') {
                return new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
                });
            }
            if (a === 'portal') return new Response('<html><body>Sign in to the Wi-Fi</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
            if (typeof a === 'number') return new Response(JSON.stringify({ error: 'not now' }), { status: a });
            if (a === 'hold') await new Promise<void>((resolve) => this.held.push(resolve));
            return this.act(s, `${url.origin}${url.pathname}`);
        });
    }

    releaseHeld(): void {
        for (const release of this.held.splice(0)) release();
    }

    rowsAt(community: string): Map<string, number | null> {
        if (!this.rows.has(community)) this.rows.set(community, new Map());
        return this.rows.get(community)!;
    }

    has(community: string, key: string, token = PHONE_TOKEN): boolean {
        return this.rowsAt(community).has(`${key}|${token}`);
    }

    private applyLeave(community: string, key: string, token: string, leftAt: number): void {
        const rows = this.rowsAt(community);
        const id = `${key}|${token}`;
        const stamp = rows.get(id);
        if (rows.has(id) && (stamp === null || (stamp as number) <= leftAt)) rows.delete(id);
        if (!this.leaves.has(community)) this.leaves.set(community, new Map());
        const leaves = this.leaves.get(community)!;
        leaves.set(id, Math.max(leaves.get(id) ?? 0, leftAt));
    }

    private act(s: Sent, where: string): Response {
        s.actedAt = this.log.push(`${s.method} ${where}`);
        const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
        const signed = (key: string) => boundSignatureValid({ url: where, method: s.method, headers: s.headers, body: s.rawBody }, key);
        if (s.path === '/api/push-tokens' && s.method === 'POST') {
            const { publicKey, token, registeredAt } = s.body;
            if (!signed(publicKey)) return json(403, { error: 'Invalid cryptographic signature' });
            const id = `${publicKey}|${token}`;
            if ((this.leaves.get(s.community)?.get(id) ?? 0) >= registeredAt) return json(409, { code: 'push_token_left' });
            const rows = this.rowsAt(s.community);
            const had = rows.get(id);
            if (!(typeof had === 'number' && had > registeredAt)) rows.set(id, registeredAt ?? null);
            return json(200, { success: true });
        }
        if (s.path === '/api/push-tokens' && s.method === 'DELETE') {
            const { publicKey, token, leftAt } = s.body;
            if (!signed(publicKey)) return json(403, { error: 'Invalid cryptographic signature' });
            if (typeof leftAt === 'number') this.applyLeave(s.community, publicKey, token, leftAt);
            else this.rowsAt(s.community).delete(`${publicKey}|${token}`);
            return json(200, { success: true });
        }
        const leave = /^\/api\/push-tokens\/leave\/([0-9a-f]{64})$/.exec(s.path);
        if (leave && s.method === 'POST') {
            const { token, leftAt, signature, signedFor } = s.body;
            if (signedFor !== audienceOf(s.community)) return json(421, { code: 'wrong_community' });
            if (!statementValid(signedFor, leave[1], token, leftAt, signature)) return json(403, { code: 'push_leave_refused' });
            this.applyLeave(s.community, leave[1], token, leftAt);
            return json(200, { left: true });
        }
        return json(404, { error: 'Not found' });
    }
}
