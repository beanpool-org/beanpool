/**
 * Settings in the member's language (words S3, web sweep W3): the page drawn for real, every section and every screen it
 * opens, in the pseudo-locale (`xx`: every sentence accented, padded ~35 % and bracketed). Any text, screen-reader
 * label, title, placeholder or alert with letters outside a bracket bypassed t().
 *
 * Shown as written: what the member and their community wrote (a name, a bio, the page's address, version numbers), the
 * 12 words (English in every language: the account key is made from them), DELETE (what a member types to confirm:
 * the code compares it), the language list (each language in itself), the brand and beanpool.org, and the guide's
 * pages (English until slice S5). Sentences that key-path files build (lib/delete-here, lib/words-clipboard,
 * lib/recovery-kit, components/SignInRecoveryLine) are the join and recovery sweep's (W4): shown whole, as written,
 * inside ours.
 *
 * And a language switch: choosing another language in Settings → Language redraws the page in it, live.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@beanpool/core';
import { SettingsPage } from './SettingsPage';
import { NO_WORDS_HERE } from '../components/SignInRecoveryLine';
import { WEB_DELETE_CARD_LINE, WEB_DELETE_CHECKING_LINE, WEB_VAULT_COPY_LINE, webLastCommunityLine } from '../lib/delete-here';
import { WEB_COPY_CLEARS_LINE } from '../lib/words-clipboard';
import { KIT_WEB_LABEL } from '../lib/recovery-kit';
import * as api from '../lib/api';
import { backToEnglish, bracketed, showIn, xx } from '../words-xx.test-support';
import { AS_WRITTEN, LANGUAGE_LIST, LanguageRoot, bypassing, guideStrings } from '../words-w3.test-support';
import ruWords from '../../words/ru.json';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        getNotificationPreferences: vi.fn(async () => ({ notify_chat: 'true', notify_marketplace: 'true', notify_escrow: 'false', eventReminderOffsets: '[1440]' })),
        updateNotificationPreferences: vi.fn(async () => ({})),
        getMemberPreferences: vi.fn(async () => ({ holiday_mode: 'false', show_as_connection_in_common: 'true' })),
        getMemberProfile: vi.fn(async () => ({ publicKey: 'me-pk', callsign: 'Kim', avatar: null, bio: 'Grows beans by the river', contact: null })),
        updateMemberProfile: vi.fn(async () => ({})),
        getNodeStats: vi.fn(async () => ({ members: 14, posts: 30, transactions: 9 })),
        getCommunityHealth: vi.fn(async () => ({})),
        getSignInRecovery: vi.fn(async () => null),
        getFriends: vi.fn(async () => [{ publicKey: 'blocked-pk-0000000000000000' }]),
    };
});
vi.mock('../lib/blocklist', async () => {
    const actual = await vi.importActual('../lib/blocklist');
    return { ...actual, loadBlocklist: vi.fn(async () => ['blocked-pk-0000000000000000']), getBlocklistFullNote: vi.fn(() => null) };
});

const WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
const identity: any = { publicKey: 'me-pk', privateKey: 'priv-key-hex', callsign: 'Kim', mnemonic: WORDS };
const RU = ruWords as Record<string, unknown>;
const ARCHETYPE = JSON.stringify({ primary: 'weaver', secondary: 'connector', mode: 'quick', updatedAt: '2026-10-01T00:00:00Z' });

/** What others wrote, and what is shown as written (see the note above). */
const OTHERS = [
    'Kim', 'K', 'me-pk…', 'Grows beans by the river', 'Blocked Bea', window.location.host, window.location.origin, 'blocked-pk-0000000000000000'.slice(0, 16),
    ...WORDS, 'DELETE', 'CALLSIGN', ...LANGUAGE_LIST, ...AS_WRITTEN, 'Ed25519',
    WEB_DELETE_CARD_LINE, WEB_DELETE_CHECKING_LINE, WEB_VAULT_COPY_LINE, webLastCommunityLine(true), WEB_COPY_CLEARS_LINE, NO_WORDS_HERE, KIT_WEB_LABEL,
];

