/**
 * The create/edit form's "Repeats" select and "Until" date (DESIGN-event-times §3, §8). The choices are computed from the
 * first date the host picked (@beanpool/core repeatChoicesFor), so there is nothing to type, and the phone offers the same
 * words. Until is optional (empty = until the host cancels it), on or after the first date and at most five years out.
 */

import { repeatChoicesFor, repeatSkipNote, repeatUntilMax, repeatUntilProblem, t, type RepeatChoiceKey } from '@beanpool/core';

/** Why the Repeats/Until rows cannot be saved as they are, or null. */
export function eventRepeatProblem(start: string, repeat: RepeatChoiceKey, until: string): 'repeat' | 'until' | null {
    if (repeat === 'never') return null;
    const firstDate = start.slice(0, 10);
    if (!repeatChoicesFor(firstDate).some(c => c.key === repeat)) return 'repeat';
    return repeatUntilProblem(until, firstDate) ? 'until' : null;
}

interface Props {
    /** The form's Starts value, "YYYY-MM-DDTHH:MM" ('' before one is picked). */
    start: string;
    repeat: RepeatChoiceKey;
    until: string;
    onRepeatChange: (key: RepeatChoiceKey) => void;
    onUntilChange: (date: string) => void;
}

const LABEL = 'block text-xs font-bold text-nature-600 dark:text-nature-300 uppercase tracking-wider mb-1';
const FIELD = 'w-full min-w-0 py-3 px-4 rounded-xl border bg-white dark:bg-nature-800 text-nature-900 dark:text-white text-[15px] focus:outline-none focus:ring-2 focus:ring-violet-300 shadow-sm';
const PROBLEM = 'm-0 mt-1 text-xs font-semibold text-red-600 dark:text-red-300';

export function EventRepeatFields({ start, repeat, until, onRepeatChange, onUntilChange }: Props) {
    const firstDate = start.slice(0, 10);
    const choices = repeatChoicesFor(firstDate);
    // A choice the new first date does not offer (the last Friday, moved to the 16th) stays chosen and says so, rather
    // than turning into "Does not repeat" behind the host's back.
    const offered = choices.some(c => c.key === repeat);
    const note = offered ? repeatSkipNote(repeat, firstDate) : null;
    const untilProblem = repeat !== 'never' && offered ? repeatUntilProblem(until, firstDate) : null;
    return (
        <div data-testid="event-repeat-fields" className="flex flex-col gap-3 min-w-0">
            <div className="min-w-0">
                <label htmlFor="event-repeat" className={LABEL}>{t('Repeats')}</label>
                <select
                    id="event-repeat"
                    data-testid="event-repeat-select"
                    value={repeat}
                    onChange={e => onRepeatChange(e.target.value as RepeatChoiceKey)}
                    className={`${FIELD} ${offered ? 'border-nature-200 dark:border-nature-700' : 'border-red-400 ring-1 ring-red-400'}`}
                >
                    {!offered && <option value={repeat} disabled>{t('Choose how the event repeats from the list')}</option>}
                    {choices.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
                {note && <p data-testid="event-repeat-note" className="m-0 mt-1 text-sm text-nature-600 dark:text-nature-300 break-words">{note}</p>}
                {!offered && <p data-testid="event-repeat-problem" role="alert" className={PROBLEM}>{t('Choose how the event repeats from the list')}</p>}
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
