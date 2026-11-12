/**
 * Ask for more (DESIGN-credit-list-amend-fable.md §3.6): a voucher who is not an owner asks for a bigger budget in ONE tap,
 * with no text and no amount (the level is the owner's or the committee's pick). Drawn in three places by this one
 * component: beside the budget line above the chips, on the Ledger's budget panel, and under the node's "You have … Beans of
 * budget left" refusal on the Give credit sheet.
 *
 * Its state is the node's (GET /api/vouchers/me `ask`): open, answered inside the week, or blocked by a pause or a freeze.
 * The weekly rule is the node's too (409 `asked_this_week`, which carries the dates). The button sends an empty body.
 */
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatDate } from '@beanpool/core';
import { useStyles } from '../app/ThemeContext';
import { askForMore, askWords, type AskState } from '../utils/credit-view';
import { rereadMyVouching } from '../utils/vouchers';
import type { BeanPoolIdentity } from '../utils/identity';

const shortDate = (iso: string): string => {
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? formatDate(d, 'day-month') : '';
};

export function AskForMore({ anchorUrl, identity, ask, onAsked, testID }: {
    anchorUrl: string;
    identity: BeanPoolIdentity;
    /** The node's state for this voucher; nothing is drawn without it (an owner, a member, an older node). */
    ask: AskState | null | undefined;
    /** Told the fresh state once the node has answered, so the screen holding the voucher's numbers follows it. */
    onAsked?: (ask: AskState) => void;
    testID?: string;
}) {
    const [state, setState] = useState<AskState | null>(ask ?? null);
    const [busy, setBusy] = useState(false);
    const [refusal, setRefusal] = useState<string | null>(null);
    useEffect(() => { setState(ask ?? null); }, [ask]);
    const styles = useStyles(({ colors }) => StyleSheet.create({
        wrap: { marginTop: 8 },
        button: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: colors.border.strong, backgroundColor: colors.surface.card, justifyContent: 'center', alignSelf: 'flex-start' },
        buttonText: { fontSize: 15, fontWeight: '700', color: colors.brand.primary },
        note: { fontSize: 13, lineHeight: 19, color: colors.text.secondary },
        refusal: { fontSize: 13, lineHeight: 19, color: colors.feedback.danger.fg, marginTop: 6 },
    }));
    if (!state) return null;
    const words = askWords(state, shortDate);
    const press = async () => {
        if (busy) return;
        setBusy(true);
        setRefusal(null);
        const res = await askForMore(anchorUrl, identity);
        if (res.ok) {
            const next: AskState = { askedAt: res.value.askedAt, lastAskedAt: res.value.askedAt, askAgainAt: res.value.askAgainAt, blocked: null };
            setState(next);
            onAsked?.(next);
            // The node's own state follows (a failed read keeps what the answer said).
            void rereadMyVouching(anchorUrl, identity, (mv) => { if (mv.ask) { setState(mv.ask); onAsked?.(mv.ask); } });
        } else if (res.code === 'asked_this_week' && typeof res.extra.askedAt === 'string' && typeof res.extra.askAgainAt === 'string') {
            const next: AskState = { askedAt: null, lastAskedAt: res.extra.askedAt, askAgainAt: res.extra.askAgainAt, blocked: null };
            setState(next);
            onAsked?.(next);
        } else {
            setRefusal(res.offline ? null : res.message || null);
        }
        setBusy(false);
    };
    return (
        <View style={styles.wrap} testID={testID ?? 'ask-for-more'}>
            {words.kind === 'button' ? (
                <Pressable accessibilityRole="button" accessibilityState={{ busy, disabled: busy }} disabled={busy} onPress={() => { void press(); }} style={[styles.button, busy && { opacity: 0.6 }]} testID="ask-for-more-button">
                    <Text style={styles.buttonText} maxFontSizeMultiplier={1.3}>{words.text}</Text>
                </Pressable>
            ) : (
                <Text style={styles.note} accessibilityLiveRegion="polite" maxFontSizeMultiplier={1.3} testID="ask-for-more-note">{words.text}</Text>
            )}
            {!!refusal && <Text style={styles.refusal} accessibilityRole="alert" maxFontSizeMultiplier={1.3}>{refusal}</Text>}
        </View>
    );
}
