/**
 * The sheet every action in Learn's preview opens (DESIGN-local-knowledge-fable.md amended §2.9): on the worldwide community,
 * where `showcase` is on, Learn is drawn from Example Valley's three sample pages and nothing in it does anything but say why
 * Local knowledge lives in a local community and offer the two ways there (Start a community, Communities near you), as the
 * other previews' sheet does (components/showcase/LocalCommunityMark.tsx). It writes nothing and calls no node.
 *
 * The guide button is absent on purpose: the members' guide page "Local knowledge" is slice K9's, and a button to a page that
 * doesn't exist yet would be a dead end. K9 adds it.
 */
import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { LOCAL_COMMUNITY_EMOJI, LOCAL_COMMUNITY_SHEET, t } from '@beanpool/core';
import { useTheme } from '../../app/ThemeContext';
import { SHEET_ROUTES, markTone } from '../showcase/LocalCommunityMark';
import { LEARN_LINES } from './learn-lines';

export function LearnPreviewSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
    const { colors } = useTheme();
    const tone = markTone(colors);
    const s = StyleSheet.create({
        scrim: { flex: 1, backgroundColor: colors.overlay.imageViewerCloseBg },
        sheet: { backgroundColor: colors.surface.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '85%' },
        title: { fontSize: 18, fontWeight: '800', color: colors.text.body },
        body: { fontSize: 15, lineHeight: 22, color: colors.text.body },
        button: { borderWidth: 1, borderRadius: 12, minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
        buttonText: { fontSize: 15, fontWeight: '800', textAlign: 'center' },
    });
    const go = (to: () => void) => { onClose(); to(); };
    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
            <Pressable style={s.scrim} onPress={onClose} accessibilityLabel={t('Close')} />
            <View style={s.sheet} testID="learn-preview-sheet">
                <ScrollView contentContainerStyle={{ padding: 20, gap: 12 }}>
                    <Text style={s.title} accessibilityRole="header">{LOCAL_COMMUNITY_EMOJI}{' '}<Text>{t(LEARN_LINES.previewTitle)}</Text></Text>
                    <Text style={s.body}>{t(LEARN_LINES.previewLine)}</Text>
                    <Text style={s.body}>{t(LOCAL_COMMUNITY_SHEET.common)}</Text>
                    <Pressable style={[s.button, { backgroundColor: tone.fg, borderColor: tone.fg }]} accessibilityRole="button"
                        onPress={() => go(() => router.push(SHEET_ROUTES.start))}>
                        <Text style={[s.buttonText, { color: colors.surface.card }]}>{t(LOCAL_COMMUNITY_SHEET.start)}</Text>
                    </Pressable>
                    <Pressable style={[s.button, { borderColor: tone.border }]} accessibilityRole="button"
                        onPress={() => go(() => router.push(SHEET_ROUTES.nearYou))}>
                        <Text style={[s.buttonText, { color: tone.fg }]}>{t(LOCAL_COMMUNITY_SHEET.nearYou)}</Text>
                    </Pressable>
                </ScrollView>
            </View>
        </Modal>
    );
}
