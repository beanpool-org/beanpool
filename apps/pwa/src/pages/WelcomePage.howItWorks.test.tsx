/**
 * Sign-up's last step, How it works, where the node has Beans off (stranger rehearsal 14 Oct 2026, B3). On the worldwide
 * community it sold a credit line down to -2000 Beans, the Commons fee, the Trust Wallet and "send credits" on the Ledger,
 * none of which exist there, in a 350 px scroll box. Where `features.beans` is false it says what is on, in plain words,
 * with no box of its own; where Beans are on it is unchanged.
 *
 * The node is a stubbed fetch, entered through the open door as WelcomePage.area.test.tsx does. The step's sentences go
 * through t(): the worldwide community is where strangers land, in their own language (#1947 confirmation N-A).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { t } from '@beanpool/core';
import { WelcomePage, HOW_IT_WORKS_WITHOUT_BEANS } from './WelcomePage';
import { generateIdentity, savePendingJoin, PENDING_JOIN_TTL_MS, type BeanPoolIdentity } from '../lib/identity';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetLanguageForTests, showLanguage } from '../lib/language';
import ruWords from '../../words/ru.json';
import frWords from '../../words/fr.json';

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubNode(info: unknown) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/api/community/info') return json(200, info);
        if (path.startsWith('/api/join')) return json(200, { success: true, member: { callsign: 'Alice' } });
        return json(200, {});
    }));
}

const GLOBAL = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'global', features: { openJoin: true, beans: false } };
const BEANS_ON = { ...GLOBAL, features: { openJoin: true } };

function b64url(s: string): string {
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let identity: BeanPoolIdentity;

beforeEach(async () => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
    resetLanguageForTests();
    window.history.replaceState(null, '', '/app');
    identity = await generateIdentity('Alice');
    Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition: vi.fn() }, configurable: true });
    Object.defineProperty(navigator, 'storage', { value: { persist: vi.fn(async () => true), persisted: vi.fn(async () => false) }, configurable: true });
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetCapturedAuthReturn();
    resetLanguageForTests();
    localStorage.clear();
});

/** Through the door with Google, a photo picked, past the 12 words, to How it works. */
async function toHowItWorks(info: unknown) {
    await savePendingJoin({ identity, provider: 'google', nonce: 'n1', startedAt: Date.now(), expiresAt: Date.now() + PENDING_JOIN_TTL_MS, restored: false });
    const token = `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify({ sub: 'g1', nonce: 'n1' }))}.c2ln`;
    window.history.replaceState(null, '', `/app/auth/google#state=n1&id_token=${token}`);
    stubNode(info);
    render(<WelcomePage onComplete={vi.fn()} />);
    fireEvent.click(await screen.findByTitle(t('Green Bean')));
    fireEvent.click(screen.getByRole('button', { name: t('Next →') }));
    await screen.findByText(t('🔑 Your Safety Backup'));
    fireEvent.click(screen.getByRole('button', { name: t('Next →') }));
    return screen.findByRole('button', { name: t("Let's Begin! 🚀") });
}

/** The money system that is off where Beans are. */
const MONEY = [/-2000/, /Mutual Credit/i, /Commons Pool/i, /Trust Wallet/i, /send credits/i, /Ledger/, /Held in Trust/i, /40 Beans/];

describe('How it works where Beans are off (the worldwide community)', () => {
    it('sells none of the money system, and says what is on: offers, needs, events, groups, messages', async () => {
        await toHowItWorks(GLOBAL);
        const step = document.body.textContent ?? '';
        for (const word of MONEY) expect(step, String(word)).not.toMatch(word);
        const list = screen.getByTestId('how-it-works-no-beans');
        for (const thing of ['Offers and needs', 'Events', 'Groups', 'Messages']) expect(within(list).getByText(`${thing}.`)).toBeInTheDocument();
        expect(list).toHaveTextContent(HOW_IT_WORKS_WITHOUT_BEANS.local);
        expect(list).toHaveTextContent('Settings → Recovery Phrase');
    });

    it('has no scroll box of its own (it was 350 px high and about 140 px wide at 320 px with 130 % text)', async () => {
        await toHowItWorks(GLOBAL);
        expect(screen.getByTestId('how-it-works-no-beans')).toBeInTheDocument();
        const boxed = Array.from(document.querySelectorAll<HTMLElement>('*')).filter(el => el.style.maxHeight !== '' || el.style.overflowY === 'auto');
        expect(boxed.map(el => el.outerHTML.slice(0, 80))).toEqual([]);
        // The page and the card pad 1rem each side below 360 px, not 2rem (jsdom draws no layout: the walk at 320 px
        // measures the width this gives).
        for (const id of ['welcome-page', 'welcome-card']) {
            expect(screen.getByTestId(id).className.split(' ')).toEqual(expect.arrayContaining(['p-8', 'max-[359px]:px-4']));
            expect(screen.getByTestId(id).style.padding).toBe('');
        }
    });
});

describe('How it works where Beans are on', () => {
    it('is unchanged: the mutual credit ledger, the Commons and the Trust Wallet', async () => {
        await toHowItWorks(BEANS_ON);
        expect(screen.queryByTestId('how-it-works-no-beans')).toBeNull();
        expect(screen.getByText("Let's look at how this community economy works.")).toBeInTheDocument();
        expect(screen.getByText('🪙 The Mutual Credit Ledger')).toBeInTheDocument();
        expect(screen.getByText('Community Commons Pool')).toBeInTheDocument();
        expect(document.body.textContent).toMatch(/Trust Wallet/);
    });
});

describe('How it works where Beans are off, in the member\'s language (#1947 confirmation N-A)', () => {
    const copy = HOW_IT_WORKS_WITHOUT_BEANS;
    /** The step's eleven sentences: the intro, four titles, four lines, the Local community line and the 12 words line. */
    const ENGLISH: string[] = [copy.intro, ...copy.things.flatMap((thing) => [thing.title, thing.line]), copy.local, copy.words];

    it('in Russian: all eleven sentences are the catalog\'s, and none is left in English', async () => {
        const ru = ruWords as Record<string, unknown>;
        expect(await showLanguage('ru')).toBe(true);
        await toHowItWorks(GLOBAL);
        expect(screen.queryByText('Here is what you can do here.')).toBeNull();
        expect(ENGLISH).toHaveLength(11);
        const step = document.body.textContent ?? '';
        for (const sentence of ENGLISH) {
            expect(ru[sentence], sentence).toEqual(expect.any(String));
            expect(ru[sentence], sentence).not.toBe(sentence);
            expect(step, sentence).toContain(ru[sentence]);
            expect(step, sentence).not.toContain(sentence);
        }
        for (const word of MONEY) expect(step, String(word)).not.toMatch(word);
    });

    it('in French: each of the eleven is the catalog\'s ("Messages." is the same word in French)', async () => {
        const fr = frWords as Record<string, unknown>;
        expect(await showLanguage('fr')).toBe(true);
        await toHowItWorks(GLOBAL);
        expect(screen.queryByText('Here is what you can do here.')).toBeNull();
        const step = document.body.textContent ?? '';
        for (const sentence of ENGLISH) {
            expect(fr[sentence], sentence).toEqual(expect.any(String));
            expect(step, sentence).toContain(fr[sentence]);
        }
    });
});
