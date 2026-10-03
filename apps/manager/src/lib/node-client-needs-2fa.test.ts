import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchDiagnostics, isAuthFailure, passwordNeeds2faError, PASSWORD_NEEDS_2FA_HINT } from './node-client';

// Sign-in step 7c: a node with two-factor sign-in off refuses the admin password sent with a request, 403
// password_needs_2fa. A profile with only a password then sees the node's words and what to do, never "offline".
const NODE_WORDS = 'Turn on two-factor sign-in in Settings, or use an automation token made from your phone';

function reply(status: number, body: unknown, statusText: string): Response {
    return new Response(JSON.stringify(body), { status, statusText, headers: { 'Content-Type': 'application/json' } });
}

describe('a password-only profile against a node whose two-factor sign-in is off', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('403 password_needs_2fa: the node\'s words plus the way out, and it counts as a sign-in problem, not offline', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => reply(403, { error: NODE_WORDS, code: 'password_needs_2fa' }, 'Forbidden')));
        const err = await fetchDiagnostics('https://node.example', 'pw').catch((e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        const message = (err as Error).message;
        expect(message).toContain(NODE_WORDS);
        expect(message).toContain('Turn on two-factor sign-in, or sign in with an owner\'s token');
        expect(message).not.toContain('HTTP 403: Forbidden');
        expect(isAuthFailure(message)).toBe(true);
    });

    it('another 403 is not taken for it', async () => {
        const other = reply(403, { error: 'Forbidden', code: 'totp_setup_required' }, 'Forbidden');
        expect(await passwordNeeds2faError(other)).toBeNull();
        expect(await other.json()).toEqual({ error: 'Forbidden', code: 'totp_setup_required' }); // the body is left to read
        expect(await passwordNeeds2faError(reply(401, { code: 'password_needs_2fa' }, 'Unauthorized'))).toBeNull();
    });

    it('401: an auth failure, as before', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => reply(401, { error: 'Invalid admin password' }, 'Unauthorized')));
        const err = await fetchDiagnostics('https://node.example', 'wrong').catch((e: Error) => e);
        expect((err as Error).message).toBe('HTTP 401: Unauthorized');
        expect(isAuthFailure((err as Error).message)).toBe(true);
    });

    it('fetch throws: offline, as before', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
        const err = await fetchDiagnostics('https://node.example', 'pw').catch((e: Error) => e);
        expect(isAuthFailure((err as Error).message)).toBe(false);
    });

    it('the hint names both ways out', () => {
        expect(PASSWORD_NEEDS_2FA_HINT).toBe('Turn on two-factor sign-in, or sign in with an owner\'s token');
    });
});
