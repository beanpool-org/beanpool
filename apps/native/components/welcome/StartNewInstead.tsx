/**
 * Under the ways back on a phone with no account: never a dead end. Says plainly what starting new does (a new account,
 * not the old one back), then goes to the front door (components/welcome/FrontDoor.tsx), where the person still chooses
 * how to join. Nothing is made by this tap.
 *
 * The table is the component's own, with the welcome screen's numbers (the restore prompt's box), not the screen's handed
 * down, so the contrast check (utils/button-contrast.ts) reads it, as components/welcome/RestoreMenu.tsx does.
 */
import { useMemo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { palette, type AppColors } from '../../constants/colors';
import { useWords } from '../LanguageProvider';

export function StartNewInstead({ colors, dark, onStartNew }: { colors: AppColors; dark: boolean; onStartNew(): void }) {
    const { t } = useWords();
    const styles = useMemo(() => makeStyles(colors, dark), [colors, dark]);
    return (
        <View style={styles.restorePromptBox} testID="start-new-instead">
            <Text style={styles.restorePromptLabel}>
                {t("Can't bring your account back? You can start again, but that makes a new account. Your old account stays as it is, and the two can never be joined into one.")}
            </Text>
            <Pressable style={styles.restorePromptBtn} onPress={onStartNew} accessibilityRole="button" accessibilityLabel={t('Start a new account instead')} testID="start-new-instead-button">
                <Text style={styles.restorePromptBtnText}>{t('Start a new account instead →')}</Text>
            </Pressable>
        </View>
    );
}

function makeStyles(colors: AppColors, dark: boolean) {
    return StyleSheet.create({
        restorePromptBox: { marginTop: 16, padding: 14, borderRadius: 14, backgroundColor: 'rgba(59, 130, 246, 0.08)', borderWidth: 1, borderColor: 'rgba(59, 130, 246, 0.25)', alignItems: 'center', width: '100%' },
        restorePromptLabel: { color: colors.text.body, fontSize: 13, marginBottom: 8, fontWeight: '500', textAlign: 'center' },
        restorePromptBtn: { width: '100%', paddingVertical: 12, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1, borderColor: palette.blue600, backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center', minHeight: 44 },
        restorePromptBtnText: { color: dark ? palette.blue400 : palette.blue700, fontSize: 14, fontWeight: '700', textAlign: 'center' },
    });
}
