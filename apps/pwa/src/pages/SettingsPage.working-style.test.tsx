/**
 * Settings, the third place to take the quiz on the web (scratch/fable-design/DESIGN-archetype-across-fable.md, slice S1):
 * the browser keeps the result, this community is sent a day and no clock, and the card shows the newest of the two.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARCHETYPES, type QuizResult } from '@beanpool/core';
import { SettingsPage } from './SettingsPage';
import * as api from '../lib/api';
import { readWorkingStyle } from '../lib/working-style';
import { LanguageRoot } from '../words-w3.test-support';

const quizDone = vi.hoisted(() => ({ result: null as unknown }));

vi.mock('../components/ArchetypeQuizModal', () => ({
    ArchetypeQuizModal: ({ visible, onComplete }: { visible: boolean; onComplete: (r: unknown) => Promise<void> }) => (
        visible ? <button onClick={() => { void onComplete(quizDone.result); }}>Finish quiz</button> : null
    ),
}));
vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        getNotificationPreferences: vi.fn(async () => ({ notify_chat: 'true', notify_marketplace: 'true', notify_escrow: 'false' })),
        getMemberPreferences: vi.fn(async () => ({ holiday_mode: 'false', show_as_connection_in_common: 'true' })),
        getMemberProfile: vi.fn(),
        updateMemberProfile: vi.fn(async () => ({ success: true, profile: null })),
        checkMembership: vi.fn(async () => ({ isMember: true, callsign: 'Kim' })),
        getNodeStats: vi.fn(async () => ({ members: 14, posts: 30, transactions: 9 })),
        getCommunityHealth: vi.fn(async () => ({})),
        getSignInRecovery: vi.fn(async () => null),
        getFriends: vi.fn(async () => []),
    };
});
vi.mock('../lib/blocklist', async () => {
    const actual = await vi.importActual('../lib/blocklist');
    return { ...actual, loadBlocklist: vi.fn(async () => []) };
});
vi.mock('../lib/member-area', async () => {
    const actual = await vi.importActual('../lib/member-area');
    return { ...actual, useNearbyLimits: vi.fn(() => null), readMyArea: vi.fn(async () => null) };
});

const identity: any = { publicKey: 'me-pk', privateKey: 'priv-key-hex', callsign: 'Kim', mnemonic: [] };
const newer: QuizResult = { primary: 'spark', secondary: 'sage', mode: 'deep', scores: { spark: 9 } as QuizResult['scores'], takenOn: '2026-11-03' };
const newerSent = JSON.stringify({ primary: 'spark', secondary: 'sage', mode: 'deep', takenOn: '2026-11-03' });
const older = JSON.stringify({ primary: 'guardian', secondary: 'weaver', mode: 'quick', takenOn: '2026-10-01' });
const row = (archetype: string | null) => ({ publicKey: 'me-pk', callsign: 'Kim', avatar: null, bio: '', contact: null, archetype });

const renderSettings = () => render(
    <LanguageRoot draw={() => (
        <SettingsPage identity={identity} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}}
            onReRunSetup={() => {}} nodeVersion="1.2.29" />
    )} />,
);

beforeEach(() => {
    localStorage.clear();
    quizDone.result = newer;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    vi.mocked(api.updateMemberProfile).mockClear();
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('Settings and the working style', () => {
    it('the quiz: the browser keeps the result, the community is sent the day and no clock', async () => {
        vi.mocked(api.getMemberProfile).mockResolvedValue(row(null) as any);
        renderSettings();
        fireEvent.click(await screen.findByText('⚡ Take 60s Quiz'));
        fireEvent.click(await screen.findByText('Finish quiz'));
        await waitFor(() => expect(api.updateMemberProfile).toHaveBeenCalledWith('me-pk', { archetype: newerSent }));
        expect(JSON.parse(readWorkingStyle('me-pk')!).scores.spark).toBe(9);
    });

    it('the card shows the browser\'s newer result over the row', async () => {
        localStorage.setItem('bp_working_style_me-pk', JSON.stringify(newer));
        vi.mocked(api.getMemberProfile).mockResolvedValue(row(older) as any);
        renderSettings();
        expect(await screen.findByText(ARCHETYPES.spark.name, { exact: false })).toBeInTheDocument();
        expect(screen.queryByText(ARCHETYPES.guardian.name, { exact: false })).toBeNull();
    });
});
