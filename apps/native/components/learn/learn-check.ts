/**
 * To check on the phone (slice K4 part 2; DESIGN-local-knowledge-fable.md §5 as amended §A5): owners and admins answer
 * members' suggestions and fixes of Local knowledge here, matching the web's components/LearnCheck.tsx and lib/learn.ts.
 *
 * Pure words, formatters and signed API helpers so app/learn/check.tsx and app/learn/check/[id].tsx stay thin and testable.
 */
import {
    KNOWLEDGE_LIMITS, formatDate, t, timeAgo, word,
    type KnowledgeDraftToCheck, type KnowledgeDraftWhole, type KnowledgeFixPart,
    type KnowledgePageWords, type KnowledgeRow,
} from '@beanpool/core';
import { signedGet, signedRequestWithMethod } from '../../utils/db';
import { LANGUAGE_NAMES } from '../../utils/language-choice';
import { hostOf } from './KnowledgeDetail';
import { topicOf } from './learn-lines';
import { knowledgeFormBody, type KnowledgeFormValues } from './learn-write';

export const LEARN_CHECK_WORDS = {
    title: word('To check'),
    loading: word('Loading...'),
    loadFailed: word("Couldn't load Learn. Check your connection and try again."),
    tryAgain: word('Try again'),
    waitingCount: word('Waiting ({n})'),
    uncheckedYear: word('Not checked for a year ({n})'),
    empty: word('Nothing to check.'),
    alreadyAnswered: word('This one was already answered.'),
    kindNew: word('New', 'a suggestion of a new page of Local knowledge, not a fix'),
    kindFix: word('Fix'),
    fromName: word('from {name}'),
    fromAssistant: word('gathered with {assistant} for {name}'),
    gatheredChip: word('Gathered with the assistant'),
    whatChanged: word('What changed'),
    pageGone: word("This page of Local knowledge isn't showing any more."),
    noteAlone: word('Only the note: no words changed.'),
    moved: word('▲ The page changed here since the fix was sent.'),
    now: word('Now', 'To check: a part of a page of Local knowledge as it shows now, beside the fix'),
    suggested: word('Suggested', 'To check: the same part as the fix would write it'),
    partTitle: word('Title'),
    partBody: word('What to know'),
    partTopic: word('Topic'),
    partPlace: word('Where', 'To check: the part of a page of Local knowledge that names its place'),
    partSources: word('Sources'),
    partLang: word('Language'),
    tags: word('Tags'),
    none: word('None'),
    where: word('Where: {place}'),
    photosIntro: word('Approve adds only the photos you keep. Keep one if it is the writer’s own, or if it shows who made it and its licence.'),
    photoN: word('Photo {n}'),
    uploadedByAssistant: word('Uploaded by the assistant. Keep it only if it is your own.'),
    leftOut: word('Left out: Approve won’t add it.'),
    keepPhoto: word('Keep this photo'),
    removePhoto: word('Remove photo'),
    commonsFrom: word('From {site}. Read by this server on {date}.'),
    commonsPerson: word('{site} notes: shows a person.'),
    commonsTrademark: word('{site} notes: shows a trademark.'),
    commonsOther: word('{site} notes: other rights may apply.'),
    openPage: word('Open its page'),
    sources: word('Sources'),
    beforeApprove: word('Before you approve'),
    checkRule1: word("It's about a place, a service or how to do something, not a private person."),
    checkRule2: word("It's in the writer's own words, not copied."),
    checkRule3: word("You believe it's right, or the sources say so."),
    sourcesTick: word('I opened the sources and they say this.'),
    whyNot: word('Why not?'),
    reasonWordsLabel: word('Add a few words (the writer reads them)'),
    send: word('Send'),
    back: word('Back'),
    approveNewHint: word('Approving adds it to Learn and announces it in the Pulse.'),
    approveFixHint: word('Approving changes the page now.'),
    approve: word('Approve'),
    editFirst: word('Edit first'),
    notThisOne: word('Not this one'),
    approvedNew: word('Approved. It is in Learn.'),
    approvedFix: word('Approved. The page shows the fix now.'),
    declinedMember: word('Answered. The writer is told.'),
    declinedAssistant: word("Answered. It won't be added to Learn."),
    leaveEditAsk: word("Leave without approving? Your changes won't be kept."),
    leaveEditDiscard: word('Leave'),
    leaveEditStay: word('Stay'),
} as const;

/** The site's own name, never translated (a name, not BeanPool's Commons). */
export const COMMONS_SITE = 'Wikimedia Commons';

/** Event emitted when a draft is answered on /learn/check/[id] so /learn/check shows the confirmation banner. */
export const LEARN_CHECK_ANSWERED = 'learn_check_answered';

export interface LearnCheckListData {
    drafts: KnowledgeDraftToCheck[];
    total: number;
    unchecked: { total: number; rows: KnowledgeRow[] };
}

export const draftKindWord = (kind: string): string => (kind === 'fix' ? t(LEARN_CHECK_WORDS.kindFix) : t(LEARN_CHECK_WORDS.kindNew));

export const draftWaited = (iso: string, now = Date.now()): string => timeAgo(Math.max(0, now - (Date.parse(iso) || now)));

export const draftFromWords = (d: Pick<KnowledgeDraftToCheck, 'assistant' | 'from'>): string => (d.assistant
    ? t(LEARN_CHECK_WORDS.fromAssistant, { assistant: d.assistant, name: d.from.name })
    : t(LEARN_CHECK_WORDS.fromName, { name: d.from.name }));

