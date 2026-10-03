/**
 * The app's break-glass code (utils/break-glass.ts): the phone's unlock comes first, the code is fetched signed and
 * checked for shape, only one ask runs at a time (a double tap makes one code), and the phone keeps no copy: any copy an
 * older app kept is deleted (#1531).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const secure = vi.hoisted(() => ({ set: vi.fn(async () => undefined), del: vi.fn(async () => undefined) }));
const unlock = vi.hoisted(() => ({ result: 'ok' as 'ok' | 'no-device-lock' | 'failed', calls: 0 }));

vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    setItemAsync: secure.set,
    deleteItemAsync: secure.del,
}));
vi.mock('../node-admin', () => ({ requireDeviceUnlock: vi.fn(async () => { unlock.calls++; return unlock.result; }) }));
vi.mock('../crypto', () => ({ buildSignedHeaders: vi.fn(async () => ({ 'X-Public-Key': 'pk', 'X-Signature': 'sig' })) }));

import * as breakGlass from '../break-glass';
import { makeBreakGlassCode, issueBreakGlassCodeOnce, forgetBreakGlassCode, sweepKeptBreakGlassCode, breakGlassStoreKey } from '../break-glass';

const identity = { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32) } as any;
const NODE = 'https://mycommunity.example.org/';

beforeEach(() => {
    vi.restoreAllMocks();
    secure.set.mockClear();
    secure.del.mockClear();
    unlock.result = 'ok';
    unlock.calls = 0;
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

describe('one code at a time (a double tap)', () => {
    it('a second press while the first is running asks neither the phone nor the node, and makes no second code', async () => {
        let answer!: (r: Response) => void;
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((res) => { answer = res; }));
        const first = issueBreakGlassCodeOnce(NODE, identity, 'C');
        const second = await issueBreakGlassCodeOnce(NODE, identity, 'C');
        expect(second).toEqual({ ok: false, reason: 'busy', message: expect.any(String) });
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
        answer(new Response(JSON.stringify({ breakGlassCode: 'bg-a1b2-c3d4-e5f6-7890' }), { status: 200 }));
        expect(await first).toEqual({ ok: true, code: 'bg-a1b2-c3d4-e5f6-7890' });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(unlock.calls).toBe(1);
    });

    it('once the first has answered (code or not), the next press asks again', async () => {
        unlock.result = 'failed';
        expect(await issueBreakGlassCodeOnce(NODE, identity, 'C')).toMatchObject({ ok: false, reason: 'failed' });
        unlock.result = 'ok';
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ breakGlassCode: 'bg-0000-1111-2222-3333' }), { status: 200 }));
        expect(await issueBreakGlassCodeOnce(NODE, identity, 'C')).toEqual({ ok: true, code: 'bg-0000-1111-2222-3333' });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
});

describe('the phone keeps no copy', () => {
    it('nothing writes a code to the secure store, and there is no way to keep one', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ breakGlassCode: 'bg-a1b2-c3d4-e5f6-7890' }), { status: 200 }));
        await issueBreakGlassCodeOnce(NODE, identity, 'C');
        expect(secure.set).not.toHaveBeenCalled();
        expect('keepBreakGlassCode' in breakGlass).toBe(false);
    });

    it("an older app's copy is deleted, under the key it was kept under", async () => {
        const key = breakGlassStoreKey('https://host.example:8443', identity.publicKey);
        expect(key).toMatch(/^[A-Za-z0-9._-]+$/);
        await forgetBreakGlassCode('https://host.example:8443', identity.publicKey);
        expect(secure.del).toHaveBeenCalledWith(key);
    });

    it('the sweep at start deletes it, does nothing without a community or a key, and never throws', async () => {
        await sweepKeptBreakGlassCode(NODE, identity.publicKey);
        expect(secure.del).toHaveBeenCalledWith(breakGlassStoreKey(NODE, identity.publicKey));
        secure.del.mockClear();
        await sweepKeptBreakGlassCode(null, identity.publicKey);
        await sweepKeptBreakGlassCode(NODE, undefined);
        expect(secure.del).not.toHaveBeenCalled();
        secure.del.mockRejectedValueOnce(new Error('store unavailable'));
        await expect(sweepKeptBreakGlassCode(NODE, identity.publicKey)).resolves.toBeUndefined();
    });
});
