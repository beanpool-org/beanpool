import React, { useState, useEffect, useCallback } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { resolveNodeApiUrl, buildAdminHeaders, getTfaSessionToken } from '../../lib/node-client';
import { nodeCredential } from '../../lib/profiles';
import type { RolesViewer } from './NodeRolesPanel';

/**
 * An AI assistant's suggestions (admin MCP design §5, slice S4), in Settings → Moderation, which the phone's Manage opens.
 *
 * Each card shows the ORIGINAL report (what the reporter and the author wrote) beside the assistant's own words, never
 * the words alone. Every piece of text is rendered as text (React escapes it; nothing here sets HTML), and the server has
 * already defused any `<<<` markers, so no reason can close or fake a block of the card.
 *
 * Approve sends the existing moderation route's own call (`approve`, from the server) under this person's own session:
 * the moderator rules and any step-up of that route hold. Only the member the assistant acts for gets an Approve button;
 * they, or an owner, can Decline.
 */

const LIST = '/api/local/admin/agent/suggestions';

interface Original {
    id: string;
    at: string | number;
    status: string;
    targetKind: 'post' | 'pulse_item' | 'member';
    reason: string | null;
    title: string | null;
    description: string | null;
    author: string | null;
    postRemoved: boolean;
    hiddenByReports: boolean;
}

export interface SuggestionCard {
    id: string;
    kind: 'dismiss_report' | 'remove_reported' | 'restore_post';
    asks: string;
    at: number;
    expiresAt: number;
    agent: { id: string; name: string; member: string | null };
    reason: { untrusted: true; text: string };
    report: Original | null;
    mine: boolean;
    approve: { method: 'POST'; path: string; body: Record<string, unknown> } | null;
}

export interface AgentSuggestionsPanelProps {
    activeNode: NodeProfile;
    viewer?: RolesViewer;
    /** After an approval, so the reports list beside it reads the change. */
    onChanged?: () => void;
}

function hoursLeft(expiresAt: number, now = Date.now()): string {
    const h = Math.max(0, Math.round((expiresAt - now) / 3_600_000));
    return h <= 1 ? 'less than an hour' : `${h} hours`;
}

