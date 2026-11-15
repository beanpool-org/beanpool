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
 * Drawn with the welcome screen's own styles (app/welcome.tsx makeStyles), as the doors are, so the contrast check reads
 * the same buttons. Both labels wrap rather than cut off at 320 dp with text at 1.3×.
 */
import { View, Text, Pressable } from 'react-native';
import { useWords } from '../LanguageProvider';

export interface UsedBeforeStyles {
    homeDoors: object;
    usedBeforeQuestion: object;
    memberBtn: object;
    memberBtnText: object;
    inviteOnlyHint: object;
}

export function UsedBefore({ onNew, onReturning, styles }: {
    /** New here: the doors (today's join). */
    onNew(): void;
    /** Used BeanPool before: the ways back. */
    onReturning(): void;
    styles: UsedBeforeStyles;
}) {
    const { t } = useWords();
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

export interface StartNewInsteadStyles {
    restorePromptBox: object;
    restorePromptLabel: object;
    restorePromptBtn: object;
    restorePromptBtnText: object;
}

/**
 * Under the ways back on a phone with no account: never a dead end. Says plainly what starting new does (a new account,
 * not the old one back), then goes to the doors, where the person still chooses how to join. Nothing is made by this tap.
 */
export function StartNewInstead({ onStartNew, styles }: { onStartNew(): void; styles: StartNewInsteadStyles }) {
    const { t } = useWords();
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
