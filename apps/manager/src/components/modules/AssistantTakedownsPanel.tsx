import React, { useState, useEffect, useCallback } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { resolveNodeApiUrl, buildAdminHeaders, getTfaSessionToken } from '../../lib/node-client';
import { nodeCredential } from '../../lib/profiles';
import type { RolesViewer } from './NodeRolesPanel';
import { useInPageConfirm } from '../common/InPageConfirm';
import { FreshProofBox, useFreshProof } from '../common/FreshProofBox';
import { proofField, throwIfFreshProof } from '../../lib/fresh-proof';
import { CHILD_SAFETY_OPEN } from '../../lib/takedown-words';

/**
 * "Taken down by assistants" (scratch/fable-design/DESIGN-mcp-moderation-fable.md §3.13; the server is apps/server
 * agent/takedowns-route.ts), in Settings → Moderation, which the phone's Manage opens: one row per call an owner's assistant made,
 * opening to its posts, with Put back and Remove now.
 *
 * - For 7 days a post is only hidden. After that the server removes it, and there is nothing to put back.
 * - Put back: a post (owners and admins), a call, or everything one assistant took down lately (owners, `canActOnMany`). One tap and
 *   no code on purpose: this is the undo of a stolen token's day. Each post goes back to where it stood, so what the server says stayed
 *   hidden (`stillHidden`, absent on an older one) is told apart from what everyone sees again.
 * - Remove now: a post goes through the delete route Settings already has, so a person's refund and its warnings are that route's. A
 *   whole call asks an owner's fresh proof, and leaves a post with a deal in escrow or an open Child safety report for one-at-a-time.
 * - The assistant's words are rendered as text and read here only. No assistant reaches any of this.
 */

const LIST = '/api/local/admin/agent/takedowns';

interface PostLine {
    id: string;
    title: string | null;
    author: string | null;
    type: string | null;
    state: 'hidden' | 'left_hidden' | 'put_back' | 'final';
    leftFor?: 'deal' | 'child_safety' | null;
    /** A Child safety report is open on it, on any day of the hold: Remove now closes that report. */
    childSafetyOpen?: boolean;
}

export interface TakedownCall {
    id: string;
    grantId: string;
    grantName: string;
    member: string | null;
    at: string;
    reasonLabel: string;
    why: string;
    /** author: `author_of`, one post and its author's others (MCP-MODERATION S2). */
    via: 'ids' | 'reports' | 'author';
    finalAfter: string;
    posts: PostLine[];
}

interface Answer { canActOnMany: boolean; takedowns: TakedownCall[] }

export interface AssistantTakedownsPanelProps {
    activeNode: NodeProfile;
    viewer?: RolesViewer;
    /** After a change, so the reports list beside it reads it. */
    onChanged?: () => void;
}

const when = (at: string) => new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const count = (n: number) => `${n} post${n === 1 ? '' : 's'}`;
const STATE_WORDS: Record<PostLine['state'], string> = {
    hidden: 'Hidden', left_hidden: 'Left hidden: a deal in escrow', put_back: 'Put back', final: 'Removed',
};
const isHeld = (p: PostLine) => p.state === 'hidden' || p.state === 'left_hidden';
const childSafetyOpen = (p: PostLine) => isHeld(p) && p.childSafetyOpen === true;
const leftForDeal = (p: PostLine) => p.state === 'left_hidden' && p.leftFor !== 'child_safety';
const stateWords = (p: PostLine) => {
    if (!childSafetyOpen(p)) return STATE_WORDS[p.state];
    if (leftForDeal(p)) return `${STATE_WORDS.left_hidden}, and ${CHILD_SAFETY_OPEN}`;
    return `${p.state === 'hidden' ? 'Hidden' : 'Left hidden'}: ${CHILD_SAFETY_OPEN}`;
};
const DEAL_WARNING = 'It has a deal in escrow: removing it refunds the buyer, as any removal does.';
const CHILD_SAFETY_WARNING = 'A Child safety report on it is still open, for a person to read. Removing the post closes that report and tells whoever filed it.';
/** What Remove now does to this post, whichever day of the hold it is: each of a deal and a Child safety report is said on its own. */
const removeWarning = (p: PostLine) => {
    const said = [leftForDeal(p) ? DEAL_WARNING : '', childSafetyOpen(p) ? CHILD_SAFETY_WARNING : ''].filter(Boolean).join(' ');
    return `${said || 'It goes for good, without waiting for the 7 days.'} This cannot be undone.`;
};
const SINCE_CHOICES = [{ days: 1, label: 'the last day' }, { days: 2, label: 'the last 2 days' }, { days: 7, label: 'the last 7 days' }];

