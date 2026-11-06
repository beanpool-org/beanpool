import { StyleSheet } from 'react-native';
import { HOME_TARGET_DP } from './HomeParts';

/**
 * "A chat"'s layout (DESIGN-home-chosen-chat-fable.md §2), on the card (components/home/ChatBody.tsx) and in its settings
 * list (CardSettingsSheet.tsx): the name wraps to two lines and the new count wraps under it at 320dp × 1.3; a list row
 * is a 48dp target whose time wraps under the name rather than squeezing it. Colours come from the central tokens where
 * each is drawn (light and dark); these are sizes only. Read by utils/__tests__/home-layout-320.test.ts.
 */
export const chatCardStyles = StyleSheet.create({
    body: { minHeight: HOME_TARGET_DP, paddingVertical: 6, borderRadius: 10 },
    head: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 4, marginBottom: 4 },
    name: { fontSize: 15, fontWeight: '700', flexShrink: 1, maxWidth: '100%' },
    pill: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, flexShrink: 0, maxWidth: '100%' },
    pillText: { fontSize: 12, fontWeight: '700' },
    line: { fontSize: 14, lineHeight: 20, marginTop: 2 },
    pickRow: {
        minHeight: HOME_TARGET_DP, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 6, marginBottom: 6,
        flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8,
    },
    pickName: { fontSize: 15, flexShrink: 1, maxWidth: '100%' },
    pickWhen: { fontSize: 13, flexShrink: 0, marginLeft: 'auto' },
});
