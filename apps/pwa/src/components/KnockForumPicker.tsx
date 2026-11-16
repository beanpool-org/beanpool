import { useId } from 'react';
import { FORUM_ASK_PICKER_WORDS, FORUM_ASK_POSTS, forumAskPickView, t } from '@beanpool/core';
import type { ForumAskPicks } from '../lib/forum-ask-picks';

/**
 * On the Ask to join form (components/AskToJoin.tsx): "Add up to three of your worldwide forum posts (optional)", the asker's
 * own posts there, tap to pick, tap again to take it off (forums F11b, DESIGN-forums-fable.md §13; the list and what is sent:
 * lib/forum-ask-picks.ts). Nothing is drawn without a list: no posts, or not on the worldwide community. Each row shows the
 * topic's title as the forum gave it and where the post is in it. The phone's twin is
 * apps/native/components/KnockForumPicker.tsx.
 */
export function KnockForumPicker({ picks, testId = 'knock-forum-picker' }: { picks: ForumAskPicks; testId?: string }) {
    const id = useId();
    const { offered, picked, toggle } = picks;
    if (!offered || offered.posts.length === 0) return null;
    const full = picked.length >= FORUM_ASK_POSTS;
    return (
        <fieldset className="m-0 mt-3 p-0 border-0 min-w-0" aria-describedby={`${id}-about`} data-testid={testId}>
            <legend className="p-0 mb-1 text-sm font-bold text-nature-900 dark:text-nature-100 break-words">{t(FORUM_ASK_PICKER_WORDS.heading)}</legend>
            <p id={`${id}-about`} className="m-0 mb-2 text-xs text-nature-600 dark:text-nature-300 break-words">{t(FORUM_ASK_PICKER_WORDS.about)}</p>
            <div className="flex flex-col gap-2 min-w-0">
                {offered.posts.map((p) => {
                    const on = picked.includes(p.postId);
                    const waiting = full && !on;
                    const v = forumAskPickView(p);
                    return (
                        <button
                            key={p.postId}
                            type="button"
                            role="checkbox"
                            aria-checked={on}
                            disabled={waiting}
                            onClick={() => toggle(p.postId)}
                            data-testid={`${testId}-${p.postId}`}
                            className="flex items-start gap-3 p-3 rounded-xl border border-nature-300 dark:border-nature-700 bg-white dark:bg-nature-900 hover:bg-nature-50 dark:hover:bg-nature-800 text-left cursor-pointer disabled:cursor-default disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand min-w-0 min-h-[48px]"
                        >
                            <span
                                aria-hidden="true"
                                className={`w-6 h-6 rounded-md border flex items-center justify-center font-bold text-sm shrink-0 ${
                                    on
                                        ? 'bg-bp-commit-fill border-transparent text-bp-commit-on'
                                        : 'border-nature-400 dark:border-nature-600 bg-white dark:bg-nature-950'
                                }`}
                            >
                                {on ? '✓' : null}
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block text-sm font-bold text-nature-900 dark:text-white break-words">{v.title}</span>
                                {/* A space between the two, so the button's name reads "title Post 4", not "titlePost 4". */}
                                {' '}
                                <span className="block text-xs text-nature-600 dark:text-nature-300 break-words">{v.where}</span>
                            </span>
                        </button>
                    );
                })}
            </div>
            {full && <p role="status" className="m-0 mt-2 text-xs text-nature-600 dark:text-nature-300 break-words" data-testid={`${testId}-full`}>{t(FORUM_ASK_PICKER_WORDS.full)}</p>}
        </fieldset>
    );
}
