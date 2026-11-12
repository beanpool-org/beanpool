// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://mullum.beanpool.org/app"}
/**
 * Settings → BeanPool → "BeanPool works in any browser: open <address> on any computer or phone", round 3 (computer-line, 13 Nov
 * 2026, the director's look at the round-2 shots): the web app served at mullum.beanpool.org, in a community whose MAIN name is
 * byron.beanpool.org (measured: GET /api/community/info on either host answers primaryAddress byron.beanpool.org, addresses
 * [byron, mullum]). The row tells a member to open the main name, on its own line and without "https://", and Copy still gives the
 * whole https:// address. SettingsUseOnComputer.test.tsx holds the rest of the row (served from plain http://localhost).
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SettingsPage } from './SettingsPage';
import { resetCommunityInfoOnce } from '../lib/visitor-lobby-gate';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
    return {
        ...actual,
        request: vi.fn(async (method: string, path: string, ...rest: unknown[]) => (
            path === '/api/node-admin/me' ? { role: null, communityName: 'Mullum' } : (actual.request as any)(method, path, ...rest)
        )),
        getNotificationPreferences: vi.fn(async () => ({})),
        getMemberPreferences: vi.fn(async () => ({})),
        updateNotificationPreferences: vi.fn(async () => ({ success: true })),
        getMemberProfile: vi.fn(async () => ({})),
        getNodeStats: vi.fn(async () => null),
        getCommunityHealth: vi.fn(async () => ({})),
    };
});

const identity: any = { publicKey: 'a1'.repeat(32), privateKey: 'priv', callsign: 'Me' };
const SERVED_FROM = 'https://mullum.beanpool.org';
const MAIN = 'https://byron.beanpool.org';
const BYRON_INFO = { addresses: ['byron.beanpool.org', 'mullum.beanpool.org'], primaryAddress: 'byron.beanpool.org' };
const writeText = vi.fn(async (_text: string) => {});
/** What the node answers to GET /api/community/info; null: it cannot be asked. */
const asked = vi.hoisted(() => ({ info: null as null | Record<string, unknown> }));

const openSettings = () => render(<SettingsPage identity={identity} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}} />);
const rowBlock = async () => screen.findByTestId('settings-use-in-browser');
const lineOf = (row: HTMLElement) => within(row).getByTestId('settings-use-in-browser-line');
const addressOf = (row: HTMLElement) => within(row).getByTestId('settings-use-in-browser-address');

beforeEach(() => {
    asked.info = BYRON_INFO;
    resetCommunityInfoOnce();
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => (
        String(input).includes('/api/community/info') && asked.info
            ? new Response(JSON.stringify(asked.info), { status: 200, headers: { 'Content-Type': 'application/json' } })
            : new Response('{}', { status: 404 })
    )));
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('Settings → "BeanPool works in any browser: open <address> on any computer or phone": the main address (round 3)', () => {
    it('the test page really is served from mullum over https', () => {
        expect(window.location.origin).toBe(SERVED_FROM);
    });

    it('served from mullum, in a community whose main name is byron: byron.beanpool.org, on its own line, without https://', async () => {
        openSettings();
        const row = await rowBlock();
        await waitFor(() => expect(addressOf(row).textContent).toBe('byron.beanpool.org'));
        expect(lineOf(row).textContent).toBe('BeanPool works in any browser: open byron.beanpool.org on any computer or phone');
        expect(row.textContent).not.toContain('https://');
        expect(row.textContent).not.toContain('mullum');
        // Its own line: a block between the words before it and after it.
        expect(addressOf(row).tagName).toBe('CODE');
        expect(addressOf(row).className).toMatch(/\bblock\b/);
        expect(addressOf(row).previousSibling?.textContent).toBe('BeanPool works in any browser: open ');
        expect(addressOf(row).nextSibling?.textContent).toBe(' on any computer or phone');
    });

    it('Copy still gives the whole address, https:// and all: the main one', async () => {
        openSettings();
        const row = await rowBlock();
        await waitFor(() => expect(addressOf(row).textContent).toBe('byron.beanpool.org'));
        fireEvent.click(within(row).getByRole('button', { name: "Copy this community's link" }));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith(MAIN));
        expect(writeText).toHaveBeenCalledTimes(1);
    });

    it('the address may break after a dot and nowhere else: a <wbr> between the dotted parts, and no invisible character in the text', async () => {
        openSettings();
        const row = await rowBlock();
        await waitFor(() => expect(addressOf(row).textContent).toBe('byron.beanpool.org'));
        const code = addressOf(row);
        expect(code.querySelectorAll('wbr')).toHaveLength(2);
        expect(Array.from(code.childNodes).map((n) => (n.nodeType === 3 ? n.textContent : n.nodeName))).toEqual(['byron.', 'WBR', 'beanpool.', 'WBR', 'org']);
        expect(code.textContent).toMatch(/^[a-z.]+$/);
        // Mid-word only as a last resort, for one part wider than the screen; the lead-in and the buttons still wrap.
        expect(code.className).toContain('[overflow-wrap:anywhere]');
        expect(code.className).not.toContain('break-all');
    });

    it('a main name that is not one of the community\'s own addresses is never used: the address the page is served from', async () => {
        asked.info = { addresses: ['mullum.beanpool.org'], primaryAddress: 'evil.example' };
        openSettings();
        const row = await rowBlock();
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        await waitFor(() => expect(addressOf(row).textContent).toBe('mullum.beanpool.org'));
        fireEvent.click(within(row).getByRole('button', { name: "Copy this community's link" }));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith(SERVED_FROM));
    });

    it('a community that names no main address: the address the page is served from', async () => {
        asked.info = { addresses: ['mullum.beanpool.org'] };
        openSettings();
        const row = await rowBlock();
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        expect(addressOf(row).textContent).toBe('mullum.beanpool.org');
    });

    it('a community that cannot be asked: the address the page is served from, with the line there from the first moment', async () => {
        asked.info = null;
        openSettings();
        const row = await rowBlock();
        expect(addressOf(row).textContent).toBe('mullum.beanpool.org');
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        expect(lineOf(row).textContent).toBe('BeanPool works in any browser: open mullum.beanpool.org on any computer or phone');
        fireEvent.click(within(row).getByRole('button', { name: "Copy this community's link" }));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith(SERVED_FROM));
    });
});
