import { useState } from 'react';
import {
    FORUM_ASK_WORDS, checkKnockForumPost, knockForumRowView, t,
    type KnockForum, type KnockForumPost, type KnockForumRowState,
} from '@beanpool/core';

/**
 * Under a request to join (components/WantsToJoin.tsx): up to three of the asker's posts on the worldwide forum (forums F11,
 * DESIGN-forums-fable.md §13). A row reads "A post on the worldwide forum ›" until a tap reads the post there (its public JSON,
 * opened to other origins for this one read) and checks who wrote it (@beanpool/core checkKnockForumPost); then it shows the
 * forum's own title and words. Everything on the row is @beanpool/core knockForumRowView: nothing the request carried is drawn
 * as the forum's. No score, no count. The request is answered the same whatever the check says. The phone's
 * components/KnockForumPosts.tsx is its twin, word for word.
 */
export function KnockForumPosts({ forum, knockId }: { forum: KnockForum; knockId: string }) {
    const [checks, setChecks] = useState<Record<string, KnockForumRowState>>({});

    const check = async (p: KnockForumPost) => {
        if (checks[p.postId] === 'checking') return;
        setChecks(c => ({ ...c, [p.postId]: 'checking' }));
        const result = await checkKnockForumPost(forum.at, p);
        setChecks(c => ({ ...c, [p.postId]: result }));
    };

    return (
        <ul className="m-0 mt-2.5 p-0 list-none flex flex-col gap-2" data-testid={`knock-forum-${knockId}`}>
            {forum.posts.map(p => {
                const c = checks[p.postId];
                const v = knockForumRowView(forum.at, p, c);
                // The same post can sit under two requests (the case the check is for): the line's id names the request too.
                const lineId = `knock-forum-check-${knockId}-${p.postId}`;
                const tone = v.tone === 'same' ? 'text-bp-ink-success font-bold' : v.tone === 'other' ? 'text-bp-ink-warning font-bold' : 'text-nature-700 dark:text-nature-200';
                return (
                    <li key={p.postId} className="rounded-xl border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-900" data-testid={`knock-forum-${knockId}-${p.postId}`}>
                        {/* Its name is its text, the headline and the check's line (the phone's label says the same). */}
                        <button type="button" onClick={() => void check(p)} aria-busy={c === 'checking'} aria-describedby={lineId}
                            className="w-full min-h-[48px] px-3 py-2.5 text-left bg-transparent border-none cursor-pointer rounded-xl">
                            <span className="flex items-start gap-2">
                                <span dir="auto" className="flex-1 min-w-0 text-sm font-bold leading-snug text-nature-950 dark:text-white break-words">
                                    {v.headline}
                                </span>
                                <span aria-hidden="true" className="text-base leading-snug text-nature-600 dark:text-nature-300">›</span>
                            </span>
                            {' '}
                            <span id={lineId} role="status" className={`block mt-1 text-[13px] leading-snug break-words ${tone}`}
                                data-testid={lineId}>{v.line}</span>
                        </button>
                        {!!v.words && (
                            <p dir="auto" className="m-0 px-3 pb-2 text-sm leading-relaxed text-nature-800 dark:text-nature-100 break-words whitespace-pre-wrap line-clamp-6">{v.words}</p>
                        )}
                        {v.openUrl && (
                            <a href={v.openUrl} target="_blank" rel="noopener noreferrer nofollow"
                                className="flex items-center min-h-[44px] px-3 text-sm font-bold text-bp-ink-info underline-offset-2 hover:underline">
                                {t(FORUM_ASK_WORDS.open)}
                            </a>
                        )}
                    </li>
                );
            })}
        </ul>
    );
}
