import { describe, it, expect, vi, afterEach } from 'vitest';
import { submitCreateGroup, type CreateGroupSubmitDeps } from '../create-group-submit';
import { dismissKeyboardWithin, KEYBOARD_DISMISS_TIMEOUT_MS } from '../keyboard-dismiss';

const never = () => new Promise<void>(() => {});

function deps(over: Partial<CreateGroupSubmitDeps<string>> = {}) {
    const calls: string[] = [];
    const d = {
        name: 'Seed Library',
        dismissKeyboard: vi.fn(async () => { calls.push('dismiss'); }),
        setSubmitting: vi.fn((b: boolean) => { calls.push(`submitting:${b}`); }),
        create: vi.fn(async (n: string) => { calls.push(`create:${n}`); return `group:${n}`; }),
        onCreated: vi.fn((r: string) => { calls.push(`created:${r}`); }),
        onInvalidName: vi.fn(() => { calls.push('invalid'); }),
        onError: vi.fn(() => { calls.push('error'); }),
        ...over,
    };
    return { d, calls };
}

afterEach(() => { vi.useRealTimers(); });

describe('dismissKeyboardWithin', () => {
    it('resolves as soon as the dismiss does', async () => {
        vi.useFakeTimers();
        let resolved = false;
        void dismissKeyboardWithin(async () => {}).then(() => { resolved = true; });
        await vi.advanceTimersByTimeAsync(0);
        expect(resolved).toBe(true);
    });

    it('resolves after the timeout when the dismiss never resolves (Android < 11 inside a Modal)', async () => {
        vi.useFakeTimers();
        let resolved = false;
        void dismissKeyboardWithin(never).then(() => { resolved = true; });
        await vi.advanceTimersByTimeAsync(KEYBOARD_DISMISS_TIMEOUT_MS - 1);
        expect(resolved).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(resolved).toBe(true);
    });

    it('resolves when the dismiss rejects or throws', async () => {
        await expect(dismissKeyboardWithin(() => Promise.reject(new Error('no')))).resolves.toBeUndefined();
        await expect(dismissKeyboardWithin(() => { throw new Error('no'); })).resolves.toBeUndefined();
    });
});

describe('submitCreateGroup', () => {
    it('marks submitting before waiting on the keyboard, then creates', async () => {
        const { d, calls } = deps();
        await expect(submitCreateGroup(d)).resolves.toBe('created');
        expect(calls).toEqual([
            'submitting:true', 'dismiss', 'create:Seed Library', 'created:group:Seed Library', 'submitting:false',
        ]);
    });

    it('still creates the group when the keyboard dismiss never resolves', async () => {
        vi.useFakeTimers();
        const { d, calls } = deps({ dismissKeyboard: vi.fn(never) });
        const outcome = submitCreateGroup(d);
        expect(d.setSubmitting).toHaveBeenCalledWith(true);
        expect(d.create).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(KEYBOARD_DISMISS_TIMEOUT_MS);
        await expect(outcome).resolves.toBe('created');
        expect(d.create).toHaveBeenCalledWith('Seed Library');
        expect(calls.at(-1)).toBe('submitting:false');
    });

    it('rejects a name under 2 characters without creating, and clears submitting', async () => {
        const { d } = deps({ name: '  a ' });
        await expect(submitCreateGroup(d)).resolves.toBe('invalid');
        expect(d.onInvalidName).toHaveBeenCalledOnce();
        expect(d.create).not.toHaveBeenCalled();
        expect(d.setSubmitting).toHaveBeenLastCalledWith(false);
    });

    it('reports a failed create and clears submitting', async () => {
        const { d } = deps({ create: vi.fn(async () => { throw new Error('node down'); }) });
        await expect(submitCreateGroup(d)).resolves.toBe('failed');
        expect(d.onError).toHaveBeenCalledOnce();
        expect(d.onCreated).not.toHaveBeenCalled();
        expect(d.setSubmitting).toHaveBeenLastCalledWith(false);
    });
});
