/**
 * The Pulse's nudges in the member's language (words S3, web sweep W1): the clipboard line and the "you've posted"
 * line are each ONE sentence with the platform's name (and the count) as placeholders, the phone's keys. The copied
 * link is the member's own, and a platform's brand (YouTube, Instagram) reads as written in every language.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PulseNudges } from './PulseNudges';
import { getPulseNudges, type MemberCreatorChannel } from '../lib/api';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-xx.test-support';

vi.mock('../lib/api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/api')>()),
    getPulseNudges: vi.fn(),
    dismissPulseNudge: vi.fn().mockResolvedValue({ success: true }),
}));

const LINK = 'https://www.instagram.com/p/abc123/';
const channels = [
    { id: 'ch-ig', platform: 'instagram', url: 'https://instagram.com/greenthumb', handle: '@greenthumb', category: 'food' },
    { id: 'ch-yt', platform: 'youtube', url: 'https://youtube.com/@greenthumb', handle: '@greenthumb', category: 'food' },
] as unknown as MemberCreatorChannel[];

/** The copied link (the member's), and the platforms' brand names, shown as written. */
const OTHERS = [LINK, 'Instagram', 'YouTube'];

beforeEach(() => {
    vi.mocked(getPulseNudges).mockResolvedValue({
        nudges: [
            { channelId: 'ch-yt', platform: 'youtube', newPostsCount: 3, currentCount: 10 },
            { channelId: 'ch-ig', platform: 'instagram', newPostsCount: 1, currentCount: 4 },
        ],
    } as any);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    Object.defineProperty(navigator, 'permissions', { value: { query: vi.fn(async () => ({ state: 'granted' })) }, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { readText: vi.fn(async () => LINK) }, configurable: true });
    localStorage.clear();
});

afterEach(() => { cleanup(); backToEnglish(); vi.restoreAllMocks(); });

describe('the Pulse nudges in the pseudo-locale', () => {
    it('the clipboard banner and the post-count banners: every word came through t()', async () => {
        await showIn('xx');
        render(<PulseNudges channels={channels} />);
        expect(await screen.findByText(xx('Link from Clipboard'), {}, { timeout: 3000 })).toBeInTheDocument();
        expect(await screen.findAllByText(xx('{platform} Updates').replace('{platform}', 'YouTube'))).toHaveLength(1);
        expect(bracketed()).toBeGreaterThan(6);
        expect(bypassing(document.body, { others: OTHERS })).toEqual([]);
        expect(screen.getByText(xx('Found a link to your {platform} channel. Would you like to share it to The Pulse?').replace('{platform}', 'Instagram'))).toBeInTheDocument();
        // One sentence with its count: "{n} new things" is the plural form, chosen by tn().
        expect(screen.getByText(xx("You've posted {n} new things on {platform} since your last visit.").replace('{n}', '3').replace('{platform}', 'YouTube'))).toBeInTheDocument();
        expect(screen.getByText(xx("You've posted {n} new thing on {platform} since your last visit.").replace('{n}', '1').replace('{platform}', 'Instagram'))).toBeInTheDocument();
    });
});

describe('the Pulse nudges in English', () => {
    it('in English nothing is bracketed, and the words are as they were', async () => {
        render(<PulseNudges channels={channels} />);
        expect(await screen.findByText('Link from Clipboard', {}, { timeout: 3000 })).toBeInTheDocument();
        await screen.findByText('YouTube Updates');
        expect(bracketed()).toBe(0);
        expect(screen.getByText('Found a link to your Instagram channel. Would you like to share it to The Pulse?')).toBeInTheDocument();
        expect(screen.getByText("You've posted 3 new things on YouTube since your last visit.")).toBeInTheDocument();
        expect(screen.getByText("You've posted 1 new thing on Instagram since your last visit.")).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Dismiss clipboard suggestion' })).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: 'Dismiss update notice' })).toHaveLength(2);
    });
});
