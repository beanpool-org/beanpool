/**
 * "Buy for {enterprise}" on an Offer priced for each one (scratch/fable-design/DESIGN-stall-consignment-fable.md §5.6, §6
 * slice 2): a keeper takes the Offer up for the enterprise they keep, which pays the seller at once (the node's door,
 * POST /api/treasury/:treasury/take-up, holds and releases in one request). One button per enterprise kept; a tap opens the
 * count picker (the member's own box, components/PerItemTakeUp) and under it the confirm sheet's one sentence. The web's
 * components/EnterpriseTakeUp.tsx is the same, and every rule, figure and sentence is @beanpool/core enterprise-take-up.ts.
 *
 * Confirm sends exactly the total the sheet showed (`expect_c`) with a retry id: the same tap retried (an answer that never
 * came) carries the same id, so the node answers it with the first sale and never sells twice. A refusal stays in the sheet
 * in plain words; nothing was paid on any of them. Colours are the existing roles, so dark mode comes with them. Drawn in
 * place inside the page's ScrollView (never a Modal of its own, so no keyboard provider here).
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
    ITEM_BOX_START, itemTakeUpBox, takeUpAnswerOf, takeUpBody, takeUpListingMoved, takeUpRefusalText, takeUpRequestFor, takeUpSheet, t,
    type ItemBoxState, type TakeUpAnswer, type TakeUpBody, type TakeUpButton, type TakeUpRequest,
} from '@beanpool/core';
import { useTheme } from '../app/ThemeContext';
import { PerItemTakeUp } from './PerItemTakeUp';
import { signedRequestWords } from './signed-request-lines';

export interface EnterpriseTakeUpProps {
    /** The listing as the page holds it (core perItemOf reads the phone's row). */
    listing: unknown;
    postId: string;
    title: string;
    sellerName: string;
    /** core takeUpButtons: one per enterprise the reader keeps, only where the node has the door. */
    buttons: readonly TakeUpButton[];
    disabled?: boolean;
    /** utils/db.ts treasuryTakeUp: the node's answer, or a thrown refusal (its `code`, `unitsLeft`, `message`). */
    send: (enterprise: string, body: TakeUpBody) => Promise<unknown>;
    /** The listing moved on (a count, a price, gone): read it again, so the keeper chooses on it as it is now. */
    onListingMoved?: () => void;
    /** The node answered a sale (released, or held with where to find it). */
    onDone: (button: TakeUpButton, answer: TakeUpAnswer) => void;
}

export function EnterpriseTakeUp({ listing, postId, title, sellerName, buttons, disabled = false, send, onListingMoved, onDone }: EnterpriseTakeUpProps) {
    const { colors } = useTheme();
    const [open, setOpen] = React.useState<TakeUpButton | null>(null);
    const [state, setState] = React.useState<ItemBoxState>(ITEM_BOX_START);
    const [refusal, setRefusal] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [request, setRequest] = React.useState<TakeUpRequest | null>(null);
    const s = React.useMemo(() => StyleSheet.create({
        list: { gap: 8, marginTop: 12 },
        button: { minHeight: 48, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' },
        buttonText: { color: colors.text.heading, fontSize: 15, fontWeight: '700', textAlign: 'center', flexShrink: 1 },
        off: { opacity: 0.6 },
        sheet: { marginTop: 12, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.app },
        title: { color: colors.text.heading, fontSize: 15, fontWeight: '800', textAlign: 'center', marginBottom: 8 },
        sentence: { color: colors.text.body, fontSize: 14, lineHeight: 20, marginBottom: 12 },
        refusal: { color: colors.feedback.danger.fg, fontSize: 13, lineHeight: 19, fontWeight: '600', marginBottom: 12 },
        row: { flexDirection: 'row', gap: 10 },
        cancel: { flex: 1, minHeight: 48, borderRadius: 10, borderWidth: 1, borderColor: colors.border.default, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
        cancelText: { color: colors.text.secondary, fontSize: 15, fontWeight: '700', textAlign: 'center' },
        confirm: { flex: 1, minHeight: 48, borderRadius: 10, backgroundColor: colors.feedback.success.solid, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
        confirmText: { color: colors.text.inverse, fontSize: 15, fontWeight: '800', textAlign: 'center' },
    }), [colors]);
    if (buttons.length === 0) return null;

    const close = () => { setOpen(null); setState(ITEM_BOX_START); setRefusal(null); setRequest(null); };
    if (!open) {
        return (
            <View style={s.list} testID="take-up-buttons">
                {buttons.map((b) => (
                    <Pressable key={b.enterprise} accessibilityRole="button" testID={`take-up-${b.enterprise}`} disabled={disabled}
                        style={[s.button, disabled && s.off]} onPress={() => { setOpen(b); setState(ITEM_BOX_START); setRefusal(null); setRequest(null); }}>
                        <Text style={s.buttonText}>{b.label}</Text>
                    </Pressable>
                ))}
            </View>
        );
    }

    const box = itemTakeUpBox(listing, state, sellerName);
    // The sheet's sentence says where the Beans go; the member's own "into trust … when you release them" does not apply.
    const shown = box ? { ...box, trust: null } : null;
    const sheet = takeUpSheet(box?.send, { stall: open.name, seller: sellerName, title });
    const canSend = !busy && !disabled && !!box?.send && !!sheet;
    const confirm = async () => {
        if (!box?.send || busy) return;
        const req = takeUpRequestFor(request, open.enterprise, postId, box.send);
        setRequest(req);
        setBusy(true);
        setRefusal(null);
        try {
            const answer = takeUpAnswerOf(await send(open.enterprise, takeUpBody(postId, box.send, req)));
            close();
            onDone(open, answer);
        } catch (e: any) {
            // The id is kept: Confirm again on the same sale is the same request, answered with the first if it went through.
            // A refusal with a code has core's line; anything else is the node's words, or the phone's own (db.ts) in the language.
            const text = takeUpRefusalText(e);
            setRefusal(typeof e?.code === 'string' ? text : signedRequestWords(text));
            if (takeUpListingMoved(e)) onListingMoved?.();
        } finally {
            setBusy(false);
        }
    };
    return (
        <View style={s.sheet} testID="take-up-sheet">
            <Text style={s.title}>{open.label}</Text>
            {shown && (
                <PerItemTakeUp listing={listing} box={shown} state={state} disabled={busy}
                    onState={(next) => { setState(next); setRefusal(null); }} />
            )}
            {!!sheet && <Text style={s.sentence} testID="take-up-sentence">{sheet.sentence}</Text>}
            {!!refusal && <Text style={s.refusal} testID="take-up-refusal" accessibilityLiveRegion="polite">{refusal}</Text>}
            <View style={s.row}>
                <Pressable accessibilityRole="button" style={s.cancel} onPress={close} disabled={busy}>
                    <Text style={s.cancelText}>{t('Cancel')}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" testID="take-up-confirm" style={[s.confirm, !canSend && s.off]} disabled={!canSend} onPress={confirm}>
                    <Text style={s.confirmText}>{busy ? t('Processing...') : t('Confirm')}</Text>
                </Pressable>
            </View>
        </View>
    );
}
