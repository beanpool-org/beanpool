/**
 * Writing Local knowledge on the phone (slice K4; DESIGN-local-knowledge-fable.md §3.3 and §3.4, as amended §3.3/§3.4): the
 * checks the form makes before it sends, what it sends where, and how My suggestions words a row. The words are core's one table
 * for both apps (@beanpool/core KNOWLEDGE_WRITE_WORDS), so the phone and the web say the same thing; each reaches a screen
 * through t() where it is drawn. Pure: the screens are app/learn/new.tsx and app/learn/mine.tsx.
 */
import {
    KNOWLEDGE_DECLINE_REASONS, KNOWLEDGE_WRITE_WORDS, formatDate, isKnowledgeTopic, t, tn, type KnowledgeDraftMine, type KnowledgeSource,
} from '@beanpool/core';

/** Core's words for writing Local knowledge, under the name the phone's Learn screens read. */
export const LEARN_WRITE = KNOWLEDGE_WRITE_WORDS;

/** What the form holds while the member writes. A link row the member opened but left as "https://" is no link. */
export interface KnowledgeFormValues {
    title: string;
    body: string;
    topic: string;
    place: string;
    sources: KnowledgeSource[];
    /** The member's own photos as data URLs (utils/post-photo.ts), at most KNOWLEDGE_LIMITS.photos. */
    photos: string[];
}

export const EMPTY_KNOWLEDGE_FORM: KnowledgeFormValues = Object.freeze({ title: '', body: '', topic: '', place: '', sources: [], photos: [] }) as KnowledgeFormValues;

/** What a fresh link row holds, so the member types the rest. */
export const LINK_START = 'https://';

const linked = (sources: readonly KnowledgeSource[]) => sources.filter((s) => {
    const url = s.url.trim();
    return url !== '' && url !== LINK_START;
});

const isWebLink = (url: string): boolean => {
    const lower = url.trim().toLowerCase();
    return (lower.startsWith('https://') && lower.length > 'https://'.length) || (lower.startsWith('http://') && lower.length > 'http://'.length);
};

/**
 * The first thing the form must say before it sends (§3.3's refusals, in the form's order), in the member's language, or null
 * when it can send.
 */
export function knowledgeFormProblem(v: KnowledgeFormValues): string | null {
    if (!v.title.trim()) return t(LEARN_WRITE.noTitle);
    if (!v.body.trim()) return t(LEARN_WRITE.noBody);
    if (!isKnowledgeTopic(v.topic)) return t(LEARN_WRITE.noTopic);
    if (linked(v.sources).some((s) => !isWebLink(s.url))) return t(LEARN_WRITE.badLink);
    return null;
}

/** What the form sends (POST /api/knowledge/drafts or /posts): trimmed, with only the links filled in and the writer's language. */
export function knowledgeFormBody(v: KnowledgeFormValues, lang: string): {
    title: string; body: string; topic: string; place?: string; sources: KnowledgeSource[]; lang: string; photos?: string[];
} {
    const place = v.place.trim();
    return {
        title: v.title.trim(),
        body: v.body.trim(),
        topic: v.topic,
        ...(place ? { place } : {}),
        sources: linked(v.sources).map((s) => ({ url: s.url.trim(), label: s.label.trim() })),
        lang,
        ...(v.photos.length > 0 ? { photos: [...v.photos] } : {}),
    };
}

/** Where it goes: a member's suggestion waits for an owner or admin; an owner's or admin's own page publishes at once. */
export function knowledgeFormPath(checks: boolean): '/api/knowledge/posts' | '/api/knowledge/drafts' {
    return checks ? '/api/knowledge/posts' : '/api/knowledge/drafts';
}

/**
 * A refusal as the form and My suggestions show it: the node's own sentence (it answers in the member's language) only when the
 * node answered, else "Couldn't send it. Check your connection and try again.". utils/db.ts signedRequestWithMethod adds `status`
 * only to an answer; a dropped connection throws the client's own English ("Network request failed", "You are off-grid…"), and an
 * answer without the node's words (`unsaid`: a proxy's page, an empty 500) is no answer. The app's rule (app/shop/mine.tsx), and
 * the web's learnRefusalText says the same.
 */
export function learnRefusal(e: unknown): string {
    const err = (e ?? {}) as { message?: unknown; status?: unknown; unsaid?: unknown };
    const answered = typeof err.status === 'number' && err.unsaid !== true && typeof err.message === 'string' && err.message.trim() !== '';
    return answered ? (err.message as string) : t(LEARN_WRITE.couldNotSend);
}

/** The node's code on a refusal (`publish_instead`, `admins_only`, `not_found`…), or undefined. */
export function refusalCode(e: unknown): string | undefined {
    const code = (e as { code?: unknown } | null | undefined)?.code;
    return typeof code === 'string' ? code : undefined;
}

/** A row's state on My suggestions: "Waiting since 3 Nov", "Added", or "Not added: {reason}" in the member's words. */
export function mineRowStatus(d: Pick<KnowledgeDraftMine, 'state' | 'createdAt' | 'reason'>): string {
    if (d.state === 'approved') return t(LEARN_WRITE.added);
    if (d.state === 'declined') {
        const reason = KNOWLEDGE_DECLINE_REASONS.find((r) => r.id === d.reason) ?? KNOWLEDGE_DECLINE_REASONS[KNOWLEDGE_DECLINE_REASONS.length - 1];
        return t(LEARN_WRITE.notAdded, { reason: t(reason.label) });
    }
    const at = new Date(d.createdAt);
    return t(LEARN_WRITE.waitingSince, { date: Number.isFinite(at.getTime()) ? formatDate(at, 'day-month') : '' });
}

/** Learn's line for a member with suggestions waiting: "1 of yours is waiting for an admin ›". */
export function waitingLine(n: number): string {
    return tn(n, LEARN_WRITE.waiting.one, LEARN_WRITE.waiting.other, { n });
}
