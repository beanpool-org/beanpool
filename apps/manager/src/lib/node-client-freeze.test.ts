import { describe, it, expect, vi, afterEach } from 'vitest';
import { freezeNodeUser, NodeRefusalError } from './node-client';
import { FreshProofRequiredError, refusalOf } from './fresh-proof';

/**
 * A freeze the node refuses says the node's words and keeps its code (the deciding review of #3121: freezeNodeUser never
 * read the body, so a refusal said "HTTP 403: Forbidden", or "HTTP 403: " over HTTP/2, and lost owner_only and
 * step_up_required). The bodies are the node's own (server state-engine CREDIT_FREEZE_WORDS, admin-key-auth
 * STEP_UP_REQUIRED_ERROR, routes/admin.ts POST /api/local/admin/users/:pubkey/freeze).
 */
const NODE = 'https://riverbend.example.org';
const KEY = 'c'.repeat(64);
const OWNER_ONLY = { error: 'Only an owner can freeze or unfreeze an owner.', code: 'owner_only' };
const OWN_ACCOUNT = { error: "You can't freeze or unfreeze your own account. Another owner or admin can.", code: 'own_account' };
const KEY_ONLY = { error: 'Sign in with your own key to freeze or unfreeze a member, so it is logged in your name.', code: 'key_session_only' };
const STEP_UP = {
    error: "Confirm it's you first: this change decides who owns the community or how it is kept safe. Press Manage in the BeanPool app again (it asks for your phone's lock), then make the change there.",
    code: 'step_up_required',
};

/** The node's answer as a real Response, its status line as a browser over HTTP/1.1 gives it. */
function answer(status: number, body: unknown) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, statusText: status === 403 ? 'Forbidden' : 'OK', headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

async function refusal(): Promise<unknown> {
    try {
        await freezeNodeUser(NODE, KEY, true, 'session');
    } catch (e) {
        return e;
    }
    throw new Error('freezeNodeUser did not refuse');
}

afterEach(() => vi.unstubAllGlobals());

describe('freezeNodeUser reads the node\'s refusal', () => {
    it.each([
        ['an admin on an owner', OWNER_ONLY],
        ['your own account', OWN_ACCOUNT],
        ['a token, not a key session', KEY_ONLY],
    ])('%s: the node\'s words as the message, with its status and code, never "HTTP 403: Forbidden"', async (_case, body) => {
        answer(403, body);
        const e = await refusal();
        expect(e).toBeInstanceOf(NodeRefusalError);
        expect((e as NodeRefusalError).message).toBe(body.error);
        expect((e as NodeRefusalError).message).not.toMatch(/HTTP 403/);
        expect((e as NodeRefusalError).status).toBe(403);
        expect((e as NodeRefusalError).code).toBe(body.code);
    });

    it('a stale phone hand-off on an owner: FreshProofRequiredError (the phone\'s unlock again), in the node\'s words, with its code', async () => {
        answer(403, STEP_UP);
        const e = await refusal();
        expect(e).toBeInstanceOf(FreshProofRequiredError);
        expect(refusalOf(e)).toEqual({ kind: 'step-up', error: STEP_UP.error });
        expect((e as FreshProofRequiredError).message).toBe(STEP_UP.error);
        expect((e as FreshProofRequiredError).code).toBe('step_up_required');
    });

    it('sends the freeze it was asked for, and answers what the node said', async () => {
        const fetchMock = answer(200, { success: true, frozen: true });
        await expect(freezeNodeUser(NODE, KEY, true, 'session')).resolves.toEqual({ success: true, frozen: true });
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url.endsWith(`riverbend.example.org/api/local/admin/users/${KEY}/freeze`)).toBe(true);
        expect(init.method).toBe('POST');
        expect(JSON.parse(String(init.body))).toEqual({ freeze: true });
    });
});
