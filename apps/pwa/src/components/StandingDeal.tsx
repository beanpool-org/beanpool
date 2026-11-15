/**
 * A standing deal on the web (DESIGN-standing-deals-fable §2.2; slice S2, with the phone's components/StandingDeal.tsx): the
 * take-up screen a payer agrees on, and the panel each side sees while it runs. Every line is core's (standingTakeUpLines,
 * standingPanel, standingStopConfirm), so the two apps say the same thing; these only draw them.
 */
import { useState } from 'react';
import {
    STANDING_PICK_DAYS, STANDING_PICK_MAX, formatDate, standingChangeId, standingPanel, standingSheet, standingStartAt, standingStopConfirm,
    standingTakeUpLines, standingTypedAmount, t,
    type StandingDealRow, type StandingPeriodUnit, type StandingSheet, type StandingSheetKind,
} from '@beanpool/core';

const day = (iso: string) => formatDate(new Date(iso), 'day-month');

/** What the payer chose: a count of periods (null: until one of them stops it) and when the first period starts (ms). */
export interface StandingChoice { periods: number | null; startsAt: number }

const RADIO = 'flex items-center gap-2 min-h-[44px] text-sm text-nature-900 dark:text-white';
const STEP = 'w-11 h-11 shrink-0 rounded-lg border border-nature-300 dark:border-nature-700 text-nature-800 dark:text-nature-100 font-bold disabled:opacity-40';
const QUIET = 'flex-1 min-h-[44px] py-2 px-2 rounded-lg border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-900 text-nature-700 dark:text-nature-200 font-bold text-sm hover:bg-nature-100 dark:hover:bg-nature-800 disabled:opacity-60 break-words';

/**
 * Take this up? (§2.2): how long (until stopped, or for k periods) and when it starts (today, or up to 30 days ahead), what is
 * held now and how it runs, then Agree. `now` is for tests.
 */
export function StandingTakeUp({ unit, beans, title, payeeName, busy, onCancel, onAgree, now, room }: {
    unit: StandingPeriodUnit; beans: number; title: string; payeeName: string; busy: boolean;
    onCancel: () => void; onAgree: (choice: StandingChoice) => void; now?: number;
    /** The payer's usable room (balance less their usable floor), when known: short of the first period, Agree is disabled. */
    room?: number | null;
}) {
    const [untilStopped, setUntilStopped] = useState(true);
    const [periods, setPeriods] = useState(6);
    const [later, setLater] = useState(false);
    const [daysAhead, setDaysAhead] = useState(1);
    // The start is worked out again at Agree: the node refuses one more than 10 minutes old (checkStandingStart), and a member
    // may tap it long after the screen opened. The lines show the start as of now.
    const startAt = () => standingStartAt(now ?? Date.now(), later ? daysAhead : 0);
    const l = standingTakeUpLines({ unit, beans, title, payeeName, startsAt: startAt(), periods, room }, day);
    return (
        <div data-testid="standing-take-up" className="bg-oat-50 dark:bg-nature-950 border border-nature-200 dark:border-nature-800 rounded-xl p-4 shadow-inner mt-2 flex flex-col gap-3">
            <p className="font-bold text-nature-900 dark:text-white text-center text-sm">{l.title}</p>
            <p dir="auto" className="text-sm text-nature-700 dark:text-nature-300 text-center break-words">{l.summary}</p>
            <fieldset className="flex flex-col min-w-0">
                <legend className="text-xs font-bold text-nature-600 dark:text-nature-400 uppercase tracking-wider mb-1">{l.howLong}</legend>
                <label className={RADIO}>
                    <input type="radio" name="standing-length" checked={untilStopped} onChange={() => setUntilStopped(true)} />
                    <span>{l.untilStopped}</span>
                </label>
                <div className="flex flex-wrap items-center gap-2">
                    <label className={RADIO}>
                        <input type="radio" name="standing-length" checked={!untilStopped} onChange={() => setUntilStopped(false)} />
                        <span data-testid="standing-periods">{l.forPeriods}</span>
                    </label>
                    {!untilStopped && (
                        <span className="flex gap-2">
                            <button type="button" className={STEP} aria-label={l.fewer} disabled={periods <= 1} onClick={() => setPeriods(p => Math.max(1, p - 1))}>−</button>
                            <button type="button" className={STEP} aria-label={l.more} disabled={periods >= STANDING_PICK_MAX} onClick={() => setPeriods(p => Math.min(STANDING_PICK_MAX, p + 1))}>+</button>
                        </span>
                    )}
                </div>
            </fieldset>
            <fieldset className="flex flex-col min-w-0">
                <legend className="text-xs font-bold text-nature-600 dark:text-nature-400 uppercase tracking-wider mb-1">{l.startLabel}</legend>
                <label className={RADIO}>
                    <input type="radio" name="standing-start" checked={!later} onChange={() => setLater(false)} />
                    <span>{l.startToday}</span>
                </label>
                <div className="flex flex-wrap items-center gap-2">
                    <label className={RADIO}>
                        <input type="radio" name="standing-start" checked={later} onChange={() => setLater(true)} />
                        <span data-testid="standing-start-on">{later ? l.startOn : l.startAhead}</span>
                    </label>
                    {later && (
                        <span className="flex gap-2">
                            <button type="button" className={STEP} aria-label={l.earlier} disabled={daysAhead <= 1} onClick={() => setDaysAhead(d => Math.max(1, d - 1))}>−</button>
                            <button type="button" className={STEP} aria-label={l.later} disabled={daysAhead >= STANDING_PICK_DAYS} onClick={() => setDaysAhead(d => Math.min(STANDING_PICK_DAYS, d + 1))}>+</button>
                        </span>
                    )}
                </div>
            </fieldset>
            <div className="text-xs text-nature-700 dark:text-nature-300 bg-white dark:bg-nature-900 py-3 px-3 rounded-lg border border-nature-100 dark:border-nature-800 flex flex-col gap-2">
                <p data-testid="standing-held-now" className="font-bold">{l.paidNow}</p>
                <p>{l.howItRuns}</p>
                <p>{l.shortAhead}</p>
                <p data-testid="standing-ask-lower-hint">{l.askLower}</p>
            </div>
            {l.noRoom && <p data-testid="standing-no-room" role="status" className="text-sm font-bold text-bp-ink-warning text-center break-words">{l.noRoom}</p>}
            <div className="flex gap-2">
                <button type="button" onClick={onCancel} disabled={busy} className={QUIET}>{t('Cancel')}</button>
                <button type="button" data-testid="standing-agree" disabled={busy || !!l.noRoom}
                    onClick={() => onAgree({ periods: untilStopped ? null : periods, startsAt: startAt() })}
                    className="flex-1 min-h-[44px] py-2 px-2 rounded-lg font-bold text-bp-commit-on text-sm bg-bp-commit-fill hover:bg-bp-commit-hover disabled:opacity-60 break-words">
                    {l.agree}
                </button>
            </div>
        </div>
    );
}

