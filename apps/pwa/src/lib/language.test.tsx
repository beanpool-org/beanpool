/**
 * The web app's language (lib/language.ts; design §1, §7 S2; director amendment 2): which language a browser starts in,
 * the switch on the first screen and Settings → Language changing the visible words live, `?lang=`, the node's default,
 * `<html lang>` / `dir`, and `X-Language` on the node's requests. The words come from the real catalogs (machine drafts),
 * fetched as the build fetches them: one import per language. Nothing contacts a node: fetch is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LANGUAGE_HEADER, currentLanguage, formatDate, t, type Lang } from '@beanpool/core';
import frWords from '../../words/fr.json';
import ruWords from '../../words/ru.json';
import {
    LANGUAGE_STORAGE_KEY, WORDS_FEEDBACK_URL, chooseAndShowLanguage, chooseLanguage, languageFromBrowser, languageFromQuery,
    languageHeaders, nodeDefaultLanguage, resetLanguageForTests, showLanguage, startLanguage,
} from './language';
import { communityInfoOnce, resetCommunityInfoOnce } from './visitor-lobby-gate';
import { request } from './api';
import { memoryIndexedDB } from './memory-indexeddb';
import { resetCapturedAuthReturn } from './web-join';
import { WelcomePage } from '../pages/WelcomePage';
import { SettingsPage } from '../pages/SettingsPage';

vi.mock('./api', async () => {
    const actual = await vi.importActual('./api');
    return {
        ...actual,
        getNotificationPreferences: vi.fn(async () => ({})),
        getMemberPreferences: vi.fn(async () => ({})),
        getMemberProfile: vi.fn(async () => ({})),
        getNodeStats: vi.fn(async () => null),
        getCommunityHealth: vi.fn(async () => ({})),
        getSignInRecovery: vi.fn(async () => null),
    };
});

const FR = frWords as Record<string, unknown>;
const RU = ruWords as Record<string, unknown>;
const OCT_15 = new Date(Date.UTC(2026, 9, 15, 9, 5));
const LOCAL_INFO = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: { openJoin: false } };

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const fetches: Array<{ path: string; headers: Record<string, string> }> = [];
function stubNode(info: unknown) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        fetches.push({ path, headers: { ...(init?.headers as Record<string, string> | undefined) } });
        if (path === '/api/community/info') return json(200, info);
        return json(404, { error: 'Not found' });
    }));
}

function browserSays(...tags: string[]) {
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(tags);
    vi.spyOn(navigator, 'language', 'get').mockReturnValue(tags[0] ?? '');
}

beforeEach(() => {
    localStorage.clear();
    resetLanguageForTests();
    resetCommunityInfoOnce();
    resetCapturedAuthReturn();
    fetches.length = 0;
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    document.documentElement.lang = 'en';
    document.documentElement.removeAttribute('dir');
    window.history.replaceState(null, '', '/app');
    browserSays('en-AU', 'en');
});
afterEach(() => {
    cleanup();
    resetLanguageForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    localStorage.clear();
});

describe('which language a browser starts in', () => {
    it('a stored choice, then ?lang=, then the browser\'s, then the node\'s default, then English', () => {
        const none = { stored: null, query: null, browser: null, nodeDefault: null };
        expect(chooseLanguage(none)).toBe('en');
        expect(chooseLanguage({ ...none, nodeDefault: 'fr' })).toBe('fr');
        expect(chooseLanguage({ ...none, browser: 'ru', nodeDefault: 'fr' })).toBe('ru');
        expect(chooseLanguage({ ...none, query: 'es', browser: 'ru', nodeDefault: 'fr' })).toBe('es');
        expect(chooseLanguage({ stored: 'zh-Hans', query: 'es', browser: 'ru', nodeDefault: 'fr' })).toBe('zh-Hans');
    });

    it('reads ?lang= and the browser\'s list as tags BeanPool writes, and nothing else', () => {
        expect(languageFromQuery('?lang=ru')).toBe('ru');
        expect(languageFromQuery('?lang=pt-BR')).toBe('pt');
        expect(languageFromQuery('?lang=zh-TW')).toBe('zh-Hant');
        expect(languageFromQuery('?lang=xx')).toBe('xx');
        expect(languageFromQuery('?lang=he')).toBeNull();
        expect(languageFromQuery('?lang=')).toBeNull();
        expect(languageFromQuery('?invite=ABC')).toBeNull();
        expect(languageFromBrowser({ languages: ['he-IL', 'fr-CA', 'en'], language: 'he-IL' })).toBe('fr');
        expect(languageFromBrowser({ languages: [], language: 'zh-CN' })).toBe('zh-Hans');
        expect(languageFromBrowser({ languages: ['he-IL'], language: 'he-IL' })).toBeNull();
        expect(nodeDefaultLanguage({ language: 'fr' })).toBe('fr');
        expect(nodeDefaultLanguage({ language: 'klingon' })).toBeNull();
        expect(nodeDefaultLanguage({})).toBeNull();
        expect(nodeDefaultLanguage(null)).toBeNull();
    });

    it('?lang=fr loads French — its words and its dates — sets <html lang="fr" dir="ltr">, and keeps it as the choice', async () => {
        expect(await startLanguage('?lang=fr')).toBe(true);
        expect(currentLanguage()).toBe('fr');
        expect(document.documentElement.lang).toBe('fr');
        expect(document.documentElement.dir).toBe('ltr');
        expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('fr');
        expect(t('Language')).toBe(FR.Language);
        expect(FR.Language).not.toBe('Language');
        // Core's dates came in the same chunk (the first chunk carries English alone: #1941 review N-f).
        expect(formatDate(OCT_15, 'day-month', { utc: true })).toBe('15 oct.');
    });

    it('a stored choice wins over ?lang= and the browser, and ?lang= never replaces it', async () => {
        localStorage.setItem(LANGUAGE_STORAGE_KEY, 'ru');
        browserSays('fr-FR');
        await startLanguage('?lang=es');
        expect(currentLanguage()).toBe('ru');
        expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('ru');
    });

    it('with nothing chosen, the browser\'s language; a stale stored tag reads as no choice', async () => {
        localStorage.setItem(LANGUAGE_STORAGE_KEY, 'klingon');
        browserSays('ru-RU', 'en');
        await startLanguage('');
        expect(currentLanguage()).toBe('ru');
        expect(document.documentElement.lang).toBe('ru');
        expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('klingon');
    });

    it('?lang=xx shows the pseudo-locale for this visit and never stores it', async () => {
        await startLanguage('?lang=xx');
        expect(currentLanguage()).toBe('xx');
        expect(t('Language')).toMatch(/^\[Ļāñĝūāĝé~+\]$/);
        expect(document.documentElement.lang).toBe('en-XA');
        expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
    });

    it('a tag BeanPool doesn\'t write is never fetched and reads English, never a throw', async () => {
        await showLanguage('ru');
        expect(currentLanguage()).toBe('ru');
        expect(await showLanguage('klingon' as Lang)).toBe(true);
        expect(currentLanguage()).toBe('en');
        expect(document.documentElement.lang).toBe('en');
    });
});

describe('the node\'s default language', () => {
    it('applies to a browser with no choice whose own language BeanPool doesn\'t write, and is never stored', async () => {
        browserSays('he-IL');
        await startLanguage('');
        expect(currentLanguage()).toBe('en');
        stubNode({ ...LOCAL_INFO, language: 'fr' });
        await communityInfoOnce();
        await waitFor(() => expect(currentLanguage()).toBe('fr'));
        expect(document.documentElement.lang).toBe('fr');
        expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
    });

    it('never over the browser\'s own language or a choice', async () => {
        browserSays('de-DE');
        await startLanguage('');
        stubNode({ ...LOCAL_INFO, language: 'fr' });
        await communityInfoOnce();
        await new Promise((r) => setTimeout(r, 0));
        expect(currentLanguage()).toBe('de');

        resetLanguageForTests();
        resetCommunityInfoOnce();
        browserSays('he-IL');
        localStorage.setItem(LANGUAGE_STORAGE_KEY, 'es');
        await startLanguage('');
        await communityInfoOnce();
        await new Promise((r) => setTimeout(r, 0));
        expect(currentLanguage()).toBe('es');
    });

    it('a node that names none, or one BeanPool doesn\'t write, leaves English', async () => {
        browserSays('he-IL');
        await startLanguage('');
        stubNode({ ...LOCAL_INFO, language: 'tlh' });
        await communityInfoOnce();
        await new Promise((r) => setTimeout(r, 0));
        expect(currentLanguage()).toBe('en');
    });
});

describe('X-Language on the node\'s requests', () => {
    it('a request to this node carries the language; another node\'s address and the pseudo-locale carry none', async () => {
        stubNode(LOCAL_INFO);
        await chooseAndShowLanguage('ru');
        await request('GET', '/api/community/info');
        expect(fetches.at(-1)?.headers[LANGUAGE_HEADER]).toBe('ru');
        expect(languageHeaders('')).toEqual({ 'X-Language': 'ru' });
        expect(languageHeaders(window.location.origin)).toEqual({ 'X-Language': 'ru' });
        // An older node at another address could refuse the header in its CORS preflight, and with it the request.
        expect(languageHeaders('https://elsewhere.example')).toEqual({});
        await showLanguage('xx');
        expect(languageHeaders('')).toEqual({});
        await chooseAndShowLanguage('en');
        expect(languageHeaders('')).toEqual({ 'X-Language': 'en' });
    });
});

describe('choosing a language, live', () => {
    it('the switch at the top of the welcome page changes the words on it at once, and keeps the choice', async () => {
        stubNode(LOCAL_INFO);
        render(<WelcomePage onComplete={vi.fn()} />);
        expect(await screen.findByText('Welcome to BeanPool')).toBeTruthy();
        const sw = screen.getByRole('combobox', { name: 'Language' });
        expect((sw as HTMLSelectElement).options).toHaveLength(25);
        fireEvent.change(sw, { target: { value: 'fr' } });
        expect(await screen.findByText(FR['Welcome to BeanPool'] as string)).toBeTruthy();
        expect(screen.queryByText('Welcome to BeanPool')).toBeNull();
        expect(screen.getByTestId('language-switch').textContent).toContain('Français');
        expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('fr');
        expect(document.documentElement.lang).toBe('fr');
        // And back.
        fireEvent.change(screen.getByRole('combobox', { name: FR.Language as string }), { target: { value: 'en' } });
        expect(await screen.findByText('Welcome to BeanPool')).toBeTruthy();
    });

    it('Settings → Language changes the words live and says machine drafts are new, with where to say what reads wrong', async () => {
        const identity = { publicKey: 'a1'.repeat(32), privateKey: 'priv', callsign: 'Me' } as never;
        render(<SettingsPage identity={identity} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}} />);
        const row = await screen.findByTestId('settings-language');
        expect(row.textContent).toContain('Language');
        expect(screen.queryByTestId('settings-language-draft')).toBeNull();
        fireEvent.change(row.querySelector('select')!, { target: { value: 'ru' } });
        await waitFor(() => expect(row.textContent).toContain(RU.Language as string));
        const draft = await screen.findByTestId('settings-language-draft');
        expect(draft.textContent).toContain(RU['These translations are new.'] as string);
        expect(draft.querySelector('a')?.getAttribute('href')).toBe(WORDS_FEEDBACK_URL);
        expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('ru');
    });
});