const said: string[] = [];
beforeEach(() => {
    localStorage.clear();
    said.length = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    vi.spyOn(window, 'alert').mockImplementation((m?: unknown) => { said.push(String(m)); });
    vi.spyOn(window, 'confirm').mockImplementation((m?: string) => { said.push(String(m)); return false; });
    vi.mocked(api.getMemberProfile).mockImplementation(async (pk: string) => (pk === 'blocked-pk-0000000000000000'
        ? { publicKey: pk, callsign: 'Blocked Bea', avatar: null, bio: '', contact: null } as any
        : { publicKey: 'me-pk', callsign: 'Kim', avatar: null, bio: 'Grows beans by the river', contact: null } as any));
});
afterEach(() => {
    cleanup();
    backToEnglish();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function renderSettings(props: Partial<Parameters<typeof SettingsPage>[0]> = {}) {
    return render(
        <LanguageRoot draw={() => (
            <SettingsPage identity={identity} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}}
                onReRunSetup={() => {}} nodeVersion="1.2.29" {...props} />
        )} />,
    );
}
const unwrapped = (extra: string[] = []) => bypassing(document.body, { others: [...OTHERS, ...extra], said });
/** The button or link whose words are `english`, as the pseudo-locale draws them. */
const tap = async (english: string) => {
    const el = await screen.findByText((_, node) => !!node && /^(BUTTON|A)$/.test(node.tagName) && (node.textContent ?? '').includes(xx(english)));
    fireEvent.click(el);
};

describe('Settings in the pseudo-locale: every word on it came through t() (words W3)', () => {
    it('the menu: the identity card, every group and row, the toggles, Appearance, Language, the BeanPool rows', async () => {
        await showIn('xx');
        renderSettings();
        expect(await screen.findByText(xx('ACCOUNT & IDENTITY'))).toBeInTheDocument();
        await screen.findByText(`🤝 ${xx('Show me as a connection in common')}`);
        expect(screen.getByText('Grows beans by the river')).toBeInTheDocument();
        expect(screen.getByRole('radiogroup', { name: xx('Appearance') })).toBeInTheDocument();
        expect(screen.getByRole('radio', { name: xx('Same as device') })).toBeInTheDocument();
        expect(bracketed()).toBeGreaterThan(40);
        expect(unwrapped()).toEqual([]);
    });

    it('the working style card, once the member has taken the quiz', async () => {
        vi.mocked(api.getMemberProfile).mockResolvedValue({ publicKey: 'me-pk', callsign: 'Kim', avatar: null, bio: '', contact: null, archetype: ARCHETYPE } as any);
        await showIn('xx');
        renderSettings();
        expect(await screen.findByText(xx('9 Qs'))).toBeInTheDocument();
        expect(screen.getByText(xx('🌟 What you tend to enjoy'))).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
    });

    it('the 12 words: the screen\'s sentences translated, the words themselves English and marked never to translate', async () => {
        await showIn('xx');
        renderSettings();
        await tap('View Recovery Phrase');
        const grid = await screen.findByTestId('seed-words');
        await waitFor(() => expect(within(grid).getByText('accident')).toBeInTheDocument());
        expect([...grid.querySelectorAll('.font-mono.font-bold')].map((s) => s.textContent)).toEqual(WORDS);
        expect(grid).toHaveAttribute('translate', 'no');
        expect(unwrapped()).toEqual([]);
    });

    it('Database Health, Notification Preferences and Advanced', async () => {
        await showIn('xx');
        renderSettings();
        await tap('Database Health & Stats');
        expect(await screen.findByText(xx('Community Members'))).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
        await tap('← Back to Settings');
        await tap('Notification Preferences');
        expect(await screen.findByText(xx('1 day before'))).toBeInTheDocument();
        expect(screen.getByText(xx('Off'))).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
        await tap('← Back to Settings');
        await tap('Advanced / Subsystem');
        await tap('Reveal');
        expect(await screen.findByText('priv-key-hex')).toBeInTheDocument();
        expect(unwrapped(['priv-key-hex'])).toEqual([]);
    });

    it('Blocked Members: a blocked member who is still a friend, and the confirm before removing them', async () => {
        await showIn('xx');
        renderSettings();
        await tap('Manage Blocked Members');
        expect(await screen.findByText('Blocked Bea')).toBeInTheDocument();
        expect(await screen.findByText(xx('Still your friend. They can notice a removal.'))).toBeInTheDocument();
        await tap('Also remove from friends');
        expect(said.at(-1)).toBe(xx('Remove {name} from your friends? They stay blocked. They can notice a removal.').replace('{name}', 'Blocked Bea'));
        await tap('Unblock All');
        expect(unwrapped()).toEqual([]);
    });

    it('Account Deletion & Sign Out: the choices, the device sign-out and the purge, words only', async () => {
        await showIn('xx');
        renderSettings();
        await tap('Account Deletion & Sign Out');
        expect(await screen.findByText(xx('Choose an Action'))).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
        await tap('Sign Out (Device Only)');
        expect(await screen.findByText(xx('🚪 Confirm Device Sign Out'))).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
        await tap('Cancel');
        await tap('Permanently Delete Account');
        const box = await screen.findByLabelText(xx('Type callsign {name} or {word} to confirm permanent deletion').replace('{name}', 'Kim').replace('{word}', 'DELETE'));
        expect(box).toHaveAttribute('placeholder', xx('Type "{name}" or "{word}"').replace('{name}', 'Kim').replace('{word}', 'DELETE'));
        expect(unwrapped()).toEqual([]);
    });

    it('Suggest a change, the profile editor and the guide', async () => {
        await showIn('xx');
        renderSettings({ initialMode: 'suggest' });
        expect(await screen.findByText(xx('Suggest a change to BeanPool'))).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
        cleanup();
        renderSettings({ initialMode: 'profile' });
        expect(await screen.findByText(xx('Your Profile'))).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
        cleanup();
        renderSettings({ initialMode: 'guide' });
        expect(await screen.findByPlaceholderText(xx('Search the guide'))).toBeInTheDocument();
        expect(unwrapped(guideStrings())).toEqual([]);
    });

    it('the working style quiz from Settings: its intro, all nine questions and the result', async () => {
        await showIn('xx');
        renderSettings();
        await tap('⚡ Take 60s Quiz');
        expect(await screen.findByText(xx('Community Working Style'))).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
        fireEvent.click(screen.getByRole('button', { name: xx('Quick Spark: 9 questions, approx 1 minute. A 60-second snapshot of how you like to work.') }));
        const quiz = screen.getByRole('dialog');
        for (let i = 0; i < 9; i++) {
            expect(within(quiz).getByRole('progressbar')).toHaveTextContent(xx('Question {n} of {total}').replace('{n}', String(i + 1)).replace('{total}', '9'));
            expect(unwrapped()).toEqual([]);
            fireEvent.click(within(quiz).getAllByRole('radio')[0]);
        }
        expect(await screen.findByText(xx('Who you work well with'))).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
    });
});

