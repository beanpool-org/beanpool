/**
 * A standing deal on the web (DESIGN-standing-deals-fable §2.2; slice S2, with the phone's components/StandingDeal.tsx): the
 * take-up screen a payer agrees on, and the panel each side sees while it runs. Every line is core's (standingTakeUpLines,
 * standingPanel, standingStopConfirm), so the two apps say the same thing; these only draw them.
 */
import { useState } from 'react';
import {
    STANDING_PICK_DAYS, STANDING_PICK_MAX, formatDate, standingPanel, standingStartAt, standingStopConfirm, standingTakeUpLines, t,
    type StandingDealRow, type StandingPeriodUnit,
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
export function StandingTakeUp({ unit, beans, title, payeeName, busy, onCancel, onAgree, now }: {
    unit: StandingPeriodUnit; beans: number; title: string; payeeName: string; busy: boolean;
    onCancel: () => void; onAgree: (choice: StandingChoice) => void; now?: number;
}) {
    const [untilStopped, setUntilStopped] = useState(true);
    const [periods, setPeriods] = useState(6);
    const [later, setLater] = useState(false);
    const [daysAhead, setDaysAhead] = useState(1);
    // The start is worked out again at Agree: the node refuses one more than 10 minutes old (checkStandingStart), and a member
    // may tap it long after the screen opened. The lines show the start as of now.
    const startAt = () => standingStartAt(now ?? Date.now(), later ? daysAhead : 0);
    const l = standingTakeUpLines({ unit, beans, title, payeeName, startsAt: startAt(), periods }, day);
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
            </div>
            <div className="flex gap-2">
                <button type="button" onClick={onCancel} disabled={busy} className={QUIET}>{t('Cancel')}</button>
                <button type="button" data-testid="standing-agree" disabled={busy}
                    onClick={() => onAgree({ periods: untilStopped ? null : periods, startsAt: startAt() })}
                    className="flex-1 min-h-[44px] py-2 px-2 rounded-lg font-bold text-bp-commit-on text-sm bg-bp-commit-fill hover:bg-bp-commit-hover disabled:opacity-60 break-words">
                    {l.agree}
                </button>
            </div>
        </div>
    );
}

/**
 * One standing deal still running, for one of its sides (`actingAs`: the member, or the enterprise they keep): since when and
 * for how much, where it is now (the payer's short-funds banner names the day the grace ends), and Stop and Message where
 * core says so. Stop asks first, in core's words for this side and phase. Nothing of a standing deal is held, so it has no
 * Release, Cancel or Hold back (DESIGN-standing-deals-upfront-fable §3).
 */
export function StandingPanel({ tx, actingAs, busy, onStop, onMessage, messageLabel }: {
    tx: StandingDealRow; actingAs: string; busy: boolean;
    onStop: () => void; onMessage?: () => void; messageLabel?: string;
}) {
    const p = standingPanel(tx, actingAs, day);
    if (!p) return null;
    const ask = () => {
        const c = standingStopConfirm(tx, actingAs, day);
        const question = [c.title, c.body].join('\n\n');
        if (window.confirm(question)) onStop();
    };
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
            {p.lastLine && <p className="text-xs text-nature-600 dark:text-nature-400 break-words">{p.lastLine}</p>}
            {p.periodOf && <p className="text-xs font-semibold text-nature-600 dark:text-nature-400">{p.periodOf}</p>}
            {(p.stop || onMessage) && (
                <div className="flex flex-wrap gap-2 mt-1">
                    {p.stop && <button type="button" data-testid="standing-stop" className={QUIET} disabled={busy} onClick={ask}>{p.stopLabel}</button>}
                    {onMessage && messageLabel && <button type="button" className={QUIET} disabled={busy} onClick={onMessage}>{messageLabel}</button>}
                </div>
            )}
        </div>
    );
}
