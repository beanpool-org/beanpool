/**
 * Settings → "Check your 12 words": owners only (sealed-keys.md §7, slice 7). Logic: lib/owner-words.ts.
 *
 * Shows the owner's status ("12 words checked 3 Oct 2026" / "not checked") and, on "Check now", a box for the
 * words. They are checked in this browser against this account; the box is emptied the moment the check answers,
 * when the tab is hidden, and when the card closes. Nothing is sent but the signed statement on a match. Nobody
 * who is not an owner sees any of this, and nothing waits on it.
 */
import { useEffect, useRef, useState } from 'react';
import {
    OWNER_WORDS_COPY as COPY, checkMyWords, fetchOwnerWordsStatus, sendOwnerWordsAttestation, typedWordCount,
    type OwnerWordsStatus,
} from '../lib/owner-words';

type Outcome = 'match' | 'mismatch' | 'count' | null;
type RecordState = 'none' | 'sending' | 'saved' | 'failed';

export function OwnerWordsCheck({ identity, startOpen = false, hasWords = true }: {
    identity: { publicKey: string; privateKey: string } | null;
    /** Opened from the home prompt's "Check now". */
    startOpen?: boolean;
    /** Whether this browser holds the 12 words: without them, "View Recovery Phrase shows them" would send the owner nowhere. */
    hasWords?: boolean;
}) {
    const [status, setStatus] = useState<OwnerWordsStatus | null>(null);
    const [open, setOpen] = useState(startOpen);
    const [typed, setTyped] = useState('');
    const [busy, setBusy] = useState(false);
    const [outcome, setOutcome] = useState<Outcome>(null);
    const [countSeen, setCountSeen] = useState(0);
    const [record, setRecord] = useState<RecordState>('none');
    const busyRef = useRef(false);

    useEffect(() => {
        let cancelled = false;
        fetchOwnerWordsStatus().then((s) => { if (!cancelled) setStatus(s); });
        return () => { cancelled = true; };
    }, [identity?.publicKey]);

    // Empty the box when the tab is hidden and when the card goes away.
    useEffect(() => {
        const onHide = () => { if (document.visibilityState === 'hidden') setTyped(''); };
        document.addEventListener('visibilitychange', onHide);
        return () => { document.removeEventListener('visibilitychange', onHide); setTyped(''); };
    }, []);

    if (!status?.owner || !identity) return null;

    const count = typedWordCount(typed);
    const statusLine = status.wordsCheckedAt ? COPY.checked(status.wordsCheckedAt) : COPY.notChecked;

    const close = () => { setTyped(''); setOutcome(null); setRecord('none'); setOpen(false); };

    const onCheck = async () => {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        const words = typed;
        const result = await checkMyWords(words, identity);
        const n = typedWordCount(words);
        busyRef.current = false;
        setBusy(false);
        if (!result.matches && result.reason === 'count') {
            // Nothing was checked: keep what was typed and say how many words there are.
            setCountSeen(n);
            setOutcome('count');
            return;
        }
        // Checked: empty the box whatever the answer.
        setTyped('');
        setOutcome(result.matches ? 'match' : 'mismatch');
        if (!result.matches) return;
        setRecord('sending');
        const at = await sendOwnerWordsAttestation();
        setRecord(at === null ? 'failed' : 'saved');
        if (at !== null) setStatus({ owner: true, wordsCheckedAt: at });
    };

    const matchText = record === 'saved' ? COPY.matchSaved : record === 'failed' ? COPY.matchNotSaved : COPY.match;

    return (
        <div data-testid="owner-words-check">
            <div className="text-xs font-bold uppercase tracking-wider text-nature-400 dark:text-nature-500 mb-2 px-1">
                COMMUNITY KEYS
            </div>
            <div className="bg-white dark:bg-nature-900 rounded-2xl shadow-sm border border-nature-200 dark:border-nature-800 p-4 space-y-3">
                <div className="flex items-start gap-3 min-w-0">
                    <span aria-hidden="true">🔑</span>
                    <div className="min-w-0">
                        <div className="font-bold text-[15px] text-nature-900 dark:text-white break-words">{COPY.title}</div>
                        <div className={`text-sm mt-0.5 leading-relaxed break-words ${status.wordsCheckedAt ? 'text-nature-600 dark:text-nature-300' : 'text-amber-800 dark:text-amber-300'}`}>
                            {statusLine}
                        </div>
                    </div>
                </div>

                {!open ? (
                    <button
                        type="button"
                        onClick={() => setOpen(true)}
                        className="w-full min-h-[48px] px-4 py-3 rounded-xl bg-emerald-700 text-white font-bold text-[15px] hover:bg-emerald-800"
                    >
                        {COPY.checkNow}
                    </button>
                ) : (
                    <div className="space-y-3">
                        <p className="text-sm leading-relaxed text-nature-700 dark:text-nature-200">{COPY.why}</p>
                        <label className="block text-xs font-bold uppercase tracking-wider text-nature-500 dark:text-nature-400" htmlFor="owner-words-input">
                            Your 12 words, in order
                        </label>
                        <textarea
                            id="owner-words-input"
                            value={typed}
                            onChange={(e) => { setTyped(e.target.value); setOutcome(null); }}
                            rows={4}
                            disabled={busy}
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            data-1p-ignore
                            data-lpignore="true"
                            placeholder="word word word …"
                            className="w-full min-h-[120px] p-3 rounded-xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-950 text-nature-900 dark:text-white text-base leading-relaxed"
                        />
                        <div className="text-sm text-nature-600 dark:text-nature-300 leading-relaxed">{count} of 12 words · {COPY.stays}</div>

                        {outcome === 'match' && (
                            <div role="status" className="p-3 rounded-xl border border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:border-emerald-800 dark:text-emerald-200 font-semibold text-sm">
                                {record === 'sending' ? COPY.match : matchText}
                            </div>
                        )}
                        {(outcome === 'mismatch' || outcome === 'count') && (
                            <div role="status" className="p-3 rounded-xl border border-red-300 bg-red-50 text-red-800 dark:bg-red-950 dark:border-red-800 dark:text-red-200 font-semibold text-sm">
                                {outcome === 'mismatch' ? COPY.mismatch : COPY.count(countSeen)}
                            </div>
                        )}

                        <div className="flex flex-wrap gap-2">
                            {outcome !== 'match' && (
                                <button
                                    type="button"
                                    onClick={onCheck}
                                    disabled={busy || count === 0}
                                    className="flex-grow basis-[140px] min-h-[48px] px-4 py-3 rounded-xl bg-emerald-700 text-white font-bold text-[15px] disabled:opacity-50"
                                >
                                    {busy ? 'Checking…' : 'Check my words'}
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={close}
                                className="flex-grow basis-[140px] min-h-[48px] px-4 py-3 rounded-xl border border-nature-300 dark:border-nature-700 text-nature-800 dark:text-nature-100 font-semibold text-[15px]"
                            >
                                {outcome === 'match' ? 'Done' : 'Close'}
                            </button>
                        </div>
                        <p className="text-xs text-nature-500 dark:text-nature-400 leading-relaxed">{hasWords ? COPY.findThem : COPY.findThemNotHere}</p>
                    </div>
                )}
            </div>
        </div>
    );
}