export const commonsRestrictionNote = (code: string): string => (
    code === 'personality' ? t(LEARN_CHECK_WORDS.commonsPerson, { site: COMMONS_SITE })
        : code === 'trademarked' ? t(LEARN_CHECK_WORDS.commonsTrademark, { site: COMMONS_SITE })
            : t(LEARN_CHECK_WORDS.commonsOther, { site: COMMONS_SITE })
);

export const creditReadDate = (iso: string): string => {
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? formatDate(d, 'day-month-year') : '';
};

export const draftTagsText = (tags: readonly string[] | undefined): string =>
    (tags && tags.length > 0 ? tags.map((tag) => `#${tag}`).join(' ') : t(LEARN_CHECK_WORDS.none));

export function fixPartLabel(part: KnowledgeFixPart): string {
    switch (part) {
        case 'title': return t(LEARN_CHECK_WORDS.partTitle);
        case 'body': return t(LEARN_CHECK_WORDS.partBody);
        case 'topic': return t(LEARN_CHECK_WORDS.partTopic);
        case 'place': return t(LEARN_CHECK_WORDS.partPlace);
        case 'sources': return t(LEARN_CHECK_WORDS.partSources);
        case 'lang': return t(LEARN_CHECK_WORDS.partLang);
    }
}

export function fixPartText(part: KnowledgeFixPart, w: Pick<KnowledgePageWords, KnowledgeFixPart>): string {
    if (part === 'topic') return t(topicOf(w.topic).label);
    if (part === 'lang') return w.lang ? ((LANGUAGE_NAMES as Record<string, string>)[w.lang] ?? w.lang) : '';
    if (part === 'sources') return w.sources.map((s) => (s.label ? `${s.label} (${hostOf(s.url)})` : hostOf(s.url))).join('\n');
    return w[part] ?? '';
}

/** GET /api/knowledge/drafts?limit=50&offset=0: throws on network/HTTP failure. */
export async function readLearnToCheck(signal?: AbortSignal, url?: string | null): Promise<LearnCheckListData> {
    const opts = signal || url !== undefined
        ? { ...(signal ? { signal } : {}), ...(url !== undefined ? { anchorUrl: url } : {}) }
        : undefined;
    const res = await signedGet('/api/knowledge/drafts?limit=50&offset=0', opts);
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`) as Error & { status?: number; code?: string };
        err.status = res.status;
        if (typeof body?.code === 'string') err.code = body.code;
        throw err;
    }
    const r = await res.json();
    const drafts = Array.isArray(r?.drafts) ? (r.drafts as KnowledgeDraftToCheck[]) : [];
    const rows = Array.isArray(r?.unchecked?.rows) ? (r.unchecked.rows as KnowledgeRow[]) : [];
    return {
        drafts,
        total: typeof r?.total === 'number' ? r.total : drafts.length,
        unchecked: {
            total: typeof r?.unchecked?.total === 'number' ? r.unchecked.total : rows.length,
            rows,
        },
    };
}

/** GET /api/knowledge/drafts/:id: returns null on 404 (already answered), throws on other failures. */
export async function readLearnDraft(id: string, signal?: AbortSignal): Promise<KnowledgeDraftWhole | null> {
    const res = await signedGet(`/api/knowledge/drafts/${encodeURIComponent(id)}`, signal ? { signal } : undefined);
    if (res.status === 404) return null;
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const err = new Error(typeof body?.error === 'string' ? body.error : `HTTP ${res.status}`) as Error & { status?: number; code?: string };
        err.status = res.status;
        if (typeof body?.code === 'string') err.code = body.code;
        throw err;
    }
    const r = await res.json();
    return (r?.draft as KnowledgeDraftWhole | undefined) ?? null;
}

/** POST /api/knowledge/drafts/:id/approve, matching web's approveLearnDraft. */
export function approveLearnDraft(
    id: string,
    opts: { edits?: KnowledgeFormValues; lang?: string | null; checkedSources?: boolean; fix?: boolean; photos?: string[] } = {},
): Promise<unknown> {
    let payload: Record<string, unknown> = {};
    if (opts.edits) {
        const body = knowledgeFormBody({ ...opts.edits, photos: opts.fix ? [] : opts.edits.photos }, '') as Record<string, unknown>;
        delete body.lang;
        if (opts.lang) body.lang = opts.lang;
        if (opts.fix) delete body.photos;
        else body.photos = (opts.edits.photos ?? []).slice(0, KNOWLEDGE_LIMITS.photos);
        body.place = opts.edits.place.trim().slice(0, KNOWLEDGE_LIMITS.place);
        body.freeTags = [...(opts.edits.freeTags ?? [])];
        payload = body;
    } else if (!opts.fix && opts.photos) {
        payload = { photos: opts.photos.slice(0, KNOWLEDGE_LIMITS.photos) };
    }
    if (opts.checkedSources) payload.checkedSources = true;
    return signedRequestWithMethod('POST', `/api/knowledge/drafts/${encodeURIComponent(id)}/approve`, payload, { withStatus: true });
}

/** POST /api/knowledge/drafts/:id/no, matching web's declineLearnDraft. */
export function declineLearnDraft(id: string, reason: string, words: string): Promise<unknown> {
    const said = words.trim().slice(0, KNOWLEDGE_LIMITS.reasonWords);
    return signedRequestWithMethod('POST', `/api/knowledge/drafts/${encodeURIComponent(id)}/no`, {
        reason,
        ...(said ? { words: said } : {}),
    }, { withStatus: true });
}
