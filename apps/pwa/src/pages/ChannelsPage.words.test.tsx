/**
 * Channels & Showcase in the member's language (words S3, web sweep W1), as the phone's app/channels.tsx: in the
 * pseudo-locale every word on the page came through t(), core's own (the categories, what a platform asks of the member,
 * the example handles, our own platform names) included. What others wrote is shown as written: a member's handles, and
 * a platform's brand name (YouTube, TikTok …), which reads the same in every language (core channels.ts platformName).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChannelsPage } from './ChannelsPage';
import { addMemberChannel, getMemberChannels, type MemberCreatorChannel } from '../lib/api';
import type { BeanPoolIdentity } from '../lib/identity';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';

vi.mock('../lib/api', () => ({
    getMemberChannels: vi.fn(),
    addMemberChannel: vi.fn(),
    updateMemberChannel: vi.fn(async () => ({ success: true })),
    deleteMemberChannel: vi.fn(async () => ({ success: true })),
}));
// The nudges above the list are their own component, with their own words check.
vi.mock('../components/PulseNudges', () => ({ PulseNudges: () => null }));

const identity: BeanPoolIdentity = { publicKey: 'my-pubkey', privateKey: 'my-privkey', callsign: 'Ana', createdAt: '2026-09-14T00:00:00Z' };
const channel = (over: Partial<MemberCreatorChannel> & Pick<MemberCreatorChannel, 'id' | 'platform'>): MemberCreatorChannel => ({
    url: null, handle: null, category: 'other', isPrimaryVideo: false, supportsAutolist: false, oauthVerifiedAt: null, syndicateToNode: true, ...over,
});
const YT = channel({ id: 'ch-yt', platform: 'youtube', handle: '@anagrows', url: 'https://youtube.com/@anagrows', category: 'food', isPrimaryVideo: true, supportsAutolist: true, oauthVerifiedAt: '2026-10-01T00:00:00Z' });
const IG = channel({ id: 'ch-ig', platform: 'instagram', handle: '@ana.makes', url: 'https://instagram.com/ana.makes', category: 'craft' });
const WEB = channel({ id: 'ch-web', platform: 'website', url: 'https://ana.example', category: 'community' });
const TT = channel({ id: 'ch-tt', platform: 'tiktok', handle: '@anadances', url: 'https://tiktok.com/@anadances', category: 'art' });

/** Brand names and what members wrote: shown as written in every language. */
const OTHERS = ['YouTube', 'Instagram', 'TikTok', 'SoundCloud', 'Facebook', '@anagrows', '@ana.makes', '@anadances'];

const props = { identity, onBack: () => {}, onViewFeed: () => {}, onSharePost: () => {} };

beforeEach(() => {
    vi.mocked(getMemberChannels).mockReset().mockResolvedValue({ channels: [YT, IG, WEB] });
    vi.mocked(addMemberChannel).mockReset();
});
afterEach(() => { cleanup(); backToEnglish(); });

