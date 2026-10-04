import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchDiagnostics, isAuthFailure, passwordNeeds2faError, PASSWORD_RETIRED_HINT } from './node-client';

// Sign-in step 10: an owner retired the node's admin password, so every password path answers 403 password_retired. A
// fleet profile with only a password says so, and that a token is the way in, never "offline".
function reply(status: number, body: unknown, statusText: string): Response {
    return new Response(JSON.stringify(body), { status, statusText, headers: { 'Content-Type': 'application/json' } });
}

describe('a password-only profile against a node whose password is retired', () => {
    afterEach(() => vi.unstubAllGlobals());

    it("403 password_retired: \"this node's password is retired: use a token\", counted as a sign-in problem", async () => {
        vi.stubGlobal('fetch', vi.fn(async () => reply(403, { error: 'retired', code: 'password_retired', passwordRetired: true }, 'Forbidden')));
        const err = await fetchDiagnostics('https://node.example', 'pw').catch((e: Error) => e);
        expect(err).toBeInstanceOf(Error);
        const message = (err as Error).message;
        expect(message).toContain("This node's password is retired: use a token");
        expect(message).not.toContain('HTTP 403: Forbidden');
        expect(isAuthFailure(message)).toBe(true);
    });

    it('the hint is the one the fleet manager matches', async () => {
        const e = await passwordNeeds2faError(reply(403, { code: 'password_retired' }, 'Forbidden'));
        expect(e?.message.startsWith(PASSWORD_RETIRED_HINT)).toBe(true);
    });
});