export function AssistantTakedownsPanel({ activeNode, viewer = { kind: 'password' }, onChanged }: AssistantTakedownsPanelProps) {
    const drawn = viewer.kind === 'password' || viewer.role === 'owner' || viewer.role === 'admin';
    const [data, setData] = useState<Answer | null>(null);
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);
    const [open, setOpen] = useState<string | null>(null);
    const [sinceDays, setSinceDays] = useState(1);
    const [ask, confirmation] = useInPageConfirm();
    const removeProof = useFreshProof();

    const headers = useCallback(
        () => buildAdminHeaders(nodeCredential(activeNode), getTfaSessionToken(activeNode.id)),
        [nodeCredential(activeNode), activeNode.id],
    );

    const load = useCallback(async () => {
        try {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, LIST), { headers: headers(), credentials: 'same-origin' });
            const json = await res.json().catch(() => ({}));
            if (res.ok && Array.isArray(json.takedowns)) setData({ canActOnMany: json.canActOnMany === true, takedowns: json.takedowns });
            // A server older than this has no such route: nothing to draw.
            else if (res.status !== 404) setMessage(`What assistants took down could not be listed: ${json.error || `HTTP ${res.status}`}`);
        } catch (e: unknown) {
            setMessage(e instanceof Error ? e.message : String(e));
        }
    }, [activeNode.url, headers]);

    useEffect(() => { if (drawn) void load(); }, [drawn, load]);

    const post = useCallback(async (apiPath: string, body: unknown) => {
        const res = await fetch(resolveNodeApiUrl(activeNode.url, apiPath), {
            method: 'POST', headers: headers(), credentials: 'same-origin', body: JSON.stringify(body ?? {}),
        });
        const json = await res.json().catch(() => ({}));
        return { res, json: json as Record<string, any> };
    }, [activeNode.url, headers]);

    const act = async (fn: () => Promise<string>) => {
        setBusy(true);
        setMessage('');
        try {
            setMessage(await fn());
            onChanged?.();
        } catch (e: unknown) {
            setMessage(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
            void load();
        }
    };

    const putBack = (body: Record<string, unknown>) => act(async () => {
        const { res, json } = await post(`${LIST}/put-back`, body);
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        const gone = json.gone > 0 ? ` ${count(json.gone)} had gone already.` : '';
        const total = json.back?.length ?? 0;
        const hidden = json.stillHidden?.length ?? 0;
        const stayed = hidden > 0 ? ` ${count(hidden)} stayed hidden for the moderators: a hide from before the assistant took ${hidden === 1 ? 'it' : 'them'} down, or the reports, still hold${hidden === 1 ? 's' : ''} ${hidden === 1 ? 'it' : 'them'}.` : '';
        const up = total > hidden ? ` ${count(total - hidden)} back up: each author is told, and everyone sees them again.` : '';
        return `Put back: ${count(total)}.${gone}${stayed}${up} Any reports the takedown closed are open again.`;
    });

    const removeOne = async (p: PostLine) => {
        const ok = await ask({
            title: `Remove "${p.title ?? 'this post'}" now?`,
            body: removeWarning(p),
            confirmLabel: 'Remove now',
        });
        if (!ok) return;
        await act(async () => {
            const { res, json } = await post(`/api/local/admin/posts/${encodeURIComponent(p.id)}/delete`, {});
            if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
            return json.warning || 'Removed.';
        });
    };

    const removeCall = async (t: TakedownCall, code?: string) => {
        if (!code) {
            const ok = await ask({ title: `Remove ${count(t.posts.filter(isHeld).length)} now?`, body: 'They go for good, without waiting for the 7 days. A post with a deal in escrow or an open Child safety report stays for you to remove by itself.', confirmLabel: 'Remove now' });
            if (!ok) return;
        }
        setBusy(true);
        setMessage('');
        try {
            const { res, json } = await post(`${LIST}/${encodeURIComponent(t.id)}/remove-now`, { ...proofField(code) });
            throwIfFreshProof(res.status, json);
            removeProof.close();
            if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
            const left = json.left?.length > 0 ? ` ${count(json.left.length)} stayed hidden: a deal in escrow, or a Child safety report still open.` : '';
            setMessage(`Removed: ${count(json.removed?.length ?? 0)}.${left}`);
            onChanged?.();
        } catch (e: unknown) {
            if (removeProof.checkError(e, (c) => removeCall(t, c), code)) return;
            setMessage(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
            void load();
        }
    };

    if (!drawn || !data || (data.takedowns.length === 0 && !message)) return null;
    const assistants = [...new Map(data.takedowns.filter((t) => t.posts.some(isHeld)).map((t) => [t.grantId, t.grantName])).entries()];

    return (
        <section aria-labelledby="agent-takedowns-title" data-testid="agent-takedowns-card" className="bg-nature-900/80 border border-nature-800 rounded-2xl p-4 sm:p-6 shadow-xl space-y-4">
            <div className="border-b border-nature-800 pb-3 min-w-0">
                <h3 id="agent-takedowns-title" className="text-base font-bold text-white m-0 break-words">Taken down by assistants</h3>
                <p className="text-xs text-nature-400 m-0 mt-1 break-words">
                    What an owner&apos;s AI assistant took down. It is hidden at once, and removed for good after 7 days unless you put it back here. Only a person can put a post back: it returns to where it stood, so a post hidden for review before stays hidden, and the reports the takedown closed open again.
                </p>
            </div>
            {message && <p role="status" className="text-sm text-nature-200 m-0 break-words">{message}</p>}
            {data.canActOnMany && assistants.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <label htmlFor="agent-takedowns-since" className="text-xs text-nature-300">Put back everything from</label>
                    <select
                        id="agent-takedowns-since"
                        value={sinceDays}
                        onChange={(e) => setSinceDays(Number(e.target.value))}
                        className="min-w-0 max-w-full min-h-[48px] bg-nature-950 border border-nature-700 rounded-xl px-3 py-2 text-xs text-white"
                    >
                        {SINCE_CHOICES.map((c) => <option key={c.days} value={c.days}>{c.label}</option>)}
                    </select>
                    {assistants.map(([grantId, name]) => (
                        <button
                            key={grantId}
                            type="button"
                            disabled={busy}
                            data-testid="agent-takedowns-put-back-since"
                            onClick={() => void putBack({ grantId, since: new Date(Date.now() - sinceDays * 86_400_000).toISOString() })}
                            className="min-h-[48px] max-w-full px-3 py-2 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-bold text-bp-cta-on disabled:opacity-50 break-words"
                        >
                            Put back all by {name}
                        </button>
                    ))}
                </div>
            )}
            <ul className="list-none m-0 p-0 space-y-3">
                {data.takedowns.map((t) => {
                    const held = t.posts.filter(isHeld);
                    return (
                        <li key={t.id} className="border border-nature-800 rounded-xl p-3 sm:p-4 space-y-2 min-w-0" data-testid="agent-takedown">
                            <p className="text-sm text-white m-0 font-semibold break-words">{t.grantName}: {count(t.posts.length)}, {t.reasonLabel}</p>
                            <p className="text-xs text-nature-400 m-0 break-words">
                                {when(t.at)} · {t.via === 'reports' ? 'by reports' : t.via === 'author' ? "by one member's posts" : 'by post'}{t.member ? ` · for ${t.member}` : ''}{held.length > 0 ? ` · final ${when(t.finalAfter)}` : ''}
                            </p>
                            <div className="border-l-2 border-nature-700 pl-3 min-w-0">
                                <p className="text-xs uppercase tracking-wide text-nature-400 m-0">The assistant&apos;s words</p>
                                <p className="text-sm text-nature-200 m-0 break-words whitespace-pre-wrap" data-testid="agent-takedown-why">{t.why}</p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                <button
                                    type="button"
                                    aria-expanded={open === t.id}
                                    onClick={() => setOpen(open === t.id ? null : t.id)}
                                    className="min-h-[48px] px-3 py-2 rounded-xl border border-nature-700 text-xs font-bold text-nature-200 hover:bg-nature-800"
                                >
                                    {open === t.id ? 'Hide its posts' : 'Show its posts'}
                                </button>
                                {data.canActOnMany && held.length > 0 && (
                                    <>
                                        <button type="button" disabled={busy} data-testid="agent-takedown-put-back-call" onClick={() => void putBack({ takedownId: t.id })}
                                            className="min-h-[48px] px-3 py-2 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-bold text-bp-cta-on disabled:opacity-50">
                                            Put back all {held.length}
                                        </button>
                                        <button type="button" disabled={busy} data-testid="agent-takedown-remove-call" onClick={() => void removeCall(t)}
                                            className="min-h-[48px] px-3 py-2 rounded-xl border border-nature-700 text-xs font-bold text-nature-200 hover:bg-nature-800 disabled:opacity-50">
                                            Remove now
                                        </button>
                                    </>
                                )}
                            </div>
                            {open === t.id && (
                                <ul className="list-none m-0 p-0 space-y-2">
                                    {t.posts.map((p) => (
                                        <li key={p.id} className="bg-nature-950/60 rounded-lg p-3 space-y-2 min-w-0" data-testid="agent-takedown-post">
                                            <p className="text-sm text-white m-0 break-words">{p.title ?? 'A post with no title'}</p>
                                            <p className="text-xs text-nature-400 m-0 break-words">{p.type ?? 'post'}{p.author ? ` by ${p.author}` : ''} · {stateWords(p)}</p>
                                            {isHeld(p) && (
                                                <div className="flex flex-wrap gap-2">
                                                    <button type="button" disabled={busy} data-testid="agent-takedown-put-back" onClick={() => void putBack({ postId: p.id })}
                                                        className="min-h-[48px] px-3 py-2 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-xs font-bold text-bp-cta-on disabled:opacity-50">
                                                        Put back
                                                    </button>
                                                    <button type="button" disabled={busy} data-testid="agent-takedown-remove" onClick={() => void removeOne(p)}
                                                        className="min-h-[48px] px-3 py-2 rounded-xl border border-nature-700 text-xs font-bold text-nature-200 hover:bg-nature-800 disabled:opacity-50">
                                                        Remove now
                                                    </button>
                                                </div>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </li>
                    );
                })}
            </ul>
            <FreshProofBox proof={removeProof} testId="agent-takedown-remove-proof" />
            {confirmation}
        </section>
    );
}
