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

/**
 * The server as these tests play it, answered to every status asked: whether it keeps the copy, whether it offers it
 * (its own word, which Settings goes by: the rule "This server" and a door anyone can't walk through), and a copy it
 * keeps but can't open (`unopenable`, why: its key gone, or another).
 */
let kept = false;
let offered = false;
let unopenable: { since: string; reason: 'recovery_seal_key_missing' | 'recovery_seal_unopenable' } | null = null;

beforeEach(() => {
    localStorage.clear();
    resetCommunityInfoOnce();
    kept = false;
    offered = false;
    unopenable = null;
    vi.mocked(copyLib.webCommunityCopyStatus).mockImplementation(async () => ({ kept, since: kept ? SINCE : null, offered, unopenable }));
    vi.mocked(copyLib.webRemoveCommunityCopy).mockImplementation(async () => { kept = false; unopenable = null; });
    vi.mocked(copyLib.webTurnOnCommunityCopy).mockImplementation(async () => { kept = true; unopenable = null; return { since: SINCE }; });
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
        offered = true;
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

describe("Settings: a copy this server keeps but can't open is never On, nor a way back (#2626 deciding pass)", () => {
    it("its key gone: the section says kept but can't be opened and what the people who run it can do, with Remove only; the list shows it as that", async () => {
        unopenable = { since: SINCE, reason: 'recovery_seal_key_missing' };
        offered = true;
        vi.mocked(api.getCommunityInfo).mockResolvedValue(SERVER_RULE);
        renderSettings();
        const section = await screen.findByTestId('community-admins-section');
        await waitFor(() => expect(within(section).getByTestId('community-admins-cant-open')).toBeInTheDocument());
        const said = within(section).getByTestId('community-admins-cant-open');
        expect(said).toHaveTextContent(/Kept since .*2026, but this community's server can't open it now, so your admins can't bring you back with it\./);
        expect(said).toHaveTextContent('The server is missing the key it locks these copies with. The people who run it can put that key back. Until then, your 12 words still work.');
        expect(within(section).queryByTestId('community-admins-on')).toBeNull();
        expect(within(section).queryByTestId('community-admins-turn-on'), 'turning it on again can\'t work without the key').toBeNull();
        expect(within(section).getByTestId('community-admins-remove')).toBeInTheDocument();

        const server = await openWaysBack();
        const row = within(server).getByTestId('ways-back-admins-cant-open');
        expect(row).toHaveTextContent(/Kept since .*2026/);
        expect(row).toHaveTextContent("This server can't open this copy now, so it can't bring your account back.");
        expect(within(server).queryByTestId('ways-back-admins-copy'), 'never listed as a way back').toBeNull();
        expect(server).not.toHaveTextContent('Keeps no copy of your account.');
    });

    it("removing it from the list asks about the copy as what it is: no words-first line, since no way back goes with it", async () => {
        unopenable = { since: SINCE, reason: 'recovery_seal_key_missing' };
        renderSettings();
        const server = await openWaysBack();
        await waitFor(() => expect(within(server).getByTestId('ways-back-admins-cant-open')).toBeInTheDocument());
        fireEvent.click(within(server).getByRole('button', { name: "Remove the copy at this community's server that it can't open" }));
        const box = within(server).getByTestId('ways-back-confirm');
        expect(box).toHaveTextContent('Remove this copy?');
        expect(box).toHaveTextContent("This community's server deletes the copy it can't open. Your 12 words still work.");
        expect(within(box).queryByTestId('ways-back-words-first')).toBeNull();
        fireEvent.click(within(box).getByRole('button', { name: 'Remove' }));
        await waitFor(() => expect(copyLib.webRemoveCommunityCopy).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(within(server).queryByTestId('ways-back-admins-cant-open')).toBeNull());
        expect(server).toHaveTextContent('Keeps no copy of your account.');
    });

    it("another key in its place, offered: Turn on again makes a copy it can open, and both then say On", async () => {
        unopenable = { since: SINCE, reason: 'recovery_seal_unopenable' };
        offered = true;
        vi.mocked(api.getCommunityInfo).mockResolvedValue(SERVER_RULE);
        renderSettings();
        const section = await screen.findByTestId('community-admins-section');
        await waitFor(() => expect(within(section).getByTestId('community-admins-cant-open')).toHaveTextContent('It was locked with a key the server no longer has. Turn it on again to make a copy it can open.'));
        const again = within(section).getByTestId('community-admins-turn-on');
        expect(again).toHaveTextContent('Turn on again');
        fireEvent.click(again);
        await waitFor(() => expect(copyLib.webTurnOnCommunityCopy).toHaveBeenCalledTimes(1));
        expect(await within(section).findByTestId('community-admins-on')).toHaveTextContent('On since');
        expect(within(section).queryByTestId('community-admins-cant-open')).toBeNull();
    });

    it("another key in its place, no longer offered: no Turn on; it can be removed", async () => {
        unopenable = { since: SINCE, reason: 'recovery_seal_unopenable' };
        renderSettings();
        const section = await screen.findByTestId('community-admins-section');
        await waitFor(() => expect(within(section).getByTestId('community-admins-cant-open')).toHaveTextContent('and this community no longer makes new copies. You can remove it; your 12 words still work.'));
        expect(within(section).queryByTestId('community-admins-turn-on')).toBeNull();
        expect(within(section).getByTestId('community-admins-remove')).toBeInTheDocument();
    });
});

describe("Settings: Turn on is offered on the server's own word (#2626 deciding pass, nit)", () => {
    it("the rule says 'This server', but the server answers that it doesn't offer it (a door anyone can walk through): no Turn on", async () => {
        vi.mocked(api.getCommunityInfo).mockResolvedValue(SERVER_RULE);
        offered = false;
        renderSettings();
        await waitFor(() => expect(copyLib.webCommunityCopyStatus).toHaveBeenCalled());
        await waitFor(() => expect(screen.queryByTestId('community-admins-turn-on')).toBeNull());
        expect(screen.queryByTestId('community-admins-section')).toBeNull();
    });

    it("the server couldn't be asked: the rule decides, as before", async () => {
        vi.mocked(api.getCommunityInfo).mockResolvedValue(SERVER_RULE);
        vi.mocked(copyLib.webCommunityCopyStatus).mockResolvedValue(null);
        renderSettings();
        expect(await screen.findByTestId('community-admins-turn-on')).toHaveTextContent('Turn on');
    });

    // As on the phone (#2683 deciding pass): a server that refuses the copy has already been handed its whole key.
    it("while the server is still being asked there is nothing to tap, even where the rule reads 'This server'", async () => {
        vi.mocked(api.getCommunityInfo).mockResolvedValue(SERVER_RULE);
        vi.mocked(copyLib.webCommunityCopyStatus).mockImplementation(() => new Promise(() => {}));
        renderSettings();
        await waitFor(() => expect(api.getCommunityInfo).toHaveBeenCalled());
        await waitFor(() => expect(copyLib.webCommunityCopyStatus).toHaveBeenCalled());
        expect(await screen.findByRole('button', { name: /Where your account can be brought back from/ })).toBeInTheDocument();
        expect(screen.queryByTestId('community-admins-turn-on')).toBeNull();
    });

    it("the server still can't be asked at the tap: it says so, and the whole key stays in this browser", async () => {
        vi.mocked(api.getCommunityInfo).mockResolvedValue(SERVER_RULE);
        vi.mocked(copyLib.webCommunityCopyStatus).mockResolvedValue(null);
        renderSettings();
        fireEvent.click(await screen.findByTestId('community-admins-turn-on'));
        expect(await screen.findByText('Couldn’t reach your community, so nothing changed. Try again in a moment.')).toBeInTheDocument();
        expect(copyLib.webTurnOnCommunityCopy).not.toHaveBeenCalled();
    });

    it("the rule moved since the page read it: asked at the tap, the server no longer offers it, so the whole key stays in this browser", async () => {
        vi.mocked(api.getCommunityInfo).mockResolvedValue(SERVER_RULE);
        offered = true;
        renderSettings();
        const turnOn = await screen.findByTestId('community-admins-turn-on');
        offered = false;
        fireEvent.click(turnOn);
        await waitFor(() => expect(screen.queryByTestId('community-admins-turn-on')).toBeNull());
        expect(copyLib.webTurnOnCommunityCopy).not.toHaveBeenCalled();
        expect(screen.queryByTestId('community-admins-on')).toBeNull();
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
