/**
 * A photo in a chat bubble, and the full-screen view a tap opens (DESIGN-group-chat-photos-fable.md §2.3): the group chat's,
 * drawn as the DM screen draws its own (components/chat/DmChatImage.tsx ChatImage). 220 × 220, cover,
 * whatever the photo's size, so a run of photos can't blow up a 320 dp layout; never wider than its bubble. Tap opens the
 * same 800 px photo full screen: no bigger copy exists anywhere (memory photos-stay-800px).
 */

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, Image, ActivityIndicator } from 'react-native';
import { LightBarModal } from '../LightBarModal';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { t } from '@beanpool/core';
import { useTheme } from '../../app/ThemeContext';
import type { ChatStyles } from './styles';

const PHOTO_SIDE = 220;

/**
 * Loads the photo once per `photoKey` (lazily: only a bubble on screen asks), then draws it. `load` answers what an <Image>
 * draws, or null: "🔒 Image unavailable", as a DM photo that can't be opened reads.
 */
export function ChatPhoto({ photoKey, load, onOpen }: { photoKey: string; load: () => Promise<string | null>; onOpen?: (uri: string) => void }) {
    const { colors } = useTheme();
    const [uri, setUri] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    const loadRef = useRef(load);
    loadRef.current = load;
    useEffect(() => {
        let active = true;
        setUri(null);
        setFailed(false);
        loadRef.current()
            .then(u => { if (active) { if (u) setUri(u); else setFailed(true); } })
            .catch(() => { if (active) setFailed(true); });
        return () => { active = false; };
    }, [photoKey]);
    if (failed) return <Text style={{ color: colors.text.muted, fontStyle: 'italic', padding: 8 }}>{t('🔒 Image unavailable')}</Text>;
    if (!uri) {
        return (
            <View style={{ width: PHOTO_SIDE, maxWidth: '100%', aspectRatio: 1, alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator color={colors.text.muted} accessibilityLabel={t('Loading photo')} />
            </View>
        );
    }
    return (
        <Pressable accessibilityRole="button" accessibilityLabel={t('View photo full screen')} onPress={() => onOpen?.(uri)}>
            <Image accessibilityLabel={t('Photo message')} source={{ uri }} style={{ width: PHOTO_SIDE, maxWidth: '100%', aspectRatio: 1, borderRadius: 12 }} resizeMode="cover" />
        </Pressable>
    );
}

/** A photo waiting above the box until Send: its thumbnail, what Send does with it, and a way to take it off. */
export function ChatWaitingPhoto({ uri, styles, disabled, onRemove }: { uri: string; styles: ChatStyles; disabled: boolean; onRemove: () => void }) {
    const { colors } = useTheme();
    return (
        <View style={styles.stagedPhotoRow}>
            <Image source={{ uri }} style={styles.stagedPhotoThumb} resizeMode="cover" accessibilityLabel={t('Photo message')} />
            <Text style={styles.stagedPhotoText}>{t('Add a caption below, or just send the photo.')}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={t('Remove photo')} accessibilityState={{ disabled }} disabled={disabled} style={styles.stagedPhotoRemove} onPress={onRemove}>
                <MaterialCommunityIcons name="close-circle" size={24} color={colors.text.muted} />
            </Pressable>
        </View>
    );
}

/**
 * The photo full screen, over the chat or a detail page (the listing's, the event's and Learn's, whose frame crops:
 * DESIGN-detail-pages-fable.md §2.6, slice DP4), until tapped or closed. Nothing when `uri` is null. Shows a spinner while the photo
 * loads and a clear fallback with Try again if it fails — never a blank full-screen overlay.
 */
export function ChatPhotoViewer({ uri, onClose }: { uri: string | null; onClose: () => void }) {
    // Unmounting the inner modal on `!uri` resets retry/settled cleanly for always-mounted callers (e.g. GroupChatView)
    // without a passive useEffect([uri]) that can race early cached/local onLoad events.
    if (!uri) return null;
    return <ChatPhotoViewerModal uri={uri} onClose={onClose} />;
}

function ChatPhotoViewerModal({ uri, onClose }: { uri: string; onClose: () => void }) {
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    const [retry, setRetry] = useState<{ uri: string; n: number } | null>(null);
    const [settled, setSettled] = useState<{ key: string; state: 'loaded' | 'error' } | null>(null);

    const retryKey = retry && retry.uri === uri ? retry.n : 0;
    const isRemote = /^https?:\/\//i.test(uri);
    const requestUri = retryKey > 0 && isRemote
        ? `${uri}${uri.includes('?') ? '&' : '?'}retry=${retryKey}`
        : uri;
    const attemptKey = `${requestUri}#${retryKey}`;
    const status = settled?.key === attemptKey ? settled.state : 'loading';

    return (
        // Its own window: the close button takes the status-bar inset itself (a Dynamic Island's 59 pt is more than 50).
        <LightBarModal visible transparent animationType="fade" onRequestClose={onClose}>
            <View style={{ flex: 1, backgroundColor: colors.overlay.imageViewerBg, alignItems: 'center', justifyContent: 'center' }}>
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('Dismiss full-size photo')}
                    style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
                    onPress={onClose}
                />
                {status !== 'error' ? (
                    <View pointerEvents="none" style={{ width: '100%', height: '100%' }}>
                        <Image
                            key={attemptKey}
                            source={{ uri: requestUri, ...(retryKey > 0 && isRemote ? { cache: 'reload' as const } : {}) }}
                            style={{ width: '100%', height: '100%' }}
                            resizeMode="contain"
                            onLoad={() => setSettled({ key: attemptKey, state: 'loaded' })}
                            onError={() => setSettled({ key: attemptKey, state: 'error' })}
                            accessibilityLabel={t('Full-size photo')}
                        />
                    </View>
                ) : null}
                {status === 'loading' ? (
                    <View
                        pointerEvents="none"
                        style={{ position: 'absolute', alignItems: 'center', justifyContent: 'center' }}
                        testID="photo-viewer-loading"
                    >
                        <ActivityIndicator size="large" color={colors.text.inverse} accessibilityLabel={t('Loading photo')} />
                    </View>
                ) : null}
                {status === 'error' ? (
                    <View
                        accessible={false}
                        accessibilityRole="alert"
                        accessibilityLiveRegion="polite"
                        onStartShouldSetResponder={() => true}
                        testID="photo-viewer-error"
                        style={{
                            maxWidth: 288,
                            marginHorizontal: 16,
                            padding: 20,
                            borderRadius: 16,
                            backgroundColor: colors.surface.card,
                            borderWidth: 1,
                            borderColor: colors.border.default,
                            alignItems: 'center',
                            gap: 12,
                        }}
                    >
                        <Text style={{ fontSize: 16, fontWeight: '800', color: colors.text.heading, textAlign: 'center' }}>
                            {t('Photo failed to load')}
                        </Text>
                        <Pressable
                            testID="photo-viewer-retry"
                            accessibilityRole="button"
                            accessibilityLabel={t('Try again')}
                            onPress={() => setRetry({ uri, n: retryKey + 1 })}
                            style={{
                                minHeight: 48,
                                minWidth: 120,
                                maxWidth: '100%',
                                paddingHorizontal: 20,
                                paddingVertical: 10,
                                borderRadius: 12,
                                backgroundColor: colors.brand.fill,
                                alignItems: 'center',
                                justifyContent: 'center',
                            }}
                        >
                            <Text style={{ fontSize: 15, fontWeight: '800', color: colors.text.onBrand, textAlign: 'center' }}>
                                {t('Try again')}
                            </Text>
                        </Pressable>
                    </View>
                ) : null}
                <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('Close photo')}
                    style={{
                        position: 'absolute', top: Math.max(50, insets.top + 8), right: 20, width: 48, height: 48, borderRadius: 24,
                        backgroundColor: colors.overlay.imageViewerCloseBg, alignItems: 'center', justifyContent: 'center',
                    }}
                    onPress={onClose}
                >
                    <MaterialCommunityIcons name="close" size={28} color={colors.text.inverse} />
                </Pressable>
            </View>
        </LightBarModal>
    );
}
