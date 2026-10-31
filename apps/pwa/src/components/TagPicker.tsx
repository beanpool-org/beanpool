import React, { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
    POST_TAGS_MAX, suggestTags, tagChildren, tagIndex, t,
} from '@beanpool/core';

export interface TagPickerProps {
    value?: string[];
    tags?: string[];
    onChange: (tags: string[]) => void;
    category?: string;
    title?: string;
    description?: string;
    testID?: string;
}

export function TagPicker({
    value,
    tags,
    onChange,
    category,
    title = '',
    description = '',
    testID = 'tag-picker',
}: TagPickerProps) {
    const selectedTags = value ?? tags ?? [];
    const [isOpen, setIsOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

    // Keyboard accessibility: Escape closes modal
    useEffect(() => {
        if (!isOpen) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setIsOpen(false);
            }
        };
        window.addEventListener('keydown', handleKeyDown, true);
        return () => window.removeEventListener('keydown', handleKeyDown, true);
    }, [isOpen]);

    const index = useMemo(() => tagIndex(), [isOpen]);

    const toggleTag = (id: string) => {
        if (selectedTags.includes(id)) {
            onChange(selectedTags.filter((t) => t !== id));
        } else {
            if (selectedTags.length >= POST_TAGS_MAX) return;
            onChange([...selectedTags, id]);
        }
    };

    const toggleGroup = (groupId: string) => {
        setExpandedGroups((prev) => {
            const next = new Set(prev);
            if (next.has(groupId)) next.delete(groupId);
            else next.add(groupId);
            return next;
        });
    };

    const suggestions = useMemo(() => {
        return suggestTags(title, description, { category, limit: 8, index });
    }, [title, description, category, index]);

    const searchResults = useMemo(() => {
        const q = searchQuery.trim();
        if (q.length < 2) return [];
        return index.search(q, 12);
    }, [searchQuery, index]);

    const groups = useMemo(() => {
        if (!category) return [];
        return tagChildren(category);
    }, [category]);

    return (
        <div className="my-2" data-testid={testID}>
            <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-nature-600 dark:text-nature-400 uppercase tracking-wider">
                    {t('Tags · optional')}
                </span>
            </div>

            {/* Chips row */}
            <div className="flex flex-wrap gap-2 items-center">
                {selectedTags.map((id) => {
                    const label = index.label(id);
                    if (!label) return null;
                    return (
                        <button
                            key={id}
                            type="button"
                            onClick={() => toggleTag(id)}
                            className="min-h-[44px] px-3 py-1.5 rounded-full text-sm font-semibold flex items-center gap-1.5 transition-colors bg-bp-cta-fill text-bp-cta-on hover:bg-bp-cta-hover"
                            aria-label={t('Remove {name}', { name: label })}
                        >
                            <span>{label}</span>
                            <span className="text-xs font-bold opacity-80" aria-hidden="true">✕</span>
                        </button>
                    );
                })}

                {selectedTags.length < POST_TAGS_MAX && (
                    <button
                        type="button"
                        onClick={() => setIsOpen(true)}
                        className="min-h-[44px] px-4 py-1.5 rounded-full text-sm font-bold flex items-center gap-1 border border-dashed border-terra-500 text-terra-600 dark:text-terra-400 hover:bg-terra-50 dark:hover:bg-terra-950/30 transition-colors"
                        aria-label={t('+ Add tag')}
                    >
                        {t('+ Add')}
                    </button>
                )}
            </div>

            {/* Modal Sheet. On document.body: inside the map's New Post panel (z-[1000], backdrop-blur, overflow-y-auto) `fixed`
                measured against the panel and the sheet was clipped to it, and inside a tab's page it sat under the app's header
                and tabs (ReportModal.tsx). Above that panel. React still bubbles a click through the portal to the form it was
                opened from, so the overlay's stops here: the enterprise form's backdrop closes that form. */}
            {isOpen && createPortal(
                <div
                    className="fixed inset-0 z-[1100] flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4 backdrop-blur-sm"
                    onClick={(e) => { e.stopPropagation(); setIsOpen(false); }}
                    role="dialog"
                    aria-modal="true"
                    aria-label={t('Tags')}
                >
                    <div
                        className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-t-3xl sm:rounded-3xl p-5 w-full max-w-lg max-h-[85vh] flex flex-col shadow-2xl"
                        onClick={(e) => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="flex items-center justify-between pb-3 border-b border-nature-100 dark:border-nature-800">
                            <h3 className="font-extrabold text-lg text-nature-900 dark:text-white">
                                {t('Tags')}
                            </h3>
                            <button
                                type="button"
                                onClick={() => setIsOpen(false)}
                                className="min-h-[44px] min-w-[44px] flex items-center justify-center text-terra-600 dark:text-terra-400 font-bold text-sm hover:underline"
                            >
                                {t('Done')}
                            </button>
                        </div>

                        {/* Search input */}
                        <div className="my-3">
                            <div className="relative">
                                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm text-nature-400">
                                    🔍
                                </span>
                                <input
                                    type="text"
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            e.preventDefault();
                                        }
                                    }}
                                    placeholder={t('Search tags...')}
                                    aria-label={t('Search tags...')}
                                    className="w-full min-h-[44px] pl-10 pr-9 py-2 rounded-xl border border-nature-200 dark:border-nature-700 bg-nature-50 dark:bg-nature-950 text-nature-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-terra-300"
                                />
                                {searchQuery.length > 0 && (
                                    <button
                                        type="button"
                                        onClick={() => setSearchQuery('')}
                                        className="absolute right-1 top-1/2 -translate-y-1/2 min-h-[44px] min-w-[44px] flex items-center justify-center text-nature-400 hover:text-nature-600 dark:hover:text-nature-200"
                                        aria-label={t('Clear search')}
                                    >
                                        ✕
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Scrollable content */}
                        <div className="overflow-y-auto flex-1 pr-1 space-y-4 max-h-[60vh]">
                            {searchQuery.trim().length >= 2 ? (
                                <div>
                                    <div className="text-xs font-bold text-nature-600 dark:text-nature-400 uppercase tracking-wider mb-2">
                                        {t('Search results')}
                                    </div>
                                    {searchResults.length === 0 ? (
                                        <p className="text-sm text-nature-400 py-4 text-center">
                                            {t('No tags found')}
                                        </p>
                                    ) : (
                                        <div className="flex flex-wrap gap-2">
                                            {searchResults.map((id) => {
                                                const label = index.label(id);
                                                const selected = selectedTags.includes(id);
                                                return (
                                                    <button
                                                        key={id}
                                                        type="button"
                                                        onClick={() => toggleTag(id)}
                                                        className={`min-h-[44px] px-3.5 py-1.5 rounded-full text-sm font-semibold flex items-center gap-1.5 transition-colors ${
                                                            selected
                                                                ? 'bg-bp-cta-fill text-bp-cta-on hover:bg-bp-cta-hover'
                                                                : 'bg-nature-100 dark:bg-nature-800 text-nature-800 dark:text-nature-200 hover:bg-nature-200 dark:hover:bg-nature-700'
                                                        }`}
                                                        aria-pressed={selected}
                                                    >
                                                        <span>{label || id}</span>
                                                        {selected && <span aria-hidden="true">✓</span>}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <>
                                    {/* Suggestions */}
                                    {suggestions.length > 0 && (
                                        <div>
                                            <div className="text-xs font-bold text-nature-600 dark:text-nature-400 uppercase tracking-wider mb-2">
                                                {t('Suggested')}
                                            </div>
                                            <div className="flex flex-wrap gap-2">
                                                {suggestions.map((id) => {
                                                    const label = index.label(id);
                                                    const selected = selectedTags.includes(id);
                                                    return (
                                                        <button
                                                            key={id}
                                                            type="button"
                                                            onClick={() => toggleTag(id)}
                                                            className={`min-h-[44px] px-3.5 py-1.5 rounded-full text-sm font-semibold flex items-center gap-1.5 transition-colors ${
                                                                selected
                                                                    ? 'bg-bp-cta-fill text-bp-cta-on hover:bg-bp-cta-hover'
                                                                    : 'bg-nature-100 dark:bg-nature-800 text-nature-800 dark:text-nature-200 hover:bg-nature-200 dark:hover:bg-nature-700'
                                                            }`}
                                                            aria-pressed={selected}
                                                        >
                                                            <span>{label || id}</span>
                                                            {selected && <span aria-hidden="true">✓</span>}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}

                                    {/* Category groups */}
                                    {groups.length > 0 && (
                                        <div>
                                            <div className="text-xs font-bold text-nature-600 dark:text-nature-400 uppercase tracking-wider mb-2">
                                                {t('Categories')}
                                            </div>
                                            <div className="divide-y divide-nature-100 dark:divide-nature-800">
                                                {groups.map((group) => {
                                                    const groupLabel = index.label(group.id) || group.id;
                                                    const isExpanded = expandedGroups.has(group.id);
                                                    const items = tagChildren(group.id);

                                                    return (
                                                        <div key={group.id} className="py-2">
                                                            <button
                                                                type="button"
                                                                onClick={() => toggleGroup(group.id)}
                                                                className="w-full min-h-[44px] flex items-center justify-between text-left font-semibold text-sm text-nature-800 dark:text-nature-200 hover:text-nature-950 dark:hover:text-white"
                                                                aria-expanded={isExpanded}
                                                            >
                                                                <span>{groupLabel}</span>
                                                                <span className="text-xs text-nature-400" aria-hidden="true">
                                                                    {isExpanded ? '▼' : '▶'}
                                                                </span>
                                                            </button>

                                                            {isExpanded && (
                                                                <div className="pt-2 pb-1 pl-2">
                                                                    <div className="flex flex-wrap gap-2">
                                                                        {items.length > 0 ? (
                                                                            items.map((item) => {
                                                                                const itemLabel = index.label(item.id) || item.id;
                                                                                const selected = selectedTags.includes(item.id);
                                                                                return (
                                                                                    <button
                                                                                        key={item.id}
                                                                                        type="button"
                                                                                        onClick={() => toggleTag(item.id)}
                                                                                        className={`min-h-[44px] px-3.5 py-1.5 rounded-full text-sm font-semibold flex items-center gap-1.5 transition-colors ${
                                                                                            selected
                                                                                                ? 'bg-bp-cta-fill text-bp-cta-on hover:bg-bp-cta-hover'
                                                                                                : 'bg-nature-100 dark:bg-nature-800 text-nature-800 dark:text-nature-200 hover:bg-nature-200 dark:hover:bg-nature-700'
                                                         }`}
                                                                                        aria-pressed={selected}
                                                                                    >
                                                                                        <span>{itemLabel}</span>
                                                                                        {selected && <span aria-hidden="true">✓</span>}
                                                                                    </button>
                                                                                );
                                                                            })
                                                                        ) : (
                                                                            <button
                                                                                type="button"
                                                                                onClick={() => toggleTag(group.id)}
                                                                                className={`min-h-[44px] px-3.5 py-1.5 rounded-full text-sm font-semibold flex items-center gap-1.5 transition-colors ${
                                                                                    selectedTags.includes(group.id)
                                                                                        ? 'bg-bp-cta-fill text-bp-cta-on hover:bg-bp-cta-hover'
                                                                                        : 'bg-nature-100 dark:bg-nature-800 text-nature-800 dark:text-nature-200 hover:bg-nature-200 dark:hover:bg-nature-700'
                                                                                }`}
                                                                                aria-pressed={selectedTags.includes(group.id)}
                                                                            >
                                                                                <span>{groupLabel}</span>
                                                                                {selectedTags.includes(group.id) && <span aria-hidden="true">✓</span>}
                                                                            </button>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </div>,
                document.body,
            )}
        </div>
    );
}
