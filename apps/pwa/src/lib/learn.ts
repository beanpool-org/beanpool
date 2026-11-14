/**
 * Learn on the web (slice K2, read-only; scratch/fable-design/DESIGN-local-knowledge-fable.md as amended by
 * DESIGN-local-knowledge-amend-fable.md, every pick Marty's, 11 Nov 2026). Local knowledge is read in its own place, never in
 * the Market: this file is the reads that place makes, the rules its screens share, and whether it shows at all.
 *
 * - **Four reads, all the member's own, all signed** (`request`): Learn's front, one topic, a search (GET /api/knowledge/front,
 *   which sends rows and never a body), and one page whole (GET /api/marketplace/posts?type=knowledge&id=…, the only way a
 *   body is read; a read that does not name the type never meets a page, so an app built before Learn never does either).
 * - **On only where the node says so** (`useLearn`): `features.knowledge`. A node from before it says nothing, and that is OFF.
 *   Where it is off and the node shows previews (`showcase`, the global community) Learn is drawn from Example Valley's three
 *   pages (components/ShowcasePreviews.tsx sampleLearnPosts) and nothing is asked of the node.
 * - **The same rules as the node's** (`learnFrontOf`, `learnTopicOf`, `learnSearchOf`): Learn's order is core's
 *   `compareKnowledge`, so a list reads the same from a node and from the sample. A search is the plain match the node falls
 *   back to; it serves the preview and the Market's one line there, never a live community (the node answers those).
 */
import { useEffect, useState } from 'react';
import {
    KNOWLEDGE_EMOJI, KNOWLEDGE_FRONT_ROWS, KNOWLEDGE_LIMITS, KNOWLEDGE_NAMES, KNOWLEDGE_SEARCH_MAX, KNOWLEDGE_TOPICS, KNOWLEDGE_TOPIC_PAGE, compareKnowledge,
    isKnowledgeTopic, knowledgeFeatureMode, knowledgeFirstLine, knowledgeTopic, pinLive, t, type FeatureMode, type KnowledgeDraftMine,
    type KnowledgeDraftToCheck, type KnowledgeDraftWhole, type KnowledgeFields, type KnowledgeFront, type KnowledgeRow, type KnowledgeSearch,
    type KnowledgeSource, type KnowledgeTopicPage,
} from '@beanpool/core';
import { myNodeRoleOnce, request } from './api';
import { useCommunityInfo, useReaderFeatures } from './features';
import { LANGUAGE_NAMES, shownLanguage } from './language';

/** A page of Local knowledge as a member reads it whole: a post of type `knowledge` with its own fields. */
export interface LearnPost {
    id: string;
    type: 'knowledge';
    /** A topic id (@beanpool/core KNOWLEDGE_TOPICS). */
    category: string;
    title: string;
    description: string;
    /** Its writer, or for a page gathered with the assistant the owner or admin who checked it. */
    authorPublicKey: string;
    authorCallsign: string;
    authorAvatarUrl?: string | null;
    createdAt: string;
    updatedAt?: string;
    /** 'active' for every page a member can read; core's pinLive reads it. */
    status: string;
    active?: boolean;
    photos?: string[];
    pinnedUntil?: string | null;
    pinnedAt?: string | null;
    knowledge: KnowledgeFields;
}

// ── The node's reads ─────────────────────────────────────────────────────────────────────

/** Learn's front: the pinned pages, then each topic that holds something, its count and its first three rows. */
export function getLearnFront(): Promise<KnowledgeFront> {
    return request<KnowledgeFront>('GET', '/api/knowledge/front');
}

/** One topic, every row in Learn's order, 50 a page: `offset` is the previous page's `next`. */
export function getLearnTopic(topic: string, offset = 0): Promise<KnowledgeTopicPage> {
    return request<KnowledgeTopicPage>('GET', `/api/knowledge/front?${new URLSearchParams({ topic, offset: String(offset) })}`);
}

/** The node's search over title, body, place and topic words, best match first, at most 30 rows. */
export function searchLearn(words: string): Promise<KnowledgeSearch> {
    return request<KnowledgeSearch>('GET', `/api/knowledge/front?${new URLSearchParams({ q: words.trim().slice(0, 100) })}`);
}

