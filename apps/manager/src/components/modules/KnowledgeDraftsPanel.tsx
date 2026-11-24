/**
 * Local knowledge to check in Node Settings (/settings → People & Safety → Triage & Moderation).
 *
 * Parity with the web app's LearnCheck (apps/pwa/src/components/LearnCheck.tsx) and the phone's To check
 * (apps/native/app/learn/check.tsx, check/[id].tsx): owners and admins signed in with their key session see
 * waiting suggestions and fixes (longest waiting first), open any one in full, inspect diffs / photos /
 * Wikimedia Commons credits / sources, and Approve, Edit first, or say Not this one.
 *
 * Uses /api/local/admin/knowledge/drafts*, which delegates directly to engine/knowledge-drafts.ts under the
 * same owner/admin rules (no moderator access, no automation token access, 404 feature_off when Learn is off).
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
    KNOWLEDGE_DECLINE_REASONS, KNOWLEDGE_EMOJI, KNOWLEDGE_LIMITS, KNOWLEDGE_TOPICS, knowledgeTopic, timeAgo,
    type KnowledgeDraftToCheck, type KnowledgeDraftWhole, type KnowledgeFixPart, type KnowledgePageWords,
    type KnowledgePhotoCredit, type KnowledgeRow, type KnowledgeSource,
} from '@beanpool/core';
import type { NodeProfile } from '../../lib/profiles';
import { nodeCredential } from '../../lib/profiles';
import {
    approveAdminKnowledgeDraft, declineAdminKnowledgeDraft, fetchAdminKnowledgeDraft, fetchAdminKnowledgeDrafts,
} from '../../lib/node-client';
import type { RolesViewer } from './NodeRolesPanel';
import { KNOWLEDGE_DRAFTS_ANCHOR } from './HomeScreen';
import { useInPageConfirm } from '../common/InPageConfirm';

export interface KnowledgeDraftsPanelProps {
    activeNode: NodeProfile;
    viewer?: RolesViewer;
    /** Optional count from /api/local/admin/data for fleet-mode token hint. */
    draftCount?: number;
    /** Called after approving or declining so Home counts refresh. */
    onChanged?: () => void;
}

const COMMONS = 'Wikimedia Commons';

function safeUrl(raw: string): string | null {
    try {
        const u = new URL(raw);
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
    } catch {
        return null;
    }
}

function hostOf(raw: string): string {
    try { return new URL(raw).host.replace(/^www\./i, ''); } catch { return raw; }
}

const topicLabel = (id: string) => knowledgeTopic(id)?.label ?? 'Local knowledge';
const topicEmoji = (id: string) => knowledgeTopic(id)?.emoji ?? KNOWLEDGE_EMOJI;
const kindWord = (kind: string) => (kind === 'fix' ? 'Fix' : 'New');
const waited = (iso: string) => timeAgo(Math.max(0, Date.now() - (Date.parse(iso) || Date.now())));
const fromWords = (d: KnowledgeDraftToCheck) =>
    (d.assistant ? `gathered with ${d.assistant} for ${d.from.name}` : `from ${d.from.name}`);

const commonsNote = (code: string) =>
    code === 'personality' ? `${COMMONS} notes: shows a person.`
        : code === 'trademarked' ? `${COMMONS} notes: shows a trademark.`
            : `${COMMONS} notes: other rights may apply.`;

const tagsText = (tags: readonly string[] | undefined) =>
    (tags && tags.length > 0 ? tags.map((tag) => `#${tag}`).join(' ') : 'None');

function partLabel(part: KnowledgeFixPart): string {
    return ({ title: 'Title', body: 'What to know', topic: 'Topic', place: 'Where', sources: 'Sources', lang: 'Language' })[part];
}

function partText(part: KnowledgeFixPart, w: Pick<KnowledgePageWords, KnowledgeFixPart>): string {
    if (part === 'topic') return topicLabel(w.topic);
    if (part === 'sources') return w.sources.map((s) => (s.label ? `${s.label} (${hostOf(s.url)})` : hostOf(s.url))).join('\n');
    return w[part] ?? '';
}

