/**
 * The words and small helpers Learn's screens share (DESIGN-local-knowledge-fable.md §3.1 as amended, §3.2). English is the key;
 * every sentence reaches a screen through t() where it is drawn.
 */
import { formatDate, knowledgeTopic, word, type WordKey } from '@beanpool/core';

/** "Nov 2026" for an ISO instant, in the reader's language; an empty string for one that doesn't read. */
export function monthYear(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? formatDate(d, 'month-year') : '';
}

/** Whether a page was last checked more than a year ago (amber "Checked over a year ago", §3.1). */
export function checkedOverAYearAgo(iso: string | null | undefined, now: number = Date.now()): boolean {
    if (!iso) return false;
    const at = Date.parse(iso);
    return Number.isFinite(at) && now - at > 365 * 24 * 60 * 60 * 1000;
}

/** A topic's emoji and its label key (an unknown topic, which a newer node may send, reads as Good to know's). */
export function topicOf(id: string): { id: string; emoji: string; label: WordKey } {
    const topic = knowledgeTopic(id) ?? knowledgeTopic('good-to-know')!;
    return { id: topic.id, emoji: topic.emoji, label: topic.label };
}

export const LEARN_LINES = {
    back: word('Back'),
    searchPlaceholder: word('Search Learn'),
    allTopics: word('All topics'),
    pinned: word('📌 PINNED'),
    outdatedChip: word('MAY BE OUT OF DATE'),
    emptyTitle: word('Nothing here yet. Know something locals should know?'),
    emptySearch: word('Nothing in Learn for "{words}".'),
    searchMarket: word('Search the Market for "{words}" ›'),
    seeAll: word('See all {n} ›'),
    offline: word("Couldn't reach your community; showing what we had."),
    loading: word('Loading Learn…'),
    off: word('Learn isn’t part of this community.'),
    kindHeader: word('LOCAL KNOWLEDGE'),
    outdatedBox: word('This may be out of date.'),
    markedOn: word('Marked {date}'),
    where: word('Where: {place}'),
    sources: word('SOURCES'),
    checked: word('Checked {date}'),
    checkedOver: word('Checked over a year ago'),
    helped: word('Helped {n}'),
    writtenBy: word('WRITTEN BY'),
    gathered: word('Gathered with the assistant from the sources above.'),
    gatheredChecked: word('Gathered with the assistant from the sources above. Checked by {name}.'),
    writtenIn: word('Written in {language}'),
    notFound: word('This page isn’t in Learn any more.'),
    report: word('🚩 Report'),
    reported: word('Reported'),
    previewLine: word('Local knowledge is written by the people who know a place, and an owner or admin checks each page. Here anyone may join with 12 words, so nobody can yet check who is who.'),
    previewTitle: word('Why Learn lives in a local community'),
    marketLine: word('📖 In Learn: {n} for "{words}" ›'),
} as const;
