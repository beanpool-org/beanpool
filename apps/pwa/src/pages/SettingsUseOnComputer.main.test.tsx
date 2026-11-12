// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://mullum.beanpool.org/app"}
/**
 * Settings → BeanPool → "BeanPool works in any browser: open <address> on any computer or phone", rounds 3 and 4 (computer-line, 13
 * Nov 2026): the web app served at mullum.beanpool.org, in a community whose MAIN name is byron.beanpool.org (measured: GET
 * /api/community/info on either host answers primaryAddress byron.beanpool.org, addresses [byron, mullum]).
 *
 * Round 3 told this page to open the main name. The deciding review found that wrong where it matters: a member signed in here, at
 * mullum, has a phone that signed in here; a Link a device code made at byron names byron, which a phone on mullum refuses (its
 * transferTarget takes only the phone's own community or a saved one). So the page says the address it is SERVED from (round 2's
 * rule), whatever the community says of its other names, and asks nothing of the node for it. The phone's row weighs the main name
 * against what Link a device would take (apps/native utils/computer-address.ts). The address is on its own line, without "https://",
 * and Copy still gives the whole https:// address. SettingsUseOnComputer.test.tsx holds the rest of the row (served from plain
 * http://localhost).
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SettingsPage } from './SettingsPage';

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
const BYRON_INFO = { addresses: ['byron.beanpool.org', 'mullum.beanpool.org'], primaryAddress: 'byron.beanpool.org' };
const writeText = vi.fn(async (_text: string) => {});
/** What the node answers to GET /api/community/info; null: it cannot be asked. The row never asks (and so is not changed by it). */
const asked = vi.hoisted(() => ({ info: null as null | Record<string, unknown> }));

const openSettings = () => render(<SettingsPage identity={identity} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}} />);
const rowBlock = async () => screen.findByTestId('settings-use-in-browser');
const lineOf = (row: HTMLElement) => within(row).getByTestId('settings-use-in-browser-line');
const addressOf = (row: HTMLElement) => within(row).getByTestId('settings-use-in-browser-address');

beforeEach(() => {
    asked.info = BYRON_INFO;
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

describe('Settings → "BeanPool works in any browser: open <address> on any computer or phone": the address the page is served from (round 4)', () => {
    it('the test page really is served from mullum over https', () => {
        expect(window.location.origin).toBe(SERVED_FROM);
    });

    it('served from mullum, in a community whose main name is byron: mullum.beanpool.org (the page\'s own), on its own line, without https://', async () => {
        openSettings();
        const row = await rowBlock();
        expect(addressOf(row).textContent).toBe('mullum.beanpool.org');
        expect(lineOf(row).textContent).toBe('BeanPool works in any browser: open mullum.beanpool.org on any computer or phone');
        expect(row.textContent).not.toContain('https://');
        expect(row.textContent).not.toContain('byron');
        // Its own line: a block between the words before it and after it.
        expect(addressOf(row).tagName).toBe('CODE');
        expect(addressOf(row).className).toMatch(/\bblock\b/);
        expect(addressOf(row).previousSibling?.textContent).toBe('BeanPool works in any browser: open ');
        expect(addressOf(row).nextSibling?.textContent).toBe(' on any computer or phone');
    });

    it('the address is there from the first moment and never changes when the community answers, for any answer or none', async () => {
        for (const info of [BYRON_INFO, null, { addresses: ['mullum.beanpool.org'], primaryAddress: 'evil.example' }, { addresses: ['mullum.beanpool.org'] }]) {
            asked.info = info;
            const { unmount } = openSettings();
            const row = await rowBlock();
            expect(addressOf(row).textContent, JSON.stringify(info)).toBe('mullum.beanpool.org');
            await new Promise((r) => setTimeout(r, 20));
            expect(addressOf(row).textContent, JSON.stringify(info)).toBe('mullum.beanpool.org');
            unmount();
        }
    });

    it('the row does not read the community\'s names at all', async () => {
        openSettings();
        const row = await rowBlock();
        await new Promise((r) => setTimeout(r, 20));
        expect(addressOf(row).textContent).toBe('mullum.beanpool.org');
        expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/api/community/info'))).toEqual([]);
    });

    it('Copy still gives the whole address, https:// and all: the page\'s own', async () => {
        openSettings();
        const row = await rowBlock();
        fireEvent.click(within(row).getByRole('button', { name: "Copy this community's link" }));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith(SERVED_FROM));
        expect(writeText).toHaveBeenCalledTimes(1);
    });

    it('the address may break after a dot and nowhere else: a <wbr> between the dotted parts, and no invisible character in the text', async () => {
        openSettings();
        const row = await rowBlock();
        const code = addressOf(row);
        expect(code.querySelectorAll('wbr')).toHaveLength(2);
        expect(Array.from(code.childNodes).map((n) => (n.nodeType === 3 ? n.textContent : n.nodeName))).toEqual(['mullum.', 'WBR', 'beanpool.', 'WBR', 'org']);
        expect(code.textContent).toMatch(/^[a-z.]+$/);
        // Mid-word only as a last resort, for one part wider than the screen; the lead-in and the buttons still wrap.
        expect(code.className).toContain('[overflow-wrap:anywhere]');
        expect(code.className).not.toContain('break-all');
    });
});
