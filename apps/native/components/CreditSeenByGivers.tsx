/**
 * "What people who give credit see" on the member's own Ledger (DESIGN-credit-list-amend-fable.md §5.4 with amendment 2 §0 item
 * 20; slice C6): exactly the answer a plain voucher gets about this member, read from `GET /api/credit/me` and drawn line for
 * line from core's `creditMeCard` (the web draws the same card from the same function), so the two apps cannot say two things:
 *
 *   What people who give credit see
 *   Credit line 1,300 · can use all of it now
 *   Balance −420 · using 420 of 1,300
 *   ✓ Credit risk: low
 *   New here: no completed trade yet.  ·  An owner or admin can say more.
 *   People who give credit here (the owners, admins and vouchers) can see your balance and your credit line, and each look is recorded.
 *
 * Three rules, as for the profile card (utils/credit-view.ts): the NODE decides what is said (a member whose node has Beans
 * off, or is the worldwide community, gets a 404 and sees nothing); NOTHING IS KEPT (the answer lives in this component's
 * state while the Ledger is open: no phone database, no storage, no offline copy, amendment 1 §5.1); and no reason is composed
 * here (each is core's riskReasonSentence over the node's figures). The reasons are all said, with no tap to open them: a mark
 * a member must tap to read is half a hidden score. A read that fails draws nothing, never a half-card.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { creditMeCard, type CreditMeCard } from '@beanpool/core';
import { useStyles } from '../app/ThemeContext';
import { useRiskInk } from './CreditRisk';
import { fetchCreditMe, marked } from '../utils/credit-view';
import type { BeanPoolIdentity } from '../utils/identity';

export function CreditSeenByGivers({ anchorUrl, identity, reread }: {
    anchorUrl: string;
    identity: BeanPoolIdentity;
    /** Changes when the member's own balance may have: the card is read again, and the one on screen stays until the new answer lands. */
    reread?: unknown;
}) {
    // What was read, and for whom: another member's card is never drawn for this one while it is read.
    const who = `${anchorUrl}|${identity.publicKey}`;
    const [read, setRead] = useState<{ who: string; card: CreditMeCard } | null>(null);
    // The screen shown again (back from Send, the Wallet, the budget panel): read again. Its first showing is the read below.
    const [shownAgain, setShownAgain] = useState(0);
    const shownBefore = useRef(false);
    useFocusEffect(useCallback(() => {
        if (!shownBefore.current) { shownBefore.current = true; return; }
        setShownAgain((n) => n + 1);
    }, []));
    useEffect(() => {
        let alive = true;
        void fetchCreditMe(anchorUrl, identity).then((r) => {
            if (!alive) return;
            // An answer is drawn; a refusal, a node without Beans or no connection draws nothing (never a stale or half card).
            setRead(r.ok && r.value.me ? { who, card: creditMeCard(r.value.me) } : null);
        });
        return () => { alive = false; };
    }, [anchorUrl, identity, reread, shownAgain]);
    const ink = useRiskInk();
    const styles = useStyles(({ colors }) => StyleSheet.create({
        card: { backgroundColor: colors.surface.card, borderRadius: 16, padding: 16, marginBottom: 20, borderWidth: 1, borderColor: colors.border.default },
        title: { fontSize: 15, fontWeight: '800', color: colors.text.heading, marginBottom: 6 },
        line: { fontSize: 14, lineHeight: 20, color: colors.text.body, marginTop: 2 },
        small: { fontSize: 12, lineHeight: 18, color: colors.text.secondary, marginTop: 2 },
        // The row's own mark (CreditRow): bold, in the danger ink, so a paused account is not read as small print.
        mark: { fontSize: 12, lineHeight: 18, fontWeight: '800', color: colors.feedback.danger.fg, marginTop: 2 },
        word: { fontSize: 14, fontWeight: '700', lineHeight: 20, marginTop: 8 },
        reason: { fontSize: 13, lineHeight: 19, color: colors.text.body, marginTop: 4 },
        told: { fontSize: 12, lineHeight: 18, color: colors.text.secondary, marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border.default },
    }));
    if (!read || read.who !== who) return null;
    const c = read.card;
    return (
        <View style={styles.card} testID="credit-seen-by-givers">
            <Text style={styles.title} accessibilityRole="header" maxFontSizeMultiplier={1.3}>{c.title}</Text>
            <Text style={styles.line} maxFontSizeMultiplier={1.3} testID="credit-seen-line">{c.credit}</Text>
            {c.liveOffers ? <Text style={styles.small} maxFontSizeMultiplier={1.3} testID="credit-seen-offers">{c.liveOffers}</Text> : null}
            <Text style={styles.line} maxFontSizeMultiplier={1.3} accessibilityLabel={c.balanceSpoken} testID="credit-seen-balance">{c.balance}</Text>
            {c.paused ? <Text style={styles.mark} maxFontSizeMultiplier={1.3} testID="credit-seen-paused">{marked('!', c.paused)}</Text> : null}
            <Text style={[styles.word, { color: ink[c.level] }]} maxFontSizeMultiplier={1.3} testID="credit-seen-risk">{marked(c.shape, c.word)}</Text>
            {c.reasons.map((line, i) => <Text key={i} style={styles.reason} maxFontSizeMultiplier={1.3} testID="credit-seen-reason">{line}</Text>)}
            <Text style={styles.told} maxFontSizeMultiplier={1.3} testID="credit-seen-told">{c.told}</Text>
        </View>
    );
}
