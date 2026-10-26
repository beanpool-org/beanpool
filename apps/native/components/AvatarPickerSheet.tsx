import React, { useEffect, useState, useRef, useMemo } from 'react';
import { View, Text, StyleSheet, Pressable, Modal, Image, ScrollView, ActivityIndicator, Alert, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { pickPicture, type WorkingPicture } from '../utils/picture-crop';
import { BUNDLED_AVATARS } from '../utils/bundled-avatars';
import { colors as lightColors, palette, type AppColors } from '../constants/colors';
import { bottomSheetLayout } from '../utils/bottom-sheet-layout';
import { PictureCropView } from './PictureCrop';
import { AVATAR_PICTURE, t } from '@beanpool/core';

interface AvatarPickerSheetProps {
    visible: boolean;
    onClose: () => void;
    onSelectImage: (uri: string) => void;
    /** The dark theme's colours. Settings, welcome and profile setup pass them in dark; light passes none. */
    colors?: AppColors;
    /** Its heading: "Profile Photo" unless the picture is another's (an enterprise's logo, from its console). */
    title?: string;
}

export function AvatarPickerSheet({ visible, onClose, onSelectImage, colors, title }: AvatarPickerSheetProps) {
    const styles = useMemo(() => (colors ? makeStyles(tonesFor(colors)) : LIGHT_STYLES), [colors]);
    const [loading, setLoading] = useState(false);
    const [selectedAvatarId, setSelectedAvatarId] = useState<string | null>(null);
    // The body scrolls and "Use Selected Avatar" sits in a footer outside it, above the system bars: at 320 dp and 130%
    // text the button was at the screen's edge, its label cut (rehearsal 5 Oct, d1).
    const { height: windowHeight } = useWindowDimensions();
    const insets = useSafeAreaInsets();
    const layout = bottomSheetLayout(windowHeight, insets);
    // The footer appears with the first pick and takes its height from the body: at 320 dp and 130% text the body then
    // ended mid-row, the avatars cut at the footer's line (rehearsal 5 Oct b, item 4). The row is the body's last part, so
    // when the body's height changes with an avatar picked, it scrolls to its end and the whole row shows above the footer.
    const bodyScrollRef = useRef<ScrollView>(null);

    // Scroll affordance for the horizontal avatar strip: without an on-screen cue it isn't
    // obvious there are more avatars off the right edge. We show a chevron on whichever side
    // has more to reveal (also tappable to page through).
    //
    // Offset/size live in refs, not state, so a drag doesn't re-render the whole sheet at 60fps —
    // only the two chevron-visibility booleans are state, and they update solely when they flip.
    // `canScrollRight` is gated on a measured width so it can't flash on before the first layout.
    const avatarScrollRef = useRef<ScrollView>(null);
    const scrollXRef = useRef(0);
    const viewWRef = useRef(0);
    const contentWRef = useRef(0);
    const [canScrollLeft, setCanScrollLeft] = useState(false);
    const [canScrollRight, setCanScrollRight] = useState(false);
    const updateScrollCues = () => {
        const x = scrollXRef.current;
        const left = x > 4;
        const right = viewWRef.current > 0 && (contentWRef.current - viewWRef.current - x > 4);
        setCanScrollLeft(prev => (prev === left ? prev : left));
        setCanScrollRight(prev => (prev === right ? prev : right));
    };

    // A photo, from the camera or the gallery, opens the crop screen in this sheet's place (components/PictureCrop.tsx): the
    // member moves and zooms it under a circle, and the part in the circle is what is kept, 512 px (Marty, 25 Oct 2026). The
    // picker never crops by itself. Cancel comes back here with nothing changed.
    const [cropping, setCropping] = useState<WorkingPicture | null>(null);
    useEffect(() => { if (!visible) setCropping(null); }, [visible]);

    const pickFrom = async (from: 'camera' | 'library' | 'files') => {
        try {
            if (from === 'camera') {
                const perm = await ImagePicker.requestCameraPermissionsAsync();
                if (!perm.granted) {
                    Alert.alert(t('Permission required'), t('Camera access is needed.'));
                    return;
                }
            }
            setLoading(true);
            const picture = await pickPicture(from);
            if (picture) setCropping(picture);
        } catch (e) {
            Alert.alert(t('Error'), from === 'camera' ? t('Could not take photo.') : t('Could not pick image.'));
        } finally {
            setLoading(false);
        }
    };
    const handleTakePhotos = () => pickFrom('camera');
    const handleGallery = () => pickFrom('library');
    const handleBrowseFiles = () => pickFrom('files');

    const handleSelectBundled = () => {
        if (!selectedAvatarId) return;
        // Store as bundled:// protocol reference — universally resolvable on all devices
        onSelectImage(`bundled://${selectedAvatarId}`);
        onClose();
    };

    return (
        <Modal
            visible={visible}
            animationType="slide"
            transparent={true}
            onRequestClose={cropping ? () => setCropping(null) : onClose}
        >
            {cropping ? (
                <PictureCropView
                    picture={cropping}
                    shape={AVATAR_PICTURE}
                    colors={colors}
                    onCancel={() => setCropping(null)}
                    onDone={(dataUri) => {
                        setCropping(null);
                        onSelectImage(dataUri);
                        onClose();
                    }}
                    onFailed={() => {
                        setCropping(null);
                        Alert.alert(t('Error'), t('Could not process photo.'));
                    }}
                />
            ) : (
            <Pressable style={styles.backdrop} accessibilityRole="button" accessibilityLabel={t('Close')} onPress={onClose}>
                <Pressable style={[styles.sheet, { maxHeight: layout.maxHeight }]} accessibilityRole="button" onPress={(e) => e.stopPropagation()}>
                    {/* Header */}
                    <View style={styles.header}>
                        <Text style={styles.title}>{title ?? t('Profile Photo')}</Text>
                        <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel={t('Close')} style={styles.closeButton}>
                            <Text style={styles.closeText}>✕</Text>
                        </Pressable>
                    </View>

                    {/* Content: scrolls when taller than the sheet, so the footer below always shows */}
                    <ScrollView
                        ref={bodyScrollRef}
                        style={styles.body}
                        contentContainerStyle={styles.content}
                        onLayout={() => { if (selectedAvatarId && !loading) bodyScrollRef.current?.scrollToEnd({ animated: true }); }}
                    >
                        {loading ? (
                            <View style={styles.loadingContainer}>
                                <ActivityIndicator size="large" color={palette.blue600} />
                                <Text style={styles.loadingText}>{t('Processing image...')}</Text>
                            </View>
                        ) : (
                            <>
                                <View style={styles.sourceButtonsRow}>
                                    <Pressable style={styles.sourceButton} accessibilityRole="button" accessibilityLabel={t('Take photo with camera')} onPress={handleTakePhotos}>
                                        <Text style={styles.sourceEmoji}>📸</Text>
                                        {/* A longer language's words take a second line in their portion of the row, and shrink rather than break mid-word. */}
                                        <Text style={styles.sourceLabel} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Camera')}</Text>
                                    </Pressable>
                                    <Pressable style={styles.sourceButton} accessibilityRole="button" accessibilityLabel={t('Choose photo from gallery')} onPress={handleGallery}>
                                        <Text style={styles.sourceEmoji}>🖼️</Text>
                                        <Text style={styles.sourceLabel} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Gallery')}</Text>
                                    </Pressable>
                                    <Pressable style={styles.sourceButton} accessibilityRole="button" accessibilityLabel={t('Browse files')} onPress={handleBrowseFiles}>
                                        <Text style={styles.sourceEmoji}>📁</Text>
                                        <Text style={styles.sourceLabel} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.7}>{t('Browse files')}</Text>
                                    </Pressable>
                                </View>

                                <Text style={styles.sectionTitle}>{t('Or choose an avatar — swipe for more:')}</Text>

                                <View style={styles.avatarScrollWrap}>
                                    <ScrollView
                                        ref={avatarScrollRef}
                                        horizontal
                                        showsHorizontalScrollIndicator={true}
                                        contentContainerStyle={styles.avatarScrollContent}
                                        scrollEventThrottle={16}
                                        onScroll={(e) => { scrollXRef.current = e.nativeEvent.contentOffset.x; updateScrollCues(); }}
                                        onLayout={(e) => { viewWRef.current = e.nativeEvent.layout.width; updateScrollCues(); }}
                                        onContentSizeChange={(w) => { contentWRef.current = w; updateScrollCues(); }}
                                    >
                                        {BUNDLED_AVATARS.map((avatar) => {
                                            const isSelected = selectedAvatarId === avatar.id;
                                            return (
                                                <Pressable
                                                    key={avatar.id}
                                                    style={[
                                                        styles.avatarItem,
                                                        isSelected && styles.avatarItemSelected
                                                    ]}
                                                    accessibilityRole="button"
                                                    accessibilityLabel={t('Select {name} avatar', { name: t(avatar.label) })}
                                                    accessibilityState={{ selected: isSelected }}
                                                    onPress={() => setSelectedAvatarId(avatar.id)}
                                                >
                                                    <Image
                                                        source={avatar.source}
                                                        accessibilityElementsHidden={true}
                                                        importantForAccessibility="no-hide-descendants"
                                                        style={isSelected ? styles.avatarImageSelected : styles.avatarImage}
                                                    />
                                                </Pressable>
                                            );
                                        })}
                                    </ScrollView>

                                    {canScrollLeft && (
                                        <Pressable
                                            style={[styles.avatarChevron, styles.avatarChevronLeft]}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('Show earlier avatars')}
                                            onPress={() => avatarScrollRef.current?.scrollTo({ x: Math.max(0, scrollXRef.current - 200), animated: true })}
                                        >
                                            <View style={styles.avatarChevronButton}>
                                                <Text style={styles.avatarChevronText}>‹</Text>
                                            </View>
                                        </Pressable>
                                    )}
                                    {canScrollRight && (
                                        <Pressable
                                            style={[styles.avatarChevron, styles.avatarChevronRight]}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('Show more avatars')}
                                            onPress={() => avatarScrollRef.current?.scrollTo({ x: scrollXRef.current + 200, animated: true })}
                                        >
                                            <View style={styles.avatarChevronButton}>
                                                <Text style={styles.avatarChevronText}>›</Text>
                                            </View>
                                        </Pressable>
                                    )}
                                </View>

                            </>
                        )}
                    </ScrollView>

                    {/* Footer: outside the scroll, clear of the gesture bar or navigation buttons */}
                    {!loading && selectedAvatarId ? (
                        <View style={[styles.footer, { paddingBottom: layout.footerPaddingBottom }]}>
                            <Pressable style={styles.confirmButton} accessibilityRole="button" onPress={handleSelectBundled}>
                                <Text style={styles.confirmButtonText}>{t('Use Selected Avatar')}</Text>
                            </Pressable>
                        </View>
                    ) : (
                        <View style={{ height: layout.footerPaddingBottom }} />
                    )}
                </Pressable>
            </Pressable>
            )}
        </Modal>
    );
}

