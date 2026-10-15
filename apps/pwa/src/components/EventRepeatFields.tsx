/**
 * The create/edit form's "Repeats" select and "Until" date (DESIGN-event-times §3, §8). The choices are computed from the
 * first date the host picked (@beanpool/core repeatChoicesFor), so there is nothing to type, and the phone offers the same
 * words. Until is optional (empty = until the host cancels it), on or after the first date and at most five years out.
 *
 * A date as long as the gap to the next one is said before Save, in the node's own sentence ("An event that repeats must
 * end before its next date starts"). A stored rule the form cannot make ('other': every 3 weeks, every 3 months) is named
 * in a plain line, "Every 3 months on the 16th — kept unless you choose another": an edit that leaves it and the first date
 * alone keeps it (nothing about the series is sent), and one that moves the date asks for a choice in red, never re-sending
 * a different rule (the deciding review of #1993, N3 and N7; its confirmation, NB1).
 */

import { repeatCaption, repeatChoicesFor, repeatLengthProblem, repeatSkipNote, repeatUntilMax, repeatUntilProblem, t, type RepeatChoiceKey, type RepeatPattern } from '@beanpool/core';

/** Wall minutes from a form's Starts to its Ends ("YYYY-MM-DDTHH:MM"); a blank end is the node's two hours. NaN if unreadable. */
export function eventFormMinutes(start: string, end: string): number {
    const at = (v: string) => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)
        ? Date.UTC(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10), +v.slice(11, 13), +v.slice(14, 16)) : NaN);
    if (!end) return Number.isFinite(at(start)) ? 120 : NaN;
    return Math.round((at(end) - at(start)) / 60_000);
}

/** A rule the edit keeps as it is: the choice it had, on the first date it had, and the rule itself for its words (null when creating). */
export interface KeptRepeat { repeat: RepeatChoiceKey; firstDate: string; rule?: Partial<RepeatPattern> | null }

/** Whether the choice is a rule the form can't make, left on the first date it had: kept as it is, not an error. */
function keptAsItIs(repeat: RepeatChoiceKey, firstDate: string, kept: KeptRepeat | null | undefined): boolean {
    return repeat === 'other' && kept?.repeat === 'other' && kept.firstDate === firstDate;
}

/** Why the Repeats/Until rows cannot be saved as they are, or null. */
export function eventRepeatProblem(start: string, repeat: RepeatChoiceKey, until: string, end = '', kept: KeptRepeat | null = null): 'repeat' | 'length' | 'until' | null {
    if (repeat === 'never') return null;
    const firstDate = start.slice(0, 10);
    // A rule the form can't make, untouched on its own date: the edit sends nothing about it, so the node keeps it; its
    // Until is still the host's to change.
    if (keptAsItIs(repeat, firstDate, kept)) return repeatUntilProblem(until, firstDate) ? 'until' : null;
    if (!repeatChoicesFor(firstDate).some(c => c.key === repeat)) return 'repeat';
    if (repeatLengthProblem(repeat, firstDate, eventFormMinutes(start, end))) return 'length';
    return repeatUntilProblem(until, firstDate) ? 'until' : null;
}

interface Props {
    /** The form's Starts value, "YYYY-MM-DDTHH:MM" ('' before one is picked). */
    start: string;
    /** The form's Ends value ('' = the node's two hours), for the length check. */
    end?: string;
    repeat: RepeatChoiceKey;
    until: string;
    onRepeatChange: (key: RepeatChoiceKey) => void;
    onUntilChange: (date: string) => void;
    /** On an edit: the rule as stored, so one the form can't make is named and kept (null when creating). */
    kept?: KeptRepeat | null;
}

const LABEL = 'block text-xs font-bold text-nature-600 dark:text-nature-300 uppercase tracking-wider mb-1';
const FIELD = 'w-full min-w-0 py-3 px-4 rounded-xl border bg-white dark:bg-nature-800 text-nature-900 dark:text-white text-[15px] focus:outline-none focus:ring-2 focus:ring-violet-300 shadow-sm';
const PROBLEM = 'm-0 mt-1 text-xs font-semibold text-bp-ink-danger';

export function EventRepeatFields({ start, end = '', repeat, until, onRepeatChange, onUntilChange, kept = null }: Props) {
    const firstDate = start.slice(0, 10);
    const choices = repeatChoicesFor(firstDate);
    // A choice the new first date does not offer (the last Friday, moved to the 16th) stays chosen and says so, rather
    // than turning into "Does not repeat" behind the host's back.
    const offered = choices.some(c => c.key === repeat);
    // A rule the form can't make, on its own date: said in words and kept, in plain text; red only once the date moves.
    const keptWords = keptAsItIs(repeat, firstDate, kept) ? repeatCaption(kept?.rule) : '';
    const asks = !offered && !keptWords;
    const note = offered ? repeatSkipNote(repeat, firstDate) : null;
    const lengthProblem = offered ? repeatLengthProblem(repeat, firstDate, eventFormMinutes(start, end)) : null;
    const untilProblem = repeat !== 'never' && (offered || !!keptWords) ? repeatUntilProblem(until, firstDate) : null;
    return (
        <div data-testid="event-repeat-fields" className="flex flex-col gap-3 min-w-0">
            <div className="min-w-0">
                <label htmlFor="event-repeat" className={LABEL}>{t('Repeats')}</label>
                <select
                    id="event-repeat"
                    data-testid="event-repeat-select"
                    value={repeat}
                    onChange={e => onRepeatChange(e.target.value as RepeatChoiceKey)}
                    className={`${FIELD} ${!asks && !lengthProblem ? 'border-nature-200 dark:border-nature-700' : 'border-red-400 ring-1 ring-red-400'}`}
                >
                    {!offered && <option value={repeat} disabled>{keptWords || t('Choose how the event repeats from the list')}</option>}
                    {choices.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
                {note && <p data-testid="event-repeat-note" className="m-0 mt-1 text-sm text-nature-600 dark:text-nature-300 break-words">{note}</p>}
                {!!keptWords && <p data-testid="event-repeat-kept" className="m-0 mt-1 text-sm text-nature-600 dark:text-nature-300 break-words">{t('{repeats} — kept unless you choose another', { repeats: keptWords })}</p>}
                {asks && <p data-testid="event-repeat-problem" role="alert" className={PROBLEM}>{t('Choose how the event repeats from the list')}</p>}
                {lengthProblem && <p data-testid="event-repeat-length-problem" role="alert" className={PROBLEM}>{lengthProblem}</p>}
            </div>
            {repeat !== 'never' && (
                <div className="min-w-0">
                    <label htmlFor="event-repeat-until" className={LABEL}>{t('Until (optional)')}</label>
                    <input
                        id="event-repeat-until"
                        data-testid="event-repeat-until"
                        type="date"
                        value={until}
                        min={firstDate || undefined}
                        max={repeatUntilMax(firstDate) || undefined}
                        onChange={e => onUntilChange(e.target.value)}
                        className={`${FIELD} ${untilProblem ? 'border-red-400 ring-1 ring-red-400' : 'border-nature-200 dark:border-nature-700'}`}
                    />
                    {!until && <p className="m-0 mt-1 text-sm text-nature-600 dark:text-nature-300">{t('Blank: it repeats until you cancel it.')}</p>}
                    {untilProblem && <p data-testid="event-repeat-until-problem" role="alert" className={PROBLEM}>{untilProblem}</p>}
                </div>
            )}
        </div>
    );
}
