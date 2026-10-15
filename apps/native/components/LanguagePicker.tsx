/**
 * Choosing the language (translation design §1; director amendment 2): the same list behind the first screen's small
 * switch ("🌐 English ▾", never a step) and Settings → Language. Each language is written in its own name and script
 * (utils/language-choice.ts LANGUAGE_NAMES), so someone who can't read the current one still finds theirs. A pick is
 * live: every screen re-renders in it (components/LanguageProvider.tsx); nothing restarts and nothing typed is lost.
 *
 * 48dp rows that wrap rather than truncate (320dp at 1.3× text); colours from the theme's roles only.
 */

import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Lang } from '@beanpool/core';
import { useTheme } from '../app/ThemeContext';
import { useWords } from './LanguageProvider';
import { LANGUAGE_NAMES, LANGUAGE_OPTIONS } from '../utils/language-choice';
import { catalogsFor } from '../utils/words-catalogs';

/** Whether the current language's words are a machine draft no native speaker has checked yet (its catalog's _meta). */
export function isMachineDraft(lang: string): boolean {
    if (lang === 'en' || lang === 'xx') return false;
    try {
        return catalogsFor(lang as Lang).some((c) => (c?._meta as { review?: unknown } | undefined)?.review === 'machine');
    } catch {
        return false;
    }
}

export function LanguagePickerSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
    const { colors } = useTheme();
    const { t, choice, phoneLanguage, chooseLanguage } = useWords();
    const styles = makeStyles(colors);
    const pick = (lang: Lang | null) => { chooseLanguage(lang); onClose(); };
    return (
        <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
            <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('Close')}>
                <Pressable style={styles.sheet} onPress={() => {}} testID="language-picker">
                    <Text style={styles.title} accessibilityRole="header">{t('Language')}</Text>
                    <ScrollView style={styles.list} accessibilityRole="radiogroup">
                        <Row
                            label={t('Same as phone ({language})', { language: LANGUAGE_NAMES[phoneLanguage] })}
                            selected={choice === null}
                            onPress={() => pick(null)}
                            styles={styles}
                        />
                        {LANGUAGE_OPTIONS.map(({ value, name }) => (
                            <Row key={value} label={name} selected={choice === value} onPress={() => pick(value)} styles={styles} testID={`language-${value}`} />
                        ))}
                    </ScrollView>
                    <Pressable style={styles.doneBtn} onPress={onClose} accessibilityRole="button">
                        <Text style={styles.doneText}>{t('Close')}</Text>
                    </Pressable>
                </Pressable>
            </Pressable>
        </Modal>
    );
}

function Row({ label, selected, onPress, styles, testID }: { label: string; selected: boolean; onPress: () => void; styles: ReturnType<typeof makeStyles>; testID?: string }) {
    return (
        <Pressable
            style={[styles.row, selected && styles.rowSelected]}
            onPress={onPress}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            accessibilityLabel={label}
            testID={testID}
        >
            <Text style={[styles.rowText, selected && styles.rowTextSelected]}>{label}</Text>
            {selected && <Text style={styles.tick}>✓</Text>}
        </Pressable>
    );
}

/** The first screen's switch: "🌐 English ▾" at the top, which opens the list. Never a step; skipping it is fine. */
export function LanguageSwitch() {
    const { colors } = useTheme();
    const { t, lang } = useWords();
    const [open, setOpen] = useState(false);
    const styles = makeStyles(colors);
    const name = lang === 'xx' ? '[Ŝāṽé~~]' : LANGUAGE_NAMES[lang];
    return (
        <>
            <Pressable
                style={styles.switch}
                onPress={() => setOpen(true)}
                accessibilityRole="button"
                accessibilityLabel={t('Language: {language}', { language: name })}
                testID="language-switch"
            >
                <Text style={styles.switchText}>🌐 {name} ▾</Text>
            </Pressable>
            <LanguagePickerSheet visible={open} onClose={() => setOpen(false)} />
        </>
    );
}

/** The styles Settings draws its rows with (app/(tabs)/settings.tsx), so this row matches its neighbours. */
export interface MenuRowStyles {
    menuBtn: object; menuIconWrap: object; menuIcon: object; menuText: object; menuSub: object; menuChevron: object;
}

/**
 * Settings → Language: the current language in its own name, a line when its words are a machine draft (director
 * amendment 3: drafts ship labelled), and the list on a tap. Live, per device.
 */
export function LanguageRow({ styles }: { styles: MenuRowStyles }) {
    const { t, lang, choice } = useWords();
    const [open, setOpen] = useState(false);
    const name = lang === 'xx' ? '[Ŝāṽé~~]' : LANGUAGE_NAMES[lang];
    return (
        <>
            <Pressable style={styles.menuBtn} onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={t('Language: {language}', { language: name })} testID="settings-language">
                <View style={styles.menuIconWrap}><Text style={styles.menuIcon}>🌐</Text></View>
                <View style={{ flex: 1 }}>
                    <Text style={styles.menuText}>{t('Language')}</Text>
                    <Text style={styles.menuSub}>{choice === null ? t('Same as phone ({language})', { language: name }) : name}</Text>
                    {isMachineDraft(lang) && <Text style={styles.menuSub}>{t('Translated by machine: some words may be wrong.')}</Text>}
                </View>
                <Text style={styles.menuChevron}>›</Text>
            </Pressable>
            <LanguagePickerSheet visible={open} onClose={() => setOpen(false)} />
        </>
    );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
    return StyleSheet.create({
        backdrop: { flex: 1, backgroundColor: colors.overlay.scrim, justifyContent: 'center', padding: 16 },
        sheet: { backgroundColor: colors.surface.card, borderRadius: 16, paddingVertical: 12, maxHeight: '85%' },
        title: { fontSize: 18, fontWeight: '700', color: colors.text.heading, paddingHorizontal: 16, paddingVertical: 8 },
        list: { flexGrow: 0 },
        row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10 },
        rowSelected: { backgroundColor: colors.surface.subtle },
        rowText: { flex: 1, fontSize: 16, color: colors.text.body },
        rowTextSelected: { fontWeight: '700', color: colors.text.heading },
        tick: { fontSize: 16, fontWeight: '700', color: colors.brand.primary, marginStart: 8 },
        doneBtn: { minHeight: 48, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
        doneText: { fontSize: 16, fontWeight: '600', color: colors.text.link },
        switch: { alignSelf: 'center', minHeight: 48, justifyContent: 'center', paddingHorizontal: 14, marginBottom: 8 },
        switchText: { fontSize: 15, fontWeight: '600', color: colors.text.secondary },
    });
}
