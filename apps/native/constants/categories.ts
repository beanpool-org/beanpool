/**
 * Single source of truth for category emoji + labels, so a category renders the
 * SAME icon everywhere (feed card, post detail, pickers). Previously the detail
 * screen and the market feed kept divergent lists (e.g. transport was 🚲 in one
 * place and 🚗 in the other, and 'garden'/'tech' were missing from the detail).
 */
import { normalizeCategory, t, word, type WordKey } from '@beanpool/core';
export { normalizeCategory };

/** Each category's emoji, and its name: shown through t() (categoryLabel). */
export const CATEGORY_META: Record<string, { emoji: string; label: WordKey }> = {
    all: { emoji: '🏷️', label: word('All Categories') },
    food: { emoji: '🥕', label: word('Food') },
    services: { emoji: '🤝', label: word('Services') },
    labour: { emoji: '👷', label: word('Labour') },
    tools: { emoji: '🛠️', label: word('Tools') },
    goods: { emoji: '📦', label: word('Goods') },
    garden: { emoji: '🌻', label: word('Garden') },
    housing: { emoji: '🏠', label: word('Housing') },
    transport: { emoji: '🚲', label: word('Transport') },
    education: { emoji: '📚', label: word('Education') },
    arts: { emoji: '🎨', label: word('Arts') },
    health: { emoji: '🌿', label: word('Health') },
    care: { emoji: '❤️', label: word('Care') },
    animals: { emoji: '🐾', label: word('Animals') },
    tech: { emoji: '💻', label: word('Tech') },
    energy: { emoji: '☀️', label: word('Energy') },
    mindset: { emoji: '📜', label: word('Mindset') },
    general: { emoji: '🌱', label: word('General') },
};

/** Categories selectable when creating/editing a post (everything except the 'all' filter). */
export const POST_CATEGORIES = Object.entries(CATEGORY_META)
    .filter(([id]) => id !== 'all')
    .map(([id, m]) => ({ id, emoji: m.emoji, label: m.label }));

export function categoryEmoji(id: string | undefined | null): string {
    if (!id) return '📦';
    if (CATEGORY_META[id]?.emoji) return CATEGORY_META[id].emoji;
    const normalized = normalizeCategory(id);
    return CATEGORY_META[normalized]?.emoji || '📦';
}

/** A category's name in the member's language; an id this build doesn't know, as it is written. */
export function categoryLabel(id: string | undefined | null): string {
    if (!id) return t(CATEGORY_META.general.label);
    if (CATEGORY_META[id]?.label) return t(CATEGORY_META[id].label);
    const normalized = normalizeCategory(id);
    if (CATEGORY_META[normalized]?.label) return t(CATEGORY_META[normalized].label);
    const str = String(id).trim();
    return str.charAt(0).toUpperCase() + str.slice(1);
}
