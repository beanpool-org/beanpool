import { StyleSheet } from 'react-native';
import { HOME_TARGET_DP } from './HomeParts';

/**
 * The bottom sheets' parts, shared by the picker, a card's settings, Help, the shop's and the tools' sheets. Exported for
 * the layout checks at 320dp (utils/__tests__/home-layout-320.test.ts).
 */
export const sheetStyles = StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
    sheet: { flexShrink: 1, borderTopLeftRadius: 18, borderTopRightRadius: 18 },
    head: { flexDirection: 'row', alignItems: 'center', paddingLeft: 16, paddingRight: 4, minHeight: HOME_TARGET_DP + 8 },
    title: { flex: 1, fontSize: 20, fontWeight: '800' },
    done: { minHeight: HOME_TARGET_DP, minWidth: HOME_TARGET_DP, paddingHorizontal: 12, justifyContent: 'center', alignItems: 'center' },
    doneText: { fontSize: 16, fontWeight: '700' },
    list: { paddingHorizontal: 16, paddingBottom: 12 },
    note: { fontSize: 13, lineHeight: 18, marginBottom: 6 },
    section: { fontSize: 12, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase', marginTop: 16, marginBottom: 2 },
    row: { flexDirection: 'row', alignItems: 'center', minHeight: HOME_TARGET_DP + 8, borderBottomWidth: StyleSheet.hairlineWidth, gap: 2 },
    rowText: { flex: 1, minWidth: 0, paddingVertical: 6 },
    name: { fontSize: 15, fontWeight: '600' },
    sub: { fontSize: 12, marginTop: 1 },
    addRow: { marginTop: 6, marginBottom: 6, minHeight: HOME_TARGET_DP, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
    addText: { fontSize: 15, fontWeight: '700' },
});
