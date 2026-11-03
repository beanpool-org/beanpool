/**
 * The community's name in the invite message is read from its card but never waited for long (front doors S10; found in the
 * lane's own self-check: the card read alone may take 15 s offline, which left Share doing nothing).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shareCommunityName } from '../invite-share-name';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('shareCommunityName', () => {
    it('is the card\'s name when it arrives in time', async () => {
        const p = shareCommunityName('mullum.beanpool.org', async () => 'Mullum');
        await vi.advanceTimersByTimeAsync(10);
        expect(await p).toBe('Mullum');
    });

    it('is the address when the card has not answered after two seconds, whatever it does later', async () => {
        let late: (n: string) => void = () => {};
        const p = shareCommunityName('mullum.beanpool.org', () => new Promise<string>((r) => { late = r; }));
        await vi.advanceTimersByTimeAsync(1999);
        let done = false;
        void p.then(() => { done = true; });
        await vi.advanceTimersByTimeAsync(0);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(2);
        expect(await p).toBe('mullum.beanpool.org');
        late('Too late');
    });

    it('is the address when the read fails or says nothing', async () => {
        const failed = shareCommunityName('a.example.org', async () => { throw new Error('offline'); });
        await vi.advanceTimersByTimeAsync(10);
        expect(await failed).toBe('a.example.org');
        const empty = shareCommunityName('b.example.org', async () => '  ');
        await vi.advanceTimersByTimeAsync(10);
        expect(await empty).toBe('b.example.org');
    });

    it('leaves no timer behind once it has answered', async () => {
        const p = shareCommunityName('c.example.org', async () => 'C');
        await vi.advanceTimersByTimeAsync(10);
        await p;
        expect(vi.getTimerCount()).toBe(0);
    });
});