/** One page whole, or null when it is not showing (taken down, hidden, not a page, or Learn is off here). */
export async function getLearnPost(id: string): Promise<LearnPost | null> {
    const rows = await request<LearnPost[]>('GET', `/api/marketplace/posts?${new URLSearchParams({ type: 'knowledge', id })}`);
    return Array.isArray(rows) ? rows.find((r) => r?.id === id && r.type === 'knowledge' && !!r.knowledge) ?? null : null;
}

// ── Whether Learn shows ──────────────────────────────────────────────────────────────────

type FeatureSet = Record<string, unknown> | null | undefined;

/**
 * Learn's mode for this reader: `live` where the node has it on, `preview` where it is off and the node shows previews (the
 * global community), `hidden` otherwise. `ready` is false until the node's info has answered; until then the mode is
 * `hidden`, so no screen flashes a preview a live node then takes away (lib/features.ts). `enabled` false: nothing is read
 * and the mode stays `hidden` (a visitor's map, a New Post panel not open).
 */
export function useLearn(enabled = true): { ready: boolean; mode: FeatureMode } {
    const info = useCommunityInfo(enabled);
    const reader = useReaderFeatures(info, enabled);
    return { ready: info !== null, mode: info ? knowledgeFeatureMode(info.features as FeatureSet, reader) : 'hidden' };
}

/** Whether a mode lets the member into Learn: live, or the sample's preview. */
export function showsLearn(mode: FeatureMode): boolean {
    return mode === 'live' || mode === 'read-only' || mode === 'preview';
}

// ── Learn's rules, on a list of pages ────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** The row card's fields of a page (node engine/knowledge.ts knowledgeRowOf): never the body, only its first line. */
export function learnRowOf(p: LearnPost, now = Date.now()): KnowledgeRow {
    return {
        id: p.id,
        title: p.title,
        line: knowledgeFirstLine(p.description),
        topic: p.category,
        photo: p.photos?.[0] ?? null,
        checkedAt: p.knowledge.checkedAt ?? p.createdAt,
        helped: p.knowledge.helped ?? 0,
        pinned: pinLive(p as never, now),
        outdated: !!p.knowledge.outdatedAt,
    };
}

const byLearnOrder = (a: KnowledgeRow, b: KnowledgeRow): number => compareKnowledge(a, b);

/** Learn's front from pages in hand: the pinned ones, then each topic that holds something (the node's knowledgeFront). */
export function learnFrontOf(posts: readonly LearnPost[], now = Date.now()): KnowledgeFront {
    const rows = posts.map((p) => learnRowOf(p, now)).sort(byLearnOrder);
    const topics = KNOWLEDGE_TOPICS.map((t) => {
        const of = rows.filter((r) => r.topic === t.id);
        return { id: t.id as string, count: of.length, rows: of.slice(0, KNOWLEDGE_FRONT_ROWS) };
    }).filter((t) => t.count > 0);
    return { total: rows.length, pinned: rows.filter((r) => r.pinned), topics };
}

/** One topic's page of rows from pages in hand (the node's knowledgeTopicPage). */
export function learnTopicOf(posts: readonly LearnPost[], topic: string, offset = 0, now = Date.now()): KnowledgeTopicPage {
    const rows = posts.map((p) => learnRowOf(p, now)).filter((r) => r.topic === topic).sort(byLearnOrder);
    return { topic, count: rows.length, rows: rows.slice(offset, offset + KNOWLEDGE_TOPIC_PAGE), next: offset + KNOWLEDGE_TOPIC_PAGE < rows.length ? offset + KNOWLEDGE_TOPIC_PAGE : null };
}

/**
 * A plain match over pages in hand: a page matches when it holds any of the words in its title, place, body or its topic's
 * name and words; best first (a word in the title counts most, then the place, then the body), ties in Learn's order.
 */
export function learnSearchOf(posts: readonly LearnPost[], words: string, now = Date.now()): KnowledgeSearch {
    const terms = words.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
    if (terms.length === 0) return { total: 0, rows: [] };
    const scored = posts.map((p) => {
        const title = p.title.toLowerCase();
        const place = (p.knowledge.place ?? '').toLowerCase();
        const body = p.description.toLowerCase();
        const topic = knowledgeTopic(p.category);
        const topicWords = topic ? `${topic.label} ${topic.keywords}`.toLowerCase() : '';
        let score = 0;
        let found = false;
        for (const w of terms) {
            const inTitle = title.includes(w);
            const inPlace = place.includes(w);
            const inBody = body.includes(w);
            if (inTitle || inPlace || inBody || topicWords.includes(w)) found = true;
            score += (inTitle ? 3 : 0) + (inPlace ? 2 : 0) + (inBody ? 1 : 0);
        }
        return { found, score, row: learnRowOf(p, now) };
    }).filter((s) => s.found);
    scored.sort((a, b) => b.score - a.score || byLearnOrder(a.row, b.row));
    return { total: scored.length, rows: scored.slice(0, KNOWLEDGE_SEARCH_MAX).map((s) => s.row) };
}

