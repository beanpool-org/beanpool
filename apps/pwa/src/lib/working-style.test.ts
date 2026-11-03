/**
 * The web's copy of the member's working style (scratch/fable-design/DESIGN-archetype-across-fable.md, slice S1): beside the
 * account, cleared with it, and read for no other key. What a community is sent is core's public form, and only when the
 * community says this key is a member.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { QuizResult } from '@beanpool/core';
import { memoryIndexedDB } from './memory-indexeddb';
import { clearAccountStorage } from './device-prefs';
import { endAccountEpoch, resetAccountEpochForTest } from './account-epoch';
import { resetGroupChatLockStoreForTest } from './group-chat-lock-store';
import { PROFILE_SAVED_EVENT } from './profile-saved';
import { useOwnAvatar } from './useOwnAvatar';
import { adoptWorkingStyle, deliverRemoval, keepQuizResult, publishQuizResult, readWorkingStyle, removeWorkingStyle, shownWorkingStyle, workingStyleToCarry } from './working-style';
import * as api from './api';

vi.mock('./api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./api')>()),
    checkMembership: vi.fn(async () => ({ isMember: true, callsign: 'Alice' })),
    updateMemberProfile: vi.fn(async () => ({ success: true, profile: { publicKey: ME } })),
    getMemberProfile: vi.fn(async () => ({ publicKey: ME, avatar: null, bio: '', contact: null })),
}));

const ME = 'my-user-pubkey';
const quiz = (takenOn: string, primary: QuizResult['primary'] = 'sage'): QuizResult => ({
    primary, secondary: 'weaver', mode: 'quick', scores: { [primary]: 3 } as QuizResult['scores'], takenOn,
});
const row = (takenOn: string) => JSON.stringify({ primary: 'guardian', secondary: 'weaver', mode: 'quick', takenOn });
const SENT = JSON.stringify({ primary: 'sage', secondary: 'weaver', mode: 'quick', takenOn: '2026-11-03' });

beforeEach(() => {
    localStorage.clear();
    resetAccountEpochForTest();
    vi.mocked(api.checkMembership).mockClear();
    vi.mocked(api.updateMemberProfile).mockClear();
    vi.mocked(api.checkMembership).mockResolvedValue({ isMember: true, callsign: 'Alice' });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the browser\'s copy', () => {
    it('holds the full result and answers the public form', () => {
        expect(keepQuizResult(ME, quiz('2026-11-03'))).toBe(SENT);
        expect(JSON.parse(readWorkingStyle(ME)!)).toMatchObject({ primary: 'sage', takenOn: '2026-11-03', scores: { sage: 3 } });
    });

    it('is never read for another key', () => {
        keepQuizResult(ME, quiz('2026-11-03'));
        expect(readWorkingStyle('someone-else')).toBeNull();
    });

    it('goes with the account: every sign-out and delete runs clearAccountStorage', async () => {
        vi.stubGlobal('indexedDB', memoryIndexedDB());
        resetGroupChatLockStoreForTest();
        keepQuizResult(ME, quiz('2026-11-03'));
        await clearAccountStorage();
        expect(readWorkingStyle(ME)).toBeNull();
    });

    it('a sign-out in another tab: this page writes it back no more', () => {
        endAccountEpoch('signed-out');
        keepQuizResult(ME, quiz('2026-11-03'));
        expect(readWorkingStyle(ME)).toBeNull();
    });
});

describe('what a Save carries', () => {
    it('the copy in its public form when newer than the row', () => {
        keepQuizResult(ME, quiz('2026-11-03'));
        expect(workingStyleToCarry(ME, row('2026-11-01'))).toBe(SENT);
        expect(workingStyleToCarry(ME, null)).toBe(SENT);
    });

    it('nothing on a tie, nothing over a newer row, nothing with no copy', () => {
        keepQuizResult(ME, quiz('2026-11-03'));
        expect(workingStyleToCarry(ME, row('2026-11-03'))).toBeNull();
        expect(workingStyleToCarry(ME, row('2026-11-04'))).toBeNull();
        expect(workingStyleToCarry('someone-else', row('2026-11-01'))).toBeNull();
    });
});

describe('a quiz\'s publish', () => {
    it('sends the public form, a day and no clock, to a community that says the key is a member', async () => {
        await publishQuizResult(ME, quiz('2026-11-03'));
        expect(api.updateMemberProfile).toHaveBeenCalledWith(ME, { archetype: SENT });
    });

    it('a guest looking around keeps the result and sends nothing', async () => {
        vi.mocked(api.checkMembership).mockResolvedValue({ isMember: false, callsign: null });
        expect(await publishQuizResult(ME, quiz('2026-11-03'))).toBeNull();
        expect(api.updateMemberProfile).not.toHaveBeenCalled();
    });
});

describe('adopting a newer row into the browser copy', () => {
    it('adopts a newer row into localStorage', () => {
        keepQuizResult(ME, quiz('2026-11-01'));
        expect(adoptWorkingStyle(ME, row('2026-11-03'))).toBe(true);
        expect(JSON.parse(readWorkingStyle(ME)!)).toMatchObject({ primary: 'guardian', takenOn: '2026-11-03' });
    });

    it('orders old millisecond stamps and adopts if newer', () => {
        keepQuizResult(ME, quiz('2026-11-01'));
        const oldStamped = JSON.stringify({ primary: 'spark', secondary: 'weaver', mode: 'quick', updatedAt: '2026-11-04T12:00:00.000Z' });
        expect(adoptWorkingStyle(ME, oldStamped)).toBe(true);
        expect(JSON.parse(readWorkingStyle(ME)!)).toMatchObject({ primary: 'spark', takenOn: '2026-11-04' });
        expect(readWorkingStyle(ME)).not.toContain('updatedAt');
    });

    it('never an older row, and a tie changes nothing', () => {
        keepQuizResult(ME, quiz('2026-11-03'));
        expect(adoptWorkingStyle(ME, row('2026-11-01'))).toBe(false);
        expect(adoptWorkingStyle(ME, row('2026-11-03'))).toBe(false);
        expect(JSON.parse(readWorkingStyle(ME)!)).toMatchObject({ takenOn: '2026-11-03' });
    });
});

// The read at web open is the sidebar's (App.tsx useOwnAvatar): nothing else reads the row before a screen is opened.
describe('at web open', () => {
    const takenOn = () => JSON.parse(readWorkingStyle(ME)!).takenOn;
    /** The node's row, with a picture: the hook shows it the moment before it adopts, so the read is known to be done. */
    const answers = (archetype: string) => vi.mocked(api.getMemberProfile).mockResolvedValue({ publicKey: ME, avatar: '/api/avatar/me', archetype } as any);

    it('adopts a newer row from the node into the browser copy', async () => {
        keepQuizResult(ME, quiz('2026-11-01'));
        answers(row('2026-11-03'));
        renderHook(() => useOwnAvatar(ME));
        await waitFor(() => expect(takenOn()).toBe('2026-11-03'));
    });

    it('an older row from the node changes nothing, and the read after a Save still adopts a newer one', async () => {
        keepQuizResult(ME, quiz('2026-11-03'));
        answers(row('2026-11-01'));
        const { result } = renderHook(() => useOwnAvatar(ME));
        await waitFor(() => expect(result.current).not.toBeNull());
        expect(takenOn()).toBe('2026-11-03');

        answers(row('2026-11-04'));
        act(() => { window.dispatchEvent(new Event(PROFILE_SAVED_EVENT)); });
        await waitFor(() => expect(takenOn()).toBe('2026-11-04'));
    });

    it('a removal still waiting to reach the community goes when the row is read at open', async () => {
        vi.useFakeTimers({ now: new Date('2026-11-03T10:00:00Z'), toFake: ['Date'] });
        try {
            keepQuizResult(ME, quiz('2026-11-01'));
            vi.mocked(api.getMemberProfile).mockResolvedValue({ publicKey: ME, avatar: null, bio: '', contact: null, archetype: row('2026-11-01') } as any);
            vi.mocked(api.updateMemberProfile).mockRejectedValueOnce(new Error('offline'));
            await removeWorkingStyle(ME);
            expect(api.updateMemberProfile).toHaveBeenCalledTimes(1);
            vi.useRealTimers();
            renderHook(() => useOwnAvatar(ME));
            await waitFor(() => expect(api.updateMemberProfile).toHaveBeenCalledTimes(2));
            expect(api.updateMemberProfile).toHaveBeenLastCalledWith(ME, { archetype: null });
        } finally {
            vi.useRealTimers();
        }
    });
});

