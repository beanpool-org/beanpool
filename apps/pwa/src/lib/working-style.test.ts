/**
 * The web's copy of the member's working style (scratch/fable-design/DESIGN-archetype-across-fable.md, slice S1): beside the
 * account, cleared with it, and read for no other key. What a community is sent is core's public form, and only when the
 * community says this key is a member.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { QuizResult } from '@beanpool/core';
import { memoryIndexedDB } from './memory-indexeddb';
import { clearAccountStorage } from './device-prefs';
import { endAccountEpoch, resetAccountEpochForTest } from './account-epoch';
import { resetGroupChatLockStoreForTest } from './group-chat-lock-store';
import { keepQuizResult, publishQuizResult, readWorkingStyle, workingStyleToCarry } from './working-style';
import * as api from './api';

vi.mock('./api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./api')>()),
    checkMembership: vi.fn(async () => ({ isMember: true, callsign: 'Alice' })),
    updateMemberProfile: vi.fn(async () => ({ success: true, profile: { publicKey: ME } })),
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
