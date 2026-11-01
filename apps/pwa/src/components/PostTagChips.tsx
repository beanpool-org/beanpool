/**
 * A listing's or an event's tags on its detail page (DESIGN-owner-seeding-tags-fable.md §4.4): each in the member's language,
 * opening the Market filtered by it. A tag this app's library has no label for shows as nothing (§4.3); with none left, no row.
 * The tags its author typed follow as `#word`, as typed, each opening the Market with exactly that tag
 * (DESIGN-tags-free-entry-fable.md §4).
 */
import { freeTagsOf, postTagsOf, t, tagIndex } from '@beanpool/core';

const CHIP = 'inline-flex items-center min-h-[44px] max-w-full break-words px-3 py-1.5 rounded-full text-xs font-semibold bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950/40 dark:hover:bg-emerald-900/60 text-emerald-800 dark:text-emerald-200 border border-emerald-300 dark:border-emerald-700/60 cursor-pointer transition-colors';

export function PostTagChips({ tags, freeTags, onPick, onPickFree, className = '' }: {
    tags: unknown;
    freeTags?: unknown;
    onPick: (id: string) => void;
    onPickFree?: (tag: string) => void;
    className?: string;
}) {
    const index = tagIndex();
    const chips = postTagsOf(tags).flatMap(id => {
        const label = index.label(id);
        return label ? [{ id, label }] : [];
    });
    const typed = onPickFree ? freeTagsOf(freeTags) : [];
    if (chips.length === 0 && typed.length === 0) return null;
    return (
        <div className={`flex flex-wrap gap-1.5 ${className}`} data-testid="post-detail-tags">
            {chips.map(({ id, label }) => (
                <button
                    key={id}
                    type="button"
                    onClick={() => onPick(id)}
                    className={CHIP}
                    aria-label={t('Filter marketplace by tag {tag}', { tag: label })}
                >
                    <span className="min-w-0">#{label}</span>
                </button>
            ))}
            {typed.map(tag => (
                <button
                    key={`#${tag}`}
                    type="button"
                    onClick={() => onPickFree?.(tag)}
                    className={CHIP}
                    aria-label={t('Filter marketplace by tag {tag}', { tag: `#${tag}` })}
                >
                    <span className="min-w-0">#{tag}</span>
                </button>
            ))}
        </div>
    );
}
