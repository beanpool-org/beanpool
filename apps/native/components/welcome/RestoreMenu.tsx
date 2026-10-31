/**
 * Restore your account's four rows (app/welcome.tsx, slice S10; vault rethink VR4 adds the third): sign-in, the 12 words,
 * "My community can bring me back" (the same key, from an admin who sees the member in person: app/rekey-code.tsx), and an
 * admin's re-key code (a new key). Every label wraps, with no line limit, so all four hold at 320 dp with text at 1.3×.
 * The table is the rows' own, not the screen's handed down, so the contrast check (utils/button-contrast.ts) reads them.
 */
import { useMemo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { palette, type AppColors } from '../../constants/colors';
import { useWords } from '../LanguageProvider';

export function RestoreMenu({ colors, dark, logos, onSocial, onWords, onCommunity, onRekey }: {
    /** The screen's colours (utils/onboarding-colors.ts). */
    colors: AppColors;
    dark: boolean;
    /** The sign-in providers' marks, beside Recover with Social. */
    logos: ReactNode;
    onSocial: () => void;
    onWords: () => void;
    onCommunity: () => void;
    onRekey: () => void;
}) {
    const { t } = useWords();
    const styles = useMemo(() => makeStyles(colors, dark), [colors, dark]);
    return (
        <>
            <Pressable style={styles.ssoRecoverBtn} onPress={onSocial} accessibilityRole="button" accessibilityLabel={t('Recover with Social Sign-In')}>
                <View style={styles.ssoRecoverRow}>
                    <Text style={styles.ssoRecoverBtnText}>{t('🌐 Recover with Social')}</Text>
                    <View style={styles.ssoRecoverLogos}>{logos}</View>
                </View>
            </Pressable>
            <Pressable style={styles.recoverBtn} onPress={onWords} accessibilityRole="button">
                <Text style={styles.recoverBtnText}>{t('🔑 Recover with 12 Words')}</Text>
            </Pressable>
            {/* No words and no sign-in, and an admin who knows them: the same key comes back (vault rethink VR3, VR4). */}
            <Pressable style={styles.recoverBtn} onPress={onCommunity} accessibilityRole="button" accessibilityHint={t('For members of a local community.')}>
                <Text style={styles.recoverBtnText}>{t('🤝 My community can bring me back')}</Text>
                <Text style={styles.restoreRowHint}>{t('For members of a local community.')}</Text>
            </Pressable>
            {/* Lost the phone and the words: an admin's re-key code (app/rekey-code.tsx, #1768). */}
            <Pressable style={styles.recoverBtn} onPress={onRekey} accessibilityRole="button">
                <Text style={styles.recoverBtnText}>{t('🪪 An admin gave me a re-key code')}</Text>
            </Pressable>
        </>
    );
}

function makeStyles(colors: AppColors, dark: boolean) {
    return StyleSheet.create({
        ssoRecoverBtn: { width: '100%', padding: 16, borderRadius: 14, borderWidth: 1, borderColor: dark ? colors.feedback.info.border : '#93C5FD', backgroundColor: dark ? colors.feedback.info.bg : '#EFF6FF', alignItems: 'center', marginBottom: 10 },
        // The label shrinks and wraps; the logos keep their size. A label that could not shrink made the row wider than
        // the button at 320dp or with enlarged text, and the centred row spilled past both edges.
        ssoRecoverRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, maxWidth: '100%' },
        ssoRecoverBtnText: { color: dark ? palette.blue400 : '#1D4ED8', fontSize: 16, fontWeight: '700', flexShrink: 1, textAlign: 'center' },
        ssoRecoverLogos: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
        recoverBtn: { width: '100%', padding: 16, borderRadius: 14, borderWidth: 1, borderColor: colors.onboarding.recoverBorder, backgroundColor: colors.onboarding.recoverBg, alignItems: 'center', marginBottom: 10 },
        recoverBtnText: { color: dark ? palette.amber400 : palette.amber800, fontSize: 16, fontWeight: '700', textAlign: 'center' },
        restoreRowHint: { color: colors.text.secondary, fontSize: 13, marginTop: 4, textAlign: 'center' },
    });
}
