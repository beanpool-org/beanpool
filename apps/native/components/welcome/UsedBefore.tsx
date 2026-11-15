/**
 * The first question on a phone with no account (Marty, 12 Nov idea 2, yes on 15 Nov): "Used BeanPool before?", asked
 * before the doors, so someone who lost or changed their phone brings their account back instead of making a second one.
 * Two plain answers of equal weight, the web's own words for the same fork (apps/pwa WelcomePage "I'm New Here" /
 * "I'm Already a Member →"), so the lines elsewhere that say "tap Already a member" still name a button on this screen:
 *
 * - **I'm New Here**: the doors, today's join (components/WelcomeDoors.tsx). Nothing is made here: an account is made
 *   only further on, by a join the person chooses there.
 * - **I'm Already a Member**: the ways back (components/welcome/RestoreMenu.tsx), best first, with "Start a new account
 *   instead" under them (StartNewInstead below), so a person who can't get back in is never stuck.
 *
 * The tables are the components' own, with the welcome screen's numbers (app/welcome.tsx makeStyles: the doors' blue
 * buttons, the restore prompt's box), not the screen's handed down, so the contrast check (utils/button-contrast.ts)
 * reads them, as components/welcome/RestoreMenu.tsx does. Both labels wrap rather than cut off at 320 dp with text at 1.3×.
 */
import { useMemo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { palette, type AppColors } from '../../constants/colors';
import { useWords } from '../LanguageProvider';

export function UsedBefore({ colors, dark, onNew, onReturning }: {
    /** The screen's colours (utils/onboarding-colors.ts). */
    colors: AppColors;
    dark: boolean;
    /** New here: the doors (today's join). */
    onNew(): void;
    /** Used BeanPool before: the ways back. */
    onReturning(): void;
}) {
    const { t } = useWords();
    const styles = useMemo(() => makeStyles(colors, dark), [colors, dark]);
    return (
        <View style={styles.homeDoors} testID="used-before">
            <Text style={styles.usedBeforeQuestion} accessibilityRole="header">{t('Used BeanPool before?')}</Text>
            <Pressable style={styles.memberBtn} onPress={onNew} accessibilityRole="button" accessibilityLabel={t("I'm New Here")} testID="used-before-new">
                <Text style={styles.memberBtnText}>{t("I'm New Here")}</Text>
            </Pressable>
            <Pressable style={styles.memberBtn} onPress={onReturning} accessibilityRole="button" accessibilityLabel={t("I'm Already a Member →")} testID="used-before-returning">
                <Text style={styles.memberBtnText}>{t("I'm Already a Member →")}</Text>
            </Pressable>
            <Text style={styles.inviteOnlyHint}>
                {t("Lost or changed your phone? Tap I'm Already a Member to bring your account back, so you don't make a second one.")}
            </Text>
        </View>
    );
}

/**
 * Under the ways back on a phone with no account: never a dead end. Says plainly what starting new does (a new account,
 * not the old one back), then goes to the doors, where the person still chooses how to join. Nothing is made by this tap.
 */
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
        homeDoors: { width: '100%', alignItems: 'center', marginTop: 16 },
        usedBeforeQuestion: { fontSize: 20, fontWeight: '700', color: colors.text.heading, textAlign: 'center', marginBottom: 16 },
        memberBtn: { backgroundColor: palette.blue600, paddingVertical: 18, paddingHorizontal: 12, borderRadius: 14, alignItems: 'center', width: '100%', marginBottom: 12, shadowColor: palette.blue600, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.25, shadowRadius: 14, elevation: 6 },
        memberBtnText: { color: colors.text.inverse, fontSize: 18, fontWeight: '700', textAlign: 'center' },
        inviteOnlyHint: { fontSize: 16, color: colors.text.secondary, textAlign: 'center', lineHeight: 22, marginTop: 4 },
        restorePromptBox: { marginTop: 16, padding: 14, borderRadius: 14, backgroundColor: 'rgba(59, 130, 246, 0.08)', borderWidth: 1, borderColor: 'rgba(59, 130, 246, 0.25)', alignItems: 'center', width: '100%' },
        restorePromptLabel: { color: colors.text.body, fontSize: 13, marginBottom: 8, fontWeight: '500', textAlign: 'center' },
        restorePromptBtn: { width: '100%', paddingVertical: 12, paddingHorizontal: 16, borderRadius: 10, borderWidth: 1, borderColor: palette.blue600, backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center', minHeight: 44 },
        restorePromptBtnText: { color: dark ? palette.blue400 : palette.blue700, fontSize: 14, fontWeight: '700', textAlign: 'center' },
    });
}
