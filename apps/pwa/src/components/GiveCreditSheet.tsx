/**
 * "Give @Rob credit" (DESIGN-credit-list-fable.md §3.3 with amendment 1 §3.3): a sheet over the People list, so the list
 * keeps its place. No text field, so no keyboard. Three ways to give, each the app's existing writer, none new:
 *
 *   Vouch for @Rob           today's VouchPresetChoice and POST /api/vouch, exactly `{ memberPubkey, vouchAmount }` (or
 *                            `{ memberPubkey, raiseTo }` on a raise); the node's budget line; a refusal shows the node's sentence.
 *   Confirm @Rob as known    (owners and admins) the web holds no names-list key, so it says what the web always says: it is
 *                            done in the BeanPool app on your phone (core INVITE_ADDS_WORDS.doneInApp). The one deliberate
 *                            difference from the phone (the web's names list stays parked); this imports no names-list key code.
 *   Raise their known floor  (owners and admins, a confirmed member, never their own) POST /api/credit/known-floor, exactly
 *                            `{ memberPubkey, raiseTo_c }`: raise only, in 100s, up to the cap. Lowering and freezing stay in Settings.
 *
 * A giver now sees the balance, so the sheet says "below zero" or "can't be given credit" before the tap in place of a refusal
 * after it (amendment §3.3), with the presets greyed under that sentence (inert: nothing can be picked, nothing is sent); the
 * node still refuses either. After a give the person is read again from the node (never updated locally), the result is said
 * in two lines (what was given, then "Their credit line is now …"), and Next opens the next person in the list.
 */
import { useId, useRef, useState } from 'react';
import { INVITE_ADDS_WORDS, beans, formatHundredths, raiseVouchFor, t, vouchFor, vouchMaxFor } from '@beanpool/core';
import { getMyVouching, vouchForMember, type MyVouching } from '../lib/api';
import {
    CREDIT_LIST_WORDS as W, getCreditPerson, raiseKnownFloor, refusalText, type CreditPerson,
} from '../lib/credit-sight';
import { VouchPresetChoice } from './VouchPresetChoice';
import { AskForMore } from './AskForMore';
import { CreditLines } from './CreditLines';
import { useDialogFocus } from './dialog-focus';

export interface GiveCreditSheetProps {
    person: CreditPerson;
    /** The giver's own budget (GET /api/vouchers/me): a voucher's presets and what is left. Null for an admin who is no voucher. */
    myVouching: MyVouching | null;
    /** The community's known floor in hundredths (GET /api/community/known-rule); null where the community confirms no one. */
    knownFloor_c: number | null;
    /** An owner or admin reads the parts and who confirmed; a voucher does not, so the sheet offers them neither known line. */
    full: boolean;
    onClose: () => void;
    /** The person read again from the node after a give; the list's row follows it. */
    onChanged: (fresh: CreditPerson) => void;
    /** Opens the next person in the list's order, or undefined at the end. */
    onNext?: () => void;
}

const STEP_C = beans(100);

