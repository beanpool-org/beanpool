/**
 * The members' read-only community shape sheet (design §4, slice S5).
 * Lists the facts from Table 4.2 as paragraphs with bold tokens.
 * "Read more in the guide" button links to `/guide/how-your-community-works`.
 *
 * For an owner or admin (`forOwners`, NodeAdminEntry; DESIGN-core-settings-fable.md §6.3, slice C3) it is the same facts under
 * the name "Core settings", with a line on whether they are confirmed and locked and a last line saying where to change them:
 * the phone shows the facts, the controls are the node's Settings page (Manage). A member's sheet is unchanged.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, Modal, ScrollView, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import {
    COMMUNITY_SHAPE_CARD_WORDS,
    communityShapeLines,
    splitBold,
    t,
    type CommunityShapeFeatures,
    type KnownRule,
} from '@beanpool/core';
import { useTheme } from '../app/ThemeContext';
import { anchorUrl } from '../utils/node-post';
import { fetchKnownRule } from '../utils/known-rule';
import type { AppColors } from '../constants/colors';
import type { CoreSettingsState } from '../utils/node-admin';
import { coreSettingsFooterWords, coreSettingsLabelWords, coreSettingsLockLineWords } from './settings/settings-lines';

export function CommunityShapeSheet({
    features,
    visible,
    onClose,
    forOwners,
}: {
    features: CommunityShapeFeatures | null | undefined;
    visible: boolean;
    onClose: () => void;
    /** Present for an owner or admin: `core` is whether the node said the core settings are locked (null: it did not say). */
    forOwners?: { core: CoreSettingsState | null };
}) {
    const { colors } = useTheme();
    const s = sheetStyles(colors);
    // The date on a tightened line: `features` carries the numbers, not when they apply. Only where there is a rule to date.
    const [rule, setRule] = useState<KnownRule | null>(null);
    const known = typeof features?.knownFloor === 'number';
    useEffect(() => {
        if (!visible || !known) return;
        let live = true;
        void anchorUrl().catch(() => null).then((url) => (url ? fetchKnownRule(url) : null)).then((r) => { if (live) setRule(r); });
        return () => { live = false; };
    }, [visible, known]);
    const lines = communityShapeLines(features, rule);
    const lockLine = forOwners ? coreSettingsLockLineWords(forOwners.core) : null;

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
                        {'🧭 '}<Text>{forOwners ? coreSettingsLabelWords() : t(COMMUNITY_SHAPE_CARD_WORDS.title)}</Text>
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
                    {lockLine ? <Text style={s.lockLine} testID="community-shape-lock-line">{lockLine}</Text> : null}
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
                    {forOwners ? <Text style={s.footer} testID="community-shape-footer">{coreSettingsFooterWords()}</Text> : null}
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
    lockLine: {
        fontSize: 15,
        lineHeight: 22,
        fontWeight: '700',
        color: colors.text.body,
    },
    footer: {
        fontSize: 14,
        lineHeight: 20,
        color: colors.text.muted,
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
