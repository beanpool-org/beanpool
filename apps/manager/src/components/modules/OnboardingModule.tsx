import React, { useEffect, useMemo, useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { fetchOnboardingFunnel, type FunnelRow } from '../../lib/node-client';

export interface OnboardingModuleProps {
    profiles: NodeProfile[];
    activeProfileId: string;
    onSelectNode: (id: string) => void;
}

const WINDOWS = [7, 30, 90] as const;

/**
 * The join flow, in order. `counted` marks the steps the node tallies as they happen;
 * the rest are derived from data it already had, which is what lets them show history
 * from before this feature existed.
 */
const STEPS: { event: string; label: string; hint: string; counted: boolean }[] = [
    { event: 'invite_attempt', label: 'Entered an invite code', hint: 'Someone submitted a code — the top of the flow', counted: true },
    { event: 'member_created', label: 'Joined', hint: 'Step 1 done — the account exists', counted: false },
    { event: 'avatar_published', label: 'Added a photo', hint: 'Step 2 done — first photo only', counted: true },
    { event: 'protection_shown', label: 'Saw the protection screen', hint: 'Step 3 — arrives with Phase A', counted: true },
    { event: 'protection_choice', label: 'Chose how to be protected', hint: 'Step 3 answered — arrives with Phase A', counted: true },
    { event: 'guide_complete', label: 'Finished the guide', hint: 'Step 4 — arrives with Phase A', counted: true },
    { event: 'activated', label: 'Actually got started', hint: 'Posted their first offer', counted: false },
];

const FAILURE_LABELS: Record<string, string> = {
    invalid: 'Code not recognised',
    expired: 'Code had expired',
    already_used: 'Code already used',
    registration_failed: 'Registration failed',
    malformed: 'Broken offline ticket',
};

function sum(rows: FunnelRow[]): number {
    return rows.reduce((n, r) => n + r.count, 0);
}

export function OnboardingModule({ profiles, activeProfileId, onSelectNode }: OnboardingModuleProps) {
    const active = profiles.find(p => p.id === activeProfileId) || profiles[0];
    const [days, setDays] = useState<number>(30);
    const [rows, setRows] = useState<FunnelRow[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!active) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        // Cleared before the request, not after it succeeds. Otherwise a failed switch
        // leaves the previous node's numbers on screen under an error banner — and worse,
        // shows one community's figures under another community's name.
        setRows(null);
        fetchOnboardingFunnel(active.url, active.adminPassword, days)
            .then(res => { if (!cancelled) setRows(res.rows); })
            .catch(e => { if (!cancelled) setError(e.message || 'Could not reach this node'); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [active?.id, active?.url, active?.adminPassword, days]);

    const view = useMemo(() => {
        if (!rows) return null;

        // Counting began the first day a tallied row was written. Everything before that
        // exists only for the derived steps, and mixing the two spans would produce
        // nonsense — more people "joined" than ever "entered a code", which reads as a
        // broken dashboard rather than as two different measurement windows.
        const countedDays = rows.filter(r => STEPS.some(s => s.event === r.event && s.counted)).map(r => r.day);
        const countingSince = countedDays.length ? countedDays.sort()[0] : null;

        const comparable = countingSince ? rows.filter(r => r.day >= countingSince) : [];
        const tally = (event: string, from: FunnelRow[]) => sum(from.filter(r => r.event === event));

        // The top of the funnel is people trying to join, and every percentage below is a
        // share of it — so an already-a-member re-entry has to come off it. That is the
        // same person arriving twice, not somebody new, which is why it is already kept
        // out of `invite_failed`; leaving it in the denominator quietly halves every
        // conversion rate instead. The first real test showed exactly that: one tablet
        // signing up, submitting twice, read as 2 attempts and therefore 50% joined.
        const submitted = tally('invite_attempt', comparable);
        const comparableReentry = tally('invite_reentry', comparable);
        const top = Math.max(0, submitted - comparableReentry);

        const steps = STEPS.map(step => {
            const total = tally(step.event, rows);                 // everything in the window
            const comparableTotal = tally(step.event, comparable); // only since counting began
            const isTopRow = step.event === 'invite_attempt';

            // Which figure this row shows. Once counting has begun, the number and the
            // percentage beside it MUST describe the same span: rendering a 30-day derived
            // total next to a percentage of the counted window produced rows reading
            // "5 ... 50%" and "1 ... 0%", which is not arithmetic anyone can follow. The
            // longer history is not thrown away — it moves to `note`.
            const primary = !countingSince ? total : isTopRow ? top : comparableTotal;
            const pct = top > 0 ? Math.round((primary / top) * 100) : 0;

            let note: string | null = null;
            if (isTopRow && comparableReentry > 0) {
                note = `${submitted} submitted, ${comparableReentry} already a member${comparableReentry === 1 ? '' : 's'} excluded`;
            } else if (countingSince && total > comparableTotal) {
                note = `${total} across the full ${days} days`;
            }

            // Over 100% is reachable and is deliberately NOT clamped away. A derived step
            // counts member rows, and a member can appear without any invite code being
            // tallied — so a rate above 100% is real information: people are arriving by a
            // route this funnel cannot see. Rounding it down to a comfortable 100% would
            // erase the only clue. The bar is capped because a bar cannot overflow; the
            // number is left alone and explained.
            if (pct > 100) {
                const why = 'more than the codes tallied — some arrived without one being counted';
                note = note ? `${note} · ${why}` : why;
            }

            return { ...step, primary, note, pct, everSeen: total > 0 };
        });

        const failures = rows
            .filter(r => r.event === 'invite_failed')
            .reduce<Record<string, number>>((acc, r) => {
                // Every current call site passes a reason, but a future bare
                // recordFunnelEvent('invite_failed') would otherwise render as a blank
                // row with a number beside it.
                const key = r.variant || 'unknown';
                acc[key] = (acc[key] || 0) + r.count;
                return acc;
            }, {});

        const reentry = sum(rows.filter(r => r.event === 'invite_reentry'));
        const protectionStates = rows
            .filter(r => r.event === 'protection_shown')
            .reduce<Record<string, number>>((acc, r) => {
                acc[r.variant || '?'] = (acc[r.variant || '?'] || 0) + r.count;
                return acc;
            }, {});

        return { steps, failures, reentry, comparableReentry, protectionStates, countingSince, top };
    }, [rows, days]);

    return (
        <div className="space-y-6 animate-fade-in font-sans">
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                    <h2 className="text-xl font-bold text-white tracking-tight m-0 flex items-center gap-2.5">
                        <span aria-hidden="true">🚪</span> Onboarding
                    </h2>
                    <p className="text-xs text-nature-400 m-0 mt-1">
                        How many people tried to join {active?.name || 'this node'}, and where they stopped.
                        Counts only — no member is identifiable here.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    {profiles.length > 1 && (
                        <select
                            value={activeProfileId}
                            onChange={e => onSelectNode(e.target.value)}
                            aria-label="Choose which node's funnel to show"
                            className="px-3 py-2 rounded-xl bg-nature-800 text-xs font-bold text-white border border-nature-700"
                        >
                            {profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                    )}
                    <div role="group" aria-label="How far back to look" className="flex rounded-xl overflow-hidden border border-nature-700">
                        {WINDOWS.map(w => (
                            <button
                                key={w}
                                onClick={() => setDays(w)}
                                aria-pressed={days === w}
                                className={`px-3 py-2 text-xs font-bold transition-all focus:outline-none focus:ring-2 focus:ring-emerald-500 ${
                                    days === w ? 'bg-emerald-600 text-white' : 'bg-nature-800 text-nature-300 hover:bg-nature-700'
                                }`}
                            >
                                {w} days
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {loading && <div className="text-xs text-nature-400 italic">Reading the funnel…</div>}

            {error && (
                <div className="p-4 rounded-xl bg-red-600/15 border border-red-500/40 text-xs text-red-300">
                    <strong className="block mb-1">Couldn't read this node</strong>
                    {error}
                </div>
            )}

            {view && !loading && (
                <>
                    {view.countingSince ? (
                        <p className="text-[11px] text-nature-500 m-0">
                            Tallied steps have been counted since <span className="font-mono text-nature-300">{view.countingSince}</span>.
                            The two derived steps — <em>Joined</em> and <em>Actually got started</em> — are worked out from
                            records this node already kept, so they reach further back. Every figure below is that
                            overlapping period only, so each number and the percentage beside it describe the same
                            stretch of time; where a step knows about more, it says so underneath.
                        </p>
                    ) : (
                        <p className="text-[11px] text-amber-400/90 m-0">
                            Nothing has been tallied yet on this node — either nobody has tried to join since it was
                            redeployed, or it's still running an older build. The two derived steps below are still accurate.
                        </p>
                    )}

                    <div className="space-y-2">
                        {view.steps.map(step => {
                            const notYetBuilt = step.counted && !step.everSeen;
                            return (
                                <div
                                    key={step.event}
                                    className="p-3 rounded-xl bg-nature-800/60 border border-nature-700 flex items-center gap-4"
                                >
                                    <div className="flex-1 min-w-0">
                                        <div className="text-sm font-bold text-white truncate">{step.label}</div>
                                        <div className="text-[10px] text-nature-500">{step.hint}</div>
                                        {step.note && !notYetBuilt && (
                                            // Not italic, and a step lighter than the hint above it: this line carries
                                            // arithmetic the reader needs in order to trust the number beside it, so it
                                            // has to be legible. Kept at the hint's size rather than bumped up, which
                                            // would make the footnote louder than the label it hangs off.
                                            <div className="text-[10px] text-nature-300 mt-0.5">{step.note}</div>
                                        )}
                                    </div>

                                    {notYetBuilt ? (
                                        // Crucially NOT rendered as a 100% drop-off. A screen that does not exist
                                        // yet would otherwise look like the place everyone abandons, and somebody
                                        // would go hunting for a bug that is really just an unbuilt feature.
                                        <span className="px-2.5 py-1 rounded-full bg-nature-700/60 text-nature-400 text-[10px] font-bold whitespace-nowrap">
                                            not measured yet
                                        </span>
                                    ) : (
                                        <>
                                            {/*
                                              aria-hidden rather than role="progressbar":
                                              the count and the percentage are both
                                              rendered as text immediately to the right,
                                              so marking this up as a progress bar would
                                              have a screen reader announce the same
                                              figure twice. The bar is decoration for the
                                              number, not a second source of it.
                                            */}
                                            <div
                                                aria-hidden="true"
                                                className="w-32 h-2 rounded-full bg-nature-900 overflow-hidden hidden sm:block"
                                            >
                                                <div
                                                    className="h-full bg-emerald-500"
                                                    style={{ width: `${Math.min(100, step.pct)}%` }}
                                                />
                                            </div>
                                            <div className="text-right shrink-0">
                                                <div className="text-lg font-black text-white font-mono leading-none">
                                                    {step.primary}
                                                </div>
                                                {view.countingSince && (
                                                    <div className="text-[10px] text-nature-500 font-mono">{step.pct}%</div>
                                                )}
                                            </div>
                                        </>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        <div className="p-4 rounded-xl bg-nature-800/60 border border-nature-700">
                            <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block mb-2">
                                Why codes were rejected
                            </span>
                            {Object.keys(view.failures).length === 0 ? (
                                <p className="text-xs text-nature-500 italic m-0">No rejected codes in this window.</p>
                            ) : (
                                <ul className="m-0 p-0 list-none space-y-1.5">
                                    {Object.entries(view.failures)
                                        .sort((a, b) => b[1] - a[1])
                                        .map(([reason, n]) => (
                                            <li key={reason} className="flex justify-between text-xs">
                                                <span className="text-nature-300">{FAILURE_LABELS[reason] || reason}</span>
                                                <span className="font-mono font-bold text-amber-300">{n}</span>
                                            </li>
                                        ))}
                                </ul>
                            )}
                            {view.reentry > 0 && (
                                <p className="text-[10px] text-nature-500 mt-3 mb-0">
                                    {/*
                                      Quotes the figure the deduction actually used, not the
                                      window-wide one. The two are equal today — a re-entry is
                                      always recorded alongside an attempt, so no re-entry can
                                      predate the first counted day — but a sentence that
                                      explains an arithmetic step should cite the number that
                                      step used, so it cannot drift from it later.
                                    */}
                                    Plus <span className="font-mono text-nature-300">
                                        {view.countingSince ? view.comparableReentry : view.reentry}
                                    </span>{' '}
                                    already-a-member re-{(view.countingSince ? view.comparableReentry : view.reentry) === 1 ? 'entry' : 'entries'} —
                                    neither rejections nor signups, so they are counted apart and taken off the top of
                                    the funnel rather than diluting the rates above.
                                </p>
                            )}
                        </div>

                        <div className="p-4 rounded-xl bg-nature-800/60 border border-nature-700">
                            <span className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 block mb-2">
                                Keepers at signup
                            </span>
                            {Object.keys(view.protectionStates).length === 0 ? (
                                <p className="text-xs text-nature-500 italic m-0">
                                    Arrives with the new protection screen.
                                </p>
                            ) : (
                                <ul className="m-0 p-0 list-none space-y-1.5">
                                    {Object.entries(view.protectionStates)
                                        .sort()
                                        .map(([state, n]) => (
                                            <li key={state} className="flex justify-between text-xs">
                                                <span className="text-nature-300">
                                                    {state === 'A' ? '3 keepers — had a spare to offer'
                                                        : state === 'B' ? '2 keepers — needed a third'
                                                        : state === 'C' ? '1 keeper — shown their words'
                                                        : state}
                                                </span>
                                                <span className="font-mono font-bold text-emerald-300">{n}</span>
                                            </li>
                                        ))}
                                </ul>
                            )}
                        </div>
                    </div>
                </>
            )}
        </div>
    );
}
