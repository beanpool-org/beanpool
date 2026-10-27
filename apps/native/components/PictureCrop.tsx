/**
 * The crop screen: one for every picture drawn in a fixed shape (Marty, 25 Oct 2026: what the member crops is exactly what
 * is shown). The photo under a frame of the shape (a circle for an avatar or a logo, 3:1 for a shop's banner), the rest of it
 * dimmed: one finger moves the photo, two pinch to zoom, − and + zoom too, and a screen reader's actions move and zoom it
 * (the frame is adjustable: swipe up or down to zoom). The frame is never left empty (core picture-crop.ts settles every
 * move). Done cuts exactly the part in the frame (utils/picture-crop.ts cutPicture); Cancel keeps nothing.
 *
 * No native module of its own: React Native's PanResponder, and the image tools the app already has. Full screen, at 320 dp
 * and 1.3× text the words wrap and every target is 48 dp; every colour is a token of the theme it is drawn in.
 *
 * - PictureCropView: the screen itself, for a sheet that already has its own Modal (components/AvatarPickerSheet.tsx).
 * - usePictureCrop: the screen in its own Modal, opened by `crop(picture, shape)`, which answers with the part chosen (or
 *   null on Cancel) and throws when it couldn't be cut (utils/banner-photo.ts's callers say so in their words).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ActivityIndicator, Image, Modal, PanResponder, Pressable, StyleSheet, Text, View, useWindowDimensions,
    type AccessibilityActionEvent, type GestureResponderEvent, type LayoutChangeEvent, type PanResponderGestureState,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
    PICTURE_CROP_MOVE_STEP, PICTURE_CROP_ZOOM_STEP, cropPlacement, cropRectOf, moveCropView, startCropView, t, zoomCropView,
    type CropView, type PictureShape,
} from '@beanpool/core';
import { colors as lightColors, palette, type AppColors } from '../constants/colors';
import { cutPicture, type CropPicture, type WorkingPicture } from '../utils/picture-crop';

/** The space kept round the frame inside the stage, so the dimmed photo shows what lies outside it. */
const FRAME_MARGIN = 16;
/** The touch floor of every button here. */
const TARGET_DP = 48;

/** The frame inside a stage of `stage`'s size: as large as fits, centred. */
function frameIn(stage: { width: number; height: number }, aspect: number) {
    const width = Math.max(1, Math.min(stage.width - 2 * FRAME_MARGIN, (stage.height - 2 * FRAME_MARGIN) * aspect));
    const height = width / aspect;
    return { width, height, left: (stage.width - width) / 2, top: (stage.height - height) / 2 };
}

type Touch = { pageX: number; pageY: number };
const apart = (a: Touch, b: Touch) => Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);

