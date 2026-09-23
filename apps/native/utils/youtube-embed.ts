/**
 * YouTube's own embedded player, as a Pulse card loads it.
 *
 * The Pulse feed has always been facade cards: a thumbnail the node fetched, and a tap that leaves
 * for the platform's own app. Re-hosting or proxying video stays rejected — the node has no rights
 * to the content and no business standing between a member and it. What this module builds is the
 * narrow exception Marty chose on 2026-09-23: YouTube's *own* player, loaded from YouTube, inside
 * the card, and only after the member taps play. Nothing here is fetched before that tap, so a
 * member who scrolls past a video is still invisible to Google.
 *
 * YouTube documents this use and attaches conditions to it
 * (https://developers.google.com/youtube/terms/required-minimum-functionality). The ones that land
 * in code live here:
 *
 * - **Client identity.** The player must be able to tell who is embedding it. A native WebView has
 *   no origin of its own, so the app lends it one made from its application id
 *   (`PULSE_PLAYER_ORIGIN`): as the `baseUrl` the HTML is loaded under, which becomes the Referer,
 *   and again as the `origin` player parameter for the platforms where a Referer cannot be set.
 *   Without it YouTube refuses with error 153.
 * - **Privacy host.** `youtube-nocookie.com`, so the player sets nothing until playback starts.
 * - **Viewport.** At least 200x200 CSS pixels. See `YOUTUBE_MIN_VIEWPORT_PX`; the card grows its
 *   media area to it while playing, letterboxing rather than cropping.
 *
 * Everything in this file is a pure string builder so it can be unit-tested without a device — the
 * rules above are assertions in `__tests__/youtube-embed.test.ts`, not comments to be trusted.
 */

import { youtubeWatchId } from '@beanpool/core';

/**
 * The application id, from `app.json` (`expo.android.package` / `expo.ios.bundleIdentifier`).
 *
 * Written out rather than imported so Metro does not pull the whole app manifest into the bundle;
 * the test asserts it still matches `app.json`, so the two cannot drift apart silently.
 */
export const PULSE_PLAYER_APP_ID = 'org.beanpool.pillar';

/**
 * Our own code for "the player never loaded at all" — no network, or YouTube unreachable.
 * YouTube's own codes are all positive, so a negative one cannot collide with them.
 */
export const YOUTUBE_ERROR_SCRIPT_FAILED = -1;

/** The player state YouTube reports when a video has finished. */
export const YOUTUBE_STATE_ENDED = 0;

/** At least 200x200 CSS pixels, which YouTube requires of a viewport showing its player. */
export const YOUTUBE_MIN_VIEWPORT_PX = 200;

/** The privacy-enhanced embed host. It stores nothing until the member actually plays something. */
export const YOUTUBE_EMBED_HOST = 'https://www.youtube-nocookie.com';

/** A reverse-DNS application id: lowercase labels, at least two of them, no scheme and no path. */
const APP_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

/** The 11-character YouTube video id. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * The HTTPS origin this app presents to YouTube, built from its application id.
 *
 * Returns null for anything that is not a plain application id, so a bad value can never be
 * concatenated into a URL or an HTML document.
 */
export function appEmbedOrigin(appId: string): string | null {
    if (typeof appId !== 'string' || !APP_ID_RE.test(appId)) return null;
    return `https://${appId}`;
}

/**
 * The Referer/`origin` this app sends YouTube: `https://org.beanpool.pillar`.
 *
 * This is the "embedded player API client identity" YouTube's required-minimum-functionality terms
 * ask for. It is not a site anyone can visit, and it is not meant to be — it identifies the client.
 */
export const PULSE_PLAYER_ORIGIN: string = appEmbedOrigin(PULSE_PLAYER_APP_ID)!;

/**
 * The video id behind a YouTube link, or null if this is not one we can play.
 *
 * `youtubeWatchId` in core covers the watch and youtu.be forms and is the shared, already-tested
 * definition — this adds only the shapes a member's channel listing also produces.
 */
export function pulseYouTubeVideoId(url: string | null | undefined): string | null {
    if (typeof url !== 'string' || !url) return null;
    const watch = youtubeWatchId(url);
    if (watch) return watch;

    let u: URL;
    try { u = new URL(url); } catch { return null; }
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    const host = u.hostname.toLowerCase();
    if (host !== 'www.youtube.com' && host !== 'youtube.com' && host !== 'm.youtube.com') return null;

    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) return null;
    if (parts[0] !== 'shorts' && parts[0] !== 'live' && parts[0] !== 'embed') return null;
    return VIDEO_ID_RE.test(parts[1]) ? parts[1] : null;
}

/**
 * The embed URL for a video id, on the no-cookie host with the parameters the card plays under.
 *
 * - `playsinline=1` keeps playback in the card on iOS instead of taking over the screen;
 * - `autoplay=1` starts it, because the member has already tapped play — this is that tap;
 * - `origin` is the client identity described at the top of this file;
 * - `enablejsapi=1` lets the page hear the player's own error and ended events, which is how the
 *   card can offer "Open on YouTube" instead of leaving a member staring at a black rectangle;
 * - `rel=0` keeps the end-of-video suggestions to the same channel;
 * - `fs=1` keeps YouTube's own full-screen button, which is allowed.
 *
 * Throws on an invalid video id: nothing unvalidated is ever concatenated into a URL.
 */
