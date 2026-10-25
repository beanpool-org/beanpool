/**
 * Sharing a post to the Pulse, in the member's language (words S3, web sweep W1): the page's words, its errors and the
 * preview card through t(), the phone's pulse-intake keys. The link, the post's title, the member's handle and name are
 * theirs; a platform's brand reads as written. What is SENT is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PulseIntakePage } from './PulseIntakePage';
import { getMemberChannels, previewPulsePost, submitPulsePost } from '../lib/api';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';

vi.mock('../lib/api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/api')>()),
    getMemberChannels: vi.fn(),
    previewPulsePost: vi.fn(),
    submitPulsePost: vi.fn(),
}));

const identity: any = { publicKey: 'me-pk', privateKey: 'priv', callsign: 'GreenThumb' };
const LINK = 'https://instagram.com/p/abc123/';
const CHANNELS = [
    { id: 'ch-ig', platform: 'instagram', url: 'https://instagram.com/greenthumb', handle: '@greenthumb', category: 'food' },
    { id: 'ch-yt', platform: 'youtube', url: 'https://youtube.com/@greenthumb', handle: null, category: 'craft' },
];
/** What the member wrote and linked, and the platforms' brand names, shown as written; ℹ is an emoji Unicode counts as a letter. */
const OTHERS = [LINK, 'Saving tomato seed', 'GreenThumb', '@greenthumb', 'Instagram', 'YouTube', 'ℹ️'];

beforeEach(() => {
    vi.mocked(getMemberChannels).mockReset().mockResolvedValue({ channels: CHANNELS } as any);
    vi.mocked(previewPulsePost).mockReset().mockResolvedValue({
        preview: { url: LINK, title: 'Saving tomato seed', thumbnailUrl: null, platform: 'instagram', category: 'food', alreadyImported: false, existingItemId: null, channelId: null, publishedAt: null },
    } as any);
    vi.mocked(submitPulsePost).mockReset().mockResolvedValue({ success: true } as any);
});
afterEach(() => { cleanup(); backToEnglish(); });

const props = { identity, onBack: vi.fn(), onManageChannels: vi.fn(), onSuccess: vi.fn() };

describe('sharing to the Pulse in the pseudo-locale', () => {
    it('no channels yet: every word came through t()', async () => {
        vi.mocked(getMemberChannels).mockResolvedValue({ channels: [] } as any);
        await showIn('xx');
        render(<PulseIntakePage {...props} />);
        expect(await screen.findByText(xx('No Channels Connected'))).toBeInTheDocument();
        expect(bracketed()).toBeGreaterThan(6);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
    });

    it('the channels, the categories, a preview, a refusal and the success line', async () => {
        await showIn('xx');
        render(<PulseIntakePage {...props} initialUrl={LINK} />);
        expect(await screen.findByText('Saving tomato seed')).toBeInTheDocument();
        expect(screen.getByText(xx('Post from Channel'))).toBeInTheDocument();
        expect(screen.getByPlaceholderText(xx('https://instagram.com/p/... or tiktok.com/...'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);

        // Two channels and none picked: the page says which is missing.
        fireEvent.click(await screen.findByRole('button', { name: xx('Share to Pulse') }));
        expect(await screen.findByText(xx('Please select which of your channels this post belongs to.'))).toBeInTheDocument();
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);

        fireEvent.click(screen.getByText('Instagram · @greenthumb').closest('button')!);
        // Flake cause: clicking a channel triggers resolvePreview, which sets resolving = true.
        // While resolving is true, the button text changes to "Resolving preview...". Under load,
        // previewPulsePost completes async after microtasks yield; synchronously querying for
        // "Share to Pulse" throws "Unable to find an accessible element". Waiting with findByRole
        // waits for resolution to finish and the button to return to "Share to Pulse".
        const shareBtn = await screen.findByRole('button', { name: xx('Share to Pulse') });
        await act(async () => { fireEvent.click(shareBtn); });
        expect(await screen.findByText(xx('Post shared to The Pulse!'))).toBeInTheDocument();
        expect(submitPulsePost).toHaveBeenCalledWith(expect.objectContaining({ url: LINK, channelId: 'ch-ig', category: 'food' }));
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
    });
});

describe('sharing to the Pulse in English', () => {
    it('in English nothing is bracketed, and the words are as they were', async () => {
        render(<PulseIntakePage {...props} initialUrl={LINK} />);
        expect(await screen.findByText('Saving tomato seed')).toBeInTheDocument();
        expect(bracketed()).toBe(0);
        expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Add to Pulse');
        expect(screen.getByRole('button', { name: 'Go back' }).textContent).toBe('‹ Back');
        expect(screen.getByText('Share a single post or video from your external channels to your local community feed.')).toBeInTheDocument();
        expect(screen.getByText('Instagram · @greenthumb')).toBeInTheDocument();
        expect(screen.getByText('Making & craft')).toBeInTheDocument();
        expect(await screen.findByRole('button', { name: 'Share to Pulse' })).toBeInTheDocument();
    });
});