// ── Topics, in the member's language ─────────────────────────────────────────────────────

/** A topic's name where a member reads it; "Local knowledge" for an id this app does not know (a newer node's topic). */
export function topicLabel(id: string): string {
    const meta = knowledgeTopic(id);
    return meta ? t(meta.label) : t(KNOWLEDGE_NAMES.kind);
}

/** A topic's glyph (Unicode 7 or older: an API 26 phone draws it); 📖 for an id this app does not know. */
export function topicEmoji(id: string): string {
    return knowledgeTopic(id)?.emoji ?? KNOWLEDGE_EMOJI;
}

// ── What a page says about itself ────────────────────────────────────────────────────────

/** "Nov 2026": a month and a year, in the language the screens are in (the plain English form if the language has no dates). */
export function monthYear(iso: string): string {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '';
    for (const lang of [shownLanguage(), 'en']) {
        try { return new Intl.DateTimeFormat(lang, { month: 'short', year: 'numeric' }).format(at); } catch { /* try the next */ }
    }
    return '';
}

/** Whether a page was last checked over a year ago (the card says so in amber instead of a month). */
export function checkedOverAYear(iso: string, now = Date.now()): boolean {
    const at = Date.parse(iso);
    return Number.isFinite(at) && now - at > 365 * DAY_MS;
}

/** A source's address if a browser may open it from here (http or https), else null: a link the node would not have kept. */
export function safeSourceUrl(url: string): string | null {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
    } catch {
        return null;
    }
}

/** The host a source lives on, as the member should see it before they tap ("www." and the path left off). */
export function sourceHost(url: string): string {
    try { return new URL(url).host.replace(/^www\./i, ''); } catch { return url; }
}

/** The name of a page's language in its own script ("Español"), or the code if the screens do not know it. */
export function languageNameOf(code: string): string {
    return (LANGUAGE_NAMES as Record<string, string>)[code] ?? code;
}

// ── Writing (slice K4) ───────────────────────────────────────────────────────────────────
// A member's suggestion waits for an owner or admin (POST /api/knowledge/drafts); an owner's or admin's own page goes into
// Learn at once (POST /api/knowledge/posts). The node checks everything again: these rules only say it before the send.

/** What the form sends: the node's KnowledgeInput. `photos` are data URLs (PostPhotoPicker), the member's own. */
export interface LearnInput {
    title: string;
    body: string;
    topic: string;
    place?: string;
    sources?: KnowledgeSource[];
    lang?: string;
    photos?: string[];
}

/** The first thing the form must say before it sends (§3.3's refusals), or null when it may go. */
export function learnFormRefusal(input: LearnInput): string | null {
    if (!input.title.trim()) return t('Give it a title.');
    if (!input.body.trim()) return t('Write what people should know.');
    if (!isKnowledgeTopic(input.topic)) return t('Pick a topic.');
    if ((input.sources ?? []).some((s) => s.url.trim() !== '' && safeSourceUrl(s.url.trim()) === null)) return t('A link must start with https:// or http://');
    return null;
}

/** The input as the node takes it: trimmed, empty sources left out, at most the limits. */
export function learnInputToSend(input: LearnInput): LearnInput {
    const sources = (input.sources ?? [])
        .map((s) => ({ url: s.url.trim(), label: s.label.trim().slice(0, KNOWLEDGE_LIMITS.sourceLabel) }))
        .filter((s) => s.url !== '')
        .slice(0, KNOWLEDGE_LIMITS.sources);
    return {
        title: input.title.trim().slice(0, KNOWLEDGE_LIMITS.title),
        body: input.body.trim().slice(0, KNOWLEDGE_LIMITS.body),
        topic: input.topic,
        place: (input.place ?? '').trim().slice(0, KNOWLEDGE_LIMITS.place),
        sources,
        lang: input.lang ?? shownLanguage(),
        photos: (input.photos ?? []).slice(0, KNOWLEDGE_LIMITS.photos),
    };
}

