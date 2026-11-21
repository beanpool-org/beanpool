/**
 * The community's welcome card's styles (CommunityWelcomeCard.tsx, slice S7), on their own so the 320 dp measures
 * (utils/__tests__/home-layout-320.test.ts) read them without the card's Settings door. Sizes only: every colour is the
 * caller's, from the central tokens.
 */
import { StyleSheet } from 'react-native';
import { HOME_TARGET_DP } from './HomeParts';

export const communityWelcomeStyles = StyleSheet.create({
    // The owners' words: the card's largest type, wrapping wherever it must (a long word breaks rather than runs out), aligned
    // by the words' own script (right for Arabic or Hebrew in an English app).
    words: { fontSize: 16, lineHeight: 23, fontWeight: '600', textAlign: 'auto', writingDirection: 'auto', paddingTop: 4, paddingBottom: 6 },
    row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8 },
    // Shrinks to wrap inside the row (a long name), where "Say hello ›" goes to the next row.
    small: { fontSize: 15, lineHeight: 20, flexShrink: 1 },
    link: { minHeight: HOME_TARGET_DP, justifyContent: 'center' },
    linkText: { fontSize: 15, fontWeight: '700' },
    count: { fontSize: 13, lineHeight: 18, paddingBottom: 6 },
    // The ×: a 48 dp target at the band's right edge, where the "…" sits on other cards.
    x: { width: HOME_TARGET_DP, height: HOME_TARGET_DP, marginRight: -12, alignItems: 'center', justifyContent: 'center', borderRadius: HOME_TARGET_DP / 2 },
    xText: { fontSize: 22, fontWeight: '700' },
});
