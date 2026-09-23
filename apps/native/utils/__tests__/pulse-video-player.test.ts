/**
 * Two rules the Pulse feed's video playback rests on.
 *
 * 1. At most one card plays at a time.
 * 2. Nothing is loaded from YouTube before the member taps play.
 *
 * Both are decisions rather than rendering, which is why they can be tested here: `pulseCardMedia`
 * is the single place a card asks "what do I show?", and `PulseFeedCard` mounts a WebView only in
 * the branch where that answer is `player`. This runner has no React Native transform and cannot
 * mount a screen (see vitest.config.ts) — so what is proven here is the decision, and the card's
 * use of it is a two-line ternary read by review.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    pulseCardMedia,
    playPulseVideo,
    playingPulseVideo,
    stopPulseVideo,
    subscribeToPulseVideo,
    resetPulseVideoPlayer,
} from '../pulse-video-player';
import { PULSE_PLAYER_ORIGIN, YOUTUBE_IFRAME_API_URL } from '../youtube-embed';
import type { PulseFeedItem } from '../pulse';

const item = (over: Partial<PulseFeedItem> = {}): PulseFeedItem => ({
    id: 'item_1',
    ownerPubkey: 'a'.repeat(64),
    callsign: 'Mullum Ceramics',
    avatarUrl: null,
    platform: 'youtube',
    category: 'craft',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: 'Firing the wood kiln',
    thumbnailUrl: 'https://images.example/thumb.jpg',
    publishedAt: new Date().toISOString(),
    source: 'autolist',
    isVerified: true,
    ...over,
});

beforeEach(() => {
    resetPulseVideoPlayer();
});

describe('nothing loads before the tap', () => {
    it('gives a YouTube card a poster, not a player, while nothing is playing', () => {
        const media = pulseCardMedia(item(), null);
        expect(media.kind).toBe('poster');
    });

    it('hands the card no address of any kind until it is the one playing', () => {
        const media = pulseCardMedia(item(), null);
        const serialised = JSON.stringify(media);
        expect(serialised).not.toMatch(/youtube/i);
        expect(serialised).not.toMatch(/http/i);
        expect(serialised).not.toMatch(/iframe/i);
        expect(serialised).not.toContain(PULSE_PLAYER_ORIGIN);
        // Including the one URL the player document takes from www.youtube.com rather than the
        // no-cookie host: it lives in the document, and the document does not exist yet.
        expect(serialised).not.toContain(YOUTUBE_IFRAME_API_URL);
        // The whole payload is three flags. There is nothing here for a card to fetch.
        expect(Object.keys(media).sort()).toEqual(['canPlayInApp', 'isVideo', 'kind']);
    });

    it('still gives the other cards a poster while one of them plays', () => {
        const media = pulseCardMedia(item({ id: 'item_2' }), 'item_1');
        expect(media.kind).toBe('poster');
        expect(JSON.stringify(media)).not.toMatch(/youtube/i);
    });

    it('builds the player only for the card the member actually tapped', () => {
        const media = pulseCardMedia(item(), 'item_1');
        expect(media.kind).toBe('player');
        if (media.kind !== 'player') throw new Error('unreachable');
        expect(media.videoId).toBe('dQw4w9WgXcQ');
        expect(media.baseUrl).toBe(PULSE_PLAYER_ORIGIN);
        expect(media.embedUrl).toContain('youtube-nocookie.com');
        expect(media.html).toContain('<iframe');
    });

    it('marks a YouTube card as playable in the app and other platforms as not', () => {
        const yt = pulseCardMedia(item(), null);
        expect(yt.kind === 'poster' && yt.canPlayInApp).toBe(true);

        for (const platform of ['tiktok', 'instagram', 'facebook', 'rss', 'website']) {
            const other = pulseCardMedia(item({ platform, url: `https://${platform}.example/p/1` }), null);
            expect(other.kind === 'poster' && other.canPlayInApp).toBe(false);
        }
    });

    it('keeps the play badge on every video platform, as the facade card always had', () => {
        for (const platform of ['youtube', 'tiktok', 'instagram', 'facebook']) {
            const media = pulseCardMedia(item({ platform }), null);
            expect(media.kind === 'poster' && media.isVideo).toBe(true);
        }
        for (const platform of ['rss', 'website', 'soundcloud']) {
            const media = pulseCardMedia(item({ platform }), null);
            expect(media.kind === 'poster' && media.isVideo).toBe(false);
        }
    });

    it('never plays a YouTube card whose link is not a video we can play', () => {
        const media = pulseCardMedia(item({ url: 'https://www.youtube.com/@beanpool' }), 'item_1');
        expect(media.kind).toBe('poster');
        expect(media.kind === 'poster' && media.canPlayInApp).toBe(false);
    });

    it('never plays a non-YouTube card, even when the store names it', () => {
        const media = pulseCardMedia(item({ platform: 'tiktok', url: 'https://www.tiktok.com/@a/video/1' }), 'item_1');
        expect(media.kind).toBe('poster');
    });
});

describe('one player at a time', () => {
    it('starts with nothing playing', () => {
        expect(playingPulseVideo()).toBeNull();
    });

    it('stops the first card when a second one starts', () => {
        playPulseVideo('item_1');
        expect(playingPulseVideo()).toBe('item_1');

        playPulseVideo('item_2');
        expect(playingPulseVideo()).toBe('item_2');
        expect(pulseCardMedia(item({ id: 'item_1' }), playingPulseVideo()).kind).toBe('poster');
        expect(pulseCardMedia(item({ id: 'item_2' }), playingPulseVideo()).kind).toBe('player');
    });

    it('tells every subscribed card when the playing one changes', () => {
        const seen: Array<string | null> = [];
        subscribeToPulseVideo((id) => seen.push(id));

        playPulseVideo('item_1');
        playPulseVideo('item_2');
        stopPulseVideo();

        expect(seen).toEqual(['item_1', 'item_2', null]);
    });

    it('does not wake the cards for a tap on the card already playing', () => {
        const listener = vi.fn();
        playPulseVideo('item_1');
        subscribeToPulseVideo(listener);

        playPulseVideo('item_1');
        expect(listener).not.toHaveBeenCalled();
        expect(playingPulseVideo()).toBe('item_1');
    });

    it('lets a card stop only itself, so a card unmounting cannot kill the one that replaced it', () => {
        playPulseVideo('item_1');
        playPulseVideo('item_2');

        // item_1 scrolls out of the list's window and unmounts, late, after item_2 took over.
        stopPulseVideo('item_1');
        expect(playingPulseVideo()).toBe('item_2');

        stopPulseVideo('item_2');
        expect(playingPulseVideo()).toBeNull();
    });

    it('stops whatever is playing when asked with no id — leaving the tab', () => {
        playPulseVideo('item_1');
        stopPulseVideo();
        expect(playingPulseVideo()).toBeNull();
    });

    it('is quiet when there was nothing to stop', () => {
        const listener = vi.fn();
        subscribeToPulseVideo(listener);
        stopPulseVideo();
        stopPulseVideo('item_1');
        expect(listener).not.toHaveBeenCalled();
    });

    it('lets a card unsubscribe without disturbing the others', () => {
        const a = vi.fn();
        const b = vi.fn();
        const unsubA = subscribeToPulseVideo(a);
        subscribeToPulseVideo(b);

        unsubA();
        playPulseVideo('item_1');

        expect(a).not.toHaveBeenCalled();
        expect(b).toHaveBeenCalledWith('item_1');
    });
});
