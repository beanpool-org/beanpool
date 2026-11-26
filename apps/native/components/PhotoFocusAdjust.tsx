import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, Modal, ScrollView, StyleSheet, Image as RNImage, type LayoutChangeEvent, type GestureResponderEvent } from 'react-native';
import { Image } from 'expo-image';
import { DEFAULT_PHOTO_FOCUS, MARKET_CARD_SHELL, photoFocusToward, photoFocusWindow, t, type PhotoFocus } from '@beanpool/core';
import { useStyles } from '../app/ThemeContext';
import { palette } from '../constants/colors';
import { focusContentPosition } from '../utils/photo-focus';

/** The Market grid card's frame, width over height (core MARKET_CARD_SHELL.photo.grid): the crop the member is choosing. */
const CARD_ASPECT = MARKET_CARD_SHELL.photo.grid.aspectWidth / MARKET_CARD_SHELL.photo.grid.aspectHeight;
/** An upright photo is drawn this tall at most, so the frame, the card and the buttons fit together at 320 dp. */
const UPRIGHT_STAGE_DP = 280;
/** The touch floor of every button here, as the crop screen's (PictureCrop.tsx). */
const TARGET_DP = 48;

/**
 * Choose what a photo's card shows (Marty, 26 Nov 2026: part of a first post's photo was cut off on its card). The whole
 * photo, with the card's frame over it at the real card's shape; a drag or a tap moves the frame to the part to keep, and the
 * card below shows the result exactly as the Market draws it (the same contentPosition). Done hands back the focus (core
 * photo-focus.ts); Reset is the card's own crop again (no focus). The photo itself is never changed or copied.
 *
 * A plain Modal: no keyboard in it, so no KeyboardProvider (topic-native-gotchas). Scrolls at 320 dp and 1.3x text.
 */