/**
 * A short week's step as the panel hands it to its page, which sends it (DESIGN-getting-paid-fable §3.1: the node's
 * POST /api/marketplace/standing/:id/lower, …/lower/:changeId/answer, …/withdraw). It resolves once the node has said yes,
 * or throws an Error whose message is the refusal in words: the panel shows it and says nothing happened that didn't.
 */
export type StandingLowerStep =
    | { move: 'lower'; standingId: string; changeId: string; periodNo: number; beans_c: number }
    | { move: 'answer'; standingId: string; changeId: string; yes: boolean }
    | { move: 'withdraw'; standingId: string; changeId: string };

const REFUSAL = 'text-sm font-bold text-bp-ink-warning break-words';
const GO = 'flex-1 min-h-[44px] py-2 px-2 rounded-lg font-bold text-bp-commit-on text-sm bg-bp-commit-fill hover:bg-bp-commit-hover disabled:opacity-60 break-words';

/**
 * One lowering sheet (design §3.2), drawn from core's lines (standingSheet), as on the phone: the payer's ask and the
 * payee's lowering offer half, 0 and "Another amount"; the payee's answer, Yes or No. A refusal stays on the sheet.
 */
function LowerSheet({ sheet, busy, error, onGo, onNo, onCancel, onMessage, messageLabel }: {
    sheet: StandingSheet; busy: boolean; error: string | null; onGo: (beans_c: number) => void; onNo: () => void; onCancel: () => void;
    onMessage?: () => void; messageLabel?: string;
}) {
    const [pick, setPick] = useState<number | 'other'>(sheet.choices.length ? 0 : 'other');
    const [typed, setTyped] = useState('');
    const typedAmount = standingTypedAmount(typed, sheet.amount_c, sheet.unit);
    const chosen = sheet.kind === 'answer' ? sheet.askBeans_c
        : pick === 'other' ? (typedAmount.ok ? typedAmount.beans_c : null) : sheet.choices[pick]?.beans_c ?? null;
    const off = busy || chosen === null;
    const cancel = <button type="button" data-testid="standing-sheet-cancel" className={QUIET} disabled={busy} onClick={onCancel}>{sheet.cancel}</button>;
    const name = `standing-lower-${sheet.standingId}`;
    return (
        <div data-testid={`standing-sheet-${sheet.kind}`} role="group" aria-label={sheet.title}
            className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-700 rounded-lg p-3 flex flex-col gap-3">
            <p className="font-bold text-nature-900 dark:text-white text-center text-sm break-words">{sheet.title}</p>
            <p dir="auto" className="text-sm text-nature-700 dark:text-nature-300 text-center break-words">{sheet.about}</p>
            {sheet.instead && <p data-testid="standing-sheet-instead" className="text-base font-bold text-nature-900 dark:text-white text-center break-words">{sheet.instead}</p>}
            {sheet.kind !== 'answer' && (
                <fieldset className="flex flex-col min-w-0">
                    <legend className="sr-only">{sheet.title}</legend>
                    {sheet.choices.map((c, i) => (
                        <label key={c.beans_c} className={RADIO}>
                            <input type="radio" name={name} data-testid={`standing-choice-${c.beans_c}`} checked={pick === i} onChange={() => setPick(i)} />
                            <span className="break-words min-w-0">{c.label}</span>
                        </label>
                    ))}
                    {sheet.otherLabel && (
                        <label className={RADIO}>
                            <input type="radio" name={name} data-testid="standing-choice-other" checked={pick === 'other'} onChange={() => setPick('other')} />
                            <span className="break-words min-w-0">{sheet.otherLabel}</span>
                        </label>
                    )}
                    {pick === 'other' && (
                        <input type="text" inputMode="decimal" data-testid="standing-other-amount" aria-label={sheet.otherLabel || undefined} value={typed}
                            onChange={(e) => setTyped(e.target.value)}
                            className="min-h-[44px] w-full rounded-lg border border-nature-300 dark:border-nature-700 bg-oat-50 dark:bg-nature-950 text-nature-900 dark:text-white px-3 text-base" />
                    )}
                    {pick === 'other' && !typedAmount.ok && typedAmount.line && <p data-testid="standing-other-refusal" role="status" className={`${REFUSAL} mt-1`}>{typedAmount.line}</p>}
                </fieldset>
            )}
            <div className="text-xs text-nature-700 dark:text-nature-300 bg-oat-50 dark:bg-nature-950 py-3 px-3 rounded-lg border border-nature-100 dark:border-nature-800 flex flex-col gap-2">
                {sheet.lines.map((line) => <p key={line} className="break-words">{line}</p>)}
            </div>
            {error && <p data-testid="standing-sheet-refusal" role="alert" className={REFUSAL}>{error}</p>}
            <div className="flex flex-wrap gap-2">
                {sheet.kind === 'answer'
                    ? <button type="button" data-testid="standing-sheet-no" className={QUIET} disabled={busy} onClick={onNo}>{sheet.no}</button>
                    : cancel}
                <button type="button" data-testid="standing-sheet-go" className={GO} disabled={off} onClick={() => { if (chosen !== null) onGo(chosen); }}>
                    {sheet.go(chosen ?? sheet.amount_c)}
                </button>
            </div>
            {sheet.kind === 'answer' && (
                <div className="flex flex-wrap gap-2">
                    {onMessage && messageLabel && <button type="button" className={QUIET} disabled={busy} onClick={onMessage}>{messageLabel}</button>}
                    {cancel}
                </div>
            )}
        </div>
    );
}

