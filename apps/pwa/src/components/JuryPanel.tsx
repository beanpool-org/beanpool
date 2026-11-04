import { useEffect, useState, type ReactNode } from 'react';
import {
    checkServedJury, juryCheckLine, juryClosedLists, juryCountHiddenLine, juryDecidesLine, juryOffersVote, juryOutcomeLine, juryPoolLine,
    juryRuleLine, jurySeatLines, jurySeatView, juryTurnoutLine, juryTurnoutOf, jurorStepAsideQuestion, t, type JuryCheck, type ServedJury,
} from '@beanpool/core';
import { answerJurySeat, getDecisionJury, type DecisionWithTally } from '../lib/api';

/**
 * A vote a drawn jury decides, on its Decide card (removal jury slice J3; core jury-card.ts has the words, the phone's
 * components/JuryPanel.tsx the same card). While it is open: who decides and by when, the reader's own seat in neutral
 * words, Serve or Step aside for a juror whose answer is due, the vote only for a seated juror, and Check the draw. Once
 * it closes: how it ended, who voted and who didn't serve (never why), and Check the draw over both lists.
 *
 * The seat comes from GET …/jury, so until it answers nobody is offered a vote. Nothing here names a juror to anyone but
 * themselves: while it is open the node names nobody else, and the card counts jurors from the tally's `turnout`.
 */
export function JuryPanel({ decision, open, me, name, voteButtons, onRefresh }: {
    decision: DecisionWithTally;
    open: boolean;
    me: string | null | undefined;
    /** The member it is about, as the card names them. */
    name: string;
    /** The card's own Yes and No, shown to a seated juror only. */
    voteButtons?: ReactNode;
    onRefresh: () => Promise<void>;
}) {
    const [jury, setJury] = useState<ServedJury | null | undefined>(undefined);
    const [loadFailed, setLoadFailed] = useState(false);
    const [check, setCheck] = useState<JuryCheck | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = async () => {
        setLoadFailed(false);
        try {
            setJury(await getDecisionJury(decision.id));
        } catch {
            setLoadFailed(true);
        }
    };
    // Again when the card's status or turnout moves (a vote cast, the vote closed), so the seat and the lists follow it.
    const turnout = juryTurnoutOf(decision.tally);
    useEffect(() => { void load(); }, [decision.id, decision.status, turnout?.voted]);

    const answer = async (to: 'serve' | 'step_aside') => {
        if (to === 'step_aside' && !window.confirm(jurorStepAsideQuestion())) return;
        setBusy(true);
        setError(null);
        try {
            const res = await answerJurySeat(decision.id, to);
            if (res.jury) setJury(res.jury);
            await onRefresh();
        } catch (err: any) {
            setError(err?.message || t('Your answer could not be sent.'));
        } finally {
            setBusy(false);
        }
    };

    const view = jury ? jurySeatView(jury, { isSubject: !!me && decision.subject === me, hasVoted: !!decision.myVote }) : null;
    const lists = jury && !open ? juryClosedLists(jury) : null;
    const outcome = open ? null : juryOutcomeLine(decision, decision.tally, name);
    const size = jury?.size ?? turnout?.size ?? decision.params?.jury?.size;

    return (
        <div className="bg-nature-800/40 border border-nature-700/50 rounded-xl p-3.5 space-y-2" data-testid="jury-panel">
            {open && typeof size === 'number' && (
                <p className="text-sm font-bold text-white break-words" data-testid="jury-decides-line">{juryDecidesLine(size, decision.closesAt)}</p>
            )}
            {outcome && <p className="text-sm font-bold text-white break-words" data-testid="jury-outcome">{outcome}</p>}

            {open && view && (
                <div className="space-y-1" data-testid={`jury-seat-${view}`}>
                    {jurySeatLines(view, { name, answerBy: jury?.answerBy, closesAt: decision.closesAt }).map(line => (
                        <p key={line} className="text-sm text-nature-200 leading-relaxed break-words">{line}</p>
                    ))}
                </div>
            )}

            {open && view === 'ask' && (
                <div className="flex flex-wrap gap-2">
                    <button
                        type="button"
                        onClick={() => answer('serve')}
                        disabled={busy}
                        className="flex-1 max-w-full py-2.5 px-4 rounded-xl bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on font-extrabold text-sm disabled:opacity-50 break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                    >
                        {t('Serve')}
                    </button>
                    <button
                        type="button"
                        onClick={() => answer('step_aside')}
                        disabled={busy}
                        className="flex-1 max-w-full py-2.5 px-4 rounded-xl bg-nature-800 text-nature-200 font-bold text-sm border border-nature-700 disabled:opacity-50 break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                    >
                        {t('Step aside')}
                    </button>
                </div>
            )}
            {open && view && juryOffersVote(view) && view !== 'ask' && voteButtons}
            {open && view === 'serving' && (
                <button
                    type="button"
                    onClick={() => answer('step_aside')}
                    disabled={busy}
                    className="text-xs font-bold text-sky-300 underline min-h-[44px] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 rounded"
                >
                    {t('Step aside')}
                </button>
            )}

            {lists && (
                <div className="space-y-1 text-xs text-nature-300 break-words" data-testid="jury-closed-lists">
                    <p data-testid="jury-voted">{lists.voted}</p>
                    <p data-testid="jury-did-not-serve">{lists.didNotServe}</p>
                    <p className="text-nature-400">{lists.note}</p>
                </div>
            )}

            {loadFailed && (
                <div className="flex flex-wrap items-center gap-x-2 text-xs text-amber-300">
                    <span>{t("Couldn't load the jury.")}</span>
                    <button type="button" onClick={() => void load()} className="underline font-bold min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 rounded">{t('Try again')}</button>
                </div>
            )}
            {error && <p className="text-xs text-red-300" role="alert">{error}</p>}

            {jury && (
                <div className="pt-1 space-y-1">
                    <button
                        type="button"
                        onClick={() => setCheck(checkServedJury(jury))}
                        className="py-2 px-3 rounded-xl bg-nature-800 text-nature-200 text-xs font-bold border border-nature-700 min-h-[44px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                    >
                        {t('Check the draw')}
                    </button>
                    {check && (
                        <p
                            role="status"
                            className={`text-xs font-semibold break-words ${check.ok ? 'text-emerald-300' : 'text-red-300'}`}
                            data-testid="jury-check-result"
                        >
                            {juryCheckLine(check)}
                        </p>
                    )}
                    <p className="text-[11px] text-nature-400">{juryPoolLine(jury)}</p>
                </div>
            )}
        </div>
    );
}

