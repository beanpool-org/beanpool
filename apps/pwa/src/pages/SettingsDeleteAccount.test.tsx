/**
 * Settings → Account Deletion & Sign Out → Permanently Delete Account, by the phone's rule (Marty, 2026-09-29;
 * lib/delete-here.ts): the node deletes the account at the community the web app talks to, and this browser's copy of
 * the key goes only when no other community it serves keeps it.
 *
 * - The web app talks to the node that served the page: that is the only community this copy serves, and the delete
 *   wipes it, as before.
 * - Pointed at another node (Advanced → Sovereign Node Connection), and the page's own node keeps the key (a member
 *   there, or it can't be asked): the web app goes back to it, and the key stays.
 * - The node doesn't delete: nothing in the browser changes, and the screen says the key is still here.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import * as api from '../lib/api';
import * as identityLib from '../lib/identity';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        getNotificationPreferences: vi.fn(async () => ({})),
        getMemberPreferences: vi.fn(async () => ({})),
        getMemberProfile: vi.fn(async () => ({})),
        getNodeStats: vi.fn(async () => null),
        getCommunityHealth: vi.fn(async () => ({})),
        getSignInRecovery: vi.fn(async () => null),
        purgeAccountApi: vi.fn(async () => ({ ok: true, message: 'Account purged' })),
    };
});
vi.mock('../lib/identity', async () => {
    const actual = await vi.importActual('../lib/identity');
    return { ...actual, wipeIdentity: vi.fn(async () => {}) };
});

const WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Kim', mnemonic: WORDS };
const CASTLEMAINE = 'https://castlemaine.beanpool.org';

/** The page's own node's answer about the key; every other request is refused. */
function pageNode(answer: 'member' | 'stranger' | 'down') {
    const asked: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/community/membership/')) {
            asked.push(url);
            if (answer === 'down') throw new TypeError('Failed to fetch');
            return new Response(JSON.stringify(answer === 'member' ? { isMember: true } : { isMember: false, isRecovering: false }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
    }));
    return asked;
}

async function openDelete() {
    render(<SettingsPage identity={identity} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}} />);
    fireEvent.click(await screen.findByText('⚠️ Account Deletion & Sign Out'));
    fireEvent.click(screen.getByRole('button', { name: 'Permanently Delete Account' }));
    fireEvent.change(screen.getByLabelText(/Type callsign Kim or DELETE/), { target: { value: 'DELETE' } });
}

const purgeButton = () => screen.getByRole('button', { name: /Purge Account/ });

beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
    // The reload the page schedules after a delete never runs here.
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.mocked(api.purgeAccountApi).mockReset().mockResolvedValue({ ok: true, message: 'Account purged' });
    vi.mocked(identityLib.wipeIdentity).mockClear();
});

describe('Settings: Permanently Delete Account', () => {
    it('talking to the page\'s own node: the delete there, then this browser\'s key goes, as before', async () => {
        const asked = pageNode('member');
        localStorage.setItem('beanpool-theme-mode', 'dark');
        await openDelete();

        expect(await screen.findByTestId('delete-key-plan')).toHaveTextContent(
            "Your key and 12 words leave this browser, for this web address. The phone app, and other communities' web addresses, keep their own copy.");
        await act(async () => { fireEvent.click(purgeButton()); });

        expect(api.purgeAccountApi).toHaveBeenCalledTimes(1);
        expect(identityLib.wipeIdentity).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem('beanpool-theme-mode')).toBeNull();
        expect(await screen.findByText('Account data purged. Reloading app...')).toBeInTheDocument();
        // No other community to ask.
        expect(asked).toEqual([]);
    });

    it('pointed at Castlemaine, and the page\'s own node still has Kim: the delete at Castlemaine; the key stays and the web app goes back', async () => {
        localStorage.setItem('bp_node_url', CASTLEMAINE);
        localStorage.setItem('beanpool-theme-mode', 'dark');
        const asked = pageNode('member');
        await openDelete();

        const home = window.location.host;
        expect(await screen.findByText(new RegExp(`Your key and 12 words stay in this browser, for ${home.replace('.', '\\.')}`))).toBeInTheDocument();
        await act(async () => { fireEvent.click(purgeButton()); });

        expect(api.purgeAccountApi).toHaveBeenCalledTimes(1);
        expect(identityLib.wipeIdentity).not.toHaveBeenCalled();
        expect(localStorage.getItem('bp_node_url')).toBeNull();
        expect(localStorage.getItem('beanpool-theme-mode')).toBe('dark');
        expect(await screen.findByText(`Account deleted at castlemaine.beanpool.org. This browser keeps your key for ${home}. Reloading app...`)).toBeInTheDocument();
        expect(asked).toEqual([`${window.location.origin}/api/community/membership/me-pk`]);
    });

    it('the page\'s own node can\'t be reached: it counts as still having Kim, so the key stays', async () => {
        localStorage.setItem('bp_node_url', CASTLEMAINE);
        pageNode('down');
        await openDelete();

        expect(await screen.findByText(/couldn't be reached, so it counts as a community you are still in\./)).toBeInTheDocument();
        await act(async () => { fireEvent.click(purgeButton()); });

        expect(identityLib.wipeIdentity).not.toHaveBeenCalled();
        expect(localStorage.getItem('bp_node_url')).toBeNull();
    });

    it('the page\'s own node says Kim is no member: the last community, so the key goes', async () => {
        localStorage.setItem('bp_node_url', CASTLEMAINE);
        pageNode('stranger');
        await openDelete();

        expect(await screen.findByText(/Your key and 12 words leave this browser/)).toBeInTheDocument();
        await act(async () => { fireEvent.click(purgeButton()); });

        expect(identityLib.wipeIdentity).toHaveBeenCalledTimes(1);
    });

    it('the node refuses the delete: nothing in this browser changes, and the screen says the key is still here', async () => {
        localStorage.setItem('bp_node_url', CASTLEMAINE);
        pageNode('stranger');
        vi.mocked(api.purgeAccountApi).mockRejectedValue(new Error('You have an escrow deal under way.'));
        await openDelete();

        await screen.findByText(/Your key and 12 words leave this browser/);
        await act(async () => { fireEvent.click(purgeButton()); });

        expect(await screen.findByText('You have an escrow deal under way. Nothing was removed from this browser: your key is still here.'))
            .toHaveAttribute('id', 'purge-error-alert');
        expect(identityLib.wipeIdentity).not.toHaveBeenCalled();
        expect(localStorage.getItem('bp_node_url')).toBe(CASTLEMAINE);
        expect(screen.queryByText(/Reloading app/)).toBeNull();
    });

    it('the button waits for the answer', async () => {
        localStorage.setItem('bp_node_url', CASTLEMAINE);
        vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
        await openDelete();

        expect(screen.getByTestId('delete-key-plan')).toHaveTextContent('Checking whether this browser still needs your key…');
        expect(purgeButton()).toBeDisabled();
    });
});