export function youtubeEmbedUrl(videoId: string): string {
    if (!VIDEO_ID_RE.test(videoId)) {
        throw new Error(`[youtube-embed] Refusing to build a player URL for a non-video id: ${videoId}`);
    }
    const params = new URLSearchParams({
        playsinline: '1',
        autoplay: '1',
        enablejsapi: '1',
        rel: '0',
        fs: '1',
        origin: PULSE_PLAYER_ORIGIN,
    });
    return `${YOUTUBE_EMBED_HOST}/embed/${videoId}?${params.toString()}`;
}

/**
 * The document the WebView loads, under `PULSE_PLAYER_ORIGIN` as its base URL.
 *
 * The iframe's src is `youtubeEmbedUrl` and nothing else — that function is the single definition
 * of where the player comes from and what it is told, so the URL cannot drift out of step with what
 * actually loads. YouTube's IFrame Player API is then attached to the iframe already on the page,
 * which `enablejsapi=1` permits, for one reason: the API reports `onError`, so an upload whose
 * owner has disabled embedding (101/150) produces a sentence and a way out instead of a black
 * rectangle. The page reports back over `ReactNativeWebView.postMessage` as `{"type":"ready"}`,
 * `{"type":"state","state":n}` and `{"type":"error","code":n}`.
 *
 * The video id is validated before it reaches the template, so no caller-controlled text is ever
 * interpolated into this document.
 */
export function youtubePlayerHtml(videoId: string): string {
    const src = youtubeEmbedUrl(videoId); // throws on anything that is not a video id
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
  #player { display: block; width: 100%; height: 100%; border: 0; }
</style>
</head>
<body>
<iframe id="player" src="${src}" frameborder="0" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>
<script>
  var send = function (msg) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); } catch (e) {}
  };
  window.onYouTubeIframeAPIReady = function () {
    try {
      new YT.Player('player', {
        events: {
          onReady: function (e) { send({ type: 'ready' }); try { e.target.playVideo(); } catch (err) {} },
          onStateChange: function (e) { send({ type: 'state', state: e.data }); },
          onError: function (e) { send({ type: 'error', code: e.data }); }
        }
      });
    } catch (err) {
      send({ type: 'error', code: ${YOUTUBE_ERROR_SCRIPT_FAILED} });
    }
  };
  var tag = document.createElement('script');
  tag.src = ${JSON.stringify(`${YOUTUBE_EMBED_HOST}/iframe_api`)};
  tag.onerror = function () { send({ type: 'error', code: ${YOUTUBE_ERROR_SCRIPT_FAILED} }); };
  document.head.appendChild(tag);
</script>
</body>
</html>`;
}

/**
 * One plain line for a player error, to sit above an "Open on YouTube" button.
 *
 * The codes are YouTube's (https://developers.google.com/youtube/iframe_api_reference#onError).
 * 101 and 150 are the same thing said twice: the uploader does not allow this video off YouTube.
 * Nothing here blames the member or asks them to try again in a way that would not help.
 */
export function youtubePlayerErrorMessage(code: number): string {
    switch (code) {
        case YOUTUBE_ERROR_SCRIPT_FAILED:
            return 'Could not reach YouTube. Check your connection.';
        case 2:
            return 'This video link does not look right.';
        case 5:
            return 'This video cannot play inside BeanPool on this phone.';
        case 100:
            return 'This video is private, or it has been taken down.';
        case 101:
        case 150:
            return 'The person who uploaded this video does not allow it to play outside YouTube.';
        case 153:
            return 'YouTube would not start the player here.';
        default:
            return 'This video could not play here.';
    }
}

/**
 * Hosts the player is allowed to navigate to on its own: YouTube's and the assets it pulls in.
 *
 * Deliberately *not* `google.com`. Matching is by suffix, so a bare `google.com` here would let the
 * player keep `accounts.google.com`, `ads.google.com` or any other Google property loaded inside
 * this small unmarked rectangle — a sign-in page in a card the member cannot inspect is exactly the
 * thing "a video player is not a browser" is meant to prevent. The embed's own assets and video
 * streams come from `ytimg.com`, `googlevideo.com` and `gstatic.com`, which are listed.
 */
const PLAYER_HOSTS = [
    'youtube-nocookie.com',
    'youtube.com',
    'ytimg.com',
    'googlevideo.com',
    'gstatic.com',
];

/**
 * What to do with a navigation the player asks for.
 *
 * `allow` keeps it inside the WebView, `external` hands it to the member's browser or YouTube app
 * (tapping the video's title, for instance), and `block` drops it. The default is `block`: a video
 * player has no business navigating a WebView inside this app to somewhere we did not expect.
 */
export function playerNavigation(url: string): 'allow' | 'external' | 'block' {
    if (typeof url !== 'string' || !url) return 'block';
    if (url === 'about:blank' || url.startsWith(PULSE_PLAYER_ORIGIN)) return 'allow';

    let u: URL;
    try { u = new URL(url); } catch { return 'block'; }
    if (u.protocol !== 'https:') return 'block';

    const host = u.hostname.toLowerCase();
    const isPlayerHost = PLAYER_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
    if (!isPlayerHost) return 'block';

    // The player itself lives under /embed and the API assets; anything else on youtube.com is the
    // member choosing to leave — the watch page, the channel, a share link.
    if (host === 'www.youtube.com' || host === 'youtube.com' || host === 'm.youtube.com') {
        return u.pathname.startsWith('/embed/') || u.pathname === '/iframe_api' ? 'allow' : 'external';
    }
    return 'allow';
}
