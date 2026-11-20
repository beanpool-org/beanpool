import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, Modal, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WELCOME_TILE_WORDS, t, type HelpSheet as HelpSheetWords, type WelcomeTileLine } from '@beanpool/core';
import type { AppColors } from '../constants/colors';
import { sheetStyles } from './home/sheet-parts';

/**
 * The "?"'s sheet (scratch/global-node/DESIGN-getting-started-fable.md §4): the guide page for the screen the member is
 * on (its title and its `help:` line, else its summary, else its section's), then Read the guide page ›, Search the
 * guide, Welcome to BeanPool (the Home tile's words again, DESIGN-onboarding-home-landing-fable.md §4.2, slice S5) and
 * Take the tour again (Pick up the tour while one is open). With no words it still has Search and the tour: the "?" is
 * never dead and never says "no help here". Drawn in Add a card's frame.
 */
export function HelpSheet({ visible, sheet, tourOpen, canTour, welcome, colors, onReadPage, onSearch, onTour, onClose }: {
    visible: boolean;
    sheet: HelpSheetWords;
    /** A tour is running: the last row says Pick up the tour. */
    tourOpen: boolean;
    /** A member's phone (a guest has no account to keep the tour on): the tour row shows. */
    canTour: boolean;
    /** The welcome tile's lines for this community (core welcomeTileLines); absent: no Welcome to BeanPool row. */
    welcome?: readonly WelcomeTileLine[] | null;
    colors: AppColors;
    onReadPage: () => void;
    onSearch: () => void;
    onTour: () => void;
    onClose: () => void;
}) {
    const insets = useSafeAreaInsets();
    // Welcome to BeanPool opens its words in the sheet; closed again whenever the sheet closes.
    const [welcomeOpen, setWelcomeOpen] = useState(false);
    useEffect(() => { if (!visible) setWelcomeOpen(false); }, [visible]);
    const row = (label: string, onPress: () => void, testID: string, a11y: string) => (
        <Pressable
            onPress={onPress}
            style={[helpStyles.row, { borderBottomColor: colors.border.default }]}
            accessibilityRole="button"
            accessibilityLabel={a11y}
            testID={testID}
        >
            <Text style={[helpStyles.rowText, { color: colors.text.link }]}>{label}</Text>
        </Pressable>
    );
    return (
        <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose} statusBarTranslucent>
            <View style={sheetStyles.backdrop}>
                <View style={[sheetStyles.sheet, helpStyles.sheet, { backgroundColor: colors.surface.card, paddingBottom: 12 + insets.bottom }]} testID="help-sheet">
                    <View style={sheetStyles.head}>
                        <Text style={[sheetStyles.title, { color: colors.text.heading }]} accessibilityRole="header" testID="help-title">
                            {/* The page's own title is the guide's (slice S5); the stand-in is ours. */}
                            {sheet.title ?? t('Help')}
                        </Text>
                        <Pressable onPress={onClose} style={sheetStyles.done} accessibilityRole="button" accessibilityLabel={t('Close help')} testID="help-close">
                            <Text style={[sheetStyles.doneText, { color: colors.text.link }]}>{t('Close')}</Text>
                        </Pressable>
                    </View>
                    <View style={helpStyles.body}>
                        {!!sheet.text && <Text style={[helpStyles.text, { color: colors.text.body }]} testID="help-text">{sheet.text}</Text>}
                        <View style={[helpStyles.rows, { borderTopColor: colors.border.default }]}>
                            {(sheet.slug || sheet.section) && row(t('Read the guide page ›'), onReadPage, 'help-read-page', t('Read the guide page: {title}', { title: sheet.title ?? '' }))}
                            {row(t('Search the guide'), onSearch, 'help-search', t('Search the guide'))}
                            {!!welcome?.length && row(t('Welcome to BeanPool'), () => setWelcomeOpen(o => !o), 'help-welcome', t('Welcome to BeanPool'))}
                            {!!welcome?.length && welcomeOpen && (
                                <View style={[helpStyles.welcome, { borderBottomColor: colors.border.default }]} testID="help-welcome-words">
                                    <Text style={[helpStyles.welcomeTitle, { color: colors.text.heading }]}>{t(WELCOME_TILE_WORDS.title)}</Text>
                                    {welcome.map((l, i) => <Text key={i} style={[helpStyles.text, { color: colors.text.body, marginBottom: 6 }]}>{l.text}</Text>)}
                                </View>
                            )}
                            {canTour && row(tourOpen ? t('Pick up the tour') : t('Take the tour again'), onTour, 'help-tour', tourOpen ? t('Pick up the tour') : t('Take the tour again'))}
                        </View>
                    </View>
                </View>
            </View>
        </Modal>
    );
}

export const helpStyles = StyleSheet.create({
    sheet: { flexGrow: 0, flexShrink: 1 },
    body: { paddingHorizontal: 16, paddingBottom: 8 },
    text: { fontSize: 15, lineHeight: 22, marginBottom: 12 },
    rows: { borderTopWidth: StyleSheet.hairlineWidth },
    row: { minHeight: 48, justifyContent: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
    rowText: { fontSize: 15, fontWeight: '700' },
    welcome: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
    welcomeTitle: { fontSize: 16, fontWeight: '800', marginBottom: 8, textTransform: 'uppercase' },
});
