import React, { useEffect, useMemo, useState } from 'react';
import { isOncePerPersonVariant } from '@beanpool/core';
import type { NodeProfile } from '../../lib/profiles';
import { fetchOnboardingFunnel, getTfaSessionToken, type FunnelRow } from '../../lib/node-client';

export interface OnboardingModuleProps {
    /**
     * Single-node Settings (People & Safety -> Onboarding Funnel) passes the one node App.tsx already resolved,
     * which carries whichever sign-in that page holds. No node switcher there: there is nothing to switch to.
     */
    activeNode?: NodeProfile;
    /** Fleet mode passes its whole list, and only it gets the switcher across them. */
    profiles?: NodeProfile[];
    activeProfileId?: string;
    onSelectNode?: (id: string) => void;
}

const WINDOWS = [7, 30, 90] as const;

/**
 * THE COHORT — one group of people, followed.
 *
 * Every row here is a subset of the row above it, computed by the node in a single pass over
 * the members who joined inside the window, so "Joined" is 100% and nothing can exceed it.
 * That is the whole change: this screen used to put four numbers about four different groups
 * of people in one column and draw a funnel through them, which is how it came to show 350%
 * of joiners reaching step 3 and to count people who joined months ago as having "actually
 * got started" this month.
 */
const COHORT: { event: string; label: string; hint: string }[] = [
    { event: 'member_created', label: 'Joined', hint: 'People who joined here in this window — every figure below is a share of them' },
    { event: 'cohort_photo', label: 'Has a photo', hint: 'Of those same people, how many have a profile photo now' },
    { event: 'cohort_posted', label: 'Has posted', hint: 'Of those same people, how many have ever listed something here' },
];

/**
 * THE IN-APP STEPS — reported by members' own apps, and NOT linked to the cohort above.
 *
 * The node cannot tie these to the people who joined, and will not be able to: M2 gives the
 * counter table no column that could identify anyone. So they are shown apart, with their own
 * heading and their own date, rather than as rows in a funnel whose percentages would be
 * dividing one set of people by a different one.
 */
const IN_APP: { event: string; label: string; hint: string }[] = [
    { event: 'protection_shown', label: 'Saw the protection screen', hint: 'Step 3 drawn on their device' },
    { event: 'protection_choice', label: 'Chose how to be protected', hint: 'Step 3 answered — their words, or skip' },
    { event: 'guide_complete', label: 'Finished the guide', hint: 'Step 4 done' },
];

const FAILURE_LABELS: Record<string, string> = {
    invalid: 'Code not recognised',
    expired: 'Code had expired',
    already_used: 'Code already used',
    registration_failed: 'Registration failed',
    malformed: 'Broken offline ticket',
    wrong_key: 'Invite made for someone else',
    key_invalidated: 'Key replaced by a re-key',
};

function sum(rows: FunnelRow[]): number {
    return rows.reduce((n, r) => n + r.count, 0);
}

