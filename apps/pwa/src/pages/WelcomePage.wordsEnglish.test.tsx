/**
 * The 12 words stay English in every language (design amendment 1; #1947 review N1): with the screens in another
 * language, the backup and restore screens say so in that language, and neither we nor the browser's page translation
 * may rewrite the words (translate="no" + notranslate on the words). In English the line is not shown. The backup
 * flow is the reviewer's: a sign-in join coming back, a face, Next.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { t } from '@beanpool/core';
import { WelcomePage } from './WelcomePage';
import { generateIdentity, savePendingJoin, PENDING_JOIN_TTL_MS, type BeanPoolIdentity } from '../lib/identity';
import { resetCapturedAuthReturn } from '../lib/web-join';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetLanguageForTests, showLanguage } from '../lib/language';
import ruWords from '../../words/ru.json';

const LINE = 'These 12 words are English in every language: write them and type them exactly as shown.';
const RU = ruWords as Record<string, unknown>;

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function stubNode(info: unknown, handlers: Record<string, () => Response> = {}) {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/api/community/info') return json(200, info);
        const key = Object.keys(handlers).find((k) => path === k || path.startsWith(k));
        return key ? handlers[key]() : json(200, {});
    }));
}
const b64url = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const GLOBAL_OPEN = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'global', features: { openJoin: true } };
const LOCAL = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local', features: { openJoin: false } };

let identity: BeanPoolIdentity;
beforeEach(async () => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetCapturedAuthReturn();
    resetLanguageForTests();
    window.history.replaceState(null, '', '/app');
    identity = await generateIdentity('Alice');
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    resetCapturedAuthReturn();
    resetLanguageForTests();
});

async function openBackup() {
    await savePendingJoin({ identity, provider: 'google', nonce: 'n1', startedAt: Date.now(), expiresAt: Date.now() + PENDING_JOIN_TTL_MS, restored: false });
    const token = `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify({ sub: 'g1', nonce: 'n1' }))}.c2ln`;
    window.history.replaceState(null, '', `/app/auth/google#state=n1&id_token=${token}`);
    stubNode(GLOBAL_OPEN, { '/api/join': () => json(200, { success: true, member: { callsign: 'Alice' } }) });
    render(<WelcomePage onComplete={vi.fn()} />);
    fireEvent.click(await screen.findByTitle(t('Green Bean')));
    fireEvent.click(screen.getByRole('button', { name: t('Next →') }));
    return screen.findByTestId('backup-words');
}

async function openRestore() {
    stubNode(LOCAL);
    render(<WelcomePage onComplete={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: t('Restore existing identity') }));
    fireEvent.click(await screen.findByRole('button', { name: t('Recover with 12 Words') }));
    return (await screen.findByLabelText(t('Recovery word {n}', { n: 1 }))).parentElement!;
}

describe('the 12 words are English, and the screens say so in the member\'s language', () => {
    it('backup screen in Russian: the line in Russian, the words marked never to translate, and still English', async () => {
        expect(await showLanguage('ru')).toBe(true);
        const grid = await openBackup();
        expect(screen.getByTestId('words-are-english').textContent).toBe(RU[LINE]);
        expect(RU[LINE]).not.toBe(LINE);
        expect(grid).toHaveAttribute('translate', 'no');
        expect(grid).toHaveClass('notranslate');
        expect([...grid.querySelectorAll('strong')].map((s) => s.textContent)).toEqual(identity.mnemonic);
    });

    it('restore screen in Russian: the line in Russian, the twelve boxes marked never to translate', async () => {
        expect(await showLanguage('ru')).toBe(true);
        const boxes = await openRestore();
        expect(screen.getByTestId('words-are-english').textContent).toBe(RU[LINE]);
        expect(boxes).toHaveAttribute('translate', 'no');
        expect(boxes).toHaveClass('notranslate');
        expect(boxes.querySelectorAll('input')).toHaveLength(12);
    });

    it('in English the line is not shown (it says nothing new), and the words are still marked', async () => {
        const grid = await openBackup();
        expect(screen.queryByTestId('words-are-english')).toBeNull();
        expect(grid).toHaveAttribute('translate', 'no');
        cleanup();
        resetCapturedAuthReturn();
        window.history.replaceState(null, '', '/app');
        const boxes = await openRestore();
        expect(screen.queryByTestId('words-are-english')).toBeNull();
        expect(boxes).toHaveAttribute('translate', 'no');
    });
});
