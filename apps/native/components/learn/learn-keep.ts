/**
 * Keeping Local knowledge right on the phone (slice K5 B; DESIGN-local-knowledge-fable.md §3.2 items 9-11, §3.5, §2.4, §2.10;
 * the node is #3203): the page's words, who is offered which action, and what "Suggest a fix" sends. The web says the same in
 * apps/pwa/src/lib/learn.ts (learnPageActions, learnFixToSend) with the same sentences. Pure: the screens are
 * components/learn/KnowledgeDetail.tsx and app/learn/new.tsx.
 *
 * Pictures on a page (DESIGN-learn-web-pictures-fable.md §9 slice 4; Marty, 22 Nov 2026, "All six of Fable's picks"): an owner's
 * or admin's Edit lists the page's pictures, each with Remove photo, and sends the ones it keeps, each as the page gave it
 * (pagePhotosKept), as the web's LearnForm does. Edit and Suggest a fix list and send the page's own sources only: the node's
 * credit rows for its pictures are never in a form (formOfPage).
 */
import { KNOWLEDGE_LIMITS, knowledgeTagsDiffer, ownKnowledgeSources, word } from '@beanpool/core';
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
    // An owner's or admin's Edit of a page with pictures (slice 4): the web's words for the same list (LearnForm).
    photosLine: word('A photo you remove is taken off this page for everyone when you save.'),
    keepPhoto: word('Keep this photo'),
    /** What a screen reader hears for each picture's button: which picture it is (review of #3353, N6). */
    removePhotoN: word('Remove photo {n}'),
    keepPhotoN: word('Keep photo {n}'),
    photoN: word('Photo {n}'),
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

/**
 * The form filled with a page as it shows: "Suggest a fix" and "Edit" start from it. Never its photos (a fix changes words; an
 * Edit lists them apart, pagePhotosOf). Its own sources only: a credit row the node wrote for a picture (core KnowledgeSource
 * `photo`) is the node's, so the form neither shows it nor sends it, and the node keeps it whatever is sent (§6.3).
 */
export function formOfPage(page: KnowledgePage): KnowledgeFormValues {
    return {
        title: page.title ?? '',
        body: page.description ?? '',
        topic: page.category ?? '',
        place: page.knowledge?.place ?? '',
        sources: ownKnowledgeSources(page.knowledge?.sources ?? []).map((s) => ({ url: s.url, label: s.label ?? '' })),
        photos: [],
        freeTags: [...(page.freeTags ?? [])],
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
    // Its tags are a part as its words are (the node's FIX_PARTS): sent only when changed, [] when all were taken off.
    if (knowledgeTagsDiffer(form.freeTags, was.freeTags)) out.freeTags = [...(form.freeTags ?? [])];
    return out;
}

/**
 * A page's pictures as the page gave them (`photos`: the node's addresses, `/api/marketplace/posts/<id>/photos/<n>?v=…&k=…`),
 * what an Edit lists, in order. Kept as given, never resolved or rebuilt: the node matches each it is sent back by its place and
 * its version (apps/server engine/knowledge.ts keptPagePhotos).
 */
export function pagePhotosOf(page: KnowledgePage | null | undefined): string[] {
    return (page?.photos ?? []).filter((p): p is string => typeof p === 'string' && p.trim() !== '');
}

/**
 * The pictures an Edit keeps, from `pictures` (pagePhotosOf of the page the form opened on: a snapshot, never the page as a later
 * read or sync left it) and the places taken off: null when none was taken off, so an Edit of the words alone sends no list and
 * never meets another owner's or admin's photo change; [] when every one was. After the node's "This page's photos changed"
 * (409 `photos_changed`) the form still holds the same snapshot and the same marks, so a second Save is refused again and never
 * takes off a picture nobody chose (review of #3353, N1).
 */
export function pagePhotosKept(pictures: readonly string[], takenOff: readonly number[]): string[] | null {
    if (!takenOff.some((i) => i >= 0 && i < pictures.length)) return null;
    return pictures.filter((_, i) => !takenOff.includes(i));
}

/**
 * Where a picture of the page is drawn from: the node's own address put in front of a path the node gave (as the copy's
 * listings are, utils/db.ts), an http(s) address as it is, anything else not drawn. Only for drawing: what is sent back is the
 * address as the page gave it (pagePhotosKept).
 */
export function pagePhotoUri(src: string, anchor: string | null | undefined): string | null {
    const at = src.trim();
    if (at.startsWith('/') && !at.startsWith('//')) return anchor ? `${anchor.replace(/\/+$/, '')}${at}` : null;
    return /^https?:\/\//i.test(at) ? at : null;
}

/**
 * What an owner's or admin's "Edit" sends: the whole form, its tags included ([] takes them off), in the page's own language
 * (the writer's, §2.8), never a new photo. `keep` (pagePhotosKept): when a picture was taken off, the pictures the page keeps,
 * each as the page gave it; the node takes the rest off for everyone, or refuses, 409 `photos_changed`, when another owner or
 * admin changed them after the form opened. Null: no list, and the pictures stay as they are.
 */
export function editBody(page: KnowledgePage, form: KnowledgeFormValues, keep: readonly string[] | null = null): Record<string, unknown> {
    const words: Record<string, unknown> = { ...knowledgeFormBody({ ...form, photos: [] }, '') };
    delete words.photos;
    delete words.lang;
    return {
        ...words, place: words.place ?? '', freeTags: [...(form.freeTags ?? [])], ...(page.knowledge?.lang ? { lang: page.knowledge.lang } : {}),
        ...(keep ? { photos: [...keep] } : {}),
    };
}

/**
 * The event an Edit hands the node's page back on (its answer after a save, or the page read again after "This page's photos
 * changed"), so the page behind the form shows it at once, until the phone's copy catches up (KnowledgeDetail's `answered`).
 */
export const LEARN_PAGE_READ = 'learn_page_read';
