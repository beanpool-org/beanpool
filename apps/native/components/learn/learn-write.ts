/**
 * Writing Local knowledge on the phone (slice K4; DESIGN-local-knowledge-fable.md §3.3 and §3.4, as amended §3.3/§3.4): the
 * words of Learn's button, the form and My suggestions, the checks the form makes before it sends, and what it sends where.
 * English is the key, the design's own sentences, the same the web shows; each reaches a screen through t() where it is drawn.
 * Pure: the screens are app/learn/new.tsx and app/learn/mine.tsx.
 */
import {
    KNOWLEDGE_DECLINE_REASONS, formatDate, isKnowledgeTopic, t, tn, word, wordn, type KnowledgeDraftMine, type KnowledgeSource,
} from '@beanpool/core';

export const LEARN_WRITE = {
    /** Learn's button, fixed at the bottom: a member's, and an owner's or admin's (theirs publishes at once). */
    suggest: word('＋ Suggest knowledge'),
    add: word('＋ Add local knowledge'),
    /** The same door in Learn's empty search, plain. */
    suggestPlain: word('Suggest knowledge'),
    /** Learn's line for a member with something waiting, to My suggestions. */
    waiting: wordn('{n} of yours is waiting for an admin ›', '{n} of yours are waiting for an admin ›'),
    formBox: word('Share something worth knowing about this place: how something works, where to go, who to call. Not about private people. In your own words.'),
    titleLabel: word('TITLE *'),
    titleHint: word('e.g. How recycling works at the tip'),
    bodyLabel: word('WHAT TO KNOW *'),
    bodyHint: word('Put the answer first. Then the details.'),
    topicLabel: word('TOPIC *'),
    placeLabel: word('WHERE (OPTIONAL)'),
    placeHint: word('e.g. The tip on Manse Road'),
    sourcesLabel: word('WHERE CAN PEOPLE CHECK THIS? (OPTIONAL)'),
    addLink: word('Add a link'),
    linkLabelHint: word('What is this page? (optional)'),
    removeLink: word('Remove this link'),
    photoLabel: word('PHOTO (OPTIONAL)'),
    addPhoto: word('📷 Add a photo'),
    photoLine: word('Your own photo. Without one, a picture for the topic is shown.'),
    removePhoto: word('Remove photo'),
    send: word('Send to the admins'),
    publish: word('Publish'),
    sendLine: word('An owner or admin checks it before anyone sees it.'),
    publishLine: word('It goes into Learn, and the Pulse announces it.'),
    sentTitle: word('Sent'),
    sentLine: word('An owner or admin will check it. You’ll hear back here.'),
    publishedTitle: word('Published'),
    publishedLine: word('It’s in Learn.'),
    openLearn: word('Open Learn'),
    done: word('Done'),
    noTitle: word('Give it a title.'),
    noBody: word('Write what people should know.'),
    noTopic: word('Pick a topic.'),
    badLink: word('A link must start with https:// or http://'),
    couldNotSend: word('Couldn’t send it. Check your connection and try again.'),
    mineTitle: word('My suggestions'),
    kindNew: word('New', 'My suggestions: a suggested new page of Local knowledge, not a fix'),
    kindFix: word('Fix', 'My suggestions: a suggested fix to a page of Local knowledge'),
    waitingSince: word('Waiting since {date}'),
    takeBack: word('Take it back'),
    takeBackAsk: word('Take this back? The admins won’t see it.'),
    keep: word('Keep it'),
    added: word('Added'),
    notAdded: word('Not added: {reason}'),
} as const;

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

/** The first thing the form must say before it sends (§3.3's refusals, in the form's order), or null when it can send. */
export function knowledgeFormProblem(v: KnowledgeFormValues) {
    if (!v.title.trim()) return LEARN_WRITE.noTitle;
    if (!v.body.trim()) return LEARN_WRITE.noBody;
    if (!isKnowledgeTopic(v.topic)) return LEARN_WRITE.noTopic;
    if (linked(v.sources).some((s) => !isWebLink(s.url))) return LEARN_WRITE.badLink;
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
