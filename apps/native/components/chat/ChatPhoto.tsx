/**
 * A photo in a chat bubble, and the full-screen view a tap opens (DESIGN-group-chat-photos-fable.md §2.3): the group chat's,
 * drawn as the DM screen draws its own (app/chat/[id].tsx ChatImage), which can move here unchanged. 220 × 220, cover,
 * whatever the photo's size, so a run of photos can't blow up a 320 dp layout; never wider than its bubble. Tap opens the
 * same 800 px photo full screen: no bigger copy exists anywhere (memory photos-stay-800px).
 */

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, Image, ActivityIndicator, Modal } from 'react-native';
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
                <ActivityIndicator color={colors.text.muted} />
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

/** The photo full screen, over the chat, until tapped or closed. Nothing when `uri` is null. */
export function ChatPhotoViewer({ uri, onClose }: { uri: string | null; onClose: () => void }) {
    const { colors } = useTheme();
    const insets = useSafeAreaInsets();
    if (!uri) return null;
    return (
        // Its own window: the close button takes the status-bar inset itself (a Dynamic Island's 59 pt is more than 50).
        <Modal visible transparent animationType="fade" onRequestClose={onClose}>
            <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('Dismiss full-size photo')}
                style={{ flex: 1, backgroundColor: colors.overlay.imageViewerBg, alignItems: 'center', justifyContent: 'center' }}
                onPress={onClose}
            >
                <Image source={{ uri }} style={{ width: '100%', height: '100%' }} resizeMode="contain" accessibilityLabel={t('Full-size photo')} />
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
            </Pressable>
        </Modal>
    );
}