/**
 * One standing deal still running, for one of its sides (`actingAs`: the member, or the enterprise they keep): since when and
 * for how much, where it is now (the payer's short-funds banner names the day the grace ends), and Stop and Message where
 * core says so. Stop asks first, in core's words for this side and phase. Nothing of a standing deal is held, so it has no
 * Release, Cancel or Hold back (DESIGN-standing-deals-upfront-fable §3). A short week (DESIGN-getting-paid-fable §3.2): the
 * quiet link under the status opens the payer's ask or the payee's lowering, and the open ask's line carries Take it back or
 * Answer, each from core (standingPanel, standingSheet), only where the page gives `onLower` and the node takes a lowering.
 */
export function StandingPanel({ tx, actingAs, busy, onStop, onMessage, messageLabel, onLower }: {
    tx: StandingDealRow; actingAs: string; busy: boolean;
    onStop: () => void; onMessage?: () => void; messageLabel?: string;
    onLower?: (step: StandingLowerStep) => Promise<void>;
}) {
    const [open, setOpen] = useState<{ kind: StandingSheetKind; changeId: string } | null>(null);
    const [sending, setSending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const p = standingPanel(tx, actingAs, day);
    if (!p) return null;
    const ask = () => {
        const c = standingStopConfirm(tx, actingAs, day);
        const question = [c.title, c.body].join('\n\n');
        if (window.confirm(question)) onStop();
    };
    // Worked out again from the row on every draw: a read that pays the period or closes the ask closes the sheet.
    const sheet = open && onLower ? standingSheet(tx, actingAs, open.kind, day) : null;
    const send = async (step: StandingLowerStep) => {
        if (!onLower || sending) return;
        setSending(true);
        setError(null);
        try {
            await onLower(step);
            setOpen(null);
        } catch (e: any) {
            setError(typeof e?.message === 'string' && e.message ? e.message : t('Try again'));
        } finally {
            setSending(false);
        }
    };
    // One change id per sheet opened, sent again on a retry, so a lost answer never makes a second ask.
    const openSheet = (kind: StandingSheetKind) => { setError(null); setOpen({ kind, changeId: standingChangeId() }); };
    const off = busy || sending;
    const askAction = p.askAction;
    return (
        <div data-testid={`standing-panel-${tx.id}`} data-phase={p.phase} data-role={p.role}
            className={`mt-4 rounded-xl p-4 border flex flex-col gap-2 ${p.warning
                ? 'bg-amber-50 dark:bg-amber-950/30 border-amber-300 dark:border-amber-700'
                : 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800'}`}>
            <p className="font-bold text-sm text-nature-900 dark:text-white break-words">{p.title}</p>
            <p data-testid="standing-status" role={p.warning ? 'alert' : undefined}
                className={`text-sm break-words ${p.warning ? 'font-bold text-amber-800 dark:text-amber-300' : 'text-nature-700 dark:text-nature-300'}`}>
                {p.status}
            </p>
            {onLower && p.askLine && (
                <div className="flex flex-col gap-1 items-start">
                    <p data-testid="standing-ask-line" className="text-sm font-semibold text-nature-900 dark:text-white break-words">{p.askLine}</p>
                    {askAction && !sheet && (
                        <button type="button" data-testid={`standing-ask-${askAction.move}`} disabled={off}
                            className="min-h-[44px] py-2 px-4 rounded-lg border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-900 text-nature-700 dark:text-nature-200 font-bold text-sm hover:bg-nature-100 dark:hover:bg-nature-800 disabled:opacity-60 break-words"
                            onClick={() => {
                                if (askAction.move === 'answer') openSheet('answer');
                                else if (tx.standingAsk && tx.standingId) send({ move: 'withdraw', standingId: tx.standingId, changeId: tx.standingAsk.id });
                            }}>
                            {askAction.label}
                        </button>
                    )}
                </div>
            )}
            {onLower && p.lowerLink && !sheet && (
                <button type="button" data-testid="standing-lower-link" disabled={off} onClick={() => openSheet(p.role === 'payee' ? 'lower' : 'ask')}
                    className="w-full min-h-[48px] text-left text-sm font-bold underline text-nature-900 dark:text-white disabled:opacity-60 break-words">
                    {p.lowerLink}
                </button>
            )}
            {error && !sheet && <p data-testid="standing-step-refusal" role="alert" className={REFUSAL}>{error}</p>}
            {sheet && open && (
                <LowerSheet key={open.changeId} sheet={sheet} busy={off} error={error}
                    onGo={(beans_c) => send(sheet.kind === 'answer'
                        ? { move: 'answer', standingId: sheet.standingId, changeId: sheet.askId!, yes: true }
                        : { move: 'lower', standingId: sheet.standingId, changeId: open.changeId, periodNo: sheet.periodNo, beans_c })}
                    onNo={() => send({ move: 'answer', standingId: sheet.standingId, changeId: sheet.askId!, yes: false })}
                    onCancel={() => { setOpen(null); setError(null); }}
                    onMessage={onMessage} messageLabel={messageLabel} />
            )}
            {p.lastLine && <p className="text-xs text-nature-600 dark:text-nature-400 break-words">{p.lastLine}</p>}
            {p.periodOf && <p className="text-xs font-semibold text-nature-600 dark:text-nature-400">{p.periodOf}</p>}
            {(p.stop || onMessage) && !sheet && (
                <div className="flex flex-wrap gap-2 mt-1">
                    {p.stop && <button type="button" data-testid="standing-stop" className={QUIET} disabled={off} onClick={ask}>{p.stopLabel}</button>}
                    {onMessage && messageLabel && <button type="button" className={QUIET} disabled={off} onClick={onMessage}>{messageLabel}</button>}
                </div>
            )}
        </div>
    );
}
