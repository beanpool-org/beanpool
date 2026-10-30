/**
 * MemberAvatar — Universal avatar component for BeanPool.
 *
 * Design Rule: Every callsign gets an avatar. If there's a name displayed,
 * there's an avatar beside it.
 *
 * Handles:
 * - Remote image URLs (with cache-busting), relative ones against the phone's community as it is now
 * - Base64 data URIs
 * - Bundled avatar references
 * - The ready-made picture the key picks when there is no image, or it fails to load (never a blank disc)
 * - Optional tap-to-enlarge (opt-in via `enlargeable`)
 */
import React from 'react';
import { View, Text, StyleSheet, Pressable, Modal, Dimensions } from 'react-native';
import { Image } from 'expo-image';
import { avatarUri } from '../utils/image-processing';
import { anchorUrl, getCachedAnchorUrl } from '../utils/node-post';
import { onCommunitySwitched } from '../utils/community-switch';
import { resolveBundledAvatar } from '../utils/bundled-avatars';
import { colors, palette } from '../constants/colors';
import { t, bundledAvatarForPubkey } from '@beanpool/core';

// Consistent color palette for letter-initial fallbacks
const FALLBACK_COLORS = [
    palette.violet500, palette.cyan500, palette.emerald500, palette.amber500,
    palette.red500, palette.pink500, palette.indigo500, palette.teal500,
] as const;

// The community relative avatar paths resolve against: one for every avatar on screen, read as the first one is drawn and
// again after every switch (utils/community-switch.ts). Each avatar used to keep the address it saw as it mounted, so after
// a switch a path from B was resolved against A: a 404 (a blank disc) or, on a server two communities share, the other
// community's photo (scratch/fable-design/DESIGN-per-community-profile-fable.md §2.3).
const anchorWatchers = new Set<() => void>();
/** Undefined until the first read lands; null with no community. */
let anchorShared: string | null | undefined;
let anchorAsked = 0;
let anchorWatched = false;

function readAnchor(): void {
    const asked = ++anchorAsked;
    anchorUrl().then(u => {
        // A switch while this read was out asked again: only the last read lands.
        if (asked !== anchorAsked) return;
        const next = u ? u.replace(/\/+$/, '') : null;
        if (next === anchorShared) return;
        anchorShared = next;
        for (const watcher of [...anchorWatchers]) watcher();
    }).catch(() => {});
}

function watchAnchor(onChange: () => void): () => void {
    anchorWatchers.add(onChange);
    if (!anchorWatched) {
        anchorWatched = true;
        try { onCommunitySwitched(readAnchor); } catch { /* nothing says a switch here: the address read below stays */ }
        readAnchor();
    }
    return () => { anchorWatchers.delete(onChange); };
}

const currentAnchor = (): string | null => anchorShared ?? getCachedAnchorUrl();

