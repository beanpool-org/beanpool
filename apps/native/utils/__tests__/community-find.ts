import { vi } from 'vitest';

/** One account a community's find names: its name at the community and its key. */
export interface Found {
    publicKey: string;
    callsign: string;
}

/** A Response as a signed POST mock hands one back. */
export function answer(status: number, body: unknown): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

/**
 * A community's find (apps/server routes/recovery-collect.ts, recovery S0), as a test's `signedPost` mock answers it: the
 * find nonce (`POST /api/recovery/find-nonce`, `nonce`), and the accounts a verified sign-in protects there (`POST
 * /api/recovery/find`, `accounts`), which a sign-in restore at the community asks before anything is released
 * (utils/sso-recovery.ts `recoverAccountWithSso`). Undefined for every other path: the test's own handler answers the
 * collect by the find's hold and the copy.
 */
export function findAnswer(path: string, accounts: readonly Found[], nonce = 'find-nonce-1'): Response | undefined {
    if (path === '/api/recovery/find-nonce') return answer(200, { nonce, expiresInSeconds: 600, clientIds: {} });
    if (path === '/api/recovery/find') return answer(200, { accounts });
    return undefined;
}

/**
 * Every fetch this test makes outside a mocked `signedPost` goes to `elsewhere`, which by default refuses it: no test
 * contacts a node. A sign-in restore at the community asks nothing unsigned now (the name lookup is gone, recovery S2).
 * Undone by `vi.unstubAllGlobals()`.
 */
export function noNodeContacted(
    elsewhere: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async (input) => {
        throw new TypeError(`Network request failed: a test contacted ${String(input)}`);
    },
) {
    const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => elsewhere(input, init));
    vi.stubGlobal('fetch', stub);
    return stub;
}
