/**
 * Single source of truth for category emoji + labels, so a category renders the
 * SAME icon everywhere (feed card, post detail, pickers). Previously the detail
 * screen and the market feed kept divergent lists (e.g. transport was 🚲 in one
 * place and 🚗 in the other, and 'garden'/'tech' were missing from the detail).
 */
export const CATEGORY_META: Record<string, { emoji: string; label: string }> = {
    all: { emoji: '🏷️', label: 'All Categories' },
    food: { emoji: '🥕', label: 'Food' },
    services: { emoji: '🤝', label: 'Services' },
    labour: { emoji: '👷', label: 'Labour' },
    tools: { emoji: '🛠️', label: 'Tools' },
    goods: { emoji: '📦', label: 'Goods' },
    garden: { emoji: '🌻', label: 'Garden' },
    housing: { emoji: '🏠', label: 'Housing' },
    transport: { emoji: '🚲', label: 'Transport' },
    education: { emoji: '📚', label: 'Education' },
    arts: { emoji: '🎨', label: 'Arts' },
    health: { emoji: '🌿', label: 'Health' },
    care: { emoji: '❤️', label: 'Care' },
    animals: { emoji: '🐾', label: 'Animals' },
    tech: { emoji: '💻', label: 'Tech' },
    energy: { emoji: '☀️', label: 'Energy' },
    general: { emoji: '🌱', label: 'General' },
};

/** Categories selectable when creating/editing a post (everything except the 'all' filter). */
export const POST_CATEGORIES = Object.entries(CATEGORY_META)
    .filter(([id]) => id !== 'all')
    .map(([id, m]) => ({ id, emoji: m.emoji, label: m.label }));

export function categoryEmoji(id: string | undefined | null): string {
    return (id && CATEGORY_META[id]?.emoji) || '📦';
}

export function categoryLabel(id: string | undefined | null): string {
    return (id && CATEGORY_META[id]?.label) || (id ? String(id) : 'General');
}