describe('Settings in English and on a language switch', () => {
    it('in English nothing is bracketed, and the words are as they were', async () => {
        renderSettings();
        expect(await screen.findByText('ACCOUNT & IDENTITY')).toBeInTheDocument();
        expect(bracketed()).toBe(0);
        expect(screen.getByText('⚠️ Account Deletion & Sign Out')).toBeInTheDocument();
        expect(screen.getByText('🛡️ Privacy Policy')).toBeInTheDocument();
        expect(screen.getByRole('radio', { name: 'Same as device' })).toBeInTheDocument();
    });

    it('choosing Русский in Settings → Language redraws Settings in Russian at once; any language redraws every section', async () => {
        renderSettings();
        const select = await screen.findByRole('combobox', { name: 'Language' });
        await act(async () => { fireEvent.change(select, { target: { value: 'ru' } }); });
        await waitFor(() => expect(document.documentElement.lang).toBe('ru'));
        expect(typeof RU['Language']).toBe('string');
        expect(await screen.findByRole('combobox', { name: RU['Language'] as string })).toBeInTheDocument();
        expect(screen.getByText(t('ACCOUNT & IDENTITY'))).toBeInTheDocument();
        // The same page, redrawn in another language without a reload: every section heading follows.
        await showIn('xx');
        for (const heading of ['ACCOUNT & IDENTITY', 'APP SETTINGS', 'LEGAL & PRIVACY', 'SYSTEM', 'DANGER ZONE', 'BEANPOOL']) {
            expect(screen.getByText(xx(heading))).toBeInTheDocument();
        }
        expect(screen.queryByText('ACCOUNT & IDENTITY')).toBeNull();
    });
});
