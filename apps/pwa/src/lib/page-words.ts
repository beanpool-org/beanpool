/**
 * The web app's tab title and page description, in the language the screens are in (translation index item 13; words-wire-2).
 *
 * index.html carries the English for a visit before the app runs and for whatever reads the file without running it (a link
 * preview, a search engine); once the app's words are in, lib/language.ts calls applyPageWords() after every language change
 * and this sets both from the words layer, so a member who reads Russian sees a Russian description and a badge in the
 * place their language puts it. A language with no translation of a sentence keeps the English (never a failure).
 *
 * The tab title is the app's name, with the Chat badge's number in front when something is waiting, so a tab in the
 * background still says a message is waiting (App.tsx hands the number to setTitleUnread). Keeping the number here, not in
 * App.tsx's effect alone, is what lets a language switch redraw the title with the badge still on it.
 */
import { t } from '@beanpool/core';

let unread = 0;

/** "BeanPool", or "(3) BeanPool" with 3 chats waiting ("(99+)" past 99). The count is a placeholder: a language may put it elsewhere. */
export function pageTitle(unreadCount: number): string {
    return unreadCount > 0
        ? t('({count}) BeanPool', { count: unreadCount > 99 ? '99+' : unreadCount }, 'tab title')
        : t('BeanPool');
}

/** What the page says it is, for the browser and for anything that shows a summary of the page. Same as index.html's, in English. */
export function pageDescription(): string {
    return t('BeanPool — Local-first independent community marketplace', undefined, 'page description');
}

/** Sets the tab's title and the page's description in the language `t()` reads now. */
export function applyPageWords(doc: Document = document): void {
    doc.title = pageTitle(unread);
    doc.querySelector('meta[name="description"]')?.setAttribute('content', pageDescription());
}

/** The Chat badge's number changed: the tab title follows. */
export function setTitleUnread(count: number, doc?: Document): void {
    unread = count;
    applyPageWords(doc);
}

/** Tests only: forget the badge, as a new page load would. */
export function resetPageWordsForTests(): void {
    unread = 0;
}
