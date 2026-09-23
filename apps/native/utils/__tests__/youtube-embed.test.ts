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
    isPlayerDocumentUrl,
    playerNavigation,
    pulseYouTubeVideoId,
    youtubeEmbedUrl,
    youtubePlayerErrorMessage,
    youtubePlayerHtml,
    PULSE_PLAYER_APP_ID,
    PULSE_PLAYER_ORIGIN,
    YOUTUBE_EMBED_HOST,
    YOUTUBE_ERROR_SCRIPT_FAILED,
    YOUTUBE_IFRAME_API_URL,
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
        // The privacy promise is about where the *video* comes from. The player frame's src is the
        // no-cookie host and nothing else — asserted on the src itself rather than on the whole
        // document, because the document also carries the JS API script, which YouTube serves only
        // from www.youtube.com (`/iframe_api` on the no-cookie host is a 404 page).
        const src = html.match(/<iframe id="player" src="([^"]+)"/)?.[1];
        expect(src).toBeTruthy();
        expect(src).not.toMatch(/https:\/\/(www\.)?youtube\.com/);
        expect(new URL(src!).hostname).toBe('www.youtube-nocookie.com');
    });

    it('takes exactly one thing from www.youtube.com: the API script, and only after the tap', () => {
        // Anything else appearing on www.youtube.com in this document would be a new fetch from
        // Google that nobody reviewed, so the list is pinned exactly rather than merely checked.
        const onYouTubeCom = html.match(/https:\/\/(?:www\.)?youtube\.com[^"'\s)]*/g) ?? [];
        expect(onYouTubeCom).toEqual([YOUTUBE_IFRAME_API_URL]);
        // "only after the tap" is the other half, and it is the card's side of this: a card that is
        // not playing is handed no address at all — see pulse-video-player.test.ts, "hands the card
        // no address of any kind until it is the one playing". This document is built there and
        // nowhere else, so no URL in it can be fetched before the member taps play.
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
    it('lets the player load the two documents it is made of', () => {
        expect(playerNavigation('about:blank')).toBe('allow');
        expect(playerNavigation(PULSE_PLAYER_ORIGIN)).toBe('allow');
        expect(playerNavigation(`${PULSE_PLAYER_ORIGIN}/`)).toBe('allow');
        expect(playerNavigation(youtubeEmbedUrl(ID))).toBe('allow');
        expect(playerNavigation(`${YOUTUBE_EMBED_HOST}/embed/${ID}`)).toBe('allow');
        expect(playerNavigation(YOUTUBE_IFRAME_API_URL)).toBe('allow');
        // The API script's own next hop, which it names in its first line.
        expect(playerNavigation('https://www.youtube.com/s/player/dac2d7b2/www-widgetapi.vflset/www-widgetapi.js')).toBe('allow');
    });

    it("lets the player fetch the assets and streams it actually plays from", () => {
        expect(playerNavigation('https://i.ytimg.com/vi/x/hq.jpg')).toBe('allow');
        expect(playerNavigation('https://s.ytimg.com/yts/jsbin/x.js')).toBe('allow');
        expect(playerNavigation('https://rr3---sn-4g5edne7.googlevideo.com/videoplayback?x=1')).toBe('allow');
        expect(playerNavigation('https://fonts.gstatic.com/s/roboto/v1/x.woff2')).toBe('allow');
    });

    it('hands a tap that would leave the player to the browser or the YouTube app', () => {
        expect(playerNavigation(`https://www.youtube.com/watch?v=${ID}`)).toBe('external');
        expect(playerNavigation('https://www.youtube.com/@beanpool')).toBe('external');
    });

    it('never keeps another corner of YouTube loaded inside the card', () => {
        // The allow-list used to be a list of hosts with the pages we could think of carved out, so
        // every `*.youtube.com` that was not www/m/bare matched by suffix and stayed in the card —
        // and so did any path at all on the no-cookie host. A sign-in or consent page in a small
        // unmarked rectangle is the thing "a video player is not a browser" exists to stop, and a
        // consent bounce is a real destination for members outside AU/US.
        expect(playerNavigation('https://accounts.youtube.com/signin')).toBe('external');
        expect(playerNavigation('https://consent.youtube.com/m?continue=x')).toBe('external');
        expect(playerNavigation('https://music.youtube.com/watch?v=' + ID)).toBe('external');
        expect(playerNavigation('https://studio.youtube.com/')).toBe('external');
        expect(playerNavigation(`${YOUTUBE_EMBED_HOST}/watch?v=${ID}`)).toBe('external');
        expect(playerNavigation(`${YOUTUBE_EMBED_HOST}/`)).toBe('external');
        // The API path is allowed on the host that serves it, and nowhere else.
        expect(playerNavigation(`${YOUTUBE_EMBED_HOST}/iframe_api`)).toBe('external');
        expect(playerNavigation('https://music.youtube.com/iframe_api')).toBe('external');
        // ...and an embed path is allowed on the embed host, not wherever it turns up.
        expect(playerNavigation(`https://www.youtube.com/embed/${ID}`)).toBe('external');
    });

    it('never keeps a Google property loaded inside the card', () => {
        // A suffix match on a bare `google.com` used to allow every one of these. A sign-in page
        // rendered inside a small unmarked rectangle is the thing this rule exists to stop.
        expect(playerNavigation('https://accounts.google.com/signin')).toBe('block');
        expect(playerNavigation('https://ads.google.com/')).toBe('block');
        expect(playerNavigation('https://www.google.com/')).toBe('block');
    });

    it('blocks everywhere else — a video player is not a browser', () => {
        expect(playerNavigation('https://evil.example/phish')).toBe('block');
        expect(playerNavigation('https://somewhere.example/embed/' + ID)).toBe('block');
        expect(playerNavigation('http://www.youtube.com/watch?v=' + ID)).toBe('block');
        expect(playerNavigation('javascript:alert(1)')).toBe('block');
        expect(playerNavigation('https://youtube.com.evil.example/')).toBe('block');
        expect(playerNavigation('https://ytimg.com.evil.example/')).toBe('block');
        // Our own origin is compared as an origin, not as a prefix of the string.
        expect(playerNavigation(`${PULSE_PLAYER_ORIGIN}.evil.example/`)).toBe('block');
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

describe('isPlayerDocumentUrl', () => {
    const embed = youtubeEmbedUrl(ID);

    it('recognises the player\'s own two documents', () => {
        expect(isPlayerDocumentUrl(PULSE_PLAYER_ORIGIN, embed)).toBe(true);
        expect(isPlayerDocumentUrl(`${PULSE_PLAYER_ORIGIN}/`, embed)).toBe(true);
        expect(isPlayerDocumentUrl(embed, embed)).toBe(true);
    });

    it('still recognises the embed when YouTube has rewritten its query string', () => {
        expect(isPlayerDocumentUrl(`${YOUTUBE_EMBED_HOST}/embed/${ID}?autoplay=1&cbrd=1`, embed)).toBe(true);
    });

    it('does not treat a subresource failure as the player failing', () => {
        // A working video routinely produces non-2xx responses on beacons and blocked assets.
        // Treating any of these as fatal used to tear down playback and blame the connection.
        expect(isPlayerDocumentUrl('https://www.youtube-nocookie.com/api/stats/watchtime', embed)).toBe(false);
        expect(isPlayerDocumentUrl('https://i.ytimg.com/vi/x/hq.jpg', embed)).toBe(false);
        expect(isPlayerDocumentUrl(`${YOUTUBE_EMBED_HOST}/embed/OTHERVIDEO`, embed)).toBe(false);
        expect(isPlayerDocumentUrl('https://evil.example/', embed)).toBe(false);
    });

    it('treats a missing or unparseable url as not the player', () => {
        expect(isPlayerDocumentUrl(undefined, embed)).toBe(false);
        expect(isPlayerDocumentUrl('', embed)).toBe(false);
        expect(isPlayerDocumentUrl('not a url', embed)).toBe(false);
    });
});
