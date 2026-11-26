/**
 * "Buy for {enterprise}" on an Offer priced for each one (scratch/fable-design/DESIGN-stall-consignment-fable.md §5.6, §6
 * slice 2): a keeper takes the Offer up for the enterprise they keep, which pays the seller at once (the node's door,
 * POST /api/treasury/:treasury/take-up, holds and releases in one request). One button per enterprise kept; a tap opens the
 * count picker (the member's own box, components/PerItemTakeUp) and under it the confirm sheet's one sentence. The web's
 * components/EnterpriseTakeUp.tsx is the same, and every rule, figure and sentence is @beanpool/core enterprise-take-up.ts.
 *
 * Confirm sends exactly the total the sheet showed (`expect_c`) with a retry id. The sale is kept in the app's book of
 * unanswered sales (core takeUpUnansweredBook) from the moment it goes until the node answers: an answer that never came (an
 * abort, a dropped signal, a gateway's 5xx) says the stall may have paid already, and Confirm sends that same sale again,
 * which the node answers with the first sale, so it is never paid twice, even after Cancel or leaving the page. The count
 * picker waits until then. The node's own refusal stays in the sheet in plain words; nothing was paid on any of them. Colours
 * are the existing roles, so dark mode comes with them. Drawn in place inside the page's ScrollView (never a Modal of its
 * own, so no keyboard provider here).
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
    ITEM_BOX_START, itemTakeUpBox, takeUpAnswerOf, takeUpConfirm, takeUpListingMoved, takeUpLostLine, takeUpOutcomeOf, takeUpRefusalText,
    takeUpSettle, takeUpSheet, takeUpUnansweredBook, t,
    type ItemBoxState, type TakeUpAnswer, type TakeUpBody, type TakeUpButton, type TakeUpRequest, type TakeUpUnansweredBook,
} from '@beanpool/core';
import { useTheme } from '../app/ThemeContext';
import { PerItemTakeUp } from './PerItemTakeUp';
import { signedRequestWords } from './signed-request-lines';

/** Every take-up sent whose answer hasn't come back, for as long as the app runs: a closed sheet or a page left keeps them. */
const UNANSWERED = takeUpUnansweredBook();

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
    /** The listing moved on (a count, a price, gone) or an answer was lost: read it again, so the keeper sees it as it is now. */
    onListingMoved?: () => void;
    /** The node answered a sale (released, or held with where to find it). */
    onDone: (button: TakeUpButton, answer: TakeUpAnswer) => void;
    /** The book of unanswered sales; the app's own unless a test hands one in. */
    unanswered?: TakeUpUnansweredBook;
}

