/**
 * Settings → "Your community's admins" and "Where your account can be brought back from" together (vault rethink VR3 on
 * top of VR1, design §4.3, §4.5 and §5.1): the web app turns the community copy on and off, and the Ways back list shows
 * the copy this server keeps for its admins, since when, and removes it. The page asks the server about the copy once
 * and after each change, so the two always say the same, wherever the copy was turned on; "Keeps no copy" is never said
 * while the server keeps one. Removed and On are said only on the server's own answer (lib/community-copy.ts).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import * as api from '../lib/api';
import * as copyLib from '../lib/community-copy';
import { resetCommunityInfoOnce } from '../lib/visitor-lobby-gate';

vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return {
        ...actual,
        getNotificationPreferences: vi.fn(async () => ({})),
        getMemberPreferences: vi.fn(async () => ({})),
        getMemberProfile: vi.fn(async () => ({})),
        getNodeStats: vi.fn(async () => null),
        getCommunityHealth: vi.fn(async () => ({})),
        getSignInRecovery: vi.fn(async () => []),
        removeSignInCopy: vi.fn(async () => true),
        getCommunityInfo: vi.fn(async () => { throw new Error('not asked'); }),
    };
});
vi.mock('../lib/community-copy', async () => {
    const actual = await vi.importActual('../lib/community-copy');
    return {
        ...actual,
        webCommunityCopyStatus: vi.fn(async () => null),
        webTurnOnCommunityCopy: vi.fn(async () => ({ since: SINCE })),
        webRemoveCommunityCopy: vi.fn(async () => {}),
    };
});

const SINCE = '2026-10-29T04:05:06.000Z';
const WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'Me', mnemonic: WORDS };
const SERVER_RULE = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'local' as const, recoveryCopies: 'server' as const };

function renderSettings() {
    render(<SettingsPage identity={identity} onIdentityUpdated={() => {}} onBack={() => {}} themePreference="system" onThemePreferenceChange={() => {}} />);
}

async function openWaysBack() {
    fireEvent.click(await screen.findByRole('button', { name: /Where your account can be brought back from/ }));
    return screen.getByTestId('ways-back-server');
}

/** The server as these tests play it: whether it keeps the copy, answered to every status asked. */
let kept = false;

beforeEach(() => {
    localStorage.clear();
    resetCommunityInfoOnce();
    kept = false;
    vi.mocked(copyLib.webCommunityCopyStatus).mockImplementation(async () => ({ kept, since: kept ? SINCE : null, offered: true }));
    vi.mocked(copyLib.webRemoveCommunityCopy).mockImplementation(async () => { kept = false; });
    vi.mocked(copyLib.webTurnOnCommunityCopy).mockImplementation(async () => { kept = true; return { since: SINCE }; });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.mocked(api.getSignInRecovery).mockReset();
    vi.mocked(api.getSignInRecovery).mockImplementation(async () => []);
    vi.mocked(api.getCommunityInfo).mockReset();
    vi.mocked(api.getCommunityInfo).mockImplementation(async () => { throw new Error('not asked'); });
});

