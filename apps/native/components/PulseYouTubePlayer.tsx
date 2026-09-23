/**
 * YouTube's embedded player, inside a Pulse card.
 *
 * This component is only ever mounted for the one card that is playing — `pulseCardMedia` decides
 * that, and until it says so there is no WebView here and nothing has been fetched from Google.
 * See `utils/youtube-embed.ts` for the terms this has to meet and `utils/pulse-video-player.ts`
 * for the one-at-a-time rule.
 *
 * What this file adds on top of those pure modules is the WebView's own configuration, which is
 * where the privacy promise is actually kept or broken:
 *
 * - `incognito` — which is not the same promise on the two platforms, so it is worth saying
 *   plainly rather than claiming the stronger one twice. On iOS the WebView is given
 *   `WKWebsiteDataStore.nonPersistentDataStore`: cookies and storage belong to this WebView, live
 *   in memory, and go when it goes. Android has no such store, so react-native-webview approximates
 *   it at *mount* — `CookieManager.removeAllCookies`, `clearCache(true)`, `clearHistory`, no form
 *   data, no saved passwords — and then leaves the WebView alone. It does not stop YouTube writing
 *   cookies during playback, and those sit in the app's WebView cookie jar on disk until something
 *   clears it. So: on iOS YouTube's cookies do not outlive the card; on Android they do not outlive
 *   the *next* card, and in between they are the only thing in that jar, because this is the only
 *   WebView in the app. Note that the mount-time wipe is process-wide for the same reason — if a
 *   second WebView is ever added here, it will lose its cookies every time a member plays a video.
 * - `thirdPartyCookiesEnabled={false}` and `cacheEnabled={false}` — what is written in the meantime
 *   is as little as it can be, and not where another site could read it.
 * - `onShouldStartLoadWithRequest` — the player may load itself and YouTube's assets. A tap that
 *   would navigate somewhere else (the video title, a share link) leaves for the member's browser
 *   or YouTube app instead of turning this small rectangle into an unmarked browser.
 *
 * It stops itself when the Pulse tab loses focus, and when it unmounts for any other reason.
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, Linking } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useFocusEffect } from 'expo-router';
import {
    isPlayerDocumentUrl,
    playerNavigation,
    youtubePlayerErrorMessage,
    YOUTUBE_ERROR_SCRIPT_FAILED,
    YOUTUBE_MIN_VIEWPORT_PX,
    YOUTUBE_STATE_ENDED,
} from '../utils/youtube-embed';
import { stopPulseVideo } from '../utils/pulse-video-player';

interface PulseYouTubePlayerProps {
    /** The feed item this player belongs to; it stops only itself, never a card that started later. */
    itemId: string;
    /** The document to load, from `youtubePlayerHtml`. */
    html: string;
    /** The origin the document is loaded under, which becomes the Referer YouTube sees. */
    baseUrl: string;
    /**
     * The embed frame's own URL. Used only to tell the player's own failures apart from the noise
     * of a subresource that happened to 404 — see `isPlayerDocumentUrl`.
     */
    embedUrl: string;
    /** One plain line for the card to show instead of the player. */
    onError: (message: string) => void;
}

export function PulseYouTubePlayer({ itemId, html, baseUrl, embedUrl, onError }: PulseYouTubePlayerProps) {
    const [ready, setReady] = React.useState(false);
    // The error callback is read from a ref so a parent that re-creates it every render cannot
    // restart the WebView mid-video.
    const onErrorRef = useRef(onError);
    useEffect(() => { onErrorRef.current = onError; }, [onError]);

    // Any unmount — scrolled out of the list's window, the card re-keyed, the screen popped —
    // means this video is no longer on screen, so it should no longer be playing.
    useEffect(() => () => stopPulseVideo(itemId), [itemId]);

    // Leaving the Pulse tab stops playback. The cleanup of a focus effect is the blur.
    useFocusEffect(useCallback(() => () => stopPulseVideo(itemId), [itemId]));

    const handleMessage = useCallback((event: WebViewMessageEvent) => {
        let msg: { type?: string; code?: number; state?: number };
        try {
            msg = JSON.parse(event.nativeEvent.data);
        } catch {
            return;
        }
        if (msg.type === 'ready') {
            setReady(true);
        } else if (msg.type === 'error') {
            onErrorRef.current(youtubePlayerErrorMessage(typeof msg.code === 'number' ? msg.code : NaN));
            stopPulseVideo(itemId);
        } else if (msg.type === 'state' && msg.state === YOUTUBE_STATE_ENDED) {
            stopPulseVideo(itemId);
        }
    }, [itemId]);

    const handleLoadFailure = useCallback((event: { nativeEvent: { url?: string } }) => {
        if (!isPlayerDocumentUrl(event.nativeEvent.url, embedUrl)) return;
        onErrorRef.current(youtubePlayerErrorMessage(YOUTUBE_ERROR_SCRIPT_FAILED));
        stopPulseVideo(itemId);
    }, [itemId, embedUrl]);

    const handleNavigation = useCallback((request: { url: string }) => {
        const verdict = playerNavigation(request.url);
        if (verdict === 'allow') return true;
        if (verdict === 'external') {
            Linking.openURL(request.url).catch((e) => {
                console.warn('[PulseYouTubePlayer] Could not open URL externally:', e);
            });
        }
        return false;
    }, []);

    return (
        <View style={styles.container}>
            <WebView
                source={{ html, baseUrl }}
                style={styles.webview}
                // The member's tap on the poster *is* the gesture that starts this, so the player
                // must not demand a second one inside the WebView.
                mediaPlaybackRequiresUserAction={false}
                allowsInlineMediaPlayback
                allowsFullscreenVideo
                javaScriptEnabled
                // As close to "nothing about what was watched outlives the card" as each platform
                // allows; the two are not the same, and the difference is at the top of this file.
                incognito
                thirdPartyCookiesEnabled={false}
                cacheEnabled={false}
                setSupportMultipleWindows={false}
                allowsBackForwardNavigationGestures={false}
                onShouldStartLoadWithRequest={handleNavigation}
                onMessage={handleMessage}
                // Both of these fire for every request the page makes, not just the player's own
                // document, so each one asks whether the thing that failed was actually the player
                // before tearing down a video that is playing perfectly well.
                onError={handleLoadFailure}
                onHttpError={handleLoadFailure}
            />
            {/* The only thing ever drawn over the WebView, and only until the player says it is
                ready — from that moment on the player has the rectangle to itself, which is what
                YouTube's terms require. */}
            {!ready ? (
                <View style={styles.loading} pointerEvents="none">
                    <ActivityIndicator color="#ffffff" />
                    <Text style={styles.loadingText} maxFontSizeMultiplier={1.3}>Starting video…</Text>
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        width: '100%',
        height: '100%',
        minHeight: YOUTUBE_MIN_VIEWPORT_PX,
        backgroundColor: '#000000',
    },
    webview: {
        flex: 1,
        backgroundColor: '#000000',
    },
    loading: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#000000',
        gap: 8,
    },
    loadingText: {
        color: '#ffffff',
        fontSize: 13,
        fontWeight: '600',
    },
});