export function EnterpriseTakeUp({ listing, postId, title, sellerName, buttons, disabled = false, send, onListingMoved, onDone, unanswered = UNANSWERED }: EnterpriseTakeUpProps) {
    const { colors } = useTheme();
    const [open, setOpen] = React.useState<TakeUpButton | null>(null);
    const [state, setState] = React.useState<ItemBoxState>(ITEM_BOX_START);
    const [refusal, setRefusal] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    const [request, setRequest] = React.useState<TakeUpRequest | null>(null);
    // The book is the app's, not this screen's: drawn again when a Confirm finds it changed since the last draw.
    const [, redraw] = React.useReducer((n: number) => n + 1, 0);
    const s = React.useMemo(() => StyleSheet.create({
        list: { gap: 8, marginTop: 12 },
        button: { minHeight: 48, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.card, alignItems: 'center', justifyContent: 'center' },
        buttonText: { color: colors.text.heading, fontSize: 15, fontWeight: '700', textAlign: 'center', flexShrink: 1 },
        off: { opacity: 0.6 },
        sheet: { marginTop: 12, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.border.default, backgroundColor: colors.surface.app },
        title: { color: colors.text.heading, fontSize: 15, fontWeight: '800', textAlign: 'center', marginBottom: 8 },
        sentence: { color: colors.text.body, fontSize: 14, lineHeight: 20, marginBottom: 12 },
        refusal: { color: colors.feedback.danger.fg, fontSize: 13, lineHeight: 19, fontWeight: '600', marginBottom: 12 },
        // Money and caution are amber (feedback.warning): an answer that never came is not a refusal.
        lost: { color: colors.feedback.warning.fg, fontSize: 13, lineHeight: 19, fontWeight: '600', marginBottom: 12 },
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

    // A sale sent for this enterprise and listing whose answer hasn't come back: Confirm sends it again exactly, and the count
    // picker waits, so nothing else can be bought here until the node says whether that one went through.
    const kept = unanswered.get(open.enterprise, postId);
    const box = kept ? null : itemTakeUpBox(listing, state, sellerName);
    // The sheet's sentence says where the Beans go; the member's own "into trust … when you release them" does not apply.
    const shown = box ? { ...box, trust: null } : null;
    const sheet = takeUpSheet(box?.send, { stall: open.name, seller: sellerName, title });
    const sentence = kept ? kept.sentence : sheet?.sentence ?? null;
    const canSend = !busy && !disabled && (!!kept || (!!box?.send && !!sheet));
    const confirm = async () => {
        if (busy) return;
        const go = takeUpConfirm({ book: unanswered, request, enterprise: open.enterprise, postId, send: box?.send, sentence: sheet?.sentence });
        if (!go) { redraw(); return; }
        setRequest(go.request);
        setBusy(true);
        setRefusal(null);
        // Kept from the moment it goes: a page left and opened again before the answer finds it, and sends it again, not a new one.
        unanswered.keep(go.sale);
        let answer: TakeUpAnswer;
        try {
            answer = takeUpAnswerOf(await send(open.enterprise, go.sale.body));
        } catch (e: any) {
            const outcome = takeUpOutcomeOf(e);
            takeUpSettle(unanswered, go, outcome);
            // A lost answer is never shown as a refusal: the kept sale's line says it may have gone through (drawn below).
            // A refusal with a code has core's line; anything else is the node's words, or the phone's own (db.ts) in the language.
            const text = takeUpRefusalText(e);
            setRefusal(outcome === 'lost' ? null : typeof e?.code === 'string' ? text : signedRequestWords(text));
            if (outcome === 'lost' || (outcome === 'refused' && takeUpListingMoved(e))) onListingMoved?.();
            return;
        } finally {
            setBusy(false);
        }
        // The node answered: forgotten here, outside the catch, so nothing the page does next can put it back as unanswered.
        takeUpSettle(unanswered, go, 'answered');
        close();
        onDone(open, answer);
    };
    return (
        <View style={s.sheet} testID="take-up-sheet">
            <Text style={s.title}>{open.label}</Text>
            {shown && (
                <PerItemTakeUp listing={listing} box={shown} state={state} disabled={busy}
                    onState={(next) => { setState(next); setRefusal(null); }} />
            )}
            {!!sentence && <Text style={s.sentence} testID="take-up-sentence">{sentence}</Text>}
            {!!kept && !busy && (
                <Text style={s.lost} testID="take-up-lost" accessibilityLiveRegion="polite">{takeUpLostLine({ stall: open.name, seller: sellerName })}</Text>
            )}
            {!!refusal && <Text style={s.refusal} testID="take-up-refusal" accessibilityLiveRegion="polite">{refusal}</Text>}
            <View style={s.row}>
                <Pressable accessibilityRole="button" testID="take-up-cancel" style={s.cancel} onPress={close} disabled={busy}>
                    <Text style={s.cancelText}>{t('Cancel')}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" testID="take-up-confirm" style={[s.confirm, !canSend && s.off]} disabled={!canSend} onPress={confirm}>
                    <Text style={s.confirmText}>{busy ? t('Processing...') : t('Confirm')}</Text>
                </Pressable>
            </View>
        </View>
    );
}
