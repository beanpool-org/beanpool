import { vi } from 'vitest';

/** One account the lookup lists: its name at the community and its key. */
export interface Listed {
    publicKey: string;
    callsign: string;
}

/**
 * A community's public lookup (`GET /api/recovery/lookup/:callsign`, apps/server routes/community.ts), which a sign-in
 * restore at the community asks before anything is released and checks the key it rebuilt against (utils/sso-recovery.ts
 * `lookupRestorable`). Answers at `node` as the server does: the accounts whose whole name is the one asked, case
 * forgiven, each with a sign-in copy. Every other request goes to `elsewhere`, which by default refuses it: no test
 * contacts a node. Undone by `vi.unstubAllGlobals()`.
 */
export function stubCommunityLookup(
    node: string,
    accounts: Listed[],
    elsewhere: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async (input) => {
        throw new TypeError(`Network request failed: a test contacted ${String(input)}`);
    },
) {
    const lookup = `${node}/api/recovery/lookup/`;
    const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (!url.startsWith(lookup)) return elsewhere(input, init);
        const asked = decodeURIComponent(url.slice(lookup.length)).trim().toLowerCase();
        const listed = accounts
            .filter(a => a.callsign.toLowerCase() === asked)
            .map(a => ({ ...a, canRecoverBySso: true, joinedAt: null, avatarUrl: null }));
        return new Response(JSON.stringify(listed), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', stub);
    return stub;
}
