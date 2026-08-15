/**
 * MemberAvatar — Universal avatar component for BeanPool.
 *
 * Design Rule: Every callsign gets an avatar. If there's a name displayed,
 * there's an avatar beside it.
 *
 * Handles:
 * - Remote image URLs (with cache-busting)
 * - Base64 data URIs
 * - Bundled avatar references
 * - Letter-initial fallback when no image is available
 * - Optional tap-to-enlarge (opt-in via `enlargeable`)
 */
import React from 'react';
import { View, Text, StyleSheet, Pressable, Modal, Dimensions } from 'react-native';
import { Image } from 'expo-image';
import { avatarUri } from '../utils/image-processing';
import { resolveBundledAvatar } from '../utils/bundled-avatars';
import { colors, palette } from '../constants/colors';

// Consistent color palette for letter-initial fallbacks
const FALLBACK_COLORS = [
    palette.violet500, palette.cyan500, palette.emerald500, palette.amber500,
    palette.red500, palette.pink500, palette.indigo500, palette.teal500,
] as const;

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
    const radius = borderRadius ?? size / 2;
    // Defensively clean raw string inputs to prevent invalid rendering on iOS
    const cleanedAvatarUrl = (avatarUrl && avatarUrl !== 'null' && avatarUrl !== 'undefined' && avatarUrl.trim() !== '') ? avatarUrl : null;
    let uri = avatarUri(cleanedAvatarUrl, pubkey, updatedAt);
    const fontSize = Math.max(Math.round(size * 0.42), 10);

    // Resolve the image source once, so the small avatar and the enlarged view
    // stay in sync. `bundledSource` (a require()d asset) takes precedence; a
    // failed bundled lookup must NOT fall through to a network uri (crashes iOS).
    let bundledSource: any = null;
    if (uri && uri.startsWith('bundled://')) {
        bundledSource = resolveBundledAvatar(uri);
        uri = null;
    }
    const imageSource = bundledSource || (uri ? { uri } : null);

    const smallEl = imageSource ? (
        <Image
            source={imageSource}
            accessibilityLabel={`${callsign}'s avatar`}
            cachePolicy="memory-disk"
            transition={120}
            style={[
                styles.image,
                { width: size, height: size, borderRadius: radius, overflow: 'hidden', flexShrink: 0 },
            ]}
        />
    ) : (
        // Letter-initial fallback with deterministic color
        (() => {
            const bgColor = getColorForPubkey(pubkey);
            const initial = (callsign || '?').charAt(0).toUpperCase();
            return (
                <View style={[styles.fallback, { width: size, height: size, borderRadius: radius, backgroundColor: bgColor + '20' }]}>
                    <Text allowFontScaling={false} numberOfLines={1} style={[styles.fallbackText, { fontSize, color: bgColor }]}>
                        {initial}
                    </Text>
                </View>
            );
        })()
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
                accessibilityLabel={`View ${callsign}'s photo`}
                hitSlop={6}
            >
                {smallEl}
            </Pressable>
            {viewerOpen && (
                <Modal visible transparent animationType="fade" onRequestClose={() => setViewerOpen(false)}>
                    <Pressable style={styles.viewerBackdrop} onPress={() => setViewerOpen(false)} accessibilityLabel="Close photo">
                        {imageSource ? (
                            <Image
                                source={imageSource}
                                accessibilityLabel={`${callsign}'s photo`}
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
                        <Text style={styles.viewerHint}>Tap anywhere to close</Text>
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