export function AgentSuggestionsPanel({ activeNode, viewer = { kind: 'password' }, onChanged }: AgentSuggestionsPanelProps) {
    const drawn = viewer.kind === 'password' || viewer.role === 'owner' || viewer.role === 'admin';
    const [items, setItems] = useState<SuggestionCard[] | null>(null);
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState<string | null>(null);

    const headers = useCallback(
        () => buildAdminHeaders(nodeCredential(activeNode), getTfaSessionToken(activeNode.id)),
        [nodeCredential(activeNode), activeNode.id],
    );

    const load = useCallback(async () => {
        try {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, LIST), { headers: headers(), credentials: 'same-origin' });
            const json = await res.json().catch(() => ({}));
            if (res.ok && Array.isArray(json.suggestions)) {
                setItems(json.suggestions as SuggestionCard[]);
            } else if (res.status === 404) {
                setItems([]);
            } else {
                setMessage(`The assistants' suggestions could not be listed: ${json.error || `HTTP ${res.status}`}`);
            }
        } catch (e: unknown) {
            setMessage(e instanceof Error ? e.message : String(e));
        }
    }, [activeNode.url, headers]);

    useEffect(() => {
        if (!drawn) return;
        void load();
    }, [drawn, load]);

    const answer = async (s: SuggestionCard, how: 'approve' | 'decline') => {
        setBusy(s.id);
        setMessage('');
        try {
            const call = how === 'approve' ? s.approve : { method: 'POST' as const, path: `${LIST}/${encodeURIComponent(s.id)}/decline`, body: {} };
            if (!call) return;
            const res = await fetch(resolveNodeApiUrl(activeNode.url, call.path), {
                method: call.method, headers: headers(), credentials: 'same-origin', body: JSON.stringify(call.body ?? {}),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) {
                setMessage(json.error || `HTTP ${res.status}`);
            } else {
                setMessage(how === 'approve' ? 'Done: approved, and the community sees the change as yours.' : 'Declined: nothing changed.');
                if (how === 'approve') onChanged?.();
            }
        } catch (e: unknown) {
            setMessage(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(null);
            void load();
        }
    };

    if (!drawn || !items || (items.length === 0 && !message)) return null;

    return (
        <section aria-labelledby="agent-suggestions-title" data-testid="agent-suggestions-card" className="bg-nature-900/80 border border-nature-800 rounded-2xl p-4 sm:p-6 shadow-xl space-y-4">
            <div className="border-b border-nature-800 pb-3 min-w-0">
                <h3 id="agent-suggestions-title" className="text-base font-bold text-white m-0 break-words">
                    Suggested by an AI assistant ({items.length})
                </h3>
                <p className="text-xs text-nature-400 m-0 mt-1 break-words">
                    An assistant cannot act: it suggests, and nothing changes until its member approves. Read the report itself, not only the assistant&apos;s words.
                </p>
            </div>
            {message && <p role="status" className="text-sm text-nature-200 m-0 break-words">{message}</p>}
            <ul className="list-none m-0 p-0 space-y-4">
                {items.map((s) => (
                    <li key={s.id} className="border border-nature-800 rounded-xl p-3 sm:p-4 space-y-3 min-w-0" data-testid="agent-suggestion">
                        <p className="text-sm text-white m-0 font-semibold break-words">
                            Suggested by {s.agent.name} for {s.agent.member ?? 'a member who is no longer here'}
                        </p>
                        <p className="text-sm text-nature-100 m-0 break-words">{s.asks}</p>
                        {s.report ? (
                            <div className="bg-nature-950/60 rounded-lg p-3 space-y-1 min-w-0">
                                <p className="text-xs uppercase tracking-wide text-nature-400 m-0">The report ({s.report.status})</p>
                                {s.report.title && <p className="text-sm text-white m-0 break-words">{s.report.title}</p>}
                                {s.report.description && <p className="text-sm text-nature-200 m-0 break-words whitespace-pre-wrap">{s.report.description}</p>}
                                {s.report.author && <p className="text-xs text-nature-400 m-0 break-words">By {s.report.author}</p>}
                                {s.report.reason && (
                                    <p className="text-sm text-nature-100 m-0 break-words whitespace-pre-wrap">
                                        <span className="text-nature-400">Why it was reported: </span>{s.report.reason}
                                    </p>
                                )}
                            </div>
                        ) : (
                            <p className="text-sm text-nature-300 m-0">The report it was about is gone.</p>
                        )}
                        <div className="border-l-2 border-nature-700 pl-3 min-w-0">
                            <p className="text-xs uppercase tracking-wide text-nature-400 m-0">The assistant&apos;s words</p>
                            <p className="text-sm text-nature-200 m-0 break-words whitespace-pre-wrap" data-testid="agent-reason">{s.reason.text}</p>
                        </div>
                        <p className="text-xs text-nature-400 m-0">Goes away in {hoursLeft(s.expiresAt)} if nobody answers.</p>
                        <div className="flex flex-wrap gap-2">
                            {s.mine && s.approve && (
                                <button
                                    type="button"
                                    disabled={busy !== null}
                                    onClick={() => void answer(s, 'approve')}
                                    className="flex-1 basis-full sm:basis-auto min-h-[48px] px-4 rounded-lg bg-terra-600 text-white font-semibold break-words disabled:opacity-50"
                                >
                                    Approve
                                </button>
                            )}
                            <button
                                type="button"
                                disabled={busy !== null}
                                onClick={() => void answer(s, 'decline')}
                                className="flex-1 basis-full sm:basis-auto min-h-[48px] px-4 rounded-lg border border-nature-700 text-nature-100 font-semibold break-words disabled:opacity-50"
                            >
                                Decline
                            </button>
                        </div>
                    </li>
                ))}
            </ul>
        </section>
    );
}
