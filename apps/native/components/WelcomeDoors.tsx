import { View, Text, Pressable } from 'react-native';
import { useWords } from './LanguageProvider';
import type { GlobalDoorState } from '../utils/global-entry';

/** The welcome screen's styles these are drawn with (app/welcome.tsx makeStyles), so the doors match the screen. */
export interface WelcomeDoorsStyles {
    homeDoors: object;
    memberBtn: object;
    memberBtnText: object;
    doorLine: object;
    inviteOnlyHint: object;
}

/**
 * The first screen's two doors (DESIGN-global-entry-fable.md §B.3, decision 2): **Join with an invite** first and
 * primary, **Explore BeanPool worldwide** right under it, then the hint. Both are always drawn, whatever the global
 * community has said or not said yet: no fade, nothing that waits on an answer, and a new member offline still sees both
 * ways in. They sit right under the title, so at 320 dp with text at 1.3× both are above the fold
 * (utils/__tests__/welcome-doors-render.test.ts measures it). The home is drawn from the top (app/welcome.tsx), so the
 * line below, which can arrive after drawing, never moves the doors: only what is under it.
 *
 * `door` is what the global community's door said this app start (utils/global-door-offer.ts). Open, or not heard yet:
 * nothing more. Otherwise one line under the button says why it can't be used right now, and TalkBack reads it with the
 * button. The button still opens the door, which asks again fresh and offers Try again. Never a gate: the invite button
 * and everything else on the screen work whatever it says (no-domain-lock-in).
 *
 * One line in English at 320dp and 1.3x text, shrinking rather than wrapping; a longer language (ru, fr, ar, the
 * pseudo-locale) may take a second line rather than shrink past 0.6 (utils/__tests__/language-switch-render.test.ts).
 *
 * `exploring`: the second door is asking whether this phone may look around first (slice S12, app/welcome.tsx
 * exploreWorldwide). The line under it says so, and a second tap waits; the invite button works all the while.
 */
export function WelcomeDoors({ door, joinWithInvite, openGlobalDoor, exploring = false, styles }: {
    door: GlobalDoorState;
    joinWithInvite(): void;
    openGlobalDoor(): void;
    exploring?: boolean;
    styles: WelcomeDoorsStyles;
}) {
    const { t } = useWords();
    const line = exploring ? t('Connecting to the global community…')
        : door === 'unreachable' ? t("Can't reach the global community right now. Try again, or join with an invite.")
        : door === 'closed' ? t('Not taking new members right now.')
        : door === 'preview' ? t('This community is in a private preview. Ask its owner for an invite.')
        : null;
    return (
        <View style={styles.homeDoors}>
            <Pressable style={styles.memberBtn} onPress={joinWithInvite} accessibilityRole="button" accessibilityLabel={t('Join with an invite')}>
                <Text style={styles.memberBtnText} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.6}>{t('🎟️ Join with an invite')}</Text>
            </Pressable>
            <Pressable style={styles.memberBtn} onPress={openGlobalDoor} disabled={exploring} accessibilityRole="button" accessibilityLabel={t('Explore BeanPool worldwide')} accessibilityHint={line ?? undefined} accessibilityState={{ busy: exploring, disabled: exploring }}>
                <Text style={styles.memberBtnText} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.6}>{t('🌍 Explore BeanPool worldwide')}</Text>
            </Pressable>
            {line && <Text style={styles.doorLine} accessibilityLiveRegion="polite">{line}</Text>}
            <Text style={styles.inviteOnlyHint}>{t('No invite? Explore BeanPool worldwide and find a community near you.')}</Text>
        </View>
    );
}
