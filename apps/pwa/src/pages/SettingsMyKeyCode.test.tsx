/**
 * Settings → "My key code" on the web (DESIGN-dm-key-signal-model §5, slice S3): the phone's card from Settings → Account
 * Protection, with its words unchanged (§4), at the head of the web's account-protection rows (before View Recovery Phrase
 * and the ways back). The digits are this browser's own key's code, the same as the phone's for that key, and showing
 * the card stores nothing.
 */
import { render, screen, within, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { SettingsPage } from './SettingsPage';
import { MyKeyCodeCard } from '../components/KeyCode';
import type { BeanPoolIdentity } from '../lib/identity';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        getNotificationPreferences: vi.fn(async () => ({})),
        getMemberPreferences: vi.fn(async () => ({})),
        updateNotificationPreferences: vi.fn(async () => ({ success: true })),
        getMemberProfile: vi.fn(async () => ({})),
        updateMemberProfile: vi.fn(async () => ({ success: true, profile: {} })),
        getNodeStats: vi.fn(async () => null),
        getCommunityHealth: vi.fn(async () => ({})),
    };
});

const KEY = 'bb'.repeat(32);
const identity: BeanPoolIdentity = { publicKey: KEY, privateKey: 'priv', callsign: 'Me', createdAt: '2026-01-01T00:00:00.000Z' };
const BODY = "If a chat with you ever says your key changed, the other person can check this code against the one their phone shows. It isn't secret: it's safe to read out.";

type PhoneHelper = { keyCodeOf: (k: string) => string | null; keyCodeSpoken: (c: string) => string };
async function phoneHelper(): Promise<PhoneHelper> {
    return (await import(/* @vite-ignore */ path.resolve(__dirname, '../../../native/utils/key-code.ts'))) as PhoneHelper;
}

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('bp_node_url', 'https://riverside.example.test');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('Settings → My key code (web)', () => {
    it("shows this browser's own key code, the phone's digits for that key, with the phone's words, before View Recovery Phrase", async () => {
        const phone = await phoneHelper();
        render(<SettingsPage identity={identity} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}} />);
        const card = await screen.findByTestId('my-key-code');
        expect(within(card).getByRole('heading', { name: 'My key code' })).toBeInTheDocument();
        const digits = within(card).getByTestId('my-key-code-digits');
        expect(digits.textContent).toBe(phone.keyCodeOf(KEY));
        expect(digits.textContent).toBe('1479 0507 0978 3849 9965');
        expect(digits).toHaveAttribute('aria-hidden', 'true');
        expect(within(card).getByText(`My key code: ${phone.keyCodeSpoken(phone.keyCodeOf(KEY)!)}`)).toHaveClass('sr-only');
        expect(within(card).getByText(BODY)).toBeInTheDocument();
        expect(card.textContent).not.toMatch(/verif/i);

        // In ACCOUNT & IDENTITY, at the head of the account-protection rows.
        const section = screen.getByText('ACCOUNT & IDENTITY');
        const recovery = screen.getByText('View Recovery Phrase');
        expect(section.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(card.compareDocumentPosition(recovery) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('the card writes nothing to localStorage, sessionStorage or IndexedDB', async () => {
        const writes: string[] = [];
        for (const name of ['setItem', 'removeItem', 'clear'] as const) {
            vi.spyOn(localStorage, name).mockImplementation(((...args: unknown[]) => { writes.push(`localStorage.${name}(${String(args[0] ?? '')})`); }) as never);
            vi.spyOn(Storage.prototype, name).mockImplementation(((...args: unknown[]) => { writes.push(`Storage.${name}(${String(args[0] ?? '')})`); }) as never);
        }
        const idb = { open: vi.fn(() => { writes.push('indexedDB.open'); return {}; }) };
        vi.stubGlobal('indexedDB', idb);
        const { unmount } = render(<MyKeyCodeCard publicKey={KEY} />);
        expect(screen.getByTestId('my-key-code-digits').textContent).toBe('1479 0507 0978 3849 9965');
        unmount();
        expect(writes).toEqual([]);
    });

    it('a key that is not a key draws no card rather than a wrong code', () => {
        for (const bad of [null, undefined, '', 'member-me', 'bb'.repeat(31)]) {
            const { container, unmount } = render(<MyKeyCodeCard publicKey={bad} />);
            expect(container.innerHTML).toBe('');
            unmount();
        }
    });
});
