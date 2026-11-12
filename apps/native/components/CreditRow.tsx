/**
 * One row of the People list with Show credit on (DESIGN-credit-list-fable.md §3.2 with its amendments 1 and 2). The whole row
 * still opens the profile; Give credit is the only other target.
 *
 *   (o) Rob                              (o) Jane
 *       No credit yet · 4 live Offers        Credit line 1,300 · can use all of it now
 *       Balance 0                            Balance −420 · using 420 of 1,300
 *       ○ Credit risk: not known yet         ✓ Credit risk: low
 *       [ Give credit ]                      [ Give credit ]
 *
 * Every sentence is core's, over the node's figures (creditRowText). No fixed height and no "…": text wraps to as many lines
 * as it needs at 320 dp and 130% text; the button sits under the text, 48 dp tall. The risk is a word with a shape, never
 * colour alone; a minus sign is a real one and a screen reader hears "minus 420 Beans". A voucher's row (for owners and the
 * committee) carries their budget in one line. Nothing here is kept: the row is drawn from the screen's state.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatDate, formatHundredths, t } from '@beanpool/core';
import { MemberAvatar } from './MemberAvatar';
import { useRiskInk } from './CreditRisk';
import { useStyles } from '../app/ThemeContext';
import { creditRowText, marked, mayGive, shortDay, type CreditPerson, type CreditSightKind } from '../utils/credit-view';

export function CreditRow({ person, sight, onOpenProfile, onGive }: {
    person: CreditPerson;
    sight: CreditSightKind;
    onOpenProfile: (p: CreditPerson) => void;
    onGive: (p: CreditPerson) => void;
}) {
    const ink = useRiskInk();
    const styles = useStyles(({ colors }) => StyleSheet.create({
        row: { paddingVertical: 12, paddingHorizontal: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.surface.subtle, backgroundColor: colors.surface.card },
        top: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
        text: { flex: 1, minWidth: 0 },
        name: { fontSize: 16, fontWeight: '700', color: colors.text.heading },
        line: { fontSize: 13, lineHeight: 19, color: colors.text.body, marginTop: 2 },
        mark: { fontSize: 12, fontWeight: '800', color: colors.feedback.danger.fg, marginTop: 2 },
        risk: { fontSize: 13, lineHeight: 19, fontWeight: '700', marginTop: 2 },
        budget: { fontSize: 13, lineHeight: 19, color: colors.text.secondary, marginTop: 2 },
        low: { color: colors.feedback.warning.fg, fontWeight: '800' },
        give: { minHeight: 48, marginTop: 10, marginLeft: 56, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, backgroundColor: colors.brand.fill, justifyContent: 'center', alignSelf: 'flex-start' },
        giveText: { color: colors.text.inverse, fontSize: 15, fontWeight: '700' },
    }));
    const text = creditRowText(person, sight);
    const budget = person.voucherBudget;
    const paused = person.status === 'paused';
    const asked = budget?.askedAt ? shortDay(budget.askedAt, (d) => formatDate(d, 'day-month')) : '';
    return (
        <View style={[styles.row, paused && { opacity: 0.6 }]} testID={`credit-row-${person.callsign}`}>
            <Pressable accessibilityRole="button" onPress={() => onOpenProfile(person)} style={styles.top}>
                <MemberAvatar avatarUrl={null} pubkey={person.memberPubkey} callsign={person.callsign || '?'} size={44} />
                <View style={styles.text}>
                    <Text style={styles.name} maxFontSizeMultiplier={1.3}>{person.callsign}</Text>
                    <Text style={styles.line} maxFontSizeMultiplier={1.3} testID="credit-sentence">{text.credit}</Text>
                    <Text style={styles.line} maxFontSizeMultiplier={1.3} accessibilityLabel={text.balanceSpoken} testID="credit-balance">{text.balance}</Text>
                    {text.pausedMark ? <Text style={styles.mark} maxFontSizeMultiplier={1.3}>{marked('!', text.pausedMark)}</Text> : null}
                    <Text style={[styles.risk, { color: ink[text.level] }]} maxFontSizeMultiplier={1.3} testID="credit-risk">{text.riskLine}</Text>
                    {budget ? (
                        <Text style={styles.budget} maxFontSizeMultiplier={1.3} testID="credit-voucher-line">
                            {budget.noLimit
                                ? t('Owner · no limit')
                                : t('Voucher · {left} of {level} left', { left: formatHundredths(budget.left_c ?? 0), level: formatHundredths(budget.setLevel_c ?? budget.level_c ?? 0) })}
                        </Text>
                    ) : null}
                    {budget && budget.runningLow ? <Text style={[styles.budget, styles.low]} maxFontSizeMultiplier={1.3}>{marked('!', budget.nothingLeft ? t('Nothing left to vouch with') : t('Running low'))}</Text> : null}
                    {budget && asked ? <Text style={styles.budget} maxFontSizeMultiplier={1.3} testID="credit-voucher-asked">{t('Asked for more on {day}', { day: asked })}</Text> : null}
                </View>
            </Pressable>
            {mayGive(person) ? (
                <Pressable accessibilityRole="button" accessibilityLabel={t('Give credit to {name}', { name: person.callsign })} onPress={() => onGive(person)} style={styles.give} testID="credit-give">
                    <Text style={styles.giveText} maxFontSizeMultiplier={1.3}>{t('Give credit')}</Text>
                </Pressable>
            ) : null}
        </View>
    );
}
