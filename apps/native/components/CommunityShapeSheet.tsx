/**
 * The members' read-only community shape sheet (design §4, slice S5).
 * Lists the facts from Table 4.2 as paragraphs with bold tokens.
 * "Read more in the guide" button links to `/guide/how-your-community-works`.
 */
import React from 'react';
import { View, Text, Pressable, Modal, ScrollView, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import {
    COMMUNITY_SHAPE_CARD_WORDS,
    communityShapeLines,
    splitBold,
    t,
    type CommunityShapeFeatures,
} from '@beanpool/core';
import { useTheme } from '../app/ThemeContext';
import type { AppColors } from '../constants/colors';

export function CommunityShapeSheet({
    features,
    visible,
    onClose,
}: {
    features: CommunityShapeFeatures | null | undefined;
    visible: boolean;
    onClose: () => void;
}) {
    const { colors } = useTheme();
    const s = sheetStyles(colors);
    const lines = communityShapeLines(features);

    const onReadMore = () => {
        onClose();
        router.push({ pathname: '/guide/[slug]', params: { slug: 'how-your-community-works' } });
    };

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
            <Pressable style={s.scrim} onPress={onClose} accessibilityLabel={t('Close')} />
            <View style={s.sheet} testID="community-shape-sheet">
                <View style={s.header}>
                    <Text style={s.title} accessibilityRole="header">
                        {'🧭 '}<Text>{t(COMMUNITY_SHAPE_CARD_WORDS.title)}</Text>
                    </Text>
                    <Pressable
                        style={s.closeBtn}
                        onPress={onClose}
                        accessibilityRole="button"
                        accessibilityLabel={t('Close')}
                        testID="community-shape-close"
                    >
                        <Text style={s.closeText}>✕</Text>
                    </Pressable>
                </View>

                <ScrollView contentContainerStyle={s.content}>
                    {lines.map((line, idx) => (
                        <Text key={idx} style={s.lineParagraph}>
                            {splitBold(line).map((part, i) => (
                                <Text
                                    key={i}
                                    style={part.bold ? s.boldText : s.plainText}
                                >
                                    {part.text}
                                </Text>
                            ))}
                        </Text>
                    ))}

                    <Pressable
                        style={s.guideButton}
                        onPress={onReadMore}
                        accessibilityRole="button"
                        testID="community-shape-read-more"
                    >
                        <Text style={s.guideButtonText}>
                            {t(COMMUNITY_SHAPE_CARD_WORDS.readMoreInGuide)}
                        </Text>
                    </Pressable>
                </ScrollView>
            </View>
        </Modal>
    );
}

const sheetStyles = (colors: AppColors) => StyleSheet.create({
    scrim: {
        flex: 1,
        backgroundColor: colors.overlay.imageViewerCloseBg,
    },
    sheet: {
        backgroundColor: colors.surface.card,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        maxHeight: '85%',
        paddingBottom: 24,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 20,
        paddingTop: 18,
        paddingBottom: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.border.default,
    },
    title: {
        fontSize: 18,
        fontWeight: '800',
        color: colors.text.body,
        flex: 1,
    },
    closeBtn: {
        minWidth: 44,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
    },
    closeText: {
        fontSize: 18,
        fontWeight: '700',
        color: colors.text.muted,
    },
    content: {
        padding: 20,
        gap: 14,
    },
    lineParagraph: {
        fontSize: 15,
        lineHeight: 22,
        color: colors.text.body,
    },
    boldText: {
        fontWeight: '700',
        color: colors.text.body,
    },
    plainText: {
        fontWeight: '400',
        color: colors.text.body,
    },
    guideButton: {
        borderWidth: 1,
        borderColor: colors.border.default,
        borderRadius: 12,
        minHeight: 48,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 16,
        marginTop: 6,
    },
    guideButtonText: {
        fontSize: 15,
        fontWeight: '700',
        color: colors.brand.primary,
        textAlign: 'center',
    },
});
