import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { tagIndex } from '@beanpool/core';
import type { NodeProfile } from '../../lib/profiles';
import { resolveNodeApiUrl, buildAdminHeaders } from '../../lib/node-client';
import { nodeCredential } from '../../lib/profiles';
import type { RolesViewer } from './NodeRolesPanel';

/**
 * "Tags members typed" (DESIGN-tags-free-entry-fable.md §5, slice F3; the server is apps/server engine/free-tags.ts and
 * routes/admin.ts), in Settings → Moderation, for owners and admins: every tag members typed on live listings here, with how
 * many listings and authors carry it and when it was first seen (counts, never who), whether members are offered it as
 * they type, and the rule on it.
 *
 * - Hide: never offered to members as they type. Merge: offered as a library tag, and the Tags field stores that tag. Clear:
 *   as before. Listings keep their text either way: delete a listing in the reports, as always.
 * - Copy as text: the list for a pull request to the library (nothing leaves the server by itself).
 * - A rule is set with a key sign-in, so it is logged in a name; an automation token reads the list only.
 */

const LIST = '/api/local/admin/free-tags';

export interface FreeTagLine {
    tag: string;
    listings: number;
    authors: number;
    firstSeen: string | null;
    offered: boolean;
    rule: 'hide' | 'merge' | null;
    mergeInto: string | null;
}

interface Answer { tags: FreeTagLine[]; offerAuthors: number; offerDays: number }

export interface FreeTagsPanelProps {
    activeNode: NodeProfile;
    viewer?: RolesViewer;
}

const seen = (at: string | null) => (at ? `first seen ${new Date(at).toLocaleDateString(undefined, { dateStyle: 'medium' })}` : 'no live listing now');
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** One line per tag, tab-separated, for an issue or a pull request to the library. */
export function freeTagsAsText(tags: readonly FreeTagLine[]): string {
    const rows = tags.map((t) => [t.tag, t.listings, t.authors, t.firstSeen?.slice(0, 10) ?? '', t.rule === 'merge' ? `merge ${t.mergeInto}` : t.rule ?? ''].join('\t'));
    return ['tag\tlistings\tauthors\tfirst seen\trule', ...rows].join('\n');
}