/** A member sends a suggestion: it waits for an owner or admin. */
export function suggestLearn(input: LearnInput): Promise<{ draft: KnowledgeDraftMine }> {
    return request('POST', '/api/knowledge/drafts', learnInputToSend(input));
}

/** An owner or admin publishes their own page: it goes into Learn at once. */
export function publishLearn(input: LearnInput): Promise<{ post: LearnPost }> {
    return request('POST', '/api/knowledge/posts', learnInputToSend(input));
}

/** The member's own suggestions: the waiting ones and those answered in the last 30 days. */
export async function getMyLearnDrafts(): Promise<{ waiting: KnowledgeDraftMine[]; answered: KnowledgeDraftMine[] }> {
    const r = await request<{ waiting?: KnowledgeDraftMine[]; answered?: KnowledgeDraftMine[] }>('GET', '/api/knowledge/drafts/mine');
    return { waiting: Array.isArray(r?.waiting) ? r.waiting : [], answered: Array.isArray(r?.answered) ? r.answered : [] };
}

/** "Take it back": the member's own waiting suggestion. */
export function withdrawLearnDraft(id: string): Promise<{ ok: true }> {
    return request('POST', `/api/knowledge/drafts/${encodeURIComponent(id)}/withdraw`);
}

/** To check (owners and admins): the waiting suggestions, the longest waiting first, 50 at a time. */
export async function getLearnToCheck(): Promise<{ drafts: KnowledgeDraftToCheck[]; total: number }> {
    const r = await request<{ drafts?: KnowledgeDraftToCheck[]; total?: number }>('GET', '/api/knowledge/drafts?limit=50&offset=0');
    const drafts = Array.isArray(r?.drafts) ? r.drafts : [];
    return { drafts, total: typeof r?.total === 'number' ? r.total : drafts.length };
}

/** One waiting suggestion whole, for the checking screen; null when it is no longer waiting. */
export async function getLearnDraft(id: string): Promise<KnowledgeDraftWhole | null> {
    try {
        return (await request<{ draft?: KnowledgeDraftWhole }>('GET', `/api/knowledge/drafts/${encodeURIComponent(id)}`))?.draft ?? null;
    } catch (e) {
        if ((e as { status?: number }).status === 404) return null;
        throw e;
    }
}

/** Approve, with the checker's edits ("Edit first", the whole form) and, for an assistant's draft, the tick. */
export function approveLearnDraft(id: string, opts: { edits?: LearnInput; lang?: string | null; checkedSources?: boolean } = {}): Promise<{ post: LearnPost }> {
    // "Edit first" keeps the suggestion's own language (§2.8: the writer's), never the checker's: one sent with none stays
    // with none, which the node keeps when no `lang` is sent.
    const edits: Partial<LearnInput> | null = opts.edits ? learnInputToSend(opts.edits) : null;
    if (edits) { delete edits.lang; if (opts.lang) edits.lang = opts.lang; }
    return request('POST', `/api/knowledge/drafts/${encodeURIComponent(id)}/approve`, {
        ...(edits ?? {}),
        ...(opts.checkedSources ? { checkedSources: true } : {}),
    });
}

/** "Not this one": a reason from core's list, and the checker's own few words, which the writer reads. */
export function declineLearnDraft(id: string, reason: string, words: string): Promise<{ ok: true }> {
    const said = words.trim().slice(0, KNOWLEDGE_LIMITS.reasonWords);
    return request('POST', `/api/knowledge/drafts/${encodeURIComponent(id)}/no`, { reason, ...(said ? { words: said } : {}) });
}

/** Whether the member is an owner or admin here (their own page publishes at once; they check others'); false until known. */
export function useChecksLearn(on: boolean): boolean {
    const [checks, setChecks] = useState(false);
    useEffect(() => {
        if (!on) return;
        let live = true;
        myNodeRoleOnce().then((role) => { if (live) setChecks(role === 'owner' || role === 'admin'); }, () => {});
        return () => { live = false; };
    }, [on]);
    return checks;
}

/** A refusal in the node's words (it answers in the member's language), or the form's own when the node said nothing. */
export function learnRefusalText(e: unknown): string {
    // Only an answer from the node (it has a status) carries its words; a dropped connection's own message is the browser's.
    const err = (e ?? {}) as { message?: unknown; unsaid?: boolean; status?: unknown };
    return typeof err.status === 'number' && !err.unsaid && typeof err.message === 'string' && err.message
        ? err.message : t("Couldn't send it. Check your connection and try again.");
}