describe('Channels & Showcase in the pseudo-locale', () => {
    it('the list, a category picker and the remove card: every word through t()', async () => {
        await showIn('xx');
        render(<ChannelsPage {...props} />);
        await screen.findByText(xx('✓ Verified'));
        expect(bracketed()).toBeGreaterThan(20);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        // The banner names the main channel by its brand, inside the sentence.
        expect(document.body.textContent).toContain(xx('You post video in more than one place. The feed uses your {platform} as the main one.').replace('{platform}', 'YouTube'));
        // Our own platform name and a listing are translated; a brand is not.
        expect(screen.getByText(xx('Website'))).toBeInTheDocument();
        expect(screen.getByLabelText(xx('Show {platform} on the local feed').replace('{platform}', 'Instagram'))).toBeInTheDocument();

        fireEvent.click(screen.getAllByRole('button', { name: xx('Change category') })[0]);
        expect(screen.getByText(xx('Select Category'))).toBeInTheDocument();
        expect(screen.getAllByText(xx('Food & growing')).length).toBeGreaterThan(0);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);

        fireEvent.click(screen.getAllByRole('button', { name: xx('Remove') })[0]);
        const dialog = await screen.findByRole('dialog');
        expect(dialog.textContent).toContain(xx('{channel} will no longer appear on your profile.').replace('{channel}', 'YouTube · @anagrows'));
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
    });

    it('no channels yet, the add form, and the cross-post question after a second video channel', async () => {
        await showIn('xx');
        vi.mocked(getMemberChannels).mockResolvedValueOnce({ channels: [] }).mockResolvedValue({ channels: [YT, TT] });
        vi.mocked(addMemberChannel).mockResolvedValue({ channel: TT, otherVideoChannels: [YT] } as never);
        render(<ChannelsPage {...props} />);
        await screen.findByText(xx('Already posting your work somewhere?'));
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);

        fireEvent.click(screen.getAllByRole('button', { name: xx('+ Add a channel') })[0]);
        expect(screen.getByText(xx('Where do you post?'))).toBeInTheDocument();
        // The example handle is core's word('youtube.com/@you'), translated where it is drawn.
        expect(screen.getByPlaceholderText(xx('youtube.com/@you'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);

        fireEvent.click(screen.getByRole('button', { name: /TikTok/ }));
        fireEvent.change(screen.getByPlaceholderText(xx('@yourhandle')), { target: { value: 'tiktok.com/@anadances' } });
        fireEvent.click(screen.getByRole('button', { name: xx('{emoji} {label}').replace('{emoji}', '🎨').replace('{label}', xx('Art & music')) }));
        await act(async () => { fireEvent.click(screen.getByRole('button', { name: xx('Add channel') })); });

        const dialog = await screen.findByRole('dialog');
        expect(dialog.textContent).toContain(xx('You post video in two places'));
        expect(dialog.textContent).toContain(xx("If you put the same videos on {platform} and {other}, they'd show up twice on the feed.\n\nWhich should the feed use?")
            .replace('{platform}', 'TikTok').replace('{other}', 'YouTube'));
        expect(screen.getByRole('button', { name: xx('{platform} (updates itself)').replace('{platform}', 'YouTube') })).toBeInTheDocument();
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
    });

    it("a list the node wouldn't give, and no identity on this device: the page's own sentence through t()", async () => {
        await showIn('xx');
        vi.mocked(getMemberChannels).mockRejectedValue(new Error(''));
        render(<ChannelsPage {...props} />);
        expect(await screen.findByRole('alert')).toHaveTextContent(xx('Could not load your channels.'));
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        cleanup();

        render(<ChannelsPage {...props} identity={null} />);
        expect(await screen.findByRole('alert')).toHaveTextContent(xx('No identity on this device yet.'));
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
    });
});

describe('Channels & Showcase in English', () => {
    it('nothing is bracketed, and the words are as they were', async () => {
        render(<ChannelsPage {...props} />);
        await screen.findByText('✓ Verified');
        expect(bracketed()).toBe(0);
        expect(document.body.textContent).toContain('You post video in more than one place. The feed uses your YouTube as the main one.');
        expect(screen.getByText('Updates itself (connected) · main video channel')).toBeInTheDocument();
        expect(screen.getAllByText('a tap per post').length).toBeGreaterThan(0);
        expect(screen.getByText('Food & growing')).toBeInTheDocument();
        expect(screen.getByLabelText('Show YouTube on the local feed')).toBeInTheDocument();
        const notice = screen.getByText('Creator account linking:').parentElement!;
        expect(notice.textContent).toBe('📱 Creator account linking: Automatic feed sync via OAuth is configured on the phone app. On the web client, you can share individual posts directly with "+ Share post" below.');
        fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]);
        await waitFor(() => expect(screen.getByRole('dialog').textContent).toContain('Instagram · @ana.makes will no longer appear on your profile.'));
    });
});