describe("Settings: your community's admins, and its copy in the Ways back list (vault rethink VR3)", () => {
    it("kept here: both say so; the list shows it with since when and never 'Keeps no copy'", async () => {
        kept = true;
        renderSettings();
        // Not offered here any more (no rule read): the copy is still the member's, and says so.
        const section = await screen.findByTestId('community-admins-section');
        expect(within(section).getByTestId('community-admins-on')).toHaveTextContent('On since');
        expect(section).toHaveTextContent('This community no longer offers this to new members. Your copy here still works until you remove it.');
        const server = await openWaysBack();
        const row = within(server).getByTestId('ways-back-admins-copy');
        expect(row).toHaveTextContent("Your community's admins");
        expect(row).toHaveTextContent('A locked copy an admin can bring your account back from, when they see you in person.');
        expect(row).toHaveTextContent(/Kept since .*2026/);
        expect(server).not.toHaveTextContent('Keeps no copy of your account.');
        // Asked once for both: the page shares the one answer.
        expect(copyLib.webCommunityCopyStatus).toHaveBeenCalledTimes(1);
    });

    it("removed from the Ways back list: the last way back asks about the words first; then both say it is gone", async () => {
        kept = true;
        renderSettings();
        const server = await openWaysBack();
        fireEvent.click(within(server).getByRole('button', { name: "Remove the copy at this community's server that its admins can bring you back from" }));
        const box = within(server).getByTestId('ways-back-confirm');
        expect(box).toHaveTextContent('Remove this way back?');
        expect(box).toHaveTextContent("This community's server deletes its copy of your account. Your admins can no longer bring you back; your 12 words still work.");
        // The only copy this browser can see: the words are asked about first.
        expect(within(box).getByTestId('ways-back-words-first')).toBeInTheDocument();
        fireEvent.click(within(box).getByRole('button', { name: 'Remove anyway' }));
        await waitFor(() => expect(copyLib.webRemoveCommunityCopy).toHaveBeenCalledTimes(1));
        expect(await screen.findByTestId('ways-back-result')).toHaveTextContent("Removed from this community's server.");
        await waitFor(() => expect(within(server).queryByTestId('ways-back-admins-copy')).toBeNull());
        expect(server).toHaveTextContent('Keeps no copy of your account.');
        // The section, read again from the same answer: no longer on, and (not offered here) gone.
        await waitFor(() => expect(screen.queryByTestId('community-admins-section')).toBeNull());
    });

    it("a removal the server didn't confirm: 'Not removed', and the copy stays listed", async () => {
        kept = true;
        vi.mocked(copyLib.webRemoveCommunityCopy).mockImplementation(async () => { throw new Error(copyLib.WEB_COMMUNITY_COPY_TEXT.unreachable); });
        renderSettings();
        const server = await openWaysBack();
        fireEvent.click(within(server).getByRole('button', { name: "Remove the copy at this community's server that its admins can bring you back from" }));
        fireEvent.click(within(server).getByRole('button', { name: 'Remove anyway' }));
        expect(await screen.findByTestId('ways-back-result')).toHaveTextContent("Not removed: this community's server didn't answer. Try again.");
        expect(within(server).getByTestId('ways-back-admins-copy')).toBeInTheDocument();
    });

    it("offered here (rule 'This server'): Turn on, then both show it; removing it in the section takes it off the list", async () => {
        vi.mocked(api.getCommunityInfo).mockResolvedValue(SERVER_RULE);
        renderSettings();
        const section = await screen.findByTestId('community-admins-section');
        const server = await openWaysBack();
        expect(server).toHaveTextContent('Keeps no copy of your account.');
        fireEvent.click(within(section).getByTestId('community-admins-turn-on'));
        await waitFor(() => expect(copyLib.webTurnOnCommunityCopy).toHaveBeenCalledTimes(1));
        expect(await within(section).findByTestId('community-admins-on')).toHaveTextContent('On since');
        expect(await within(server).findByTestId('ways-back-admins-copy')).toBeInTheDocument();
        expect(server).not.toHaveTextContent('Keeps no copy of your account.');

        fireEvent.click(within(section).getByTestId('community-admins-remove'));
        await waitFor(() => expect(copyLib.webRemoveCommunityCopy).toHaveBeenCalledTimes(1));
        expect(await within(section).findByTestId('community-admins-turn-on')).toBeInTheDocument();
        await waitFor(() => expect(within(server).queryByTestId('ways-back-admins-copy')).toBeNull());
    });

    it("a server that couldn't be asked about it (or one from before it): nothing listed for it, and the sign-in copies as before", async () => {
        vi.mocked(copyLib.webCommunityCopyStatus).mockResolvedValue(null);
        vi.mocked(api.getSignInRecovery).mockResolvedValue(['google']);
        renderSettings();
        const server = await openWaysBack();
        expect(within(server).getByRole('button', { name: "Remove the Google copy at this community's server" })).toBeInTheDocument();
        expect(within(server).queryByTestId('ways-back-admins-copy')).toBeNull();
        expect(screen.queryByTestId('community-admins-section')).toBeNull();
    });
});

describe('lib/community-copy.ts: a removal counts only on the server\'s own answer', () => {
    it("a 200 that isn't the server's (a proxy's page) is not a removal; the server's { kept: false } is", async () => {
        const actual = await vi.importActual<typeof import('../lib/community-copy')>('../lib/community-copy');
        const fetchSpy = vi.fn<typeof fetch>();
        vi.stubGlobal('fetch', fetchSpy);
        fetchSpy.mockResolvedValueOnce(new Response('<html>Welcome to the cafe wifi</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
        await expect(actual.webRemoveCommunityCopy()).rejects.toThrow(actual.WEB_COMMUNITY_COPY_TEXT.unreachable);
        fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ removed: 1, kept: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        await expect(actual.webRemoveCommunityCopy()).resolves.toBeUndefined();
        fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'This server is a standby.', code: 'standby' }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
        await expect(actual.webRemoveCommunityCopy()).rejects.toThrow('This server is a standby.');
    });
});
