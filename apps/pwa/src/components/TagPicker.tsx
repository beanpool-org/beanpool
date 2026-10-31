import React, { useState, useMemo, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
    FREE_TAGS_MAX, FREE_TAG_TOO_SHORT, POST_TAGS_MAX, TAG_COMMA, TOO_MANY_TAGS, TYPED_TAG_WORDS,
    enterTypedTags, exactLibraryTag, lastTagOff, suggestTags, tagChildren, tagIndex, t, typedTag, type RefusedTag,
} from '@beanpool/core';

export interface TagPickerProps {
    value?: string[];
    tags?: string[];
    onChange: (tags: string[]) => void;
    /** The tags the member typed, as stored, and what takes them. Without it the picker holds the library's tags only. */
    freeTags?: string[];
    onFreeTagsChange?: (freeTags: string[]) => void;
    category?: string;
    title?: string;
    description?: string;
    testID?: string;
}

export function TagPicker({
    value,
    tags,
    onChange,
    freeTags = [],
    onFreeTagsChange,
    category,
    title = '',
    description = '',
    testID = 'tag-picker',
}: TagPickerProps) {
    const selectedTags = value ?? tags ?? [];
    const [isOpen, setIsOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
    // Why the last commit stayed in the field, in words, until the field changes.
    const [refused, setRefused] = useState<RefusedTag | null>(null);

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
            if (selectedTags.length >= POST_TAGS_MAX) {
                setRefused(TOO_MANY_TAGS);
                return;
            }
            onChange([...selectedTags, id]);
        }
    };

    const canType = !!onFreeTagsChange;
    const held = { tags: selectedTags, freeTags };

    // The typed word has found its tag. Left in the field, Done would put back one just taken off.
    const pickFound = (id: string) => {
        toggleTag(id);
        if (canType && (selectedTags.includes(id) || selectedTags.length < POST_TAGS_MAX)) setSearchQuery('');
    };

    /** Commits what is typed (core typed-tags.ts); false when a piece was refused and stays in the field with its words. */
    const enter = (text: string, done: boolean): boolean => {
        const entry = enterTypedTags(text, held, done, index);
        if (entry.tags.length !== selectedTags.length) onChange(entry.tags);
        if (entry.freeTags.length !== freeTags.length) onFreeTagsChange?.(entry.freeTags);
        setSearchQuery(entry.rest);
        setRefused(entry.refused);
        return !entry.refused;
    };

    const typeInField = (text: string, composing: boolean) => {
        setRefused(null);
        // A word an input method is still building is not the member's yet: it commits when the composition ends.
        if (canType && !composing && TAG_COMMA.test(text)) enter(text, false);
        else setSearchQuery(text);
    };

    // Backspace on an empty field takes the last chip off.
    const backspaceOnEmpty = () => {
        if (!canType || searchQuery.length > 0) return;
        const off = lastTagOff(held);
        if (off.freeTags.length !== freeTags.length) onFreeTagsChange?.(off.freeTags);
        else if (off.tags.length !== selectedTags.length) onChange(off.tags);
    };

    // Done commits what is in the field: a refused piece keeps the sheet open, with its words.
    const finish = () => {
        if (!canType || enter(searchQuery, true)) setIsOpen(false);
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
        const found = index.search(q, 12);
        // A plural ("lemons") is no prefix of its label, and Enter picks that label: it has a row like any other.
        const exact = canType ? exactLibraryTag(q, index) : null;
        return exact && !found.includes(exact) ? [exact, ...found] : found;
    }, [searchQuery, index, canType]);

    // What Enter would do with the field now. A word still being typed is not yet too short.
    const typed = canType ? typedTag(searchQuery, held, index) : null;
    const addable = typed?.kind === 'free' && !freeTags.includes(typed.tag) ? typed.tag : null;
    const shownRefusal = refused ?? (typed?.kind === 'refused' && typed.why !== FREE_TAG_TOO_SHORT ? typed : null);

    const groups = useMemo(() => {
        if (!category) return [];
        return tagChildren(category);
    }, [category]);

    const chosenChips = (
        <>
            {selectedTags.map((id) => {
                const label = index.label(id);
                if (!label) return null;
                return (
                    <button
                        key={id}
                        type="button"
                        onClick={() => toggleTag(id)}
                        className="min-h-[44px] max-w-full break-words px-3 py-1.5 rounded-full text-sm font-semibold flex items-center gap-1.5 transition-colors bg-bp-cta-fill text-bp-cta-on hover:bg-bp-cta-hover"
                        aria-label={t('Remove {name}', { name: label })}
                    >
                        <span>{label}</span>
                        <span className="text-xs font-bold opacity-80" aria-hidden="true">✕</span>
                    </button>
                );
            })}
            {freeTags.map((tag) => (
                <button
                    key={`#${tag}`}
                    type="button"
                    onClick={() => onFreeTagsChange?.(freeTags.filter((other) => other !== tag))}
                    className="min-h-[44px] max-w-full break-words px-3 py-1.5 rounded-full text-sm font-semibold flex items-center gap-1.5 transition-colors bg-bp-cta-fill text-bp-cta-on hover:bg-bp-cta-hover"
                    aria-label={t('Remove {name}', { name: `#${tag}` })}
                >
                    <span className="min-w-0">#{tag}</span>
                    <span className="text-xs font-bold opacity-80" aria-hidden="true">✕</span>
                </button>
            ))}
        </>
    );

    return (
        <div className="my-2" data-testid={testID}>
            <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-nature-600 dark:text-nature-400 uppercase tracking-wider">
                    {t('Tags · optional')}
                </span>
            </div>

            {/* Chips row */}
            <div className="flex flex-wrap gap-2 items-center">
                {chosenChips}

                {(selectedTags.length < POST_TAGS_MAX || (canType && freeTags.length < FREE_TAGS_MAX)) && (
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
                                onClick={finish}
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
                                    onChange={(e) => typeInField(e.target.value, (e.nativeEvent as InputEvent).isComposing === true)}
                                    onCompositionEnd={(e) => typeInField(e.currentTarget.value, false)}
                                    onKeyDown={(e) => {
                                        const composing = e.nativeEvent.isComposing;
                                        if (e.key === 'Enter') {
                                            e.preventDefault();
                                            if (canType && !composing) enter(searchQuery, true);
                                        } else if (e.key === 'Backspace' && !e.repeat && !composing) {
                                            backspaceOnEmpty();
                                        }
                                    }}
                                    placeholder={t('Search tags...')}
                                    aria-label={t('Search tags...')}
                                    className="w-full min-h-[44px] pl-10 pr-9 py-2 rounded-xl border border-nature-200 dark:border-nature-700 bg-nature-50 dark:bg-nature-950 text-nature-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-terra-300"
                                />
                                {searchQuery.length > 0 && (
                                    <button
                                        type="button"
                                        onClick={() => { setSearchQuery(''); setRefused(null); }}
                                        className="absolute right-1 top-1/2 -translate-y-1/2 min-h-[44px] min-w-[44px] flex items-center justify-center text-nature-400 hover:text-nature-600 dark:hover:text-nature-200"
                                        aria-label={t('Clear search')}
                                    >
                                        ✕
                                    </button>
                                )}
                            </div>
                            {shownRefusal && (
                                <p role="alert" className="m-0 mt-1.5 text-xs font-semibold text-red-600 dark:text-red-300">{t(shownRefusal.why)}</p>
                            )}
                        </div>

                        {/* Scrollable content */}
                        <div className="overflow-y-auto flex-1 pr-1 space-y-4 max-h-[60vh]">
                            {canType && selectedTags.length + freeTags.length > 0 && (
                                <div className="flex flex-wrap gap-2 items-center" data-testid="tag-picker-chosen">{chosenChips}</div>
                            )}
                            {searchQuery.trim().length >= 2 ? (
                                <div>
                                    {(searchResults.length > 0 || !canType) && (
                                        <div className="text-xs font-bold text-nature-600 dark:text-nature-400 uppercase tracking-wider mb-2">
                                            {t('Search results')}
                                        </div>
                                    )}
                                    {searchResults.length === 0 ? (
                                        !canType && (
                                            <p className="text-sm text-nature-400 py-4 text-center">
                                                {t('No tags found')}
                                            </p>
                                        )
                                    ) : (
                                        <div className="flex flex-wrap gap-2">
                                            {searchResults.map((id) => {
                                                const label = index.label(id);
                                                const selected = selectedTags.includes(id);
                                                return (
                                                    <button
                                                        key={id}
                                                        type="button"
                                                        onClick={() => pickFound(id)}
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
                                    {canType && (
                                        <div className="text-xs text-nature-600 dark:text-nature-300 space-y-1">
                                            <p className="m-0">{t(TYPED_TAG_WORDS.arePublic)}</p>
                                            <p className="m-0">{t(TYPED_TAG_WORDS.yourWords)}</p>
                                        </div>
                                    )}
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

                        {/* The last row, and held below the list: twelve results would push it off a short screen. */}
                        {addable && (
                            <button
                                type="button"
                                onClick={() => enter(searchQuery, true)}
                                data-testid="tag-picker-add-typed"
                                className="w-full min-h-[44px] mt-2 flex items-center text-left break-words text-sm font-bold text-nature-900 dark:text-white hover:underline border-t border-nature-100 dark:border-nature-800"
                            >
                                {t(TYPED_TAG_WORDS.add, { tag: `#${addable}` })}
                            </button>
                        )}
                    </div>
                </div>,
                document.body,
            )}
        </div>
    );
}
