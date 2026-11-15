/**
 * Keeping Local knowledge right on the phone (slice K5 B; DESIGN-local-knowledge-fable.md §3.2 items 9-11, §3.5, §2.4, §2.10;
 * the node is #3203): the page's words, who is offered which action, and what "Suggest a fix" sends. The web says the same in
 * apps/pwa/src/lib/learn.ts (learnPageActions, learnFixToSend) with the same sentences. Pure: the screens are
 * components/learn/KnowledgeDetail.tsx and app/learn/new.tsx.
 */
import { KNOWLEDGE_LIMITS, word } from '@beanpool/core';
import type { KnowledgePage } from '../../utils/learn-copy';
import { knowledgeFormBody, type KnowledgeFormValues } from './learn-write';

export const LEARN_KEEP = {
    helped: word('👍 This helped'),
    helpedDone: word('👍 Helped ✓'),
    fixAsk: word('Something changed? Suggest a fix'),
    fix: word('Suggest a fix'),
    edit: word('Edit'),
    stillRight: word('Still right'),
    stillRightDone: word('Still right ✓'),
    markOutdated: word('Mark as out of date'),
    clearMark: word('Clear the mark'),
    outdatedHint: word('What may be out of date? (optional)'),
    cancel: word('Cancel'),
    noteLabel: word('WHAT CHANGED? *'),
    noteHint: word('e.g. The tip is closed on Mondays since March'),
    noNote: word('Say what changed.'),
    fixLine: word('An owner or admin checks it first. The page stays as it is until then.'),
    save: word('Save'),
    // An owner's or admin's "Edit" opens on the node's page: not reached, it says so (the words other screens already say).
    unreached: word("Couldn't reach your community. Check your connection and try again."),
    again: word('Try again'),
} as const;

/** Which of a page's actions a reader is offered (§2.4). */
export interface PageActions {
    /** "👍 This helped": any member but the page's writer. */
    helped: boolean;
    /** "Something changed? Suggest a fix": a member, the writer too (their own fix waits as well); never an owner or admin. */
    fix: boolean;
    /** An owner or admin: "Edit" (at once) and "Still right" (re-stamps Checked). */
    edit: boolean;
    stillRight: boolean;
    /** "Mark as out of date" with a note: the writer, an owner or an admin, while it isn't marked. */
    markOutdated: boolean;
    /** "Clear the mark": an owner or admin, while it is marked. */
    clearMark: boolean;
}

/**
 * The actions on a page for one reader. No key (a visitor) and anything but a live Learn (off, or the worldwide community's
 * preview) take none: the page is read, and nothing is offered that the node would refuse. `checks`: an owner or admin here.
 */
export function pageActions(f: { signedIn: boolean; live: boolean; own: boolean; checks: boolean; outdated: boolean }): PageActions {
    if (!f.signedIn || !f.live) return { helped: false, fix: false, edit: false, stillRight: false, markOutdated: false, clearMark: false };
    return {
        helped: !f.own,
        fix: !f.checks,
        edit: f.checks,
        stillRight: f.checks,
        markOutdated: (f.own || f.checks) && !f.outdated,
        clearMark: f.checks && f.outdated,
    };
}

/** The form filled with a page as it shows: "Suggest a fix" and "Edit" start from it. Never its photos (a fix changes words). */
export function formOfPage(page: KnowledgePage): KnowledgeFormValues {
    return {
        title: page.title ?? '',
        body: page.description ?? '',
        topic: page.category ?? '',
        place: page.knowledge?.place ?? '',
        sources: (page.knowledge?.sources ?? []).map((s) => ({ url: s.url, label: s.label ?? '' })),
        photos: [],
    };
}

const sourcesKey = (sources: ReadonlyArray<{ url: string; label?: string }>) => JSON.stringify(sources.map((s) => [s.url.trim(), (s.label ?? '').trim()]));

/**
 * What "Suggest a fix" sends (§3.5): the page it names, "What changed?", and only the parts the member changed from `page`, the
 * page the form opened on (app/learn/new.tsx keeps it; never the copy as a later sync left it: review of #3218). The phone's copy
 * may be older than the node's page: a part sent unchanged from it would read as a change (PR #3203, "For K5 B"), so an untouched
 * part is never sent. Never photos (the node refuses them on a fix), never a language.
 */
export function fixBody(page: KnowledgePage, form: KnowledgeFormValues, note: string): Record<string, unknown> {
    const now = knowledgeFormBody({ ...form, photos: [] }, '');
    const was = formOfPage(page);
    const out: Record<string, unknown> = { fixOf: page.id, note: note.trim().slice(0, KNOWLEDGE_LIMITS.changeNote) };
    if (now.title !== was.title.trim()) out.title = now.title;
    if (now.body !== was.body.trim()) out.body = now.body;
    if (now.topic !== was.topic) out.topic = now.topic;
    if ((now.place ?? '') !== was.place.trim()) out.place = now.place ?? '';
    if (sourcesKey(now.sources) !== sourcesKey(was.sources)) out.sources = now.sources;
    return out;
}

/** What an owner's or admin's "Edit" sends: the whole form, in the page's own language (the writer's, §2.8), never photos. */
export function editBody(page: KnowledgePage, form: KnowledgeFormValues): Record<string, unknown> {
    const words: Record<string, unknown> = { ...knowledgeFormBody({ ...form, photos: [] }, '') };
    delete words.photos;
    delete words.lang;
    return { ...words, place: words.place ?? '', ...(page.knowledge?.lang ? { lang: page.knowledge.lang } : {}) };
}