// ─── S3: Remove my working style ─────────────────────────────────────────────────────────────────────────────────────────
describe('Remove my working style (the browser)', () => {
    const holds = (archetype: string | null) => vi.mocked(api.getMemberProfile).mockResolvedValue({ publicKey: ME, avatar: null, bio: '', contact: null, archetype } as any);
    beforeEach(() => {
        vi.useFakeTimers({ now: new Date('2026-11-03T10:00:00Z'), toFake: ['Date'] });
        vi.mocked(api.getMemberProfile).mockClear();
    });
    afterEach(() => { vi.useRealTimers(); });

    it('takes the browser copy off and tells the community with a null, where it holds a result', async () => {
        keepQuizResult(ME, quiz('2026-11-01'));
        holds(row('2026-11-01'));
        await removeWorkingStyle(ME);
        expect(readWorkingStyle(ME)).toBeNull();
        expect(api.updateMemberProfile).toHaveBeenCalledTimes(1);
        expect(api.updateMemberProfile).toHaveBeenCalledWith(ME, { archetype: null });
        // Done: nothing waits, and the row is shown as it is.
        expect(shownWorkingStyle(ME, row('2026-11-01'))).toBe(row('2026-11-01'));
    });

    it('sends nothing where the community holds none', async () => {
        keepQuizResult(ME, quiz('2026-11-01'));
        holds(null);
        await removeWorkingStyle(ME);
        expect(readWorkingStyle(ME)).toBeNull();
        expect(api.updateMemberProfile).not.toHaveBeenCalled();
    });

    it('a browser that is only looking around as a guest sends nothing, and keeps no removal waiting', async () => {
        vi.mocked(api.checkMembership).mockResolvedValue({ isMember: false } as any);
        keepQuizResult(ME, quiz('2026-11-01'));
        await removeWorkingStyle(ME);
        expect(api.updateMemberProfile).not.toHaveBeenCalled();
        expect(shownWorkingStyle(ME, row('2026-11-01'))).toBe(row('2026-11-01'));
    });

    it('a community that cannot be reached keeps the removal waiting: the old row is not shown, and the next read of the row sends it', async () => {
        keepQuizResult(ME, quiz('2026-11-01'));
        holds(row('2026-11-01'));
        vi.mocked(api.updateMemberProfile).mockRejectedValueOnce(new Error('offline'));
        await removeWorkingStyle(ME);
        expect(api.updateMemberProfile).toHaveBeenCalledTimes(1);
        // The card shows nothing, though the community still holds the result.
        expect(shownWorkingStyle(ME, row('2026-11-01'))).toBeNull();
        expect(adoptWorkingStyle(ME, row('2026-11-01'))).toBe(false);
        expect(readWorkingStyle(ME)).toBeNull();

        expect(await deliverRemoval(ME, row('2026-11-01'))).toBe(false);
        expect(api.updateMemberProfile).toHaveBeenCalledTimes(2);
        expect(api.updateMemberProfile).toHaveBeenLastCalledWith(ME, { archetype: null });
        expect(shownWorkingStyle(ME, row('2026-11-01'))).toBe(row('2026-11-01'));
    });

    it('a community that will not say who is a member keeps it waiting', async () => {
        vi.mocked(api.checkMembership).mockResolvedValue({ isMember: null } as any);
        keepQuizResult(ME, quiz('2026-11-01'));
        await removeWorkingStyle(ME);
        expect(api.updateMemberProfile).not.toHaveBeenCalled();
        expect(await deliverRemoval(ME, row('2026-11-01'))).toBe(true);
    });

    it('a result taken after the removal, on another device, stands: no null, and the browser takes it', async () => {
        keepQuizResult(ME, quiz('2026-11-01'));
        holds(row('2026-11-01'));
        vi.mocked(api.updateMemberProfile).mockRejectedValueOnce(new Error('offline'));
        await removeWorkingStyle(ME);

        expect(await deliverRemoval(ME, row('2026-11-04'))).toBe(false);
        expect(api.updateMemberProfile).toHaveBeenCalledTimes(1);
        expect(adoptWorkingStyle(ME, row('2026-11-04'))).toBe(true);
        expect(shownWorkingStyle(ME, row('2026-11-04'))).toBe(row('2026-11-04'));
    });

    it('a retake after the removal replaces it, and a Save carries the retake, not a null', async () => {
        keepQuizResult(ME, quiz('2026-11-01'));
        holds(row('2026-11-01'));
        vi.mocked(api.updateMemberProfile).mockRejectedValueOnce(new Error('offline'));
        await removeWorkingStyle(ME);
        keepQuizResult(ME, quiz('2026-11-03', 'spark'));
        expect(await deliverRemoval(ME, row('2026-11-01'))).toBe(false);
        expect(api.updateMemberProfile).toHaveBeenCalledTimes(1);
        expect(JSON.parse(workingStyleToCarry(ME, row('2026-11-01'))!)).toMatchObject({ primary: 'spark', takenOn: '2026-11-03' });
    });

    it('a browser signed out in another tab removes nothing', async () => {
        keepQuizResult(ME, quiz('2026-11-01'));
        endAccountEpoch('signed-out');
        await removeWorkingStyle(ME);
        expect(api.updateMemberProfile).not.toHaveBeenCalled();
    });

    it('goes with the account: a removal still waiting is cleared by every sign-out', async () => {
        vi.stubGlobal('indexedDB', memoryIndexedDB());
        resetGroupChatLockStoreForTest();
        keepQuizResult(ME, quiz('2026-11-01'));
        vi.mocked(api.updateMemberProfile).mockRejectedValueOnce(new Error('offline'));
        holds(row('2026-11-01'));
        await removeWorkingStyle(ME);
        expect(shownWorkingStyle(ME, row('2026-11-01'))).toBeNull();
        await clearAccountStorage();
        expect(shownWorkingStyle(ME, row('2026-11-01'))).toBe(row('2026-11-01'));
    });
});

describe('a date from a bad clock or a node (the browser)', () => {
    it('a far-future row is taken as undated: a retake today is newer than it', () => {
        vi.useFakeTimers({ now: new Date('2026-11-03T10:00:00Z'), toFake: ['Date'] });
        try {
            keepQuizResult(ME, quiz('2026-11-03', 'spark'));
            expect(workingStyleToCarry(ME, row('2099-01-01'))).not.toBeNull();
            expect(adoptWorkingStyle(ME, row('2099-01-01'))).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});
