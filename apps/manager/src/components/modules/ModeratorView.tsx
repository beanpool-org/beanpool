import React, { useCallback, useEffect, useState } from 'react';
import { HelpLink, ManualProvider, useManual } from '../manual/Manual';
import { PhoneReturnLink } from '../layout/ReturnLinks';
import type { BackLink } from '../../lib/came-from';
import { MODERATOR_MANUAL_PAGES } from '../../lib/manual';
import {
    REMOVAL_REASONS,
    actionNodeReport,
    dismissNodeReport,
    fetchNodeReports,
    type ListedReport,
    type ReportStatusFilter,
} from '../../lib/node-client';

/**
 * Settings for a moderator: Reports, and nothing else (Marty's decision, 2026-09-19: "real, narrow: reports and
 * removing posts only").
 *
 * Not the owners' Settings with sections hidden: none of the other sections, sub-tabs, menus or their data loads
 * exist here, so there is nothing to find by URL or by a stale saved tab. Every link lands on this one screen. The
 * node refuses a moderator's session everywhere else anyway (admin-auth.ts, MODERATOR_ROUTES); this screen only
 * offers what that session can do: read the reports, dismiss one, mark one handled, take down what was reported.
 */

const FILTERS: { id: ReportStatusFilter; label: string }[] = [
    { id: 'open', label: 'Open' },
    { id: 'actioned', label: 'Handled' },
    { id: 'dismissed', label: 'Dismissed' },
    { id: 'all', label: 'All' },
];

export interface ModeratorViewProps {
    nodeUrl: string;
    communityName: string;
    onLogout: () => void;
    /** Back to where the member came from (lib/came-from.ts). */
    back?: BackLink;
}

export function ModeratorView(props: ModeratorViewProps) {
    return (
        <ManualProvider pages={MODERATOR_MANUAL_PAGES}>
            <ModeratorScreen {...props} />
        </ManualProvider>
    );
}