export function FreeTagsPanel({ activeNode, viewer = { kind: 'token' } }: FreeTagsPanelProps) {
    const drawn = viewer.kind === 'token' || viewer.role === 'owner' || viewer.role === 'admin';
    // A rule is set with a key sign-in only (the server answers a token key_session_only): a token reads the list.
    const maySet = viewer.kind === 'key';
    const [data, setData] = useState<Answer | null>(null);
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);
    const [merging, setMerging] = useState<string | null>(null);
    const [query, setQuery] = useState('');
    const index = useMemo(() => tagIndex(), []);

    const headers = useCallback(() => buildAdminHeaders(nodeCredential(activeNode)), [nodeCredential(activeNode), activeNode.id]);

    const load = useCallback(async () => {
        try {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, LIST), { headers: headers(), credentials: 'same-origin' });
            const json = await res.json().catch(() => ({}));
            if (res.ok && Array.isArray(json.tags)) setData({ tags: json.tags, offerAuthors: json.offerAuthors ?? 2, offerDays: json.offerDays ?? 7 });
            // A server older than this has no such route: nothing to draw.
            else if (res.status !== 404) setMessage(`The tags could not be listed: ${json.error || `HTTP ${res.status}`}`);
        } catch (e: unknown) {
            setMessage(e instanceof Error ? e.message : String(e));
        }
    }, [activeNode.url, headers]);

    useEffect(() => { if (drawn) void load(); }, [drawn, load]);

    const setRule = async (tag: string, action: 'hide' | 'merge' | 'clear', into?: string) => {
        setBusy(true);
        setMessage('');
        try {
            const res = await fetch(resolveNodeApiUrl(activeNode.url, `${LIST}/${encodeURIComponent(tag)}/${action}`), {
                method: 'POST', headers: headers(), credentials: 'same-origin', body: JSON.stringify(into ? { into } : {}),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
            setMessage(action === 'hide' ? `#${tag} is no longer offered to members.`
                : action === 'merge' ? `#${tag} is offered as ${index.label(into ?? '') || into}.` : `#${tag} has no rule now.`);
            setMerging(null);
            setQuery('');
        } catch (e: unknown) {
            setMessage(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
            void load();
        }
    };

    const copy = async () => {
        if (!data) return;
        try {
            await navigator.clipboard.writeText(freeTagsAsText(data.tags));
            setMessage('Copied: paste it into an issue or a pull request for the library.');
        } catch {
            setMessage('This browser would not copy. Select the list and copy it by hand.');
        }
    };

    // Not an alert: the panel sits among the moderation section's own, and a list that could not be read is no emergency.
    if (!drawn || !data) return message ? <p className="text-sm text-red-300" data-testid="free-tags-unread">{message}</p> : null;
    const matches = merging && query.trim().length >= 2 ? index.search(query, 6).filter((id) => id.includes('.')) : [];

    return (
        <div className="bg-nature-900/80 border border-nature-800 rounded-2xl p-4 sm:p-6 shadow-xl space-y-4" data-testid="free-tags-panel">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-nature-800 pb-3">
                <h3 className="text-base font-bold text-white m-0">Tags members typed</h3>
                {data.tags.length > 0 && (
                    <button type="button" onClick={copy} className="min-h-[44px] px-3 rounded-lg text-sm font-semibold border border-nature-700 text-nature-200 hover:bg-nature-800">
                        Copy as text
                    </button>
                )}
            </div>
            <p className="text-sm text-nature-300 m-0">
                Members are offered a typed tag as they type once {plural(data.offerAuthors, 'member')} use it on live listings, or one member has for
                {' '}{plural(data.offerDays, 'day')} with no report. Hide keeps a tag out of what members are offered; merge offers it as a library tag.
                Listings keep their words either way.
            </p>
            {!maySet && (
                <p className="text-xs text-nature-300 m-0 break-words" data-testid="free-tags-key-only">
                    To hide or merge a tag, sign in to this Manager with your own key: a rule is logged in your name, and this token can only read the list.
                </p>
            )}
            {message &&<p className="text-sm text-nature-200 m-0 break-words" role="status">{message}</p>}
            {data.tags.length === 0 ? (
                <p className="text-sm text-nature-400 m-0">No typed tags on live listings yet.</p>
            ) : (
                <ul className="divide-y divide-nature-800 m-0 p-0 list-none">
                    {data.tags.map((t) => (
                        <li key={t.tag} className="py-3 space-y-2" data-testid="free-tag-row">
                            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                                <span className="font-bold text-white break-words min-w-0">#{t.tag}</span>
                                <span className="text-xs text-nature-300">
                                    {plural(t.listings, 'listing')} · {plural(t.authors, 'author')} · {seen(t.firstSeen)}
                                </span>
                            </div>
                            <div className="text-xs font-semibold text-nature-200">
                                {t.rule === 'hide' ? 'Hidden: not offered' : t.rule === 'merge' ? `Merged into ${index.label(t.mergeInto ?? '') || t.mergeInto}`
                                    : t.offered ? 'Offered to members' : 'Not offered yet'}
                            </div>
                            {maySet && <div className="flex flex-wrap gap-2">
                                {t.rule !== 'hide' && (
                                    <button type="button" disabled={busy} onClick={() => setRule(t.tag, 'hide')}
                                        className="min-h-[44px] px-3 rounded-lg text-sm font-semibold border border-nature-700 text-nature-100 hover:bg-nature-800 disabled:opacity-50">
                                        Hide
                                    </button>
                                )}
                                <button type="button" disabled={busy} onClick={() => { setMerging(merging === t.tag ? null : t.tag); setQuery(''); }}
                                    className="min-h-[44px] px-3 rounded-lg text-sm font-semibold border border-nature-700 text-nature-100 hover:bg-nature-800 disabled:opacity-50"
                                    aria-expanded={merging === t.tag}>
                                    Merge into a library tag
                                </button>
                                {t.rule && (
                                    <button type="button" disabled={busy} onClick={() => setRule(t.tag, 'clear')}
                                        className="min-h-[44px] px-3 rounded-lg text-sm font-semibold border border-nature-700 text-nature-100 hover:bg-nature-800 disabled:opacity-50">
                                        Clear the rule
                                    </button>
                                )}
                            </div>}
                            {maySet && merging === t.tag && (
                                <div className="space-y-2">
                                    <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a library tag"
                                        aria-label="Find a library tag"
                                        className="w-full min-h-[44px] px-3 rounded-lg bg-nature-950 border border-nature-700 text-white text-sm" />
                                    <div className="flex flex-wrap gap-2">
                                        {matches.map((id) => (
                                            <button key={id} type="button" disabled={busy} onClick={() => setRule(t.tag, 'merge', id)}
                                                className="min-h-[44px] px-3 rounded-full text-sm font-semibold bg-nature-800 text-nature-100 hover:bg-nature-700 disabled:opacity-50">
                                                {index.label(id) || id}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
