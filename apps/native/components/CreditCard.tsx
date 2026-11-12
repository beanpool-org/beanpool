/**
 * The credit card on a profile (DESIGN-credit-list-fable.md §3.4 with its amendment 1), above "Add to the names list" and the
 * Vouch box, for the same viewers: owners, admins and vouchers. Read from the node when the profile opens (one logged look a
 * day per viewer and person); drawn nothing for anyone the node does not answer (a plain member's phone never asks), and
 * nothing is kept: the card lives in this component's state while the profile is open.
 *
 *   Credit · only people who can give credit see this · each look is recorded
 *   Credit line 1,300 · can use all of it now
 *   Balance −420 · using 420 of 1,300
 *   Made of: known floor 1,000 · vouched 200 · earned 100          <- owners, admins
 *   Confirmed by @marty · Vouched by @marty 100, @olive 100       <- owners, admins
 *   ✓ Credit risk: low ›
 *
 * A voucher's card is every line but "Made of" and who stands behind (the node does not send them). Every sentence is core's.
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CREDIT_SIGHT_WORDS, formatCount, formatHundredths, t, tn } from '@beanpool/core';
import { useStyles } from '../app/ThemeContext';
import { RiskLine } from './CreditRisk';
import { cappedWords, creditRowText, marked, fetchCreditPerson, madeOfWords, standsBehindWords, type CreditPerson, type CreditSightKind } from '../utils/credit-view';
import type { BeanPoolIdentity } from '../utils/identity';

export function CreditCard({ anchorUrl, identity, memberPubkey }: { anchorUrl: string; identity: BeanPoolIdentity; memberPubkey: string }) {
    const [read, setRead] = useState<{ sight: CreditSightKind; person: CreditPerson } | null>(null);
    useEffect(() => {
        let alive = true;
        setRead(null);
        void fetchCreditPerson(anchorUrl, identity, memberPubkey).then((r) => { if (alive && r.ok) setRead({ sight: r.value.sight, person: r.value.person }); });
        return () => { alive = false; };
    }, [anchorUrl, identity, memberPubkey]);
    const styles = useStyles(({ colors }) => StyleSheet.create({
        card: { marginHorizontal: 16, marginTop: 12, padding: 14, borderRadius: 14, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card },
        title: { fontSize: 15, fontWeight: '800', color: colors.text.heading },
        only: { fontSize: 12, lineHeight: 18, color: colors.text.secondary, marginBottom: 6 },
        line: { fontSize: 14, lineHeight: 20, color: colors.text.body, marginTop: 2 },
        small: { fontSize: 12, lineHeight: 18, color: colors.text.secondary, marginTop: 2 },
    }));
    if (!read || read.person.own) return null;
    const { person, sight } = read;
    const text = creditRowText(person, sight);
    const made = madeOfWords(person);
    const capped = cappedWords(person);
    return (
        <View style={styles.card} testID="credit-card">
            <Text style={styles.title} accessibilityRole="header" maxFontSizeMultiplier={1.3}>{t('Credit')}</Text>
            <Text style={styles.only} maxFontSizeMultiplier={1.3}>{t(CREDIT_SIGHT_WORDS.onlyGivers)}</Text>
            <Text style={styles.line} maxFontSizeMultiplier={1.3} testID="credit-card-line">{text.credit}</Text>
            {person.line_c > 0 && typeof person.liveOffers === 'number' ? (
                <Text style={styles.small} maxFontSizeMultiplier={1.3}>{tn(person.liveOffers, '{n} live Offer', '{n} live Offers', { n: formatCount(person.liveOffers) })}</Text>
            ) : null}
            <Text style={styles.line} maxFontSizeMultiplier={1.3} accessibilityLabel={text.balanceSpoken} testID="credit-card-balance">{text.balance}</Text>
            {text.pausedMark ? <Text style={styles.small} maxFontSizeMultiplier={1.3}>{marked('!', text.pausedMark)}</Text> : null}
            {made ? <Text style={styles.small} maxFontSizeMultiplier={1.3} testID="credit-card-made">{made}</Text> : null}
            {standsBehindWords(person).map((line, i) => <Text key={i} style={styles.small} maxFontSizeMultiplier={1.3}>{line}</Text>)}
            {capped ? <Text style={styles.small} maxFontSizeMultiplier={1.3}>{capped}</Text> : null}
            {typeof person.youVouched_c === 'number' && person.youVouched_c > 0 ? (
                <Text style={styles.small} maxFontSizeMultiplier={1.3}>{t('You vouched {amount}', { amount: formatHundredths(person.youVouched_c) })}</Text>
            ) : null}
            <RiskLine risk={person.risk} word={text.risk} shape={text.riskShape} testID="credit-card-risk" />
        </View>
    );
}