export function OnboardingModule({ activeNode, profiles, activeProfileId, onSelectNode }: OnboardingModuleProps) {
    // One code path for both callers: single-node Settings is a list of one, so the switcher below and the
    // "no profiles" card are decided by what is in `nodes`, not by a mode flag.
    const singleNode = Boolean(activeNode);
    const nodes = activeNode ? [activeNode] : profiles ?? [];
    const active = activeNode ?? nodes.find(p => p.id === activeProfileId) ?? nodes[0];
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
        fetchOnboardingFunnel(active.url, active.adminPassword, days, active ? getTfaSessionToken(active.id) : undefined)
            .then(res => { if (!cancelled) setRows(res.rows); })
            .catch(e => { if (!cancelled) setError(e.message || 'Could not reach this node'); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [active?.id, active?.url, active?.adminPassword, days]);

    const view = useMemo(() => {
        if (!rows) return null;

        const tally = (event: string, from: FunnelRow[] = rows) => sum(from.filter(r => r.event === event));

        // ---- the cohort ----
        const joined = tally('member_created');
        const cohort = COHORT.map(step => {
            const count = tally(step.event);
            const isBase = step.event === 'member_created';
            // A subset of a group, so this is a true share and cannot exceed 100. With nobody
            // in the group there is no share to take: the row reads 0 of 0, not 0%.
            const pct = isBase ? 100 : joined > 0 ? Math.round((count / joined) * 100) : 0;
            return { ...step, count, pct, isBase };
        });

        // ---- the in-app steps ----
        // Only rows a client has deduplicated per person are added up. The rest are the old
        // one-per-showing counts; they cannot be corrected after the fact, so they are left
        // where they are and ignored rather than quietly inflating these figures.
        const perPerson = rows.filter(r => isOncePerPersonVariant(r.variant));
        const perPersonDays = perPerson.map(r => r.day).sort();
        const countedSince = perPersonDays.length ? perPersonDays[0] : null;
        const inApp = IN_APP.map(step => ({ ...step, count: tally(step.event, perPerson) }));

        // Worth naming out loud when it is there: an operator who sees a small number beside a
        // step wants to know whether it is a drop-off or an old build still double-reporting.
        const staleReports = sum(rows.filter(
            r => IN_APP.some(s => s.event === r.event) && !isOncePerPersonVariant(r.variant),
        ));

        // ---- the codes ----
        const attempts = tally('invite_attempt');
        const reentry = tally('invite_reentry');
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

        return { cohort, joined, inApp, countedSince, staleReports, attempts, reentry, failures };
    }, [rows]);

    if (!active) {
        return (
            <div className="bg-nature-950/50 border-2 border-dashed border-nature-800/80 rounded-2xl p-12 flex flex-col items-center justify-center text-center space-y-3 animate-fade-in font-sans">
                <span className="text-4xl opacity-50 grayscale" aria-hidden="true">🚪</span>
                <h4 className="text-sm font-bold text-nature-300 m-0">No Node Profiles Available</h4>
                <p className="text-xs text-nature-500 m-0 max-w-sm">
                    Configure or select a sovereign node profile in Fleet Settings to inspect onboarding funnel metrics.
                </p>
            </div>
        );
    }

    return (
        <div className="space-y-6 animate-fade-in font-sans">
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                    {/*
                      In single-node Settings this panel sits under People & Safety's own h2, so its title is an
                      h3 there; in fleet mode it IS the page and stays an h2. And the community is not named:
                      the page the owner is on is already their own node, so "join Local Sovereign Node" would
                      be both redundant and, when no profile names it, plain wrong.
                    */}
                    {singleNode ? (
                        <h3 className="text-base font-bold text-white tracking-tight m-0 flex items-center gap-2.5">
                            <span aria-hidden="true">🚪</span> Onboarding Funnel
                        </h3>
                    ) : (
                        <h2 className="text-xl font-bold text-white tracking-tight m-0 flex items-center gap-2.5">
                            <span aria-hidden="true">🚪</span> Onboarding
                        </h2>
                    )}
                    <p className="text-xs text-nature-400 m-0 mt-1">
                        How many people tried to join{singleNode ? '' : ` ${active?.name || 'this node'}`}, and where
                        they stopped. Counts only — no member is identifiable here.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    {nodes.length > 1 && onSelectNode && (
                        <select
                            value={activeProfileId}
                            onChange={e => onSelectNode(e.target.value)}
                            aria-label="Choose which node's funnel to show"
                            className="px-3 py-2 rounded-xl bg-nature-800 text-xs font-bold text-white border border-nature-700"
                        >
                            {nodes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                    )}
                    <div role="group" aria-label="How far back to look" className="flex rounded-xl overflow-hidden border border-nature-700">
                        {WINDOWS.map(w => (
                            <button
                                key={w}
                                onClick={() => setDays(w)}
                                aria-pressed={days === w}
                                className={`px-3 py-2 text-xs font-bold transition-all focus:outline-none focus:ring-2 focus:ring-emerald-500 min-h-[48px] lg:min-h-0 ${
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
                    <section aria-labelledby="funnel-cohort-heading" className="space-y-2">
                        <h4 id="funnel-cohort-heading" className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 m-0">
                            The people who joined
                        </h4>
                        <p className="text-[11px] text-nature-500 m-0">
                            One group of people, followed: everyone who joined here in the last{' '}
                            <span className="font-mono text-nature-300">{days}</span> days, and how far those same
                            people have got since. Each figure below is a share of that first row, so none of them
                            can pass 100%.
                        </p>
                        {view.joined === 0 && (
                            <p className="text-[11px] text-amber-400/90 m-0">
                                Nobody joined in this window. Try a longer one.
                            </p>
                        )}
                        {view.cohort.map(step => (
                            <div
                                key={step.event}
                                className="p-3 rounded-xl bg-nature-800/60 border border-nature-700 flex items-center gap-4"
                            >
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-bold text-white truncate">{step.label}</div>
                                    <div className="text-[10px] text-nature-500">{step.hint}</div>
                                </div>
                                {/*
                                  aria-hidden rather than role="progressbar": the count and the
                                  percentage are both rendered as text immediately to the right, so
                                  marking this up as a progress bar would have a screen reader
                                  announce the same figure twice. The bar decorates the number.
                                */}
                                <div
                                    aria-hidden="true"
                                    className="w-32 h-2 rounded-full bg-nature-900 overflow-hidden hidden sm:block"
                                >
                                    <div className="h-full bg-emerald-500" style={{ width: `${step.pct}%` }} />
                                </div>
                                <div className="text-right shrink-0">
                                    <div className="text-lg font-black text-white font-mono leading-none">{step.count}</div>
                                    {(step.isBase || view.joined > 0) && (
                                        <div className="text-[10px] text-nature-500 font-mono">{step.pct}%</div>
                                    )}
                                </div>
                            </div>
                        ))}
                    </section>

                    <section aria-labelledby="funnel-in-app-heading" className="space-y-2">
                        <h4 id="funnel-in-app-heading" className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 m-0">
                            Steps inside the app
                        </h4>
                        <p className="text-[11px] text-nature-500 m-0">
                            These happen on a member's own device, so their app reports them. Your server keeps no
                            record of who reported what, and so <strong className="text-nature-300">cannot link these
                            to the people above</strong>. Read them on their own, not as a percentage of anything.
                            {view.countedSince ? (
                                <> Counted once per person since{' '}
                                    <span className="font-mono text-nature-300">{view.countedSince}</span>.</>
                            ) : null}
                        </p>
                        {!view.countedSince && (
                            <p className="text-[11px] text-amber-400/90 m-0">
                                Nothing counted once per person yet. Members' apps report these from the build that
                                added per-person counting; until some of them update, there is nothing here to show.
                            </p>
                        )}
                        {view.staleReports > 0 && (
                            <p className="text-[11px] text-nature-500 m-0">
                                <span className="font-mono text-nature-300">{view.staleReports}</span> older report
                                {view.staleReports === 1 ? ' is' : 's are'} left out: before this change an app counted
                                every time a screen was drawn, so the same person could be counted several times over.
                                Those figures can't be corrected after the fact, so they are ignored rather than mixed in.
                            </p>
                        )}
                        {view.inApp.map(step => (
                            <div
                                key={step.event}
                                className="p-3 rounded-xl bg-nature-800/60 border border-nature-700 flex items-center gap-4"
                            >
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm font-bold text-white truncate">{step.label}</div>
                                    <div className="text-[10px] text-nature-500">{step.hint}</div>
                                </div>
                                <div className="text-right shrink-0">
                                    <div className="text-lg font-black text-white font-mono leading-none">{step.count}</div>
                                    <div className="text-[10px] text-nature-500">people</div>
                                </div>
                            </div>
                        ))}
                    </section>

                    <section aria-labelledby="funnel-codes-heading" className="space-y-2">
                        <h4 id="funnel-codes-heading" className="text-[10px] font-extrabold uppercase tracking-wider text-nature-400 m-0">
                            Codes
                        </h4>
                        <p className="text-[11px] text-nature-500 m-0">
                            Attempts, not people — one person trying a code three times is three attempts. That is why
                            nothing above is worked out as a share of these.
                        </p>
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                            <div className="p-4 rounded-xl bg-nature-800/60 border border-nature-700">
                                <div className="flex justify-between items-baseline">
                                    <span className="text-sm font-bold text-white">Entered an invite code</span>
                                    <span className="text-lg font-black text-white font-mono leading-none">{view.attempts}</span>
                                </div>
                                {view.reentry > 0 && (
                                    <p className="text-[10px] text-nature-500 mt-3 mb-0">
                                        Including <span className="font-mono text-nature-300">{view.reentry}</span>{' '}
                                        already-a-member re-{view.reentry === 1 ? 'entry' : 'entries'} — neither
                                        rejections nor signups, which is why they are named here rather than hidden
                                        among the failures.
                                    </p>
                                )}
                            </div>

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
                            </div>
                        </div>
                    </section>
                </>
            )}
        </div>
    );
}
