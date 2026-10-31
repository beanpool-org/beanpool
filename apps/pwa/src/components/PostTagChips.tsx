/**
 * A listing's or an event's tags on its detail page (DESIGN-owner-seeding-tags-fable.md §4.4): each in the member's language,
 * opening the Market filtered by it. A tag this app's library has no label for shows as nothing (§4.3); with none left, no row.
 */
import { postTagsOf, t, tagIndex } from '@beanpool/core';

export function PostTagChips({ tags, onPick, className = '' }: { tags: unknown; onPick: (id: string) => void; className?: string }) {
    const index = tagIndex();
    const chips = postTagsOf(tags).flatMap(id => {
        const label = index.label(id);
        return label ? [{ id, label }] : [];
    });
    if (chips.length === 0) return null;
    return (
        <div className={`flex flex-wrap gap-1.5 ${className}`} data-testid="post-detail-tags">
            {chips.map(({ id, label }) => (
                <button
                    key={id}
                    type="button"
                    onClick={() => onPick(id)}
                    className="inline-flex items-center min-h-[44px] px-3 py-1.5 rounded-full text-xs font-semibold bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:hover:bg-emerald-900/60 text-emerald-800 dark:text-emerald-200 border border-emerald-300 dark:border-emerald-700/60 cursor-pointer transition-colors"
                    aria-label={t('Filter marketplace by tag {tag}', { tag: label })}
                >
                    #{label}
                </button>
            ))}
        </div>
    );
}