export function GiveCreditSheet({ person, myVouching, knownFloor_c, full, onClose, onChanged, onNext }: GiveCreditSheetProps) {
    const dialog = useRef<HTMLDivElement | null>(null);
    useDialogFocus(dialog, onClose);
    const titleId = useId();
    const [vouching, setVouching] = useState<MyVouching | null>(myVouching);
    const [preset, setPreset] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [refusal, setRefusal] = useState<{ text: string; code?: string } | null>(null);
    const [done, setDone] = useState<{ said: string; line: string } | null>(null);
    const [doneInApp, setDoneInApp] = useState(false);

    const name = person.callsign;
    const noLimit = vouching?.noLimit === true;
    const prior = person.youVouched_c ?? 0;
    const isRaise = prior > 0;
    const atMax = prior >= vouchMaxFor(noLimit);
    const belowZero = person.balance_c < 0;
    const mayVouch = !!vouching?.voucher && person.canGive && !belowZero && !atMax;

    // The known floor: a confirmed member's floor, raised from what they hold now, in 100s up to the cap.
    const held = person.parts?.known_c ?? 0;
    const cap = person.parts?.cap_c ?? 0;
    const confirmed = !!person.standsBehind?.confirmedBy;
    // A community with the confirmation dial off shows neither known line (design §3.3): the node's rule says whether it confirms.
    const mayRaise = full && knownFloor_c !== null && confirmed && person.canGive && cap > held && !person.frozen?.known;
    const [target, setTarget] = useState<number>(Math.min(cap, held + STEP_C));
    const raiseTarget = Math.min(cap, Math.max(held + STEP_C, target));
    const mayConfirm = full && !confirmed && person.canGive && knownFloor_c !== null && knownFloor_c > 0;

    const lineAfter = (fresh: CreditPerson) => t(W.lineNow, { line: formatHundredths(fresh.line_c) });
    // The node's own sentence for a refusal it made; a request that got no answer at all reads as offline, never as the browser's own "Failed to fetch".
    const refusalOf = (e: unknown, fallback: string) => (typeof (e as { status?: unknown } | null)?.status === 'number' ? refusalText(e, fallback) : t(W.offlineGive));

    async function vouch() {
        if (!preset) return;
        setBusy(true);
        setRefusal(null);
        setDone(null);
        try {
            // A raise posts the total it ends at, a first vouch its amount; the node lands the difference.
            const res = await vouchForMember(person.memberPubkey, isRaise ? { raiseTo: preset } : { vouchAmount: preset });
            setPreset(null);
            const fresh = (await getCreditPerson(person.memberPubkey)).person;
            onChanged(fresh);
            setDone({
                said: isRaise ? t(W.raisedVouch, { name, total: formatHundredths(res.total) }) : t(W.vouched, { amount: formatHundredths(preset), name }),
                line: lineAfter(fresh),
            });
            void getMyVouching().then(setVouching).catch(() => {});
        } catch (e) {
            // The node's sentence, shown as it is; nothing is changed in the list.
            setPreset(null);
            setRefusal({ text: refusalOf(e, t('Could not vouch.')), code: (e as { code?: string })?.code });
        } finally {
            setBusy(false);
        }
    }

    async function raise() {
        setBusy(true);
        setRefusal(null);
        setDone(null);
        try {
            const out = await raiseKnownFloor(person.memberPubkey, raiseTarget);
            const fresh = (await getCreditPerson(person.memberPubkey)).person;
            onChanged(fresh);
            setDone({ said: t(W.raised, { name, amount: formatHundredths(out.knownFloor_c) }), line: lineAfter(fresh) });
            setTarget(Math.min(fresh.parts?.cap_c ?? cap, (fresh.parts?.known_c ?? out.knownFloor_c) + STEP_C));
        } catch (e) {
            setRefusal({ text: refusalOf(e, t('Could not raise the known floor.')), code: (e as { code?: string })?.code });
        } finally {
            setBusy(false);
        }
    }

    const box = 'p-3.5 rounded-xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900';
    const heading = 'm-0 mb-2 text-sm font-bold text-nature-950 dark:text-white break-words';
    const btn = 'w-full min-h-[48px] py-2.5 px-4 rounded-xl text-sm font-bold bg-bp-commit-fill text-bp-commit-on border-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shadow-sm';
    const sentence = 'm-0 text-[13px] leading-relaxed text-nature-700 dark:text-nature-300 break-words';

    return (
        <div
            ref={dialog}
            className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/50"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            data-testid="give-credit-sheet"
            onClick={onClose}
        >
            <div
                className="w-full sm:max-w-[520px] max-h-[90vh] overflow-y-auto p-4 rounded-t-2xl sm:rounded-2xl bg-oat-50 dark:bg-nature-950 border border-nature-200 dark:border-nature-800 shadow-xl space-y-3"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-start justify-between gap-2">
                    <h2 id={titleId} tabIndex={-1} className="m-0 text-base font-extrabold text-nature-950 dark:text-white outline-none break-words min-w-0">
                        {t(W.sheetTitle, { name })}
                    </h2>
                    <button
                        type="button"
                        onClick={onClose}
                        className="min-w-[44px] min-h-[44px] shrink-0 rounded-lg flex items-center justify-center text-base text-nature-500 hover:text-nature-900 dark:hover:text-white bg-transparent border-0 cursor-pointer"
                        aria-label={t(W.close)}
                    >
                        ✕
                    </button>
                </div>

                <div className={box}>
                    <CreditLines person={person} reasons="all" />
                    {person.line_c === 0 && (person.liveOffers ?? 0) > 0 && (
                        <p className={`${sentence} mt-2`} data-testid="credit-at-once">{t(W.usedAtOnce)}</p>
                    )}
                </div>

                {/* Vouch for @Rob */}
                {vouching?.voucher && (
                    <div className={box} data-testid="give-vouch">
                        <h3 className={heading}>{isRaise ? raiseVouchFor(name) : vouchFor(name)}</h3>
                        {(belowZero || !person.canGive) && (
                            <p className={`${sentence} mb-2`} data-testid="give-blocked">{belowZero ? t(W.belowZero, { name }) : t(W.cantBeGiven, { name })}</p>
                        )}
                        {!atMax && (
                            // Below zero or unable to be given part of a line: the presets stay in view, greyed and inert (design §3.3), and no request can be sent.
                            <div inert={belowZero || !person.canGive} className={belowZero || !person.canGive ? 'opacity-40' : undefined} data-testid="give-presets">
                                <VouchPresetChoice
                                    value={preset}
                                    onChange={setPreset}
                                    budgetLeft={vouching.budget?.left ?? 0}
                                    budgetTotal={vouching.budget?.level ?? 0}
                                    noLimit={noLimit}
                                    raiseFrom={isRaise ? prior : undefined}
                                />
                                <button type="button" disabled={busy || !preset || !mayVouch} onClick={vouch} className={btn} data-testid="give-vouch-submit">
                                    {busy
                                        ? t(W.saving)
                                        : preset
                                            ? t('Vouch {amount} for @{name}', { amount: formatHundredths(preset), name })
                                            : (isRaise ? raiseVouchFor(name) : vouchFor(name))}
                                </button>
                            </div>
                        )}
                        {refusal?.code === 'not_enough' && <div className="mt-3"><AskForMore ask={vouching.ask ?? null} /></div>}
                    </div>
                )}

                {/* Confirm @Rob as known: the web's one deliberate difference, said where the tap lands. */}
                {mayConfirm && (
                    <div className={box} data-testid="give-confirm">
                        <button
                            type="button"
                            onClick={() => setDoneInApp(true)}
                            aria-describedby={doneInApp ? `${titleId}-app` : undefined}
                            className="w-full min-h-[44px] text-left bg-transparent border-0 p-0 cursor-pointer text-sm font-bold text-bp-ink-accent break-words"
                            data-testid="give-confirm-button"
                        >
                            {t(W.confirmTitle, { name })}
                            <span className="block text-xs font-medium text-nature-600 dark:text-nature-300">{t(W.confirmAdds, { floor: formatHundredths(knownFloor_c) })}</span>
                        </button>
                        {doneInApp && (
                            <p id={`${titleId}-app`} className="m-0 mt-2 rounded-xl bg-bp-chip-info-tint px-3 py-2 text-[13px] leading-relaxed text-bp-chip-info-ink break-words" data-testid="give-confirm-note">
                                {t(INVITE_ADDS_WORDS.doneInApp)}
                            </p>
                        )}
                    </div>
                )}

                {/* Raise their known floor: raise only, in 100s, up to the cap. */}
                {mayRaise && (
                    <div className={box} data-testid="give-raise">
                        <h3 className={heading}>{t(W.raiseTitle)}</h3>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => setTarget(Math.max(held + STEP_C, raiseTarget - STEP_C))}
                                disabled={raiseTarget <= held + STEP_C}
                                aria-label={t(W.raiseLess)}
                                className="min-w-[44px] min-h-[44px] rounded-xl border border-nature-300 dark:border-nature-700 bg-transparent text-lg font-bold text-nature-950 dark:text-white cursor-pointer disabled:opacity-40"
                            >
                                −
                            </button>
                            <output className="flex-1 text-center text-lg font-extrabold text-nature-950 dark:text-white" data-testid="give-raise-amount" aria-live="polite">
                                {formatHundredths(raiseTarget)}
                            </output>
                            <button
                                type="button"
                                onClick={() => setTarget(Math.min(cap, raiseTarget + STEP_C))}
                                disabled={raiseTarget >= cap}
                                aria-label={t(W.raiseMore)}
                                className="min-w-[44px] min-h-[44px] rounded-xl border border-nature-300 dark:border-nature-700 bg-transparent text-lg font-bold text-nature-950 dark:text-white cursor-pointer disabled:opacity-40"
                            >
                                +
                            </button>
                        </div>
                        <button type="button" disabled={busy} onClick={raise} className={`${btn} mt-3`} data-testid="give-raise-submit">
                            {t(W.raiseAction, { amount: formatHundredths(raiseTarget) })}
                        </button>
                    </div>
                )}

                {refusal && (
                    <p role="alert" className="m-0 p-3 rounded-xl bg-bp-chip-warn-tint text-bp-chip-warn-ink text-[13px] font-bold leading-relaxed break-words" data-testid="give-refusal">
                        {refusal.text}
                    </p>
                )}
                {done && (
                    <div role="status" className="p-3 rounded-xl bg-bp-chip-ok-tint text-bp-chip-ok-ink text-[13px] font-bold leading-relaxed break-words space-y-1" data-testid="give-done">
                        <p className="m-0">{done.said}</p>
                        <p className="m-0" data-testid="give-line">{done.line}</p>
                    </div>
                )}

                <p className={sentence}>{t(W.cantTakeBack)}</p>

                {onNext && (
                    <button type="button" onClick={onNext} className="w-full min-h-[48px] rounded-xl border border-bp-accent-fill bg-transparent text-text-primary text-sm font-bold cursor-pointer" data-testid="give-next">
                        {t(W.next)}
                    </button>
                )}
            </div>
        </div>
    );
}
