import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FormerAddressBanner } from './FormerAddressBanner';
import {
    dismissMainAddress,
    formerAddressNotice,
    isMainAddressDismissed,
    nonPrimaryAddressNotice,
} from '../lib/former-address';
import { communityInfoOnce } from '../lib/visitor-lobby-gate';
import type { CommunityInfo } from '../lib/api';

vi.mock('../lib/visitor-lobby-gate', () => ({ communityInfoOnce: vi.fn() }));

const base: CommunityInfo = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0 };
const moved = (over: Partial<CommunityInfo> = {}): CommunityInfo => ({
    ...base,
    addresses: ['newname.beanpool.org'],
    primaryAddress: 'newname.beanpool.org',
    formerAddresses: ['oldname.beanpool.org'],
    ...over,
});

const renamedFleet = (over: Partial<CommunityInfo> = {}): CommunityInfo => ({
    ...base,
    addresses: ['byron.beanpool.org', 'mullum.beanpool.org'],
    primaryAddress: 'byron.beanpool.org',
    ...over,
});

/** The host the web app reaches its community at: bp_node_url when set (lib/api.ts getNodeApiUrl), else the page's. */
const openedAt = (host: string | null) => {
    if (host) localStorage.setItem('bp_node_url', `https://${host}`);
    else localStorage.removeItem('bp_node_url');
};

/** Renders and waits for the community's answer to have been read, so an empty render means "nothing to say". */
async function renderBanner(info: CommunityInfo | Error, signedIn = false, isGuest: boolean | null = false) {
    if (info instanceof Error) vi.mocked(communityInfoOnce).mockRejectedValue(info);
    else vi.mocked(communityInfoOnce).mockResolvedValue(info);
    const view = render(<FormerAddressBanner signedIn={signedIn} isGuest={isGuest} />);
    await waitFor(() => expect(communityInfoOnce).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    return view;
}

describe('formerAddressNotice (where the community lives now)', () => {
    it('at a former name: the primary address, and a plain link to it that carries nothing', () => {
        expect(formerAddressNotice(moved(), 'oldname.beanpool.org')).toEqual({ primaryAddress: 'newname.beanpool.org', href: 'https://newname.beanpool.org/' });
    });

    it('nothing at the current name, at another of its names, or anywhere not listed as former', () => {
        expect(formerAddressNotice(moved(), 'newname.beanpool.org')).toBeNull();
        expect(formerAddressNotice(moved({ addresses: ['newname.beanpool.org', 'community.example.org'] }), 'community.example.org')).toBeNull();
        expect(formerAddressNotice(moved(), 'localhost')).toBeNull();
        expect(formerAddressNotice(moved(), 'someone-else.beanpool.org')).toBeNull();
        expect(formerAddressNotice(moved(), null)).toBeNull();
        // A server that lists the primary as former too still sends nobody round in a circle.
        expect(formerAddressNotice(moved({ formerAddresses: ['newname.beanpool.org'] }), 'newname.beanpool.org')).toBeNull();
    });

    it('nothing when the node says no primary address (a node whose only name it released), or says nothing (an older node)', () => {
        expect(formerAddressNotice(moved({ primaryAddress: null }), 'oldname.beanpool.org')).toBeNull();
        expect(formerAddressNotice(moved({ primaryAddress: undefined }), 'oldname.beanpool.org')).toBeNull();
        expect(formerAddressNotice({ ...base, formerAddresses: ['oldname.beanpool.org'] }, 'oldname.beanpool.org')).toBeNull();
        expect(formerAddressNotice({ ...base, primaryAddress: 'newname.beanpool.org' }, 'oldname.beanpool.org')).toBeNull();
        expect(formerAddressNotice(null, 'oldname.beanpool.org')).toBeNull();
    });

    it('never links anywhere but a bare host: nothing for a scheme, a path, a port or anything else a host is not', () => {
        for (const primaryAddress of ['javascript:alert(1)', 'https://newname.beanpool.org', 'newname.beanpool.org/steal?k=1', 'newname.beanpool.org:8443',
            'user@newname.beanpool.org', 'NewName.beanpool.org', 'new name.beanpool.org', '', 42 as unknown as string]) {
            expect(formerAddressNotice(moved({ primaryAddress }), 'oldname.beanpool.org')).toBeNull();
        }
        expect(formerAddressNotice(moved({ formerAddresses: 'oldname.beanpool.org' as unknown as string[] }), 'oldname.beanpool.org')).toBeNull();
    });
});

describe('nonPrimaryAddressNotice (quiet line at an own non-primary address)', () => {
    it('at a non-main own address: the primary address, and a plain link to it', () => {
        expect(nonPrimaryAddressNotice(renamedFleet(), 'mullum.beanpool.org')).toEqual({
            primaryAddress: 'byron.beanpool.org',
            href: 'https://byron.beanpool.org/',
        });
    });

    it('nothing at the primary address', () => {
        expect(nonPrimaryAddressNotice(renamedFleet(), 'byron.beanpool.org')).toBeNull();
    });

    it('nothing on a LAN or loopback host', () => {
        expect(nonPrimaryAddressNotice(renamedFleet({ addresses: ['byron.beanpool.org', 'localhost'] }), 'localhost')).toBeNull();
        expect(nonPrimaryAddressNotice(renamedFleet({ addresses: ['byron.beanpool.org', '127.0.0.1'] }), '127.0.0.1')).toBeNull();
        expect(nonPrimaryAddressNotice(renamedFleet({ addresses: ['byron.beanpool.org', '192.168.1.10'] }), '192.168.1.10')).toBeNull();
        expect(nonPrimaryAddressNotice(renamedFleet({ addresses: ['byron.beanpool.org', 'mybox.local'] }), 'mybox.local')).toBeNull();
    });

    it('nothing when primaryAddress is a LAN or loopback host', () => {
        expect(nonPrimaryAddressNotice({ ...base, addresses: ['localhost', 'mullum.beanpool.org'], primaryAddress: 'localhost' }, 'mullum.beanpool.org')).toBeNull();
    });

    it('nothing with no primaryAddress, or missing from addresses', () => {
        expect(nonPrimaryAddressNotice(renamedFleet({ primaryAddress: null }), 'mullum.beanpool.org')).toBeNull();
        expect(nonPrimaryAddressNotice(renamedFleet({ primaryAddress: undefined }), 'mullum.beanpool.org')).toBeNull();
        expect(nonPrimaryAddressNotice(renamedFleet({ addresses: ['byron.beanpool.org'] }), 'mullum.beanpool.org')).toBeNull();
        expect(nonPrimaryAddressNotice(null, 'mullum.beanpool.org')).toBeNull();
        expect(nonPrimaryAddressNotice(renamedFleet(), null)).toBeNull();
    });

    it('nothing when host is in formerAddresses: formerAddressNotice handles it', () => {
        const withBoth: CommunityInfo = {
            ...base,
            addresses: ['byron.beanpool.org', 'mullum.beanpool.org'],
            primaryAddress: 'byron.beanpool.org',
            formerAddresses: ['mullum.beanpool.org'],
        };
        expect(nonPrimaryAddressNotice(withBoth, 'mullum.beanpool.org')).toBeNull();
    });

    it('never links anywhere but a bare host', () => {
        for (const primaryAddress of ['javascript:alert(1)', 'https://byron.beanpool.org', 'byron.beanpool.org/steal?k=1', 'byron.beanpool.org:8443', '']) {
            expect(nonPrimaryAddressNotice(renamedFleet({ primaryAddress }), 'mullum.beanpool.org')).toBeNull();
        }
    });
});

describe('dismissMainAddress / isMainAddressDismissed', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('starts not dismissed, dismiss holds per primary address', () => {
        expect(isMainAddressDismissed('byron.beanpool.org')).toBe(false);
        dismissMainAddress('byron.beanpool.org');
        expect(isMainAddressDismissed('byron.beanpool.org')).toBe(true);
        // Another primary address is not dismissed: a later move shows again
        expect(isMainAddressDismissed('next.beanpool.org')).toBe(false);
    });
});