export function PictureCropView({ picture, shape, colors = lightColors, onCancel, onDone, onFailed }: {
    picture: WorkingPicture;
    shape: PictureShape;
    /** The theme's colours; light when none are passed (as AvatarPickerSheet's). */
    colors?: AppColors;
    onCancel: () => void;
    /** The part chosen, as a JPEG data URL. */
    onDone: (dataUri: string) => void;
    /** It couldn't be cut: the screen closes, and its opener says so. */
    onFailed: (e: unknown) => void;
}) {
    const insets = useSafeAreaInsets();
    const window = useWindowDimensions();
    const s = useMemo(() => makeStyles(colors), [colors]);
    // The stage's size, measured; until then the window's less the words and buttons, so the first frame is near right.
    const [stage, setStage] = useState(() => ({ width: window.width, height: Math.max(200, window.height - 320) }));
    const [view, setView] = useState<CropView>(() => startCropView(picture));
    const [busy, setBusy] = useState(false);
    const frame = frameIn(stage, shape.aspect);
    const rect = cropRectOf(picture, shape, view);
    const placed = cropPlacement(picture, rect, frame.width);

    // The view as last set, for gestures between renders; and the frame, which the stage's layout can change mid-gesture.
    const viewRef = useRef(view);
    const frameRef = useRef(frame);
    frameRef.current = frame;
    const show = useCallback((next: CropView) => { viewRef.current = next; setView(next); }, []);

    // A gesture: where the view was when it began (or when its fingers last changed), and the pinch's first spread.
    const gesture = useRef<{ from: CropView; dx: number; dy: number; spread: number | null } | null>(null);
    const pan = useMemo(() => PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (_e: GestureResponderEvent, g: PanResponderGestureState) => {
            gesture.current = { from: viewRef.current, dx: g.dx, dy: g.dy, spread: null };
        },
        onPanResponderMove: (e: GestureResponderEvent, g: PanResponderGestureState) => {
            const touches = e.nativeEvent.touches as unknown as Touch[];
            const at = gesture.current ?? (gesture.current = { from: viewRef.current, dx: g.dx, dy: g.dy, spread: null });
            if (touches.length >= 2) {
                const spread = apart(touches[0], touches[1]);
                if (!at.spread) { gesture.current = { from: viewRef.current, dx: g.dx, dy: g.dy, spread }; return; }
                show(zoomCropView(picture, shape, at.from, spread / at.spread));
                return;
            }
            // A finger lifted from a pinch: the drag goes on from where the pinch left it.
            if (at.spread) { gesture.current = { from: viewRef.current, dx: g.dx, dy: g.dy, spread: null }; return; }
            const f = frameRef.current;
            show(moveCropView(picture, shape, at.from, (g.dx - at.dx) / f.width, (g.dy - at.dy) / f.height));
        },
        onPanResponderRelease: () => { gesture.current = null; },
        onPanResponderTerminate: () => { gesture.current = null; },
    }), [picture, shape, show]);

    const zoom = (factor: number) => show(zoomCropView(picture, shape, viewRef.current, factor));
    const move = (dx: number, dy: number) => show(moveCropView(picture, shape, viewRef.current, dx, dy));
    const onAction = (e: AccessibilityActionEvent) => {
        switch (e.nativeEvent.actionName) {
            case 'increment': return zoom(PICTURE_CROP_ZOOM_STEP);
            case 'decrement': return zoom(1 / PICTURE_CROP_ZOOM_STEP);
            case 'moveLeft': return move(-PICTURE_CROP_MOVE_STEP, 0);
            case 'moveRight': return move(PICTURE_CROP_MOVE_STEP, 0);
            case 'moveUp': return move(0, -PICTURE_CROP_MOVE_STEP);
            case 'moveDown': return move(0, PICTURE_CROP_MOVE_STEP);
        }
    };

    const done = async () => {
        if (busy) return;
        setBusy(true);
        try {
            onDone(await cutPicture(picture, cropRectOf(picture, shape, viewRef.current), shape));
        } catch (e) {
            setBusy(false);
            onFailed(e);
        }
    };

    const onStageLayout = (e: LayoutChangeEvent) => {
        const { width, height } = e.nativeEvent.layout;
        if (width > 0 && height > 0) setStage((was) => (was.width === width && was.height === height ? was : { width, height }));
    };
    // The dim round the frame: one border whose inside edge is the frame's shape (a circle's, for a round one), wide enough
    // to reach every edge of the stage.
    const dim = Math.max(stage.width, stage.height);
    const radius = shape.round ? frame.width / 2 : 0;

    return (
        <View style={[s.screen, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]} testID="picture-crop">
            <View style={s.head}>
                <Text style={s.title} accessibilityRole="header">{t('Choose the part that shows')}</Text>
                <Text style={s.hint}>{t('Drag the picture to move it. Pinch, or use − and +, to zoom.')}</Text>
            </View>
            <View style={s.stage} onLayout={onStageLayout} testID="picture-crop-stage" {...pan.panHandlers}>
                <Image
                    source={{ uri: picture.uri }}
                    resizeMode="stretch"
                    style={{ position: 'absolute', left: frame.left + placed.left, top: frame.top + placed.top, width: placed.width, height: placed.height }}
                    accessibilityIgnoresInvertColors
                    testID="picture-crop-image"
                />
                <View pointerEvents="none" style={[s.dim, {
                    left: frame.left - dim, top: frame.top - dim, width: frame.width + 2 * dim, height: frame.height + 2 * dim,
                    borderWidth: dim, borderRadius: shape.round ? radius + dim : 0,
                }]} />
                <View
                    style={[s.frame, { left: frame.left, top: frame.top, width: frame.width, height: frame.height, borderRadius: radius }]}
                    accessible
                    accessibilityRole="adjustable"
                    accessibilityLabel={t('The part of the picture that shows')}
                    accessibilityHint={t('Swipe up or down to zoom. Use the actions to move the picture.')}
                    accessibilityActions={[
                        { name: 'increment', label: t('Zoom in') },
                        { name: 'decrement', label: t('Zoom out') },
                        { name: 'moveLeft', label: t('Move the picture left') },
                        { name: 'moveRight', label: t('Move the picture right') },
                        { name: 'moveUp', label: t('Move the picture up') },
                        { name: 'moveDown', label: t('Move the picture down') },
                    ]}
                    onAccessibilityAction={onAction}
                    testID="picture-crop-frame"
                />
            </View>
            <View style={s.zoomRow}>
                <Pressable style={({ pressed }) => [s.zoomButton, pressed && s.pressed]} onPress={() => zoom(1 / PICTURE_CROP_ZOOM_STEP)} disabled={busy}
                    accessibilityRole="button" accessibilityLabel={t('Zoom out')} testID="picture-crop-zoom-out">
                    <Text style={s.zoomText}>−</Text>
                </Pressable>
                <Pressable style={({ pressed }) => [s.zoomButton, pressed && s.pressed]} onPress={() => zoom(PICTURE_CROP_ZOOM_STEP)} disabled={busy}
                    accessibilityRole="button" accessibilityLabel={t('Zoom in')} testID="picture-crop-zoom-in">
                    <Text style={s.zoomText}>+</Text>
                </Pressable>
            </View>
            <View style={s.footer}>
                <Pressable style={({ pressed }) => [s.button, s.cancel, pressed && s.pressed]} onPress={onCancel} disabled={busy}
                    accessibilityRole="button" accessibilityState={{ disabled: busy }} testID="picture-crop-cancel">
                    <Text style={[s.buttonText, s.cancelText]}>{t('Cancel')}</Text>
                </Pressable>
                <Pressable style={({ pressed }) => [s.button, s.done, pressed && s.pressed]} onPress={() => { void done(); }} disabled={busy}
                    accessibilityRole="button" accessibilityLabel={busy ? t('Cropping picture...') : t('Done')} accessibilityState={{ disabled: busy, busy }} testID="picture-crop-done">
                    {busy ? <ActivityIndicator color={colors.text.onBrand} /> : <Text style={[s.buttonText, s.doneText]}>{t('Done')}</Text>}
                </Pressable>
            </View>
        </View>
    );
}

