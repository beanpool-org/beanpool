/**
 * "Step back from being confirmed?" (scratch/fable-design/DESIGN-balance-rule-fable.md §1, §2): the one way out of the
 * rule, from Home's card and from Settings. Asks once, says what stepping back does, and tells the truth about the answer:
 * done (and whether they still owe past the ordinary line), or the node's refusal with the sheet still open. The same as
 * the phone's components/StepBackSheet.tsx.
 */
import { useEffect, useState } from 'react';
import { KNOWN_RULE_WORDS, steppedBackLine, t } from '@beanpool/core';
import { stepBackFromConfirmed } from '../lib/known-rule';

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

export function StepBackSheet({ onClose, onSteppedBack }: {
    onClose: () => void;
    /** Once the member has read that it's done and closed the sheet. */
    onSteppedBack: () => void;
}) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);

    const close = () => {
        if (busy) return;
        if (done !== null) onSteppedBack(); else onClose();
    };
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });

    const stepBack = async () => {
        setBusy(true);
        setError(null);
        try {
            const answer = await stepBackFromConfirmed();
            if (answer.ok) setDone(steppedBackLine(answer.owing));
            else setError(answer.error);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[300] flex items-end sm:items-center justify-center" onClick={close} role="dialog" aria-modal="true" aria-labelledby="step-back-title" data-testid="step-back-sheet">
            <div className="absolute inset-0 bg-black/60" />
            <div className="relative bg-bg-card rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[85vh] overflow-y-auto p-5 flex flex-col gap-3 break-words" onClick={(e) => e.stopPropagation()}>
                {done ? (
                    <>
                        <p id="step-back-title" role="status" data-testid="step-back-done" className="m-0 text-base leading-relaxed text-text-primary">{done}</p>
                        <button type="button" onClick={close} data-testid="step-back-close"
                            className={`w-full min-h-[48px] px-4 py-2 rounded-xl border-0 font-bold text-sm cursor-pointer bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on ${FOCUS}`}>
                            {t(KNOWN_RULE_WORDS.ok)}
                        </button>
                    </>
                ) : (
                    <>
                        <h2 id="step-back-title" className="m-0 text-lg font-bold text-text-primary">{t(KNOWN_RULE_WORDS.sheetTitle)}</h2>
                        <p className="m-0 text-sm leading-relaxed text-text-primary">{t(KNOWN_RULE_WORDS.sheetBody)}</p>
                        {error && <p role="alert" data-testid="step-back-error" className="m-0 text-sm font-semibold text-danger">{error}</p>}
                        <button type="button" onClick={() => { void stepBack(); }} disabled={busy} aria-busy={busy} data-testid="step-back-confirm"
                            className={`w-full min-h-[48px] px-4 py-2 rounded-xl border-0 font-bold text-sm cursor-pointer bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on ${FOCUS}`}>
                            {busy ? t(KNOWN_RULE_WORDS.steppingBack) : t(KNOWN_RULE_WORDS.stepBack)}
                        </button>
                        <button type="button" onClick={close} disabled={busy} data-testid="step-back-keep"
                            className={`w-full min-h-[48px] px-4 py-2 rounded-xl border-0 bg-transparent font-bold text-sm cursor-pointer text-text-secondary ${FOCUS}`}>
                            {t(KNOWN_RULE_WORDS.keepIt)}
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}
