/**
 * Restore your account's four rows (app/welcome.tsx, slice S10; vault rethink VR4 adds the third): sign-in, the 12 words,
 * "My community can bring me back" (the same key, from an admin who sees the member in person: app/rekey-code.tsx), and an
 * admin's re-key code (a new key). Every label wraps, with no line limit, so all four hold at 320 dp with text at 1.3×.
 */
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useWords } from '../LanguageProvider';

/** The welcome screen's styles these are drawn with (app/welcome.tsx makeStyles), so the rows match the screen. */
export interface RestoreMenuStyles {
    ssoRecoverBtn: object;
    ssoRecoverRow: object;
    ssoRecoverBtnText: object;
    ssoRecoverLogos: object;
    recoverBtn: object;
    recoverBtnText: object;
    restoreRowHint: object;
}

export function RestoreMenu({ styles, logos, onSocial, onWords, onCommunity, onRekey }: {
    styles: RestoreMenuStyles;
    /** The sign-in providers' marks, beside Recover with Social. */
    logos: ReactNode;
    onSocial: () => void;
    onWords: () => void;
    onCommunity: () => void;
    onRekey: () => void;
}) {
    const { t } = useWords();
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
