/**
 * Settings → BeanPool → "BeanPool works in any browser: open <address> on any computer or phone" (computer-line, 13 Nov
 * 2026; the phone says the matching line, apps/native components/UseOnComputerRow.tsx, and core's use-on-computer.ts holds
 * both). A member who asked "is there a desktop app?" is told there isn't: this is BeanPool on a computer, in any browser,
 * at the community's address, with the same account. The address is the one the page is served from. For every member: an
 * owner sees it as well as their "Manage" link.
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SettingsPage } from './SettingsPage';

const node = vi.hoisted(() => ({ role: null as null | 'owner' | 'admin' }));
vi.mock('../lib/api', async () => {
    const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
    return {
        ...actual,
        // The role the node answers to Settings' own ask (components/NodeAdminLink.tsx); anything else as it was.
        request: vi.fn(async (method: string, path: string, ...rest: unknown[]) => (
            path === '/api/node-admin/me' ? { role: node.role, communityName: 'Mullum' } : (actual.request as any)(method, path, ...rest)
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
const ORIGIN = window.location.origin;
const LINE = `BeanPool works in any browser: open ${ORIGIN} on any computer or phone`;
const openSettings = () => render(<SettingsPage identity={identity} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}} />);
const lineBlock = async () => screen.findByTestId('settings-use-in-browser');
const writeText = vi.fn(async (_text: string) => {});

beforeEach(() => {
    node.role = null;
    writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
});
afterEach(() => {
    // jsdom has no execCommand; the tests below that need one put it there.
    Reflect.deleteProperty(document, 'execCommand');
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('Settings → "BeanPool works in any browser: open <address> on any computer or phone"', () => {
    it('a member sees the line with the address this page is served from', async () => {
        openSettings();
        const row = await lineBlock();
        expect(within(row).getByTestId('settings-use-in-browser-line').textContent).toBe(LINE);
        // The address is text, not a link: a dead link on the page you are already on helps no one.
        expect(row.querySelector('a')).toBeNull();
        expect(within(row).getByText(ORIGIN).tagName).toBe('CODE');
    });

    it('it sits with the phone app and install rows, before "Use the phone app"', async () => {
        openSettings();
        const row = await lineBlock();
        const phoneApp = await screen.findByTestId('settings-use-phone-app');
        expect(row.parentElement).toBe(phoneApp.parentElement!.parentElement);
        expect(row.compareDocumentPosition(phoneApp) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('Copy copies the address and says Copied', async () => {
        openSettings();
        const row = await lineBlock();
        const copy = within(row).getByRole('button', { name: "Copy this community's link" });
        expect(copy.textContent).toBe('📋 Copy');
        fireEvent.click(copy);
        await waitFor(() => expect(writeText).toHaveBeenCalledWith(ORIGIN));
        await waitFor(() => expect(within(row).getByRole('button').textContent).toBe('✓ Copied!'));
        expect(writeText).toHaveBeenCalledTimes(1);
    });

    // The browser may not let the page copy: a plain http:// home-network node has no clipboard API (navigator.clipboard is
    // undefined), and the older copy command answers false when it is refused, or throws. Copy must say so, never "Copied".
    describe('when the browser will not copy', () => {
        const noClipboard = () => Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
        const refusingClipboard = () => Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied'); }) }, configurable: true });
        const execCommand = (impl: () => boolean) => {
            const fn = vi.fn(impl);
            Object.defineProperty(document, 'execCommand', { value: fn, configurable: true });
            return fn;
        };
        const press = async () => {
            openSettings();
            const row = await lineBlock();
            fireEvent.click(within(row).getByRole('button', { name: "Copy this community's link" }));
            return row;
        };

        it('the clipboard refuses and the older command answers false: "Could not copy", never "Copied", and no helper box is left in the page', async () => {
            refusingClipboard();
            const exec = execCommand(() => false);
            const row = await press();
            await waitFor(() => expect(within(row).getByRole('button').textContent).toBe('Could not copy'));
            expect(exec).toHaveBeenCalledWith('copy');
            expect(row.textContent).not.toContain('Copied');
            expect(within(row).getByRole('status').textContent).toBe('Could not copy');
            expect(document.querySelector('textarea')).toBeNull();
        });

        it('there is no clipboard at all (a plain http:// page) and the older command throws: "Could not copy", and the page is left as it was', async () => {
            noClipboard();
            execCommand(() => { throw new Error('refused'); });
            const row = await press();
            await waitFor(() => expect(within(row).getByRole('button').textContent).toBe('Could not copy'));
            expect(row.textContent).not.toContain('Copied');
            expect(document.querySelector('textarea')).toBeNull();
        });

        it('there is no clipboard but the older command works (a plain http:// page): the address is copied that way and it says Copied', async () => {
            noClipboard();
            let copied = '';
            execCommand(() => { copied = document.querySelector('textarea')?.value ?? ''; return true; });
            const row = await press();
            await waitFor(() => expect(within(row).getByRole('button').textContent).toBe('✓ Copied!'));
            expect(copied).toBe(ORIGIN);
            expect(document.querySelector('textarea')).toBeNull();
        });

        it('the answer goes back to Copy after a moment, so a second try can be made', async () => {
            refusingClipboard();
            execCommand(() => false);
            const row = await press();
            await waitFor(() => expect(within(row).getByRole('button').textContent).toBe('Could not copy'));
            await waitFor(() => expect(within(row).getByRole('button').textContent).toBe('📋 Copy'), { timeout: 3500 });
        });
    });

    it('an owner sees both: the Manage link and this line, and the line is not in the owners\' block', async () => {
        node.role = 'owner';
        openSettings();
        const manage = await screen.findByRole('link', { name: /Manage Mullum/ });
        const row = await lineBlock();
        expect(row.textContent).toContain(LINE);
        expect(manage.closest('div.overflow-hidden')!.contains(row)).toBe(false);
    });

    it('wraps rather than runs off a 320 px screen: the address breaks anywhere and the words wrap', async () => {
        openSettings();
        const row = await lineBlock();
        expect(within(row).getByText(ORIGIN).className).toContain('break-all');
        expect(row.className).not.toMatch(/\bw-\[\d+px\]|\bwhitespace-nowrap\b/);
        expect(within(row).getByTestId('settings-use-in-browser-line').className).toContain('break-words');
    });
});
