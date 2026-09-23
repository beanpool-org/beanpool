/**
 * The YouTube embedded player's rules, as assertions.
 *
 * Every one of these stands for a condition YouTube attaches to using its player inside an app
 * (https://developers.google.com/youtube/terms/required-minimum-functionality) or for the privacy
 * promise the Pulse feed was built on. They are here, rather than in a comment, because a comment
 * cannot fail.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
    appEmbedOrigin,
    playerNavigation,
    pulseYouTubeVideoId,
    youtubeEmbedUrl,
    youtubePlayerErrorMessage,
    youtubePlayerHtml,
    PULSE_PLAYER_APP_ID,
    PULSE_PLAYER_ORIGIN,
    YOUTUBE_EMBED_HOST,
    YOUTUBE_ERROR_SCRIPT_FAILED,
    YOUTUBE_MIN_VIEWPORT_PX,
} from '../youtube-embed';

const ID = 'dQw4w9WgXcQ';

describe('the player URL and its parameters', () => {
    const url = new URL(youtubeEmbedUrl(ID));

    it('loads from the privacy-enhanced no-cookie host, never youtube.com', () => {
        expect(url.origin).toBe(YOUTUBE_EMBED_HOST);
        expect(url.hostname).toBe('www.youtube-nocookie.com');
        expect(url.pathname).toBe(`/embed/${ID}`);
    });

    it('plays inline in the card rather than taking over the screen', () => {
        expect(url.searchParams.get('playsinline')).toBe('1');
    });

    it('starts playing, because the member has already tapped play', () => {
        expect(url.searchParams.get('autoplay')).toBe('1');
    });

    it('identifies the app to YouTube with the origin parameter', () => {
        expect(url.searchParams.get('origin')).toBe(PULSE_PLAYER_ORIGIN);
    });

    it('enables the JS API, so an error can be reported instead of a black rectangle', () => {
        expect(url.searchParams.get('enablejsapi')).toBe('1');
    });

    it("keeps YouTube's own full-screen button", () => {
        expect(url.searchParams.get('fs')).toBe('1');
    });

    it('refuses to build a URL from anything that is not a video id', () => {
        expect(() => youtubeEmbedUrl('../../evil')).toThrow();
        expect(() => youtubeEmbedUrl('" onload="x')).toThrow();
        expect(() => youtubeEmbedUrl('')).toThrow();
    });
});

describe('the Referer / baseUrl the app presents to YouTube', () => {
    it('is the application id as an HTTPS origin', () => {
        expect(PULSE_PLAYER_ORIGIN).toBe('https://org.beanpool.pillar');
        expect(appEmbedOrigin('org.beanpool.pillar')).toBe('https://org.beanpool.pillar');
    });

    it('still matches the application id in app.json', () => {
        const appJsonPath = fileURLToPath(new URL('../../app.json', import.meta.url).href);
        const appJson = JSON.parse(readFileSync(appJsonPath, 'utf8'));
        expect(appJson.expo.android.package).toBe(PULSE_PLAYER_APP_ID);
        expect(appJson.expo.ios.bundleIdentifier).toBe(PULSE_PLAYER_APP_ID);
    });

    it('refuses anything that is not a plain application id', () => {
        expect(appEmbedOrigin('https://org.beanpool.pillar')).toBeNull();
        expect(appEmbedOrigin('org.beanpool.pillar/evil')).toBeNull();
        expect(appEmbedOrigin('nodots')).toBeNull();
        expect(appEmbedOrigin('')).toBeNull();
    });

    it('is what the player document is loaded under, and what the player is told', () => {
        const html = youtubePlayerHtml(ID);
        expect(html).toContain(`origin=${encodeURIComponent(PULSE_PLAYER_ORIGIN)}`);
    });
});

describe('the player document', () => {
    const html = youtubePlayerHtml(ID);

    it('is the embed URL and nothing else — one definition of where the player comes from', () => {
        expect(html).toContain(`src="${youtubeEmbedUrl(ID)}"`);
    });

    it('never reaches youtube.com for the player itself', () => {
        expect(html).not.toMatch(/https:\/\/(www\.)?youtube\.com/);
    });

    it('refuses a video id it cannot vouch for, so nothing is interpolated unchecked', () => {
        expect(() => youtubePlayerHtml('"><script>alert(1)</script>')).toThrow();
    });
});

describe('the error mapping', () => {
    it("names the uploader's choice for 101 and 150, which are the same refusal", () => {
        const expected = 'The person who uploaded this video does not allow it to play outside YouTube.';
        expect(youtubePlayerErrorMessage(101)).toBe(expected);
        expect(youtubePlayerErrorMessage(150)).toBe(expected);
    });

    it('tells a member with no network what is actually wrong', () => {
        expect(youtubePlayerErrorMessage(YOUTUBE_ERROR_SCRIPT_FAILED)).toMatch(/connection/i);
    });

    it('has its own line for 153, the missing client identity', () => {
        expect(youtubePlayerErrorMessage(153)).toBe('YouTube would not start the player here.');
    });

    it('distinguishes a removed or private video from an un-embeddable one', () => {
        expect(youtubePlayerErrorMessage(100)).toMatch(/private|taken down/i);
        expect(youtubePlayerErrorMessage(100)).not.toBe(youtubePlayerErrorMessage(101));
    });

    it('still says something plain for a code YouTube has not documented', () => {
        expect(youtubePlayerErrorMessage(999)).toBe('This video could not play here.');
        expect(youtubePlayerErrorMessage(NaN)).toBe('This video could not play here.');
    });

    it('never leaves a member reading a bare number', () => {
        for (const code of [YOUTUBE_ERROR_SCRIPT_FAILED, 2, 5, 100, 101, 150, 153, 42]) {
            const message = youtubePlayerErrorMessage(code);
            expect(message.length).toBeGreaterThan(10);
            expect(message).not.toMatch(/\d/);
        }
    });
});

describe('the video id behind a link', () => {
    it('reads the watch and youtu.be forms', () => {
        expect(pulseYouTubeVideoId(`https://www.youtube.com/watch?v=${ID}`)).toBe(ID);
        expect(pulseYouTubeVideoId(`https://youtu.be/${ID}`)).toBe(ID);
    });

    it('reads the shorts, live and embed forms a channel listing also produces', () => {
        expect(pulseYouTubeVideoId(`https://www.youtube.com/shorts/${ID}`)).toBe(ID);
        expect(pulseYouTubeVideoId(`https://www.youtube.com/live/${ID}`)).toBe(ID);
        expect(pulseYouTubeVideoId(`https://www.youtube.com/embed/${ID}`)).toBe(ID);
    });

    it('is null for anything that is not a YouTube video we can play', () => {
        expect(pulseYouTubeVideoId('https://www.tiktok.com/@a/video/123')).toBeNull();
        expect(pulseYouTubeVideoId('https://www.youtube.com/@beanpool')).toBeNull();
        expect(pulseYouTubeVideoId('http://www.youtube.com/watch?v=' + ID)).toBeNull();
        expect(pulseYouTubeVideoId('https://evil.example/www.youtube.com/shorts/' + ID)).toBeNull();
        expect(pulseYouTubeVideoId(null)).toBeNull();
        expect(pulseYouTubeVideoId('')).toBeNull();
    });
});

describe('what the player may navigate to', () => {
    it('lets the player load itself and YouTube\'s assets', () => {
        expect(playerNavigation('about:blank')).toBe('allow');
        expect(playerNavigation(PULSE_PLAYER_ORIGIN)).toBe('allow');
        expect(playerNavigation(youtubeEmbedUrl(ID))).toBe('allow');
        expect(playerNavigation(`${YOUTUBE_EMBED_HOST}/iframe_api`)).toBe('allow');
        expect(playerNavigation('https://i.ytimg.com/vi/x/hq.jpg')).toBe('allow');
    });

    it('hands a tap that would leave the player to the browser or the YouTube app', () => {
        expect(playerNavigation(`https://www.youtube.com/watch?v=${ID}`)).toBe('external');
        expect(playerNavigation('https://www.youtube.com/@beanpool')).toBe('external');
    });

    it('blocks everywhere else — a video player is not a browser', () => {
        expect(playerNavigation('https://evil.example/phish')).toBe('block');
        expect(playerNavigation('http://www.youtube.com/watch?v=' + ID)).toBe('block');
        expect(playerNavigation('javascript:alert(1)')).toBe('block');
        expect(playerNavigation('https://youtube.com.evil.example/')).toBe('block');
        expect(playerNavigation('')).toBe('block');
    });
});

describe('the viewport rule', () => {
    it('is the 200 CSS pixels YouTube requires, and the card grows to it', () => {
        expect(YOUTUBE_MIN_VIEWPORT_PX).toBeGreaterThanOrEqual(200);
        // At the narrowest screen the app supports, a 16:9 card is shorter than that, which is why
        // the rule needs enforcing at all: 320dp less the list's 16pt padding each side.
        const cardWidth = 320 - 32;
        expect(Math.round((cardWidth * 9) / 16)).toBeLessThan(YOUTUBE_MIN_VIEWPORT_PX);
        expect(cardWidth).toBeGreaterThanOrEqual(YOUTUBE_MIN_VIEWPORT_PX);
    });
});
