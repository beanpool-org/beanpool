/**
 * Which Pulse card, if any, is playing a video — and what a card should therefore draw.
 *
 * Three rules live here, all of them decisions rather than rendering, which is why they are in
 * `utils/` where they can be tested without a device:
 *
 * 1. **At most one player at a time.** A feed is a column of videos; if tapping the second one left
 *    the first running, a member would be hunting through the scroll for the thing making noise.
 *    Starting a video stops whatever was playing.
 * 2. **Nothing loads before the tap.** `pulseCardMedia` returns a poster for every card that is not
 *    the one playing, and that poster carries no YouTube URL, no embed and no player HTML — there
 *    is nothing for a card to fetch until someone asks for it. This is the privacy property the
 *    original facade design was for, kept intact.
 * 3. **A video stops when it leaves the screen, not when it has yet to arrive.** See
 *    `pulseVideoViewabilityChanged`, which the Pulse screen hands every viewability event.
 *
 * The store is a module-level singleton on purpose: it is answering "which one of all the cards on
 * screen", a question no single card can hold. Cards read it with `useSyncExternalStore`.
 */

import { VIDEO_PLATFORMS } from '@beanpool/core';
import type { PulseFeedItem } from './pulse';
import {
    pulseYouTubeVideoId,
    youtubeEmbedUrl,
    youtubePlayerHtml,
    PULSE_PLAYER_ORIGIN,
} from './youtube-embed';

type Listener = (playingItemId: string | null) => void;

let playingItemId: string | null = null;
/**
 * Whether the item playing has been seen in the list's viewable set since it started.
 *
 * Only `pulseVideoViewabilityChanged` reads it, and only to tell "has left the screen" apart from
 * "has not arrived on it yet". It is not rendering state, so no listener is woken for it.
 */
let playingWasViewable = false;
const listeners = new Set<Listener>();

function emit() {
    for (const listener of [...listeners]) listener(playingItemId);
}

/** The id of the feed item currently playing, or null when nothing is. */
export function playingPulseVideo(): string | null {
    return playingItemId;
}

/** Starts this item, stopping whatever was playing. A second call for the same item is a no-op. */
export function playPulseVideo(itemId: string): void {
    if (!itemId || playingItemId === itemId) return;
    playingItemId = itemId;
    // A card can be tapped before the list considers it viewable, so a fresh video starts out
    // having never been seen — and must not be stopped for it.
    playingWasViewable = false;
    emit();
}

/**
 * Stops playback.
 *
 * With an `itemId` it stops only that item — a card unmounting, scrolling out of view or losing
 * focus says "stop me", and must not stop a different card that has started since. With no argument
 * it stops whatever is playing, which is what leaving the Pulse tab wants.
 */
export function stopPulseVideo(itemId?: string): void {
    if (playingItemId === null) return;
    if (itemId !== undefined && itemId !== playingItemId) return;
    playingItemId = null;
    playingWasViewable = false;
    emit();
}

/** Subscribes to changes; returns the unsubscribe. The shape `useSyncExternalStore` expects. */
export function subscribeToPulseVideo(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}

/** Test-only: drops all state so one test cannot leak a playing video into the next. */
export function resetPulseVideoPlayer(): void {
    playingItemId = null;
    playingWasViewable = false;
    listeners.clear();
}

/**
 * What a change in the list's viewable set means for the video playing: a video scrolled out of
 * sight stops.
 *
 * The rule is *left* the viewable set, not *is not in* it, and the difference is a real bug. The
 * poster fills the media area, which is the second thing in a card, so on a 320dp screen it is easy
 * to tap play on a card whose top third is peeking up from the bottom of the list — well under the
 * 40% the screen asks for, and the card then grows to the 200px minimum viewport, which lowers its
 * share further. That card is not in `viewableItems`, so under the old rule the very next
 * viewability event — the member scrolling up a few pixels to see the video they just started, or
 * any other row crossing its threshold — stopped it. The player fell back to the poster with no
 * message, a second after the tap.
 *
 * So a video is stopped only once it has been seen viewable and then is not. A video that has never
 * arrived on screen is left alone; the member is on their way to it. The unmount and blur stops in
 * `PulseYouTubePlayer` are unaffected — they already say "stop me" about a specific card.
 *
 * Lives here rather than in the screen because the bookkeeping belongs to the same singleton as
 * "which card is playing", and because a screen cannot be mounted in this runner.
 */
export function pulseVideoViewabilityChanged(viewableItemIds: ReadonlyArray<string | undefined>): void {
    if (playingItemId === null) return;
    if (viewableItemIds.includes(playingItemId)) {
        playingWasViewable = true;
        return;
    }
    if (!playingWasViewable) return;
    stopPulseVideo(playingItemId);
}

/**
 * What the media area of a card shows.
 *
 * `poster` is the facade card exactly as it has always been: the node's thumbnail, and a tap that
 * either starts the in-app player (`canPlayInApp`) or leaves for the platform. It deliberately
 * carries no address of any kind — see rule 2 above.
 */
export type PulseCardMedia =
    | { kind: 'poster'; isVideo: boolean; canPlayInApp: boolean }
    | { kind: 'player'; videoId: string; html: string; baseUrl: string; embedUrl: string };

/** Platforms whose cards show a play badge over the poster. Only YouTube can play in the app. */
const IN_APP_PLATFORM = 'youtube';

/**
 * The media decision for one card: poster, or YouTube's player.
 *
 * A card becomes a player only when it is the item the store says is playing. Instagram, TikTok,
 * Facebook and everything else stay posters that open their own app, as they always have.
 */
export function pulseCardMedia(item: PulseFeedItem, currentlyPlayingItemId: string | null): PulseCardMedia {
    const videoId = item.platform === IN_APP_PLATFORM ? pulseYouTubeVideoId(item.url) : null;
    // The play badge belongs to every video platform, as it always has — TikTok and Instagram just
    // keep opening their own app when it is tapped.
    const isVideo = (VIDEO_PLATFORMS as readonly string[]).includes(item.platform);

    if (videoId === null || currentlyPlayingItemId !== item.id) {
        return { kind: 'poster', isVideo, canPlayInApp: videoId !== null };
    }

    return {
        kind: 'player',
        videoId,
        html: youtubePlayerHtml(videoId),
        baseUrl: PULSE_PLAYER_ORIGIN,
        embedUrl: youtubeEmbedUrl(videoId),
    };
}
