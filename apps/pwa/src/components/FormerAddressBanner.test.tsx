import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FormerAddressBanner } from './FormerAddressBanner';
import { formerAddressNotice } from '../lib/former-address';
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

/** The host the web app reaches its community at: bp_node_url when set (lib/api.ts getNodeApiUrl), else the page's. */
const openedAt = (host: string | null) => {
    if (host) localStorage.setItem('bp_node_url', `https://${host}`);
    else localStorage.removeItem('bp_node_url');
};

/** Renders and waits for the community's answer to have been read, so an empty render means "nothing to say". */
async function renderBanner(info: CommunityInfo | Error, signedIn = false) {
    if (info instanceof Error) vi.mocked(communityInfoOnce).mockRejectedValue(info);
    else vi.mocked(communityInfoOnce).mockResolvedValue(info);
    const view = render(<FormerAddressBanner signedIn={signedIn} />);
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

describe('FormerAddressBanner', () => {
    beforeEach(() => {
        vi.clearAllMocks();
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