function CommonsCredit({ credit }: { credit: KnowledgePhotoCredit }) {
    const href = safeUrl(credit.url);
    const read = new Date(credit.readAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
    const notes = [...new Set(credit.restrictions.map(commonsNote))];
    return (
        <div className="space-y-0.5 text-xs" data-testid="manager-learn-credit">
            <p className="m-0 font-bold text-white break-words">{credit.maker ? `📷 ${credit.maker} · ${credit.licence}` : `📷 ${credit.licence}`}</p>
            <p className="m-0 text-nature-400">From {COMMONS}. Read by this server on {read}.</p>
            {notes.map((n) => <p key={n} className="m-0 font-bold text-bp-ink-warning">{n}</p>)}
            {href && (
                <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 min-h-[44px] font-bold text-bp-chip-learn-ink hover:underline">
                    Open its page<span aria-hidden="true">↗</span>
                </a>
            )}
        </div>
    );
}

export function KnowledgeDraftsPanel({ activeNode, viewer = { kind: 'token' }, draftCount = 0, onChanged }: KnowledgeDraftsPanelProps) {
    const isKeyChecker = viewer.kind === 'key' && (viewer.role === 'owner' || viewer.role === 'admin');
    const isTokenViewer = viewer.kind === 'token';
    const [ask, confirmation] = useInPageConfirm();

    const [list, setList] = useState<{ drafts: KnowledgeDraftToCheck[]; total: number; unchecked: { total: number; rows: KnowledgeRow[] } } | null>(null);
    const [hidden, setHidden] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);

    const [openId, setOpenId] = useState<string | null>(null);
    const [draft, setDraft] = useState<KnowledgeDraftWhole | null | 'loading' | 'failed'>(null);
    const [ticked, setTicked] = useState(false);
    const [removed, setRemoved] = useState<number[]>([]);
    const [mode, setMode] = useState<'read' | 'no' | 'edit'>('read');
    const [reason, setReason] = useState<string | null>(null);
    const [words, setWords] = useState('');
    const [busy, setBusy] = useState(false);
    const [refusal, setRefusal] = useState<string | null>(null);

    // Edit-first form state
    const [editTitle, setEditTitle] = useState('');
    const [editBody, setEditBody] = useState('');
    const [editTopic, setEditTopic] = useState('');
    const [editPlace, setEditPlace] = useState('');
    const [editSources, setEditSources] = useState<KnowledgeSource[]>([]);
    const [editPhotos, setEditPhotos] = useState<string[]>([]);
    const [editFreeTags, setEditFreeTags] = useState('');
    const [edited, setEdited] = useState(false);

    const cred = nodeCredential(activeNode);

    const loadList = useCallback(async () => {
        if (!isKeyChecker || !activeNode?.url) return;
        setLoadError(null);
        try {
            const res = await fetchAdminKnowledgeDrafts(activeNode.url, cred);
            setHidden(false);
            setList(res);
        } catch (e: any) {
            // Learn switched off (404 feature_off) or no permission (403): draw nothing.
            if (e?.status === 404 || e?.status === 403) {
                setHidden(true);
                setList(null);
            } else {
                setLoadError(e instanceof Error ? e.message : String(e));
            }
        }
    }, [isKeyChecker, activeNode?.url, cred]);

    useEffect(() => {
        void loadList();
    }, [loadList]);

    const openDraft = useCallback(async (id: string) => {
        setOpenId(id);
        setDraft('loading');
        setTicked(false);
        setRemoved([]);
        setMode('read');
        setReason(null);
        setWords('');
        setRefusal(null);
        setEdited(false);
        setMessage(null);
        try {
            const d = await fetchAdminKnowledgeDraft(activeNode.url, id, cred);
            setDraft(d);
        } catch {
            setDraft('failed');
        }
    }, [activeNode?.url, cred]);

    const closeDraft = async () => {
        if (mode === 'edit' && edited) {
            const ok = await ask({
                title: 'Leave without approving?',
                body: "Your changes won't be kept.",
                confirmLabel: 'Leave',
            });
            if (!ok) return;
        }
        setOpenId(null);
        setDraft(null);
        setMode('read');
        setRefusal(null);
        setEdited(false);
    };

    if (isTokenViewer) {
        if (draftCount <= 0) return null;
        return (
            <section id={KNOWLEDGE_DRAFTS_ANCHOR} data-testid="knowledge-drafts-card" className="bg-nature-900/80 border border-nature-800 rounded-2xl p-4 sm:p-6 shadow-xl space-y-2">
                <h3 className="text-base font-bold text-white m-0 break-words">📖 Local knowledge to check ({draftCount})</h3>
                <p className="text-xs text-nature-300 m-0 break-words">
                    Sign in to this community&apos;s Settings with your owner or admin key — or open Learn in the BeanPool app — to check and approve these drafts. Automation tokens cannot approve Local knowledge.
                </p>
            </section>
        );
    }

    if (!isKeyChecker || hidden) return null;
    if (!list && !loadError && !openId) return null;
    if (list && list.drafts.length === 0 && list.unchecked.rows.length === 0 && !message && !loadError && !openId) return null;

    const shownPhoto = (src: string) => src.startsWith('data:image/');

    const startEdit = (d: KnowledgeDraftWhole) => {
        const kept = d.photos.filter((src, i) => shownPhoto(src) && !removed.includes(i));
        setEditTitle(d.title);
        setEditBody(d.body);
        setEditTopic(d.topic);
        setEditPlace(d.place ?? '');
        setEditSources(d.sources.map((s) => ({ url: s.url, label: s.label })));
        setEditPhotos(kept);
        setEditFreeTags((d.freeTags ?? []).join(', '));
        setEdited(false);
        setRefusal(null);
        setMode('edit');
    };

    const runAction = async (fn: () => Promise<unknown>, said: string) => {
        if (busy) return;
        setBusy(true);
        setRefusal(null);
        try {
            await fn();
            setOpenId(null);
            setDraft(null);
            setMode('read');
            setMessage(said);
            onChanged?.();
            await loadList();
        } catch (e: unknown) {
            setRefusal(e instanceof Error ? e.message : "Couldn't send it. Check your connection and try again.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <section
            id={KNOWLEDGE_DRAFTS_ANCHOR}
            aria-labelledby="knowledge-drafts-title"
            data-testid="knowledge-drafts-card"
            className="bg-nature-900/80 border border-nature-800 rounded-2xl p-4 sm:p-6 shadow-xl space-y-4 min-w-0"
        >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-nature-800 pb-3 min-w-0">
                <div className="min-w-0">
                    <h3 id="knowledge-drafts-title" className="text-base font-bold text-white m-0 break-words flex items-center gap-2">
                        <span aria-hidden="true">📖</span>
                        <span>Local knowledge to check{list ? ` (${list.total})` : ''}</span>
                    </h3>
                    <p className="text-xs text-nature-400 m-0 mt-1 break-words">
                        Members&apos; suggestions and fixes waiting for an owner or admin to check before they show in Learn.
                    </p>
                </div>
                {openId ? (
                    <button
                        type="button"
                        data-testid="manager-learn-back"
                        onClick={() => void closeDraft()}
                        className="min-h-[44px] px-3 py-1.5 rounded-lg bg-nature-800 hover:bg-nature-700 text-xs text-white font-bold"
                    >
                        ‹ Back to list
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={() => void loadList()}
                        className="min-h-[44px] px-3 py-1.5 rounded-lg bg-nature-800 hover:bg-nature-700 text-xs text-white font-bold"
                    >
                        Refresh
                    </button>
                )}
            </div>

            {message && <p role="status" data-testid="manager-learn-said" className="text-sm font-semibold text-bp-chip-learn-ink m-0 break-words">{message}</p>}
            {loadError && (
                <div role="alert" className="text-xs text-red-300 bg-red-950/40 border border-red-900/60 rounded-lg px-3 py-2 flex flex-wrap items-center justify-between gap-2">
                    <span>Couldn&apos;t load Local knowledge drafts: {loadError}</span>
                    <button type="button" onClick={() => void loadList()} className="min-h-[44px] px-3 rounded-lg border border-red-700 text-white font-bold">Try again</button>
                </div>
            )}

            {openId ? (
                draft === 'loading' ? (
                    <p className="text-sm text-nature-300 m-0">Loading…</p>
                ) : draft === 'failed' ? (
                    <div role="alert" className="space-y-2">
                        <p className="text-sm text-red-300 m-0">Couldn&apos;t load this suggestion. Check your connection and try again.</p>
                        <button type="button" onClick={() => void openDraft(openId)} className="min-h-[44px] px-3 rounded-lg bg-nature-800 text-white text-xs font-bold">Try again</button>
                    </div>
                ) : draft === null ? (
                    <p data-testid="manager-learn-gone" className="text-sm text-nature-300 m-0">This one was already answered.</p>
                ) : (() => {
                    const d = draft;
                    const byAssistant = d.assistant !== null;
                    const fix = d.kind === 'fix';
                    const mayApprove = !d.needsSourcesTicked || ticked;
                    const keptPhotos = d.photos.filter((src, i) => shownPhoto(src) && !removed.includes(i));
                    const togglePhoto = (i: number) => setRemoved((was) => (was.includes(i) ? was.filter((x) => x !== i) : [...was, i]));

                    if (mode === 'edit') {
                        const submitEdit = () => {
                            if (!editTitle.trim()) { setRefusal('Give it a title.'); return; }
                            if (!editBody.trim()) { setRefusal('Write what people should know.'); return; }
                            if (!knowledgeTopic(editTopic)) { setRefusal('Pick a topic.'); return; }
                            const cleanedSources = editSources
                                .map((s) => ({ url: s.url.trim(), label: s.label.trim().slice(0, KNOWLEDGE_LIMITS.sourceLabel) }))
                                .filter((s) => s.url !== '');
                            if (cleanedSources.some((s) => !safeUrl(s.url))) { setRefusal('A link must start with https:// or http://'); return; }
                            const freeTags = editFreeTags.split(',').map((x) => x.trim()).filter(Boolean);
                            const payload: Record<string, unknown> = {
                                title: editTitle.trim().slice(0, KNOWLEDGE_LIMITS.title),
                                body: editBody.trim().slice(0, KNOWLEDGE_LIMITS.body),
                                topic: editTopic,
                                place: editPlace.trim().slice(0, KNOWLEDGE_LIMITS.place),
                                sources: cleanedSources.slice(0, KNOWLEDGE_LIMITS.sources),
                                freeTags,
                                ...(d.lang ? { lang: d.lang } : {}),
                                ...(!fix ? { photos: editPhotos.slice(0, KNOWLEDGE_LIMITS.photos) } : {}),
                                ...(d.needsSourcesTicked ? { checkedSources: true } : {}),
                            };
                            void runAction(
                                () => approveAdminKnowledgeDraft(activeNode.url, d.id, payload, cred),
                                fix ? 'Approved. The page shows the fix now.' : 'Approved. It is in Learn.',
                            );
                        };
                        return (
                            <div className="space-y-3 min-w-0" data-testid="manager-learn-edit-form">
                                <label className="block space-y-1">
                                    <span className="text-xs font-bold uppercase text-nature-400">Title *</span>
                                    <input
                                        type="text"
                                        data-testid="manager-learn-edit-title"
                                        value={editTitle}
                                        maxLength={KNOWLEDGE_LIMITS.title}
                                        onChange={(e) => { setEditTitle(e.target.value); setEdited(true); setRefusal(null); }}
                                        className="w-full min-h-[44px] rounded-xl bg-nature-950 border border-nature-700 px-3 py-2 text-sm text-white"
                                    />
                                </label>
                                <label className="block space-y-1">
                                    <span className="text-xs font-bold uppercase text-nature-400">What to know *</span>
                                    <textarea
                                        data-testid="manager-learn-edit-body"
                                        rows={5}
                                        value={editBody}
                                        maxLength={KNOWLEDGE_LIMITS.body}
                                        onChange={(e) => { setEditBody(e.target.value); setEdited(true); setRefusal(null); }}
                                        className="w-full rounded-xl bg-nature-950 border border-nature-700 px-3 py-2 text-sm text-white"
                                    />
                                </label>
                                <label className="block space-y-1">
                                    <span className="text-xs font-bold uppercase text-nature-400">Topic *</span>
                                    <select
                                        data-testid="manager-learn-edit-topic"
                                        value={editTopic}
                                        onChange={(e) => { setEditTopic(e.target.value); setEdited(true); setRefusal(null); }}
                                        className="w-full min-h-[44px] rounded-xl bg-nature-950 border border-nature-700 px-3 py-2 text-sm text-white"
                                    >
                                        {KNOWLEDGE_TOPICS.map((tp) => (
                                            <option key={tp.id} value={tp.id}>{tp.emoji} {tp.label}</option>
                                        ))}
                                    </select>
                                </label>
                                <label className="block space-y-1">
                                    <span className="text-xs font-bold uppercase text-nature-400">Where (optional)</span>
                                    <input
                                        type="text"
                                        value={editPlace}
                                        maxLength={KNOWLEDGE_LIMITS.place}
                                        onChange={(e) => { setEditPlace(e.target.value); setEdited(true); setRefusal(null); }}
                                        className="w-full min-h-[44px] rounded-xl bg-nature-950 border border-nature-700 px-3 py-2 text-sm text-white"
                                    />
                                </label>
                                <label className="block space-y-1">
                                    <span className="text-xs font-bold uppercase text-nature-400">Tags (comma-separated)</span>
                                    <input
                                        type="text"
                                        value={editFreeTags}
                                        onChange={(e) => { setEditFreeTags(e.target.value); setEdited(true); setRefusal(null); }}
                                        className="w-full min-h-[44px] rounded-xl bg-nature-950 border border-nature-700 px-3 py-2 text-sm text-white"
                                    />
                                </label>
                                {!fix && editPhotos.length > 0 && (
                                    <div className="space-y-2">
                                        <span className="text-xs font-bold uppercase text-nature-400">Photos kept</span>
                                        <div className="flex flex-wrap gap-3">
                                            {editPhotos.map((src, i) => (
                                                <div key={i} className="space-y-1">
                                                    <img src={src} alt={`Photo ${i + 1}`} className="w-20 h-20 object-cover rounded-lg" />
                                                    <button
                                                        type="button"
                                                        onClick={() => { setEditPhotos((prev) => prev.filter((_, j) => j !== i)); setEdited(true); }}
                                                        className="block min-h-[44px] px-2 rounded-lg border border-nature-700 text-xs text-nature-200 font-semibold"
                                                    >
                                                        Remove photo
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {refusal && <p role="alert" className="text-sm font-bold text-red-300 m-0 break-words">{refusal}</p>}
                                <div className="flex flex-wrap gap-2">
                                    <button
                                        type="button"
                                        data-testid="manager-learn-edit-approve"
                                        disabled={busy}
                                        onClick={submitEdit}
                                        className="flex-1 basis-full sm:basis-auto min-h-[48px] px-4 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-bp-cta-on font-bold disabled:opacity-50"
                                    >
                                        Approve
                                    </button>
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => { setMode('read'); setRefusal(null); }}
                                        className="flex-1 basis-full sm:basis-auto min-h-[48px] px-4 rounded-xl border border-nature-700 text-nature-100 font-bold"
                                    >
                                        Back
                                    </button>
                                </div>
                            </div>
                        );
                    }

                    const changed = d.changed ?? [];
                    const moved = new Set(d.pageChanged ?? []);
                    const tagsChanged = d.freeTagsChanged === true;

                    return (
                        <article data-testid="manager-learn-one" className="space-y-3 min-w-0">
                            <div className="flex flex-wrap items-center gap-1.5">
                                <span className="px-2 py-0.5 rounded-full text-[11px] font-bold uppercase bg-bp-chip-learn-tint text-bp-chip-learn-ink">{topicLabel(d.topic)}</span>
                                <span className="px-2 py-0.5 rounded-full text-[11px] font-bold uppercase bg-bp-chip-learn-tint text-bp-chip-learn-ink">{kindWord(d.kind)}</span>
                                {byAssistant && (
                                    <span data-testid="manager-learn-gathered" className="px-2 py-0.5 rounded-full text-[11px] font-bold uppercase bg-bp-chip-learn-tint text-bp-chip-learn-ink">
                                        Gathered with the assistant
                                    </span>
                                )}
                            </div>
                            <h4 className="text-lg font-extrabold text-white m-0 break-words">{d.title}</h4>
                            <p className="text-xs text-nature-400 m-0 flex flex-wrap gap-x-2">
                                <span>{fromWords(d)}</span>
                                <span>{waited(d.createdAt)}</span>
                            </p>

                            {d.note && (
                                <div className="rounded-xl bg-nature-950/70 border border-nature-800 p-3 space-y-1">
                                    <p className="text-[11px] font-bold uppercase text-nature-400 m-0">What changed</p>
                                    <p className="text-sm text-nature-100 m-0 break-words">{d.note}</p>
                                </div>
                            )}

                            {fix && (
                                !d.post ? (
                                    <p className="text-sm text-nature-400 m-0">This page of Local knowledge isn&apos;t showing any more.</p>
                                ) : changed.length === 0 && !tagsChanged ? (
                                    <p className="text-sm text-nature-400 m-0">Only the note: no words changed.</p>
                                ) : (
                                    <div className="space-y-2" data-testid="manager-learn-parts">
                                        {changed.map((part) => (
                                            <div key={part} className="rounded-xl bg-nature-950/70 border border-nature-800 p-3 space-y-1">
                                                <p className="text-[11px] font-bold uppercase text-nature-400 m-0">{partLabel(part)}</p>
                                                {moved.has(part) && <p className="text-xs font-bold text-bp-ink-warning m-0">▲ The page changed here since the fix was sent.</p>}
                                                <p className="text-xs font-bold text-nature-400 m-0">Now</p>
                                                <p className="text-sm text-nature-200 m-0 whitespace-pre-wrap break-words">{partText(part, d.post!)}</p>
                                                <p className="text-xs font-bold text-nature-400 m-0">Suggested</p>
                                                <p className="text-sm font-bold text-white m-0 whitespace-pre-wrap break-words">{partText(part, d)}</p>
                                            </div>
                                        ))}
                                        {tagsChanged && (
                                            <div className="rounded-xl bg-nature-950/70 border border-nature-800 p-3 space-y-1">
                                                <p className="text-[11px] font-bold uppercase text-nature-400 m-0">Tags</p>
                                                {d.freeTagsPageChanged === true && <p className="text-xs font-bold text-bp-ink-warning m-0">▲ The page changed here since the fix was sent.</p>}
                                                <p className="text-xs font-bold text-nature-400 m-0">Now</p>
                                                <p className="text-sm text-nature-200 m-0 break-words">{tagsText(d.post.freeTags)}</p>
                                                <p className="text-xs font-bold text-nature-400 m-0">Suggested</p>
                                                <p className="text-sm font-bold text-white m-0 break-words">{tagsText(d.freeTags)}</p>
                                            </div>
                                        )}
                                    </div>
                                )
                            )}

                            <div className="text-sm text-nature-100 whitespace-pre-wrap break-words leading-relaxed">{d.body}</div>
                            {d.place && <p className="text-sm font-bold text-white m-0 break-words">Where: {d.place}</p>}
                            {(d.freeTags?.length ?? 0) > 0 && (
                                <div className="rounded-xl bg-nature-950/70 border border-nature-800 p-3 space-y-1">
                                    <p className="text-[11px] font-bold uppercase text-nature-400 m-0">Tags</p>
                                    <p className="text-sm text-nature-100 m-0 break-words">{tagsText(d.freeTags)}</p>
                                </div>
                            )}

                            {d.photos.length > 0 && (
                                <div className="space-y-3" data-testid="manager-learn-photos">
                                    <p className="text-xs text-nature-400 m-0">Approve adds only the photos you keep. Keep one if it is the writer&apos;s own, or if it shows who made it and its licence.</p>
                                    {d.photos.map((src, i) => {
                                        if (!shownPhoto(src)) return null;
                                        const out = removed.includes(i);
                                        const credit = d.photoCredits?.[i] ?? null;
                                        return (
                                            <figure key={i} className="m-0 space-y-1.5">
                                                <img src={src} alt={`Photo ${i + 1}`} className={`w-full max-w-md aspect-[4/3] object-cover rounded-xl ${out ? 'opacity-40' : ''}`} />
                                                {credit && <CommonsCredit credit={credit} />}
                                                {!credit && byAssistant && <p className="text-xs text-nature-400 m-0">Uploaded by the assistant. Keep it only if it is your own.</p>}
                                                {out && <p className="text-xs text-nature-400 m-0">Left out: Approve won&apos;t add it.</p>}
                                                <button
                                                    type="button"
                                                    disabled={busy}
                                                    onClick={() => togglePhoto(i)}
                                                    className="min-h-[44px] px-3 rounded-lg border border-nature-700 text-xs font-bold text-white"
                                                >
                                                    {out ? 'Keep this photo' : 'Remove photo'}
                                                </button>
                                            </figure>
                                        );
                                    })}
                                </div>
                            )}

                            {d.sources.length > 0 && (
                                <div className="rounded-xl bg-nature-950/70 border border-nature-800 p-3 space-y-1.5">
                                    <p className="text-[11px] font-bold uppercase text-nature-400 m-0">Sources</p>
                                    <ul className="m-0 p-0 list-none space-y-1">
                                        {d.sources.map((s, i) => {
                                            const href = safeUrl(s.url);
                                            const host = hostOf(s.url);
                                            return (
                                                <li key={`${i}-${s.url}`}>
                                                    {href ? (
                                                        <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex flex-col min-h-[44px] justify-center text-sm font-bold text-bp-chip-learn-ink hover:underline break-words">
                                                            <span>{s.label || host} ↗</span>
                                                            <span className="text-xs font-normal text-nature-400 break-all">{host}</span>
                                                        </a>
                                                    ) : (
                                                        <div className="text-sm text-nature-200 break-words">{s.label || host}</div>
                                                    )}
                                                </li>
                                            );
                                        })}
                                    </ul>
                                </div>
                            )}

                            <div className="rounded-xl bg-nature-950/70 border border-nature-800 p-3 space-y-1">
                                <p className="text-[11px] font-bold uppercase text-nature-400 m-0">Before you approve</p>
                                <ul className="m-0 pl-5 text-xs text-nature-200 space-y-1">
                                    <li>It&apos;s about a place, a service or how to do something, not a private person.</li>
                                    <li>It&apos;s in the writer&apos;s own words, not copied.</li>
                                    <li>You believe it&apos;s right, or the sources say so.</li>
                                </ul>
                            </div>

                            {d.needsSourcesTicked && (
                                <label className="flex items-start gap-3 min-h-[44px] text-sm font-bold text-white cursor-pointer">
                                    <input
                                        type="checkbox"
                                        data-testid="manager-learn-tick"
                                        checked={ticked}
                                        onChange={(e) => setTicked(e.target.checked)}
                                        className="mt-0.5 w-5 h-5 shrink-0"
                                    />
                                    <span>I opened the sources and they say this.</span>
                                </label>
                            )}

                            {mode === 'no' ? (
                                <fieldset data-testid="manager-learn-no" className="m-0 p-0 border-0 space-y-2 min-w-0">
                                    <legend className="text-sm font-bold text-white mb-1">Why not?</legend>
                                    {KNOWLEDGE_DECLINE_REASONS.map((r) => (
                                        <label key={r.id} className="flex items-center gap-3 min-h-[44px] text-sm text-nature-100 cursor-pointer">
                                            <input
                                                type="radio"
                                                name="manager-learn-no-reason"
                                                value={r.id}
                                                checked={reason === r.id}
                                                onChange={() => setReason(r.id)}
                                                className="w-5 h-5 shrink-0"
                                            />
                                            <span>{r.label}</span>
                                        </label>
                                    ))}
                                    <label className="block space-y-1">
                                        <span className="text-xs font-bold text-nature-400">Add a few words (the writer reads them)</span>
                                        <textarea
                                            data-testid="manager-learn-no-words"
                                            value={words}
                                            maxLength={KNOWLEDGE_LIMITS.reasonWords}
                                            rows={3}
                                            onChange={(e) => setWords(e.target.value)}
                                            className="w-full rounded-xl bg-nature-950 border border-nature-700 px-3 py-2 text-sm text-white"
                                        />
                                    </label>
                                    {refusal && <p role="alert" className="text-sm font-bold text-red-300 m-0 break-words">{refusal}</p>}
                                    <div className="flex flex-wrap gap-2">
                                        <button
                                            type="button"
                                            data-testid="manager-learn-no-send"
                                            disabled={!reason || busy}
                                            onClick={() => reason && void runAction(
                                                () => declineAdminKnowledgeDraft(activeNode.url, d.id, reason, words, cred),
                                                byAssistant ? "Answered. It won't be added to Learn." : 'Answered. The writer is told.',
                                            )}
                                            className="flex-1 basis-full sm:basis-auto min-h-[48px] px-4 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-bp-cta-on font-bold disabled:opacity-50"
                                        >
                                            Send
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => { setMode('read'); setRefusal(null); }}
                                            className="flex-1 basis-full sm:basis-auto min-h-[48px] px-4 rounded-xl border border-nature-700 text-nature-100 font-bold"
                                        >
                                            Back
                                        </button>
                                    </div>
                                </fieldset>
                            ) : (
                                <div className="space-y-2">
                                    <p className="text-xs text-nature-400 m-0">{fix ? 'Approving changes the page now.' : 'Approving adds it to Learn and announces it in the Pulse.'}</p>
                                    {refusal && <p role="alert" className="text-sm font-bold text-red-300 m-0 break-words">{refusal}</p>}
                                    <div className="flex flex-wrap gap-2">
                                        <button
                                            type="button"
                                            data-testid="manager-learn-approve"
                                            disabled={!mayApprove || busy}
                                            onClick={() => void runAction(
                                                () => approveAdminKnowledgeDraft(activeNode.url, d.id, {
                                                    ...(d.needsSourcesTicked ? { checkedSources: true } : {}),
                                                    ...(!fix && d.photos.length > 0 ? { photos: keptPhotos } : {}),
                                                }, cred),
                                                fix ? 'Approved. The page shows the fix now.' : 'Approved. It is in Learn.',
                                            )}
                                            className="flex-1 basis-full sm:basis-auto min-h-[48px] px-4 rounded-xl bg-bp-cta-fill hover:bg-bp-cta-hover text-bp-cta-on font-bold disabled:opacity-50"
                                        >
                                            Approve
                                        </button>
                                        <button
                                            type="button"
                                            data-testid="manager-learn-edit"
                                            disabled={!mayApprove || busy}
                                            onClick={() => startEdit(d)}
                                            className="flex-1 basis-full sm:basis-auto min-h-[48px] px-4 rounded-xl border border-nature-700 text-nature-100 font-bold disabled:opacity-50"
                                        >
                                            Edit first
                                        </button>
                                        <button
                                            type="button"
                                            data-testid="manager-learn-not"
                                            disabled={busy}
                                            onClick={() => { setMode('no'); setRefusal(null); }}
                                            className="flex-1 basis-full sm:basis-auto min-h-[48px] px-4 rounded-xl border border-nature-700 text-nature-100 font-bold disabled:opacity-50"
                                        >
                                            Not this one
                                        </button>
                                    </div>
                                </div>
                            )}
                        </article>
                    );
                })()
            ) : list ? (
                <div className="space-y-4">
                    {list.drafts.length === 0 ? (
                        <p data-testid="manager-learn-empty" className="text-sm text-nature-300 m-0">Nothing to check.</p>
                    ) : (
                        <div className="space-y-2" data-testid="manager-learn-list">
                            <p className="text-xs font-bold uppercase text-nature-400 m-0">Waiting ({list.total})</p>
                            <div className="space-y-2">
                                {list.drafts.map((d) => (
                                    <button
                                        key={d.id}
                                        type="button"
                                        data-testid="manager-learn-row"
                                        onClick={() => void openDraft(d.id)}
                                        className="w-full text-left p-3 rounded-xl bg-nature-950 border border-nature-800 hover:border-nature-700 transition-colors flex flex-col gap-1 min-h-[48px]"
                                    >
                                        <span className="text-sm font-bold text-white break-words">
                                            <span aria-hidden="true">{topicEmoji(d.topic)} </span>
                                            {d.title}
                                        </span>
                                        <span className="text-xs text-nature-400 flex flex-wrap gap-x-2">
                                            <span className="font-semibold text-nature-200">{kindWord(d.kind)}</span>
                                            <span>{fromWords(d)}</span>
                                            <span>{waited(d.createdAt)}</span>
                                        </span>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                    {list.unchecked.rows.length > 0 && (
                        <div className="space-y-2 pt-2 border-t border-nature-800" data-testid="manager-learn-year">
                            <p className="text-xs font-bold uppercase text-nature-400 m-0">Not checked for a year ({list.unchecked.total})</p>
                            <ul className="m-0 p-0 list-none space-y-1.5">
                                {list.unchecked.rows.map((r) => (
                                    <li key={r.id} className="text-xs text-nature-200 break-words">
                                        {topicEmoji(r.topic)} {r.title}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            ) : null}
            {confirmation}
        </section>
    );
}