/** The sheet's own light look (slate), or the theme's tokens when a theme passes its colours. */
function tonesFor(colors?: AppColors) {
    return colors ? {
        sheet: colors.surface.card,
        line: colors.border.default,
        title: colors.text.heading,
        closeBg: colors.surface.subtle,
        closeText: colors.text.secondary,
        sourceBg: colors.surface.subtle,
        sourceBorder: colors.border.strong,
        sourceLabel: colors.text.body,
        section: colors.text.secondary,
        chevronBg: colors.surface.subtle,
        chevronText: colors.text.body,
        itemBg: colors.surface.subtle,
        selectedBg: colors.accent.tint,
        loading: colors.text.secondary,
    } : {
        sheet: lightColors.surface.card,
        line: palette.slate100,
        title: palette.slate900,
        closeBg: palette.slate100,
        closeText: palette.slate500,
        sourceBg: palette.slate50,
        sourceBorder: palette.slate200,
        sourceLabel: palette.slate700,
        section: palette.slate600,
        chevronBg: 'rgba(255,255,255,0.92)',
        chevronText: palette.slate700,
        itemBg: palette.slate50,
        selectedBg: palette.blue50,
        loading: palette.slate500,
    };
}

const makeStyles = (tone: ReturnType<typeof tonesFor>) => StyleSheet.create({
    backdrop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'flex-end',
    },
    sheet: {
        backgroundColor: tone.sheet,
        borderTopLeftRadius: 24,
        borderTopRightRadius: 24,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: 20,
        borderBottomWidth: 1,
        borderBottomColor: tone.line,
    },
    // Shrinks beside the close button: a longer language's title wraps rather than pushing ✕ off the sheet.
    title: {
        fontSize: 18,
        fontWeight: '700',
        color: tone.title,
        flexShrink: 1,
    },
    closeButton: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: tone.closeBg,
        alignItems: 'center',
        justifyContent: 'center',
    },
    closeText: {
        fontSize: 16,
        fontWeight: '700',
        color: tone.closeText,
    },
    // Shrinks to fit the sheet's cap and scrolls; never grows past its content.
    body: {
        flexGrow: 0,
        flexShrink: 1,
    },
    content: {
        padding: 20,
    },
    footer: {
        paddingHorizontal: 20,
        paddingTop: 12,
        borderTopWidth: 1,
        borderTopColor: tone.line,
    },
    sourceButtonsRow: {
        flexDirection: 'row',
        gap: 8,
        marginBottom: 24,
    },
    sourceButton: {
        flex: 1,
        backgroundColor: tone.sourceBg,
        borderWidth: 2,
        borderColor: tone.sourceBorder,
        borderRadius: 16,
        paddingVertical: 14,
        paddingHorizontal: 4,
        alignItems: 'center',
    },
    sourceEmoji: {
        fontSize: 32,
        marginBottom: 8,
    },
    sourceLabel: {
        fontSize: 16,
        fontWeight: '600',
        color: tone.sourceLabel,
        textAlign: 'center',
    },
    sectionTitle: {
        fontSize: 16,
        fontWeight: '600',
        color: tone.section,
        marginBottom: 16,
    },
    avatarScrollWrap: {
        position: 'relative',
    },
    avatarScrollContent: {
        gap: 16,
        paddingVertical: 10,
        paddingHorizontal: 4,
    },
    // Outer Pressable is the touch target (≥44dp wide, full strip height); it carries no
    // visual so the shadow/elevation can live on the inner circle where Android honours it.
    avatarChevron: {
        position: 'absolute',
        top: 0,
        bottom: 0,
        width: 44,
        justifyContent: 'center',
        zIndex: 2,
    },
    avatarChevronLeft: {
        left: -4,
        alignItems: 'flex-start',
    },
    avatarChevronRight: {
        right: -4,
        alignItems: 'flex-end',
    },
    avatarChevronButton: {
        width: 34,
        height: 34,
        borderRadius: 17,
        backgroundColor: tone.chevronBg,
        justifyContent: 'center',
        alignItems: 'center',
        // subtle lift so the cue reads as a control floating over the strip
        shadowColor: '#000',
        shadowOpacity: 0.18,
        shadowRadius: 3,
        shadowOffset: { width: 0, height: 1 },
        elevation: 3,
    },
    avatarChevronText: {
        fontSize: 24,
        fontWeight: '800',
        color: tone.chevronText,
        textAlign: 'center',
        includeFontPadding: false,
    },
    avatarItem: {
        width: 80,
        height: 80,
        borderRadius: 40,
        borderWidth: 3,
        borderColor: 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: tone.itemBg,
    },
    avatarItemSelected: {
        borderColor: palette.blue500,
        backgroundColor: tone.selectedBg,
        transform: [{ scale: 1.1 }],
    },
    avatarImage: {
        width: 60,
        height: 60,
        borderRadius: 30,
        overflow: 'hidden',
    },
    avatarImageSelected: {
        width: 70,
        height: 70,
        borderRadius: 35,
        overflow: 'hidden',
    },
    confirmButton: {
        backgroundColor: palette.blue500,
        borderRadius: 12,
        padding: 16,
        alignItems: 'center',
    },
    confirmButtonText: {
        color: lightColors.text.inverse,
        fontSize: 16,
        fontWeight: '700',
    },
    loadingContainer: {
        padding: 40,
        alignItems: 'center',
    },
    loadingText: {
        marginTop: 16,
        color: tone.loading,
        fontWeight: '600',
    },
});

const LIGHT_STYLES = makeStyles(tonesFor());