/**
 * An open jury vote's numbers, in the card's metrics box: jurors who voted of those seated, how many must vote and what
 * removing takes, and why no Yes or No shows yet. Never a percentage of a split the node didn't send.
 */
export function JuryTurnoutBox({ decision, name }: { decision: DecisionWithTally; name: string }) {
    const turnout = juryTurnoutOf(decision.tally);
    if (!turnout) {
        return <p className="text-xs text-nature-300" data-testid="jury-turnout">{juryCountHiddenLine()}</p>;
    }
    const pct = Math.min(100, Math.round((turnout.voted / Math.max(1, turnout.mustVote)) * 100));
    const met = turnout.voted >= turnout.mustVote;
    return (
        <div data-testid="jury-turnout">
            <div className="flex justify-between gap-2 text-xs font-semibold mb-1">
                <span className="text-nature-400 min-w-0 break-words">{t('Turnout: {line}', { line: juryTurnoutLine(turnout) })}</span>
                <span className={met ? 'text-emerald-400' : 'text-nature-400'}>{met ? t('Quorum Met ✅') : t('Pending Quorum')}</span>
            </div>
            <div
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={t('Quorum progress')}
                className="h-2 bg-nature-800 rounded-full overflow-hidden"
            >
                <div className={`h-full rounded-full ${met ? 'bg-emerald-500' : 'bg-sky-500'}`} style={{ width: `${pct}%` }} />
            </div>
            <p className="text-xs text-nature-300 mt-1 break-words">{juryRuleLine(turnout, decision.tally.minYes, name)}</p>
            <p className="text-xs text-nature-400 mt-1 break-words">{juryCountHiddenLine()}</p>
        </div>
    );
}