describe('FormerAddressBanner', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        openedAt(null);
    });

    it('opened at a former address: says where the community lives now, with a plain link there, and never redirects', async () => {
        openedAt('oldname.beanpool.org');
        const before = window.location.href;
        await renderBanner(moved());
        const banner = await screen.findByTestId('former-address-banner');
        expect(banner.textContent).toBe('This community has moved to newname.beanpool.org. Open it there');
        const link = screen.getByRole('link', { name: 'Open it there' });
        expect(link.getAttribute('href')).toBe('https://newname.beanpool.org/');
        // The old address's query (an invite, a shared post) never goes with it, nor does the page as a referrer.
        expect(link.getAttribute('rel')).toContain('noreferrer');
        expect(window.location.href).toBe(before);
    });

    it('to a member signed in here: they sign in there again, as in a new browser', async () => {
        openedAt('oldname.beanpool.org');
        await renderBanner(moved(), true);
        expect((await screen.findByTestId('former-address-banner')).textContent)
            .toBe("This community has moved to newname.beanpool.org. Open it thereYou'll sign in there again, as you would in a new browser.");
    });

    it('shown at a non-main own address with the right host, link carries no secret, help toggles', async () => {
        openedAt('mullum.beanpool.org');
        const before = window.location.href;
        await renderBanner(renamedFleet());

        const banner = await screen.findByTestId('main-address-banner');
        expect(banner.textContent).toContain("This community's main address is now byron.beanpool.org. This address keeps working.");

        const link = screen.getByRole('link', { name: 'Open it there' });
        expect(link.getAttribute('href')).toBe('https://byron.beanpool.org/');
        expect(link.getAttribute('rel')).toContain('noreferrer');
        // A link carries no secret, key, seed or token: only the bare origin
        expect(link.getAttribute('href')).not.toContain('?');
        expect(link.getAttribute('href')).not.toContain('#');
        expect(window.location.href).toBe(before);

        // Help is hidden initially
        expect(screen.queryByTestId('main-address-help')).toBeNull();

        // Tapping "Link this browser from your phone" displays the help
        const linkBtn = screen.getByRole('button', { name: 'Link this browser from your phone' });
        expect(linkBtn.getAttribute('aria-expanded')).toBe('false');
        expect(linkBtn.getAttribute('aria-controls')).toBe('main-address-help');
        fireEvent.click(linkBtn);

        const help = await screen.findByTestId('main-address-help');
        expect(help.id).toBe('main-address-help');
        expect(linkBtn.getAttribute('aria-expanded')).toBe('true');
        expect(help.textContent).toBe(
            'To use byron.beanpool.org from this browser, the phone must be on byron.beanpool.org first, because a Link a device code is refused when the phone and browser are on different addresses.'
        );

        // Tapping again hides the help
        fireEvent.click(linkBtn);
        expect(screen.queryByTestId('main-address-help')).toBeNull();
        expect(linkBtn.getAttribute('aria-expanded')).toBe('false');
    });

    it('not shown at the primary address', async () => {
        openedAt('byron.beanpool.org');
        const { container } = await renderBanner(renamedFleet());
        expect(container.innerHTML).toBe('');
    });

    it('not shown on a LAN or loopback host', async () => {
        openedAt('localhost');
        const { container, unmount } = await renderBanner(renamedFleet({ addresses: ['byron.beanpool.org', 'localhost'] }));
        expect(container.innerHTML).toBe('');
        unmount();

        openedAt('192.168.1.5');
        const view2 = await renderBanner(renamedFleet({ addresses: ['byron.beanpool.org', '192.168.1.5'] }));
        expect(view2.container.innerHTML).toBe('');
    });

    it('not shown with no primaryAddress', async () => {
        openedAt('mullum.beanpool.org');
        const { container, unmount } = await renderBanner(renamedFleet({ primaryAddress: null }));
        expect(container.innerHTML).toBe('');
        unmount();

        const older = await renderBanner({ ...base, addresses: ['mullum.beanpool.org'] });
        expect(older.container.innerHTML).toBe('');
    });

    it('not shown on a guest look', async () => {
        openedAt('mullum.beanpool.org');
        const { container } = await renderBanner(renamedFleet(), false, /* isGuest */ true);
        expect(container.innerHTML).toBe('');
    });

    it('not shown while guest status is unknown (isGuest is null)', async () => {
        openedAt('mullum.beanpool.org');
        const { container } = await renderBanner(renamedFleet(), false, /* isGuest */ null);
        expect(container.innerHTML).toBe('');
    });

    it('not shown when isGuest is omitted (visitor view defaults to null)', async () => {
        openedAt('mullum.beanpool.org');
        render(<FormerAddressBanner />);
        await waitFor(() => expect(communityInfoOnce).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 0));
        expect(screen.queryByTestId('main-address-banner')).toBeNull();
    });

    it('dismissal holds, and a later move shows again', async () => {
        openedAt('mullum.beanpool.org');
        const { unmount } = await renderBanner(renamedFleet());
        const banner = await screen.findByTestId('main-address-banner');
        expect(banner).toBeDefined();

        // Dismiss the line
        const dismissBtn = screen.getByRole('button', { name: 'Dismiss' });
        fireEvent.click(dismissBtn);
        expect(screen.queryByTestId('main-address-banner')).toBeNull();

        unmount();

        // Re-rendering with the same primary address remains dismissed
        const { container: container2, unmount: unmount2 } = await renderBanner(renamedFleet());
        expect(container2.innerHTML).toBe('');
        unmount2();

        // A later move to a new primary address shows again
        const laterMove = renamedFleet({
            addresses: ['castle.beanpool.org', 'mullum.beanpool.org'],
            primaryAddress: 'castle.beanpool.org',
        });
        await renderBanner(laterMove);
        const banner3 = await screen.findByTestId('main-address-banner');
        expect(banner3.textContent).toContain("This community's main address is now castle.beanpool.org. This address keeps working.");
    });

    it('nothing at the current address', async () => {
        openedAt('newname.beanpool.org');
        const { container } = await renderBanner(moved());
        expect(container.innerHTML).toBe('');
    });

    it('nothing when the node says no primary address, or is too old to say', async () => {
        openedAt('oldname.beanpool.org');
        const { container, unmount } = await renderBanner(moved({ primaryAddress: null }));
        expect(container.innerHTML).toBe('');
        unmount();
        const older = await renderBanner({ ...base, addresses: ['newname.beanpool.org'] });
        expect(older.container.innerHTML).toBe('');
    });

    it('nothing when the node could not be asked', async () => {
        openedAt('oldname.beanpool.org');
        const { container } = await renderBanner(new Error('offline'));
        expect(container.innerHTML).toBe('');
    });

    it('a read that fails at once takes nothing down with it: the page around it still renders', async () => {
        openedAt('oldname.beanpool.org');
        vi.mocked(communityInfoOnce).mockImplementation(() => { throw new Error('no such export on the mock'); });
        render(<div data-testid="page"><FormerAddressBanner signedIn /><p>the page</p></div>);
        await waitFor(() => expect(communityInfoOnce).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 0));
        expect(screen.getByTestId('page').innerHTML).toBe('<p>the page</p>');
    });
});
