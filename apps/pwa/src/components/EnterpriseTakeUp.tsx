/**
 * "Buy for {enterprise}" on an Offer priced for each one (scratch/fable-design/DESIGN-stall-consignment-fable.md §5.6, §6
 * slice 2): a keeper takes the Offer up for the enterprise they keep, which pays the seller at once (the node's door,
 * POST /api/treasury/:treasury/take-up, holds and releases in one request). One button per enterprise kept; a tap opens the
 * count picker (the member's own box, components/PerItemTakeUp) and under it the confirm sheet's one sentence. The phone's
 * components/EnterpriseTakeUp.tsx is the same, and every rule, figure and sentence is @beanpool/core enterprise-take-up.ts.
 *
 * Confirm sends exactly the total the sheet showed (`expect_c`) with a retry id. The sale is kept in the app's book of
 * unanswered sales (core takeUpUnansweredBook) from the moment it goes until the node answers: an answer that never came
 * ("Failed to fetch", "Load failed", a gateway's 5xx) says the stall may have paid already, and Confirm sends that same sale
 * again, which the node answers with the first sale, so it is never paid twice, even after Cancel or closing the listing. The
 * count picker waits until then. The node's own refusal stays in the sheet in plain words; nothing was paid on any of them.
 * Neutral greys, the commit green and the warning ink only, so dark mode comes with them.
 */
import { useReducer, useState } from 'react';
import {
    ITEM_BOX_START, itemTakeUpBox, takeUpAnswerOf, takeUpConfirm, takeUpListingMoved, takeUpLostLine, takeUpOutcomeOf, takeUpRefusalText,
    takeUpSettle, takeUpSheet, takeUpUnansweredBook, t,
    type ItemBoxState, type TakeUpAnswer, type TakeUpBody, type TakeUpButton, type TakeUpRequest, type TakeUpUnansweredBook,
} from '@beanpool/core';
import { PerItemTakeUp } from './PerItemTakeUp';

/** Every take-up sent whose answer hasn't come back, for as long as the page runs: a closed sheet or listing keeps them. */
const UNANSWERED = takeUpUnansweredBook();

export interface EnterpriseTakeUpProps {
    /** The listing as the page holds it (core perItemOf reads the web's post). */
    listing: unknown;
    postId: string;
    title: string;
    sellerName: string;
    /** core takeUpButtons: one per enterprise the reader keeps, only where the node has the door. */
    buttons: readonly TakeUpButton[];
    disabled?: boolean;
    /** lib/api.ts treasuryTakeUp: the node's answer, or a thrown refusal (its `code`, `unitsLeft`, `message`). */
    send: (enterprise: string, body: TakeUpBody) => Promise<unknown>;
    /** The listing moved on (a count, a price, gone) or an answer was lost: read it again, so the keeper sees it as it is now. */
    onListingMoved?: () => void;
    /** The node answered a sale (released, or held with where to find it). */
    onDone: (button: TakeUpButton, answer: TakeUpAnswer) => void;
    /** The book of unanswered sales; the page's own unless a test hands one in. */
    unanswered?: TakeUpUnansweredBook;
}

const SECONDARY = 'w-full min-h-[48px] py-2.5 px-3 rounded-lg border border-nature-300 dark:border-nature-600 bg-white dark:bg-nature-900 text-nature-900 dark:text-white font-bold text-sm break-words hover:bg-nature-100 dark:hover:bg-nature-800 disabled:opacity-60 disabled:cursor-not-allowed';

export function EnterpriseTakeUp({ listing, postId, title, sellerName, buttons, disabled = false, send, onListingMoved, onDone, unanswered = UNANSWERED }: EnterpriseTakeUpProps) {
    const [open, setOpen] = useState<TakeUpButton | null>(null);
    const [state, setState] = useState<ItemBoxState>(ITEM_BOX_START);
    const [refusal, setRefusal] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [request, setRequest] = useState<TakeUpRequest | null>(null);
    // The book is the page's, not this sheet's: drawn again when a Confirm finds it changed since the last draw.
    const [, redraw] = useReducer((n: number) => n + 1, 0);
    if (buttons.length === 0) return null;

    const close = () => { setOpen(null); setState(ITEM_BOX_START); setRefusal(null); setRequest(null); };
    if (!open) {
        return (
            <div data-testid="take-up-buttons" className="flex flex-col gap-2 mt-3">
                {buttons.map((b) => (
                    <button key={b.enterprise} type="button" data-testid={`take-up-${b.enterprise}`} className={SECONDARY} disabled={disabled}
                        onClick={() => { setOpen(b); setState(ITEM_BOX_START); setRefusal(null); setRequest(null); }}>
                        {b.label}
                    </button>
                ))}
            </div>
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
        // Kept from the moment it goes: a listing closed and opened again before the answer finds it, and sends it again.
        unanswered.keep(go.sale);
        try {
            const answer = takeUpAnswerOf(await send(open.enterprise, go.sale.body));
            takeUpSettle(unanswered, go, 'answered');
            close();
            onDone(open, answer);
        } catch (e) {
            const outcome = takeUpOutcomeOf(e);
            takeUpSettle(unanswered, go, outcome);
            // A lost answer is never shown as a refusal: the kept sale's line says it may have gone through (drawn below).
            setRefusal(outcome === 'lost' ? null : takeUpRefusalText(e));
            if (outcome === 'lost' || (outcome === 'refused' && takeUpListingMoved(e))) onListingMoved?.();
        } finally {
            setBusy(false);
        }
    };
    return (
        <div data-testid="take-up-sheet" className="bg-oat-50 dark:bg-nature-950 border border-nature-200 dark:border-nature-800 rounded-xl p-4 shadow-inner mt-3">
            <p className="font-bold text-nature-900 dark:text-white mb-2 text-center text-sm break-words">{open.label}</p>
            {shown && (
                <PerItemTakeUp listing={listing} box={shown} state={state} disabled={busy}
                    onState={(next) => { setState(next); setRefusal(null); }} />
            )}
            {sentence && <p data-testid="take-up-sentence" className="m-0 mb-3 text-[14px] leading-snug text-nature-900 dark:text-white break-words">{sentence}</p>}
            {kept && !busy && (
                <p data-testid="take-up-lost" role="status" className="m-0 mb-3 text-[13px] leading-snug text-bp-ink-warning font-semibold break-words">
                    {takeUpLostLine({ stall: open.name, seller: sellerName })}
                </p>
            )}
            {refusal && <p data-testid="take-up-refusal" role="alert" className="m-0 mb-3 text-[13px] leading-snug text-bp-ink-danger font-semibold break-words">{refusal}</p>}
            <div className="flex gap-2">
                <button type="button" data-testid="take-up-cancel" onClick={close} disabled={busy}
                    className="flex-1 min-h-[48px] py-2.5 rounded-lg border border-nature-200 dark:border-nature-700 text-nature-600 dark:text-nature-300 font-bold hover:bg-nature-100 dark:hover:bg-nature-800 transition-colors text-sm">
                    {t('Cancel')}
                </button>
                <button type="button" data-testid="take-up-confirm" onClick={confirm} disabled={!canSend}
                    className="flex-1 min-h-[48px] py-2.5 rounded-lg font-bold text-bp-commit-on text-sm transition-all shadow-sm bg-bp-commit-fill hover:bg-bp-commit-hover disabled:cursor-not-allowed disabled:opacity-60">
                    {busy ? t('Processing...') : t('Confirm')}
                </button>
            </div>
        </div>
    );
}