/**
 * The crop screen in its own Modal, for a screen with none (Manage's banner, Your shop's): `crop(picture, shape)` opens it
 * and answers with the part chosen, null on Cancel (or when the screen goes away), and throws when it couldn't be cut.
 * `element` is drawn anywhere in the screen.
 */
export function usePictureCrop(colors?: AppColors): { crop: CropPicture; element: React.ReactElement } {
    const [open, setOpen] = useState<{ picture: WorkingPicture; shape: PictureShape; resolve: (v: string | null) => void; reject: (e: unknown) => void } | null>(null);
    const openRef = useRef(open);
    openRef.current = open;
    useEffect(() => () => { openRef.current?.resolve(null); }, []);
    const crop = useCallback<CropPicture>((picture, shape) => new Promise<string | null>((resolve, reject) => {
        openRef.current?.resolve(null);
        setOpen({ picture, shape, resolve, reject });
    }), []);
    const close = () => setOpen(null);
    const element = (
        <Modal visible={!!open} animationType="slide" onRequestClose={() => { open?.resolve(null); close(); }}>
            {open ? (
                <PictureCropView
                    picture={open.picture}
                    shape={open.shape}
                    colors={colors}
                    onCancel={() => { open.resolve(null); close(); }}
                    onDone={(uri) => { open.resolve(uri); close(); }}
                    onFailed={(e) => { open.reject(e); close(); }}
                />
            ) : null}
        </Modal>
    );
    return { crop, element };
}

const makeStyles = (colors: AppColors) => StyleSheet.create({
    screen: { flex: 1, backgroundColor: colors.surface.app },
    head: { paddingHorizontal: 16, paddingBottom: 12, gap: 4 },
    title: { fontSize: 20, lineHeight: 26, fontWeight: '800', color: colors.text.heading },
    hint: { fontSize: 14, lineHeight: 20, color: colors.text.secondary },
    // The photo's ground: the image viewer's near-black, in both themes, so the photo reads as it is.
    stage: { flex: 1, minHeight: 160, overflow: 'hidden', backgroundColor: colors.overlay.imageViewerBg },
    dim: { position: 'absolute', borderColor: colors.overlay.imageViewerCloseBg },
    frame: { position: 'absolute', borderWidth: 2, borderColor: palette.white },
    zoomRow: { flexDirection: 'row', justifyContent: 'center', gap: 16, paddingTop: 12 },
    zoomButton: {
        minWidth: TARGET_DP, minHeight: TARGET_DP, borderRadius: TARGET_DP / 2, alignItems: 'center', justifyContent: 'center',
        backgroundColor: colors.surface.subtle, borderWidth: 1, borderColor: colors.border.strong,
    },
    zoomText: { fontSize: 24, lineHeight: 28, fontWeight: '700', color: colors.text.heading },
    footer: { flexDirection: 'row', gap: 12, paddingHorizontal: 16, paddingTop: 12 },
    button: { flex: 1, minHeight: TARGET_DP, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 10 },
    cancel: { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border.strong },
    done: { backgroundColor: colors.brand.fill },
    buttonText: { fontSize: 16, fontWeight: '700', textAlign: 'center' },
    cancelText: { color: colors.text.body },
    doneText: { color: colors.text.onBrand },
    pressed: { opacity: 0.85 },
});
