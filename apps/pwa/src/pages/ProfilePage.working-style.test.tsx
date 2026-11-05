/**
 * The web's three places to take the quiz, and the profile Save (scratch/fable-design/DESIGN-archetype-across-fable.md,
 * slice S1). A retake here reaches this community with a day and no clock, the browser keeps the result, and a Save sends
 * a newer copy, never the row back.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARCHETYPES, calculateSynergy, type QuizResult } from '@beanpool/core';
import { ProfilePage } from './ProfilePage';
import { PublicProfilePage } from './PublicProfilePage';
import * as api from '../lib/api';
import { readWorkingStyle } from '../lib/working-style';

const quizDone = vi.hoisted(() => ({ result: null as unknown }));

vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../components/ImageLightbox', () => ({ ImageLightbox: () => null }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));
vi.mock('../components/ChannelChips', () => ({ ChannelChips: () => null }));
vi.mock('../components/ArchetypeQuizModal', () => ({
    ArchetypeQuizModal: ({ visible, onComplete }: { visible: boolean; onComplete: (r: unknown) => Promise<void> }) => (
        visible ? <button onClick={() => { onComplete(quizDone.result).catch(() => {}); }}>Finish quiz</button> : null
    ),
}));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false),
    blockUser: vi.fn(async () => {}),
    unblockUser: vi.fn(async () => {}),
    onBlocklistUpdated: vi.fn(() => () => {}),
    getBlocklistFullNote: vi.fn(() => null),
}));
vi.mock('../lib/api', () => ({
    getMemberProfile: vi.fn(),
    updateMemberProfile: vi.fn(async () => ({ success: true, profile: {} })),
    checkMembership: vi.fn(async () => ({ isMember: true, callsign: 'Alice' })),
    registerMember: vi.fn(async () => null),
    getMemberRatings: vi.fn(async () => ({ average: 0, count: 0, asProvider: { average: 0, count: 0 }, asReceiver: { average: 0, count: 0 }, ratings: [] })),
    getMarketplacePosts: vi.fn(async () => []),
    getBalance: vi.fn(async () => ({ balance: 1, floor: -50, earnedCredit: 0, tier: { name: 'Green Bean', emoji: '🌱' } })),
    getRatingsGiven: vi.fn(async () => ({ ratings: [] })),
    getFriends: vi.fn(async () => []),
    submitRating: vi.fn(async () => ({})),
    getPublicChannels: vi.fn(async () => ({ channels: [] })),
}));

const ME: any = { publicKey: 'my-user-pubkey', privateKey: 'priv', callsign: 'Alice', createdAt: '2026-01-01T00:00:00.000Z' };
const COPY_KEY = `bp_working_style_${ME.publicKey}`;
const older = JSON.stringify({ primary: 'guardian', secondary: 'weaver', mode: 'quick', updatedAt: '2026-10-01T01:02:03.456Z' });
const newer: QuizResult = { primary: 'spark', secondary: 'sage', mode: 'deep', scores: { spark: 9 } as QuizResult['scores'], takenOn: '2026-11-03' };
const newerSent = JSON.stringify({ primary: 'spark', secondary: 'sage', mode: 'deep', takenOn: '2026-11-03' });
const myProfile = (archetype: string | null) => ({
    publicKey: ME.publicKey, callsign: 'Alice', avatar: null, bio: 'Bakes on Fridays', role: 'member', archetype, joinedAt: '2026-01-01T00:00:00Z', contact: null,
});
const sentArchetypes = () => vi.mocked(api.updateMemberProfile).mock.calls.map(([, update]) => update.archetype);

beforeEach(() => {
    localStorage.clear();
    quizDone.result = newer;
    vi.mocked(api.updateMemberProfile).mockClear();
    vi.mocked(api.checkMembership).mockResolvedValue({ isMember: true, callsign: 'Alice' });
});
afterEach(() => { cleanup(); });

const openProfile = async (row: string | null) => {
    vi.mocked(api.getMemberProfile).mockResolvedValue(myProfile(row) as any);
    render(<ProfilePage identity={ME} onBack={() => {}} />);
    await screen.findByText('Save Profile Changes');
};
const save = async () => {
    fireEvent.click(screen.getByText('Save Profile Changes'));
    await waitFor(() => expect(api.updateMemberProfile).toHaveBeenCalled());
};

describe('ProfilePage Save', () => {
    it('sends the browser\'s newer result in its public form, not the row it read', async () => {
        localStorage.setItem(COPY_KEY, JSON.stringify(newer));
        await openProfile(older);
        await save();
        expect(sentArchetypes()).toEqual([newerSent]);
    });

    it('a row stamped to the millisecond is not sent back', async () => {
        await openProfile(older);
        await save();
        expect(sentArchetypes()).toEqual([undefined]);
    });

    it('a member who never took the quiz sends nothing of it', async () => {
        await openProfile(null);
        await save();
        expect(sentArchetypes()).toEqual([undefined]);
    });

    it('a row the node never showed: the browser\'s result stays here', async () => {
        localStorage.setItem(COPY_KEY, JSON.stringify(newer));
        vi.mocked(api.getMemberProfile).mockRejectedValue(new Error('offline'));
        render(<ProfilePage identity={ME} onBack={() => {}} />);
        await screen.findByText('Save Profile Changes');
        await save();
        expect(sentArchetypes()).toEqual([undefined]);
    });
});

describe('the quiz on the web', () => {
    it('ProfilePage: the browser keeps the result and the community is sent the day, no clock', async () => {
        await openProfile(null);
        fireEvent.click(screen.getByText('⚡ Take 60s Quiz'));
        fireEvent.click(await screen.findByText('Finish quiz'));
        await waitFor(() => expect(sentArchetypes()).toEqual([newerSent]));
        expect(JSON.parse(readWorkingStyle(ME.publicKey)!).scores.spark).toBe(9);
    });

    it('a publish that failed: the next Save sends it, because the community still doesn\'t hold it', async () => {
        await openProfile(older);
        vi.mocked(api.updateMemberProfile).mockRejectedValueOnce(new Error('offline'));
        fireEvent.click(screen.getByLabelText('Retake community working style quiz'));
        fireEvent.click(await screen.findByText('Finish quiz'));
        await waitFor(() => expect(api.updateMemberProfile).toHaveBeenCalledTimes(1));
        fireEvent.click(screen.getByText('Save Profile Changes'));
        await waitFor(() => expect(api.updateMemberProfile).toHaveBeenCalledTimes(2));
        expect(sentArchetypes()).toEqual([newerSent, newerSent]);
    });

    describe('a publish that failed, with a row dated the same day', () => {
        const today = JSON.stringify({ primary: 'guardian', secondary: 'weaver', mode: 'quick', takenOn: newer.takenOn });
        const saveAgain = async (calls: number) => {
            fireEvent.click(screen.getByText('Save Profile Changes'));
            await waitFor(() => expect(api.updateMemberProfile).toHaveBeenCalledTimes(calls));
            await screen.findByText('Save Profile Changes');
        };
        const failedRetake = async () => {
            await openProfile(today);
            vi.mocked(api.updateMemberProfile).mockRejectedValueOnce(new Error('offline'));
            fireEvent.click(screen.getByLabelText('Retake community working style quiz'));
            fireEvent.click(await screen.findByText('Finish quiz'));
            await waitFor(() => expect(api.updateMemberProfile).toHaveBeenCalledTimes(1));
        };

        it('the next Save sends it, though the rule sees a tie', async () => {
            await failedRetake();
            await saveAgain(2);
            expect(sentArchetypes()).toEqual([newerSent, newerSent]);
        });

        it('the card shows the retake, not the row it couldn\'t replace', async () => {
            await failedRetake();
            expect(await screen.findByText(ARCHETYPES.spark.name, { exact: false })).toBeTruthy();
            expect(screen.queryByText(ARCHETYPES.guardian.name, { exact: false })).toBeNull();
        });

        it('sent once: the Save after that carries nothing, and the card keeps it', async () => {
            await failedRetake();
            await saveAgain(2);
            await saveAgain(3);
            expect(sentArchetypes()).toEqual([newerSent, newerSent, undefined]);
            expect(await screen.findByText(ARCHETYPES.spark.name, { exact: false })).toBeTruthy();
        });

        it('a Save that failed too keeps it for the next', async () => {
            await failedRetake();
            vi.mocked(api.updateMemberProfile).mockRejectedValueOnce(new Error('offline'));
            const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
            await saveAgain(2);
            await saveAgain(3);
            alert.mockRestore();
            expect(sentArchetypes()).toEqual([newerSent, newerSent, newerSent]);
        });

        it('the quiz\'s own Save landing it: the next Save has nothing to carry', async () => {
            await failedRetake();
            fireEvent.click(await screen.findByText('Finish quiz'));
            await waitFor(() => expect(api.updateMemberProfile).toHaveBeenCalledTimes(2));
            await saveAgain(3);
            expect(sentArchetypes()).toEqual([newerSent, newerSent, undefined]);
        });

        it('a row the node never showed: it stays here, as any result does', async () => {
            vi.mocked(api.getMemberProfile).mockRejectedValue(new Error('offline'));
            render(<ProfilePage identity={ME} onBack={() => {}} />);
            await screen.findByText('Save Profile Changes');
            vi.mocked(api.updateMemberProfile).mockRejectedValueOnce(new Error('offline'));
            fireEvent.click(screen.getByText('⚡ Take 60s Quiz'));
            fireEvent.click(await screen.findByText('Finish quiz'));
            await waitFor(() => expect(api.updateMemberProfile).toHaveBeenCalledTimes(1));
            await saveAgain(2);
            expect(sentArchetypes()).toEqual([newerSent, undefined]);
        });
    });

    it('PublicProfilePage: the same', async () => {
        vi.mocked(api.getMemberProfile).mockResolvedValue(myProfile(null) as any);
        render(<PublicProfilePage identity={ME} pubkey={ME.publicKey} onBack={() => {}} onMessage={() => {}} onNavigatePost={() => {}} />);
        fireEvent.click(await screen.findByText('⚡ Take 60s Quiz'));
        fireEvent.click(await screen.findByText('Finish quiz'));
        await waitFor(() => expect(sentArchetypes()).toEqual([newerSent]));
        expect(readWorkingStyle(ME.publicKey)).not.toBeNull();
    });

    it('my own card shows the browser\'s newer result over the row', async () => {
        localStorage.setItem(COPY_KEY, JSON.stringify(newer));
        await openProfile(older);
        expect(await screen.findByText(ARCHETYPES.spark.name, { exact: false })).toBeTruthy();
        expect(screen.queryByText(ARCHETYPES.guardian.name, { exact: false })).toBeNull();
    });

    it('my own card on the member page does too', async () => {
        localStorage.setItem(COPY_KEY, JSON.stringify(newer));
        vi.mocked(api.getMemberProfile).mockResolvedValue(myProfile(older) as any);
        render(<PublicProfilePage identity={ME} pubkey={ME.publicKey} onBack={() => {}} onMessage={() => {}} onNavigatePost={() => {}} />);
        expect(await screen.findByText(ARCHETYPES.spark.name, { exact: false })).toBeTruthy();
    });

    it('another member\'s page reads the chemistry from my newest result, though this community\'s row has none', async () => {
        localStorage.setItem(COPY_KEY, JSON.stringify(newer));
        const PEER = 'peer-pubkey-123456789';
        vi.mocked(api.getMemberProfile).mockImplementation(async (pk: string) => (pk === PEER
            ? { ...myProfile(JSON.stringify({ primary: 'weaver', secondary: 'sage', mode: 'quick', takenOn: '2026-11-01' })), publicKey: PEER, callsign: 'Bob' }
            : myProfile(null)) as any);
        render(<PublicProfilePage identity={ME} pubkey={PEER} onBack={() => {}} onMessage={() => {}} onNavigatePost={() => {}} />);
        expect(await screen.findByText(calculateSynergy('spark', 'weaver').headline)).toBeTruthy();
    });
});
