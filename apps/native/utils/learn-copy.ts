/**
 * Learn on the phone, worked out from the phone's own copy of the pages (utils/db.ts `knowledge_posts`). No React Native
 * imports, so vitest can hold it to the design (scratch/fable-design/DESIGN-local-knowledge-fable.md as amended, §A3 "the
 * Learn screen", §2.7 "In Learn").
 *
 * The node answers the same questions from its own rows (GET /api/knowledge/front, apps/server engine/knowledge.ts), with
 * the same row, the same order (@beanpool/core `compareKnowledge`) and the same scoring, so Learn reads the same online and
 * offline. A row is what the row card draws: never the body, only its first line.
 */
import {
    KNOWLEDGE_FRONT_ROWS, KNOWLEDGE_SEARCH_MAX, KNOWLEDGE_TOPICS, KNOWLEDGE_TOPIC_PAGE, compareKnowledge, knowledgeFirstLine,
    knowledgeTopic, pinLive,
    type KnowledgeFront, type KnowledgeRow, type KnowledgeSearch, type KnowledgeTopicPage,
} from '@beanpool/core';

/** A page as the node sent it and the phone kept it (utils/db.ts getKnowledgePosts): the fields Learn reads. */
export interface KnowledgePage {
    id: string;
    title: string;
    description: string;
    category: string;
    photos?: string[];
    createdAt?: string;
    updatedAt?: string;
    pinnedUntil?: string;
    pinnedAt?: string;
    status?: string;
    active?: boolean | number;
    hiddenByReportsAt?: string | null;
    authorPublicKey?: string;
    authorCallsign?: string;
    knowledge?: {
        sources?: Array<{ url: string; label: string }>;
        place?: string | null;
        lang?: string | null;
        checkedAt?: string;
        outdatedAt?: string | null;
        outdatedNote?: string | null;
        helped?: number;
        gathered?: boolean;
    };
}

// Example Valley's sample pages, for the worldwide community's preview, are read with the other samples, by the preview
// components alone (components/showcase/sample-screens.ts samplePages).

/** Whether a page shows in Learn: active, not hidden by reports (the node's own filter, engine/knowledge.ts showingTo). */
export function pageShows(page: KnowledgePage): boolean {
    if (!page || typeof page.id !== 'string' || typeof page.title !== 'string') return false;
    if (page.active === 0 || page.active === false) return false;
    if (page.status !== undefined && page.status !== 'active') return false;
    return !page.hiddenByReportsAt;
}

/** The row card's fields of a page (the node's knowledgeRowOf): never the body, only its first line. */
export function rowOfPage(page: KnowledgePage, now: number = Date.now()): KnowledgeRow {
    return {
        id: page.id,
        title: page.title,
        line: knowledgeFirstLine(page.description ?? ''),
        topic: page.category,
        photo: page.photos?.[0] ?? null,
        checkedAt: page.knowledge?.checkedAt ?? page.createdAt ?? '',
        helped: page.knowledge?.helped ?? 0,
        pinned: pinLive({ pinnedUntil: page.pinnedUntil, status: 'active', active: true, type: 'knowledge' } as any, now),
        outdated: !!page.knowledge?.outdatedAt,
    };
}

/** The reader's own collation for "title A to Z in the reader's language order", where the phone has one. */
export type TitleCompare = (a: string, b: string) => number;

/** Every showing page as a row, in Learn's order (@beanpool/core compareKnowledge: topic, then not-outdated, pinned, helped, title). */
export function learnRows(pages: readonly KnowledgePage[], now: number = Date.now(), compareTitles?: TitleCompare): KnowledgeRow[] {
    return pages.filter(pageShows).map((p) => rowOfPage(p, now)).sort((a, b) => compareKnowledge(a, b, compareTitles));
}

/** Learn's front from the copy: the pinned pages, then each topic that holds something, its count and its first three rows. */
export function learnFront(pages: readonly KnowledgePage[], now: number = Date.now(), compareTitles?: TitleCompare): KnowledgeFront {
    const rows = learnRows(pages, now, compareTitles);
    const topics = KNOWLEDGE_TOPICS.map((t) => {
        const of = rows.filter((r) => r.topic === t.id);
        return { id: t.id as string, count: of.length, rows: of.slice(0, KNOWLEDGE_FRONT_ROWS) };
    }).filter((t) => t.count > 0);
    return { total: rows.length, pinned: rows.filter((r) => r.pinned), topics };
}

/** One topic from the copy: every row in Learn's order, a page at a time (`offset`), as the node pages it. */
export function learnTopic(pages: readonly KnowledgePage[], topic: string, offset = 0, now: number = Date.now(), compareTitles?: TitleCompare): KnowledgeTopicPage {
    const rows = learnRows(pages, now, compareTitles).filter((r) => r.topic === topic);
    return {
        topic,
        count: rows.length,
        rows: rows.slice(offset, offset + KNOWLEDGE_TOPIC_PAGE),
        next: offset + KNOWLEDGE_TOPIC_PAGE < rows.length ? offset + KNOWLEDGE_TOPIC_PAGE : null,
    };
}

/** The words of a search: lower case, split on white space, empty pieces dropped. */
export function searchTerms(words: string): string[] {
    return (typeof words === 'string' ? words : '').toLowerCase().split(/\s+/).filter((w) => w.length > 0);
}

/**
 * A plain match over the phone's own copy, for when the node can't be asked (amended §2.7): the title, the place, the body and
 * the topic's words. As the node's search reads the words, a page matches when ANY word is found (its full text search ORs the
 * words), and the more of them it holds the higher it ranks: a word in the title counts most (3), then in the place (2), then in
 * the body or the topic's words (1); ties in Learn's order; at most KNOWLEDGE_SEARCH_MAX rows. Plain substring matching, so a
 * script written without spaces matches as well.
 */
export function learnSearch(pages: readonly KnowledgePage[], words: string, now: number = Date.now(), compareTitles?: TitleCompare): KnowledgeSearch {
    const terms = searchTerms(words);
    if (terms.length === 0) return { total: 0, rows: [] };
    const scored: Array<{ score: number; row: KnowledgeRow }> = [];
    for (const page of pages.filter(pageShows)) {
        const title = page.title.toLowerCase();
        const place = (page.knowledge?.place ?? '').toLowerCase();
        const body = (page.description ?? '').toLowerCase();
        const topic = knowledgeTopic(page.category);
        const topicWords = topic ? `${topic.keywords} ${topic.label}`.toLowerCase() : '';
        let score = 0;
        for (const w of terms) {
            score += (title.includes(w) ? 3 : 0) + (place.includes(w) ? 2 : 0) + (body.includes(w) || topicWords.includes(w) ? 1 : 0);
        }
        if (score > 0) scored.push({ score, row: rowOfPage(page, now) });
    }
    scored.sort((a, b) => b.score - a.score || compareKnowledge(a.row, b.row, compareTitles));
    return { total: scored.length, rows: scored.slice(0, KNOWLEDGE_SEARCH_MAX).map((s) => s.row) };
}