function getColorForPubkey(pubkey: string | null | undefined): string {
    if (!pubkey) return FALLBACK_COLORS[0];
    let hash = 0;
    for (let i = 0; i < Math.min(pubkey.length, 8); i++) {
        hash = pubkey.charCodeAt(i) + ((hash << 5) - hash);
    }
    return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

interface MemberAvatarProps {
    avatarUrl: string | null | undefined;
    pubkey: string;
    callsign: string;
    /** Avatar diameter in pixels. Default: 36 */
    size?: number;
    /** ISO timestamp of last profile update — used for cache-busting */
    updatedAt?: string | null;
    /** Border radius override. Default: size/2 (circle). Use lower value for rounded square. */
    borderRadius?: number;
    /** When true, tapping the avatar opens a full-screen enlarged view. Default: false. */
    enlargeable?: boolean;
}

// Memoized: all props are primitives, and avatars sit inside list rows/headers that
// re-render on every sync tick — without memo each tick replays the image transition.
export const MemberAvatar = React.memo(MemberAvatarBase);

function MemberAvatarBase({
    avatarUrl,
    pubkey,
    callsign,
    size = 36,
    updatedAt,
    borderRadius,
    enlargeable = false,
}: MemberAvatarProps) {
    const [viewerOpen, setViewerOpen] = React.useState(false);
    const anchor = React.useSyncExternalStore(watchAnchor, currentAnchor, currentAnchor);
    // The address that failed to load (a stale `k=` after the photo changed elsewhere, a re-keyed node): the ready-made
    // picture the key picks stands in for it, never a blank disc (Damo, 29 Oct). Another address is tried afresh.
    const [failedUri, setFailedUri] = React.useState<string | null>(null);

    const radius = borderRadius ?? size / 2;
    // Defensively clean raw string inputs to prevent invalid rendering on iOS
    const cleanedAvatarUrl = (avatarUrl && avatarUrl !== 'null' && avatarUrl !== 'undefined' && avatarUrl.trim() !== '') ? avatarUrl : null;
    let uri = avatarUri(cleanedAvatarUrl, pubkey, updatedAt, anchor);
    const fontSize = Math.max(Math.round(size * 0.42), 10);

    // Resolve the image source once, so the small avatar and the enlarged view
    // stay in sync. `bundledSource` (a require()d asset) takes precedence; a
    // failed bundled lookup must NOT fall through to a network uri (crashes iOS).
    let bundledSource: any = null;
    if (uri && uri.startsWith('bundled://')) {
        bundledSource = resolveBundledAvatar(uri);
        uri = null;
    }
    const remoteUri = uri && uri !== failedUri ? uri : null;
    let imageSource = bundledSource || (remoteUri ? { uri: remoteUri } : null);
    if (!imageSource) {
        const fallbackPreset = bundledAvatarForPubkey(pubkey || callsign);
        imageSource = resolveBundledAvatar(fallbackPreset);
    }

    const smallEl = (
        <Image
            source={imageSource}
            accessibilityLabel={t("{name}'s avatar", { name: callsign })}
            cachePolicy="memory-disk"
            transition={120}
            onError={remoteUri ? () => setFailedUri(remoteUri) : undefined}
            style={[
                styles.image,
                { width: size, height: size, borderRadius: radius, overflow: 'hidden', flexShrink: 0 },
            ]}
        />
    );

    if (!enlargeable) return smallEl;

    const win = Dimensions.get('window');
    const bigSize = Math.min(win.width, win.height) * 0.8;
    const bigInitialColor = getColorForPubkey(pubkey);

    return (
        <>
            <Pressable
                onPress={() => setViewerOpen(true)}
                accessibilityRole="imagebutton"
                accessibilityLabel={t("View {name}'s photo", { name: callsign })}
                hitSlop={6}
            >
                {smallEl}
            </Pressable>
            {viewerOpen && (
                <Modal visible transparent animationType="fade" onRequestClose={() => setViewerOpen(false)}>
                    <Pressable style={styles.viewerBackdrop} onPress={() => setViewerOpen(false)} accessibilityRole="button" accessibilityLabel={t('Close photo')}>
                        {imageSource ? (
                            <Image
                                source={imageSource}
                                accessibilityLabel={t("{name}'s photo", { name: callsign })}
                                cachePolicy="memory-disk"
                                contentFit="cover"
                                transition={150}
                                style={{ width: bigSize, height: bigSize, borderRadius: 24, backgroundColor: colors.surface.subtle }}
                            />
                        ) : (
                            <View style={[styles.fallback, { width: bigSize, height: bigSize, borderRadius: 24, backgroundColor: bigInitialColor + '20' }]}>
                                <Text allowFontScaling={false} style={[styles.fallbackText, { fontSize: bigSize * 0.42, color: bigInitialColor }]}>
                                    {(callsign || '?').charAt(0).toUpperCase()}
                                </Text>
                            </View>
                        )}
                        <Text style={styles.viewerCallsign}>{callsign}</Text>
                        <Text style={styles.viewerHint}>{t('Tap anywhere to close')}</Text>
                    </Pressable>
                </Modal>
            )}
        </>
    );
}

const styles = StyleSheet.create({
    image: {
        backgroundColor: colors.surface.subtle,
        overflow: 'hidden',
    },
    fallback: {
        justifyContent: 'center',
        alignItems: 'center',
    },
    fallbackText: {
        fontWeight: '800',
    },
    viewerBackdrop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.92)',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
    },
    viewerCallsign: {
        color: '#fff',
        fontSize: 20,
        fontWeight: '700',
        marginTop: 24,
        textAlign: 'center',
    },
    viewerHint: {
        color: 'rgba(255,255,255,0.6)',
        fontSize: 13,
        marginTop: 8,
    },
});