function ModeratorScreen({ nodeUrl, communityName, onLogout, back }: ModeratorViewProps) {
    const manual = useManual();
    const [filter, setFilter] = useState<ReportStatusFilter>('open');
    const [reports, setReports] = useState<ListedReport[]>([]);
    const [pendingCount, setPendingCount] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await fetchNodeReports(nodeUrl, filter);
            setReports(res.reports);
            setPendingCount(res.pendingCount);
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : 'Could not load the reports');
        } finally {
            setLoading(false);
        }
    }, [nodeUrl, filter]);

    useEffect(() => { void load(); }, [load]);

    useEffect(() => {
        if (typeof document !== 'undefined') {
            document.title = communityName ? `${communityName} — Reports` : 'BeanPool — Reports';
        }
    }, [communityName]);

    return (
        <div className="bp-settings min-h-screen bg-nature-950 text-nature-100 font-sans antialiased" data-testid="moderator-view">
            <header className="sticky top-0 z-40 bg-nature-900/95 backdrop-blur-md border-b border-nature-800">
                <div className="max-w-4xl mx-auto flex flex-wrap items-center gap-x-1 gap-y-0 pl-3 pr-1 min-h-[56px]">
                    <div className="min-w-0 flex-1 py-1">
                        <p className="text-xs font-semibold text-terra-400 m-0 truncate">{`${communityName || 'BeanPool'} · Settings`}</p>
                        <p className="text-sm font-bold text-white m-0">Moderator</p>
                    </div>
                    {back && <PhoneReturnLink back={back} />}
                    {manual && (
                        <button
                            type="button"
                            onClick={() => manual.openManual()}
                            className="min-h-[48px] min-w-[48px] px-3 rounded-xl text-sm font-medium text-nature-200 hover:text-white hover:bg-nature-800/60"
                        >
                            Manual
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={onLogout}
                        className="min-h-[48px] px-3 rounded-xl text-sm font-medium text-nature-400 hover:text-red-400 hover:bg-nature-800/60"
                    >
                        Log Out
                    </button>
                </div>
            </header>

            <main className="max-w-4xl mx-auto p-4 sm:p-6 space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                    <h1 className="text-xl font-black text-white m-0 flex items-center gap-2 flex-1 min-w-0">
                        <span aria-hidden="true">⚠️</span>
                        <span>Reports</span>
                        <HelpLink screen="people/moderation" />
                    </h1>
                    <button
                        type="button"
                        onClick={() => void load()}
                        className="min-h-[48px] px-4 rounded-xl bg-nature-800 hover:bg-nature-700 text-sm text-white font-bold"
                    >
                        Refresh
                    </button>
                </div>
                <p className="text-sm text-nature-300 m-0">
                    What members have reported. You can take down a reported post or Pulse item, or dismiss the report.
                    The author is told their post was removed and why, never by whom; whoever reported it hears the outcome.
                </p>

                <div role="group" aria-label="Show reports" className="flex flex-wrap gap-2">
                    {FILTERS.map(f => (
                        <button
                            key={f.id}
                            type="button"
                            aria-pressed={filter === f.id}
                            onClick={() => setFilter(f.id)}
                            className={`min-h-[48px] px-4 rounded-xl text-sm font-bold border transition-colors ${filter === f.id
                                ? 'bg-terra-600 border-terra-500 text-white'
                                : 'bg-nature-900 border-nature-700 text-nature-200 hover:border-nature-500'}`}
                        >
                            {f.label}
                            {f.id === 'open' && pendingCount !== null ? ` (${pendingCount})` : ''}
                        </button>
                    ))}
                </div>

                {error && (
                    <div role="alert" className="text-sm font-semibold text-red-300 bg-red-950/40 border border-red-900/60 rounded-xl px-4 py-3">
                        {error}
                    </div>
                )}

                {loading && reports.length === 0 ? (
                    <p role="status" className="text-sm text-nature-400">Loading reports…</p>
                ) : reports.length === 0 && !error ? (
                    <div className="py-8 px-4 text-center text-sm font-semibold text-emerald-400 bg-emerald-950/20 border border-emerald-900/40 rounded-xl">
                        {filter === 'open' ? 'No open reports. The queue is clear.' : 'No reports here.'}
                    </div>
                ) : (
                    <ul className="space-y-3 list-none p-0 m-0">
                        {reports.map(r => (
                            <ReportCard key={r.id} report={r} nodeUrl={nodeUrl} onDone={load} />
                        ))}
                    </ul>
                )}

                <p className="text-xs text-nature-500 pt-2">
                    Suspending a member, and the rest of Settings, stays with this community's owners and admins.
                </p>
            </main>
        </div>
    );
}

function when(iso: string): string {
    const t = new Date(iso);
    return Number.isNaN(t.getTime()) ? '' : t.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function ReportCard({ report, nodeUrl, onDone }: { report: ListedReport; nodeUrl: string; onDone: () => void }) {
    const [choosingReason, setChoosingReason] = useState(false);
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const isOpen = report.outcome === 'open';
    const hasPost = !!report.postId;
    const pulse = report.pulseItem ?? null;
    const canRemovePost = isOpen && hasPost && !report.postRemoved;
    const canRemovePulse = isOpen && !!pulse && !pulse.removed;

    const run = async (label: string, fn: () => Promise<unknown>) => {
        setBusy(label);
        setError(null);
        try {
            await fn();
            setChoosingReason(false);
            onDone();
        } catch (e: unknown) {
            setError(e instanceof Error ? e.message : 'That did not work');
        } finally {
            setBusy(null);
        }
    };

    const outcomeLabel = report.outcome === 'actioned' ? 'Handled' : report.outcome === 'dismissed' ? 'Dismissed' : 'Open';
    const btn = 'min-h-[48px] px-4 rounded-xl text-sm font-bold transition-colors disabled:opacity-50';

    return (
        <li className="p-4 rounded-2xl bg-nature-900/80 border border-nature-800 space-y-3 break-words" data-testid="moderator-report">
            <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={`px-2 py-0.5 rounded font-bold border ${isOpen
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                    : 'bg-nature-800 text-nature-300 border-nature-700'}`}>
                    {outcomeLabel}
                </span>
                <span className="text-nature-400">
                    Reported by {report.reporterCallsign || 'a member'}{report.createdAt ? ` · ${when(report.createdAt)}` : ''}
                </span>
            </div>

            {hasPost ? (
                <div className="space-y-1">
                    <p className="text-xs font-bold uppercase tracking-wider text-nature-500 m-0">
                        Post{report.postAuthorCallsign ? ` by ${report.postAuthorCallsign}` : ''}{report.postRemoved ? ' · already down' : ''}
                    </p>
                    <p className="text-base font-bold text-white m-0">{report.postTitle || 'Untitled post'}</p>
                    {report.postDescription && <p className="text-sm text-nature-200 m-0 whitespace-pre-line">{report.postDescription}</p>}
                </div>
            ) : pulse ? (
                <div className="space-y-1">
                    <p className="text-xs font-bold uppercase tracking-wider text-nature-500 m-0">
                        Pulse · {pulse.platform}{pulse.removed ? ' · already off the Pulse' : ''}
                    </p>
                    {!pulse.removed && pulse.url && /^https?:\/\//i.test(pulse.url) ? (
                        <a href={pulse.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center min-h-[48px] text-terra-300 underline break-all">
                            {pulse.title || pulse.url}
                        </a>
                    ) : (
                        <p className="text-base font-bold text-white m-0">{pulse.title || 'Untitled item'}</p>
                    )}
                </div>
            ) : (
                <div className="space-y-1">
                    <p className="text-xs font-bold uppercase tracking-wider text-nature-500 m-0">Member</p>
                    <p className="text-base font-bold text-white m-0">{report.targetCallsign || 'A member'}</p>
                    <p className="text-xs text-nature-400 m-0">
                        A report about a member, not a post. Suspending someone is for the owners and admins: mark it handled once you have passed it on, or dismiss it.
                    </p>
                </div>
            )}

            <blockquote className="m-0 pl-3 border-l-2 border-nature-700 text-sm text-nature-100">
                {report.reason || 'No reason given'}
            </blockquote>

            {error && (
                <p role="alert" className="text-sm font-semibold text-red-300 m-0">{error}</p>
            )}

            {isOpen && !choosingReason && (
                <div className="flex flex-wrap gap-2">
                    {canRemovePost && (
                        <button type="button" disabled={!!busy} onClick={() => setChoosingReason(true)}
                            className={`${btn} bg-red-900/80 hover:bg-red-800 border border-red-700 text-white`}>
                            Remove the post
                        </button>
                    )}
                    {canRemovePulse && (
                        <button type="button" disabled={!!busy}
                            onClick={() => void run('pulse', () => actionNodeReport(nodeUrl, report.id, { removePulseItem: true }))}
                            className={`${btn} bg-red-900/80 hover:bg-red-800 border border-red-700 text-white`}>
                            {busy === 'pulse' ? 'Removing…' : 'Remove from the Pulse'}
                        </button>
                    )}
                    {!canRemovePost && !canRemovePulse && (
                        <button type="button" disabled={!!busy}
                            onClick={() => void run('handled', () => actionNodeReport(nodeUrl, report.id, {}))}
                            className={`${btn} bg-nature-800 hover:bg-nature-700 border border-nature-600 text-white`}>
                            {busy === 'handled' ? 'Saving…' : 'Mark handled'}
                        </button>
                    )}
                    <button type="button" disabled={!!busy}
                        onClick={() => void run('dismiss', () => dismissNodeReport(nodeUrl, report.id))}
                        className={`${btn} bg-nature-900 hover:bg-nature-800 border border-nature-700 text-nature-100`}>
                        {busy === 'dismiss' ? 'Dismissing…' : hasPost && !report.postRemoved ? 'Dismiss (keep the post)' : 'Dismiss'}
                    </button>
                </div>
            )}

            {isOpen && choosingReason && (
                <div className="space-y-3 p-3 rounded-xl bg-nature-950 border border-nature-800">
                    <label className="block text-sm font-semibold text-nature-200">
                        Why? The author reads this.
                        <select
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            className="mt-1 block w-full min-h-[48px] bg-nature-900 border border-nature-700 rounded-xl px-3 text-sm text-white focus:outline-none focus:border-terra-500"
                        >
                            <option value="">No reason given</option>
                            {REMOVAL_REASONS.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
                        </select>
                    </label>
                    <div className="flex flex-wrap gap-2">
                        <button type="button" disabled={!!busy}
                            onClick={() => void run('post', () => actionNodeReport(nodeUrl, report.id, { deletePost: true, reasonCategory: reason || undefined }))}
                            className={`${btn} bg-red-700 hover:bg-red-600 text-white`}>
                            {busy === 'post' ? 'Removing…' : 'Remove it'}
                        </button>
                        <button type="button" disabled={!!busy} onClick={() => setChoosingReason(false)}
                            className={`${btn} bg-nature-800 hover:bg-nature-700 text-nature-100`}>
                            Cancel
                        </button>
                    </div>
                </div>
            )}
        </li>
    );
}