export function PhotoFocusAdjust({ uri, focus, onDone, onCancel }: {
    /** The photo to adjust, or null when the screen is closed. */
    uri: string | null;
    focus: PhotoFocus | null;
    onDone: (focus: PhotoFocus | null) => void;
    onCancel: () => void;
}) {
    const [aspect, setAspect] = useState<number | null>(null);
    const [box, setBox] = useState<{ w: number; h: number } | null>(null);
    const [picked, setPicked] = useState<PhotoFocus | null>(focus);

    useEffect(() => {
        setPicked(focus);
        setAspect(null);
        if (!uri) return;
        let live = true;
        RNImage.getSize(uri, (w, h) => { if (live && w > 0 && h > 0) setAspect(w / h); }, () => { if (live) setAspect(1); });
        return () => { live = false; };
    }, [uri, focus]);

    const styles = useStyles(({ colors }) => StyleSheet.create({
        overlay: { flex: 1, backgroundColor: colors.overlay.scrim, justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 24 },
        sheet: { backgroundColor: colors.surface.card, borderRadius: 20, maxHeight: '100%' },
        body: { padding: 16 },
        title: { fontSize: 18, fontWeight: '900', color: colors.text.heading, marginBottom: 4 },
        hint: { fontSize: 13, color: colors.text.secondary, marginBottom: 12 },
        // The photo's ground: the image viewer's near-black, in both themes, as the crop screen's.
        stage: { alignSelf: 'center', backgroundColor: colors.overlay.imageViewerBg, borderRadius: 12, overflow: 'hidden' },
        photo: { width: '100%', height: '100%' },
        // The frame's outside is dimmed in four bands, as the crop screen dims round its frame; the frame is outlined white.
        shade: { position: 'absolute', backgroundColor: colors.overlay.imageViewerCloseBg },
        frame: { position: 'absolute', borderWidth: 2, borderColor: palette.white },
        label: { fontSize: 11, fontWeight: '800', color: colors.text.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 14, marginBottom: 6 },
        card: { width: '62%', aspectRatio: CARD_ASPECT, borderRadius: MARKET_CARD_SHELL.radius, overflow: 'hidden', borderWidth: 1, borderColor: colors.border.default, alignSelf: 'center' },
        row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end', marginTop: 16 },
        btn: { minHeight: TARGET_DP, paddingHorizontal: 16, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.app },
        btnText: { fontSize: 14, fontWeight: '800', color: colors.text.body },
        done: { backgroundColor: colors.brand.fill, borderColor: colors.brand.fill },
        doneText: { color: colors.text.onBrand },
    }));

    const shown = picked ?? DEFAULT_PHOTO_FOCUS;
    const win = aspect ? photoFocusWindow(aspect, CARD_ASPECT, shown) : null;
    const move = (e: GestureResponderEvent) => {
        if (!aspect || !box) return;
        const { locationX, locationY } = e.nativeEvent;
        const px = Math.min(1, Math.max(0, locationX / box.w));
        const py = Math.min(1, Math.max(0, locationY / box.h));
        setPicked((was) => photoFocusToward(aspect, CARD_ASPECT, px, py, was ?? DEFAULT_PHOTO_FOCUS));
    };
    const onStage = (e: LayoutChangeEvent) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });

    return (
        <Modal visible={!!uri} transparent animationType="fade" onRequestClose={onCancel}>
            <View style={styles.overlay}>
                <View style={styles.sheet}>
                    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
                        <Text style={styles.title} accessibilityRole="header">{t('Choose what the card shows')}</Text>
                        <Text style={styles.hint}>{t('Drag or tap the part of the photo to keep. The whole photo still shows when someone opens the post.')}</Text>
                        {uri && aspect ? (
                            <View
                                testID="photo-focus-stage"
                                style={[styles.stage, aspect >= 1 ? { width: '100%', aspectRatio: aspect } : { height: UPRIGHT_STAGE_DP, aspectRatio: aspect }]}
                                onLayout={onStage}
                                onStartShouldSetResponder={() => true}
                                onMoveShouldSetResponder={() => true}
                                onResponderTerminationRequest={() => false}
                                onResponderGrant={move}
                                onResponderMove={move}
                                accessible
                                accessibilityLabel={t('Photo with the card frame over it')}
                                accessibilityHint={t('Drag or tap to move the frame')}
                            >
                                <Image source={{ uri }} style={styles.photo} contentFit="fill" accessible={false} />
                                {win ? (
                                    <>
                                        <View pointerEvents="none" style={[styles.shade, { left: 0, right: 0, top: 0, height: `${win.top * 100}%` }]} />
                                        <View pointerEvents="none" style={[styles.shade, { left: 0, right: 0, bottom: 0, height: `${(1 - win.top - win.height) * 100}%` }]} />
                                        <View pointerEvents="none" style={[styles.shade, { left: 0, top: `${win.top * 100}%`, height: `${win.height * 100}%`, width: `${win.left * 100}%` }]} />
                                        <View pointerEvents="none" style={[styles.shade, { right: 0, top: `${win.top * 100}%`, height: `${win.height * 100}%`, width: `${(1 - win.left - win.width) * 100}%` }]} />
                                        <View testID="photo-focus-frame" pointerEvents="none" style={[styles.frame, { left: `${win.left * 100}%`, top: `${win.top * 100}%`, width: `${win.width * 100}%`, height: `${win.height * 100}%` }]} />
                                    </>
                                ) : null}
                            </View>
                        ) : null}
                        <Text style={styles.label}>{t('On the card')}</Text>
                        {uri ? (
                            <View style={styles.card}>
                                <Image testID="photo-focus-card" source={{ uri }} style={styles.photo} contentFit="cover" contentPosition={focusContentPosition(picked)} />
                            </View>
                        ) : null}
                        <View style={styles.row}>
                            <Pressable style={styles.btn} accessibilityRole="button" onPress={() => setPicked(null)}>
                                <Text style={styles.btnText}>{t('Reset')}</Text>
                            </Pressable>
                            <Pressable style={styles.btn} accessibilityRole="button" onPress={onCancel}>
                                <Text style={styles.btnText}>{t('Cancel')}</Text>
                            </Pressable>
                            <Pressable testID="photo-focus-done" style={[styles.btn, styles.done]} accessibilityRole="button" onPress={() => onDone(picked)}>
                                <Text style={[styles.btnText, styles.doneText]}>{t('Done')}</Text>
                            </Pressable>
                        </View>
                    </ScrollView>
                </View>
            </View>
        </Modal>
    );
}
