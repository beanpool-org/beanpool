/**
 * The app's break-glass code (utils/break-glass.ts): the phone's unlock comes first, the code is fetched signed and
 * checked for shape, and a kept copy goes only to the secure store, readable while the phone is unlocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const secure = vi.hoisted(() => ({ set: vi.fn(async () => undefined), del: vi.fn(async () => undefined) }));
const unlock = vi.hoisted(() => ({ result: 'ok' as 'ok' | 'no-device-lock' | 'failed' }));

vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    setItemAsync: secure.set,
    deleteItemAsync: secure.del,
}));
vi.mock('../node-admin', () => ({ requireDeviceUnlock: vi.fn(async () => unlock.result) }));
vi.mock('../crypto', () => ({ buildSignedHeaders: vi.fn(async () => ({ 'X-Public-Key': 'pk', 'X-Signature': 'sig' })) }));

import { makeBreakGlassCode, keepBreakGlassCode, forgetBreakGlassCode, breakGlassStoreKey } from '../break-glass';

const identity = { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32) } as any;
const NODE = 'https://mycommunity.example.org/';

beforeEach(() => {
    vi.restoreAllMocks();
    secure.set.mockClear();
    secure.del.mockClear();
    unlock.result = 'ok';
});

describe('makeBreakGlassCode', () => {
    it('asks the node, signed, only after the phone unlocks, and returns the code', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ breakGlassCode: 'bg-a1b2-c3d4-e5f6-7890' }), { status: 200 }));
        const r = await makeBreakGlassCode(NODE, identity, 'My Community');
        expect(r).toEqual({ ok: true, code: 'bg-a1b2-c3d4-e5f6-7890' });
        expect(String(fetchSpy.mock.calls[0][0])).toBe('https://mycommunity.example.org/api/node-admin/break-glass');
        expect((fetchSpy.mock.calls[0][1] as RequestInit).method).toBe('POST');
        expect(((fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>)['X-Signature']).toBe('sig');
        expect(secure.set).not.toHaveBeenCalled();
    });

    it('no screen lock, or a failed unlock: the node is never asked', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        unlock.result = 'no-device-lock';
        expect((await makeBreakGlassCode(NODE, identity, 'C')).ok).toBe(false);
        unlock.result = 'failed';
        expect((await makeBreakGlassCode(NODE, identity, 'C')).ok).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("the node's refusal (an admin, a moderator) is passed on, and an answer of the wrong shape is no code", async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Only an owner of this community has a break-glass code' }), { status: 403 }));
        const refused = await makeBreakGlassCode(NODE, identity, 'C');
        expect(refused).toEqual({ ok: false, reason: 'refused', message: 'Only an owner of this community has a break-glass code' });
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ breakGlassCode: '<script>' }), { status: 200 }));
        expect((await makeBreakGlassCode(NODE, identity, 'C')).ok).toBe(false);
    });
});

describe('keeping the code', () => {
    it('goes to the secure store, this device only, under a key the store accepts', async () => {
        await keepBreakGlassCode('https://host.example:8443', identity.publicKey, 'bg-a1b2-c3d4-e5f6-7890');
        const [key, value, opts] = secure.set.mock.calls[0] as unknown as [string, string, { keychainAccessible: number }];
        expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
        expect(key).toBe(breakGlassStoreKey('https://host.example:8443', identity.publicKey));
        expect(value).toBe('bg-a1b2-c3d4-e5f6-7890');
        expect(opts.keychainAccessible).toBe(6);
        await forgetBreakGlassCode('https://host.example:8443', identity.publicKey);
        expect(secure.del).toHaveBeenCalledWith(key);
    });
});
