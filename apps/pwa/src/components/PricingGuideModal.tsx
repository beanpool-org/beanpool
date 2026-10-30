/**
 * PricingGuideModal — Searchable, Auto-Adjusting Community Pricing Guide for PWA (#206).
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
    PRICING_CATEGORIES,
    DEFAULT_PRICING_CATALOG,
    DEFAULT_PRICING_CONFIG,
    formatNumber,
    t,
    tn,
    word,
    type PricingGuideItem,
    type PricingCategory,
    type PricingCategoryMeta,
    type PricingConfig,
    type WordKey,
} from '@beanpool/core';
import { getPricingGuideApi, submitPricingReportApi } from '../lib/api';
import { Sentence } from './Sentence';

/**
 * The category pills' names, as core's PRICING_CATEGORIES writes them (pricing-catalog.ts), marked here and shown
 * through t() in the member's language; a category this build doesn't know, as the catalog wrote it. The catalog's
 * own items (names, descriptions, units, season hints) come from the node's catalog and are shown as written.
 */
const PRICING_CATEGORY_WORDS: Readonly<Record<PricingCategory, WordKey>> = {
    food: word('Food & Produce'),
    services: word('Services & Trade'),
    labour: word('Labour & Help'),
    tools: word('Tools & Hardware'),
    goods: word('Goods & Materials'),
    garden: word('Plants & Garden'),
    housing: word('Housing & Space'),
    transport: word('Transport & Rides'),
    education: word('Education & Lessons'),
    arts: word('Arts & Crafts'),
    health: word('Health & Wellness'),
    care: word('Care & Family'),
    animals: word('Animals & Pets'),
    tech: word('Tech & Digital'),
    energy: word('Energy & Firewood'),
    mindset: word('Mindset & Wisdom'),
    general: word('General & Community'),
};

function categoryWords(cat: PricingCategoryMeta): string {
    return Object.prototype.hasOwnProperty.call(PRICING_CATEGORY_WORDS, cat.id) ? t(PRICING_CATEGORY_WORDS[cat.id]) : cat.label;
}

/** A price in Beans for a screen reader (the bean is hidden): "12 Beans", as the row always read. */
function beansWords(n: number): string {
    return tn(n, '{n} Beans', '{n} Beans');
}

/** The select control's whole name: the item (the catalog's, as written), the price, its unit and the trend. */
function selectLabel(item: PricingGuideItem, price: number): string {
    const label = item.unit
        ? tn(price, 'Select {name} for offer at {n} Beans per {unit}', 'Select {name} for offer at {n} Beans per {unit}', { name: item.name, unit: item.unit })
        : tn(price, 'Select {name} for offer at {n} Beans', 'Select {name} for offer at {n} Beans', { name: item.name });
    if (item.trend === 'up') return t('{label}, price rising', { label });
    if (item.trend === 'down') return t('{label}, price falling', { label });
    return label;
}

interface Props {
    isOpen: boolean;
    onClose: () => void;
    onSelectOfferItem?: (item: PricingGuideItem, effectivePrice: number) => void;
    reporterPubkey?: string;
}

export function PricingGuideModal({ isOpen, onClose, onSelectOfferItem, reporterPubkey }: Props) {
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedCategory, setSelectedCategory] = useState<PricingCategory | 'all'>('all');
    const [items, setItems] = useState<PricingGuideItem[]>(DEFAULT_PRICING_CATALOG);
    const [config, setConfig] = useState<PricingConfig>(DEFAULT_PRICING_CONFIG);
    const [loading, setLoading] = useState(false);

    // Reporting state
    const [reportingItem, setReportingItem] = useState<PricingGuideItem | null>(null);
    const [reportType, setReportType] = useState<'too_high' | 'too_low' | 'other'>('too_high');
    const [reportComment, setReportComment] = useState('');
    const [reportSubmitting, setReportSubmitting] = useState(false);
    const [reportSuccess, setReportSuccess] = useState(false);
    const reportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Clear reporting success timer on unmount or when modal closes
    useEffect(() => {
        return () => {
            if (reportTimerRef.current) {
                clearTimeout(reportTimerRef.current);
                reportTimerRef.current = null;
            }
        };
    }, []);

    useEffect(() => {
        if (!isOpen && reportTimerRef.current) {
            clearTimeout(reportTimerRef.current);
            reportTimerRef.current = null;
        }
    }, [isOpen]);

    // Keyboard (Escape) & Modal Accessibility
    useEffect(() => {
        if (!isOpen) return;
        function handleKeyDown(e: KeyboardEvent) {
            if (e.key !== 'Escape') return;
            if (reportingItem) {
                setReportingItem(null);
                return;
            }
            onClose();
        }
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, reportingItem, onClose]);

    useEffect(() => {
        if (!isOpen) return;

        let isMounted = true;
        async function fetchCatalog() {
            setLoading(true);
            try {
                const res = await getPricingGuideApi();
                if (!isMounted || !res) return;

                if (Array.isArray(res.items) && res.items.length > 0) {
                    setItems(res.items);
                }
                if (res.config) {
                    setConfig(res.config);
                }
            } catch (e) {
                console.warn('[PricingGuide] Using local fallback catalog:', e);
            } finally {
                if (isMounted) setLoading(false);
            }
        }

        fetchCatalog();
        return () => { isMounted = false; };
    }, [isOpen]);

    const filteredItems = useMemo(() => {
        const query = searchQuery.trim().toLowerCase();
        return items.filter((item) => {
            const matchesCat = selectedCategory === 'all' || item.category === selectedCategory;
            if (!matchesCat) return false;
            if (!query) return true;
            return (
                item.name.toLowerCase().includes(query) ||
                item.description.toLowerCase().includes(query) ||
                item.category.toLowerCase().includes(query)
            );
        });
    }, [items, selectedCategory, searchQuery]);

    async function handleSubmitReport(e: React.FormEvent) {
        e.preventDefault();
        if (!reportingItem) return;

        setReportSubmitting(true);
        try {
            await submitPricingReportApi(reportingItem.id, reportType, reportComment.trim() || undefined, reporterPubkey);
            setReportSuccess(true);
            if (reportTimerRef.current) clearTimeout(reportTimerRef.current);
            reportTimerRef.current = setTimeout(() => {
                reportTimerRef.current = null;
                setReportingItem(null);
                setReportSuccess(false);
                setReportComment('');
                setReportType('too_high');
            }, 1200);
        } catch (err) {
            console.error('[PricingGuide] Failed to submit report:', err);
        } finally {
            setReportSubmitting(false);
        }
    }

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 overflow-y-auto"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pricing-guide-title"
            onClick={(e) => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div className="relative w-full max-w-2xl bg-white dark:bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 flex flex-col max-h-[90vh] overflow-hidden animate-in fade-in zoom-in-95 duration-150">
                {/* Header */}
                <div className="flex items-center justify-between p-4 sm:p-5 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50">
                    <div>
                        <h2 id="pricing-guide-title" className="text-lg sm:text-xl font-extrabold text-zinc-900 dark:text-zinc-50 flex items-center gap-2">
                            <span aria-hidden="true">💡</span> {t('Community Pricing Guide')}
                        </h2>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                            {tn(items.length, '{n} items & services benchmarked', '{n} items & services benchmarked')}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="w-8 h-8 rounded-full flex items-center justify-center text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 transition-colors"
                        aria-label={t('Close pricing guide')}
                    >
                        ✕
                    </button>
                </div>

                {/* Search Bar */}
                <div className="p-3 sm:p-4 border-b border-zinc-200 dark:border-zinc-800">
                    <div className="relative flex items-center">
                        <span className="absolute left-3 text-zinc-400 text-sm" aria-hidden="true">🔍</span>
                        <input
                            type="text"
                            aria-label={t('Search community price catalog')}
                            placeholder={t('Search produce, services, trades, gear...')}
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full pl-9 pr-10 py-2 text-sm rounded-xl bg-zinc-100 dark:bg-zinc-800 border-none text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                        />
                        {searchQuery && (
                            <button
                                type="button"
                                aria-label={t('Clear search')}
                                onClick={() => setSearchQuery('')}
                                className="absolute right-1.5 p-1.5 min-w-[36px] min-h-[36px] flex items-center justify-center text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 font-bold rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                            >
                                ✕
                            </button>
                        )}
                    </div>
                </div>

                {/* Categories Pills */}
                <div className="flex gap-2 p-2 sm:px-4 overflow-x-auto border-b border-zinc-200 dark:border-zinc-800 scrollbar-none bg-zinc-50/50 dark:bg-zinc-900/30">
                    <button
                        type="button"
                        aria-pressed={selectedCategory === 'all'}
                        onClick={() => setSelectedCategory('all')}
                        className={`flex-shrink-0 px-3 py-1.5 min-h-[44px] rounded-full text-xs font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 transition-colors ${
                            selectedCategory === 'all'
                                ? 'bg-bp-commit-fill text-bp-commit-on'
                                : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                        }`}
                    >
                        <span aria-hidden="true">🌟</span> {t('All Items')}
                    </button>
                    {PRICING_CATEGORIES.map((cat) => {
                        const active = selectedCategory === cat.id;
                        return (
                            <button
                                key={cat.id}
                                type="button"
                                aria-pressed={active}
                                onClick={() => setSelectedCategory(cat.id)}
                                className={`flex-shrink-0 px-3 py-1.5 min-h-[44px] rounded-full text-xs font-semibold flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 transition-colors ${
                                    active
                                        ? 'bg-bp-commit-fill text-bp-commit-on'
                                        : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-200 dark:hover:bg-zinc-700'
                                }`}
                            >
                                <span aria-hidden="true">{cat.emoji}</span> {categoryWords(cat)}
                            </button>
                        );
                    })}
                </div>

                {/* Instructions Tip Banner */}
                <div className="mx-4 mt-3 mb-1 p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/60 flex items-center gap-2.5 text-xs text-emerald-800 dark:text-emerald-300 font-medium">
                    <span className="text-sm" aria-hidden="true">💡</span>
                    <span>
                        {onSelectOfferItem
                            ? t('Tap any item to auto-fill your offer listing with community price estimates.')
                            : t('Community estimates based on local marketplace trades and seasonal averages.')}
                    </span>
                </div>

                {/* Items List */}
                <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
                    {loading ? (
                        <div className="flex items-center justify-center py-12 text-zinc-400 text-sm">
                            <span className="animate-spin mr-2" aria-hidden="true">⏳</span> {t('Loading community estimates...')}
                        </div>
                    ) : filteredItems.length === 0 ? (
                        <div className="py-12 text-center text-zinc-400">
                            <p className="text-3xl mb-2" aria-hidden="true">🔍</p>
                            <p className="text-sm font-medium">{t('No items found matching "{query}"', { query: searchQuery })}</p>
                        </div>
                    ) : (
                        filteredItems.map((item) => {
                            const effectivePrice = item.priceBeans;
                            const confidenceDot =
                                (item.confidenceCount || 0) >= 3 ? 'bg-emerald-500' : (item.confidenceCount || 0) >= 1 ? 'bg-amber-500' : 'bg-rose-400';
                            const showSeasonality = Boolean(config.showSeasonality && item.seasonalityHint);
                            const descriptionId = `pricing-item-desc-${item.id}`;
                            const seasonalityId = `pricing-item-season-${item.id}`;

                            return (
                                <div
                                    key={item.id}
                                    className={`relative isolate flex flex-wrap items-center gap-3 p-3 rounded-xl bg-zinc-50 dark:bg-zinc-800/40 border border-zinc-200/80 dark:border-zinc-800 transition-all ${
                                        onSelectOfferItem
                                            ? 'cursor-pointer hover:border-emerald-500/50 hover:bg-zinc-100/80 dark:hover:bg-zinc-800/80 active:scale-[0.99]'
                                            : ''
                                    }`}
                                >
                                    {/*
                                      The select action is a real button covering the row, and a SIBLING of the
                                      Report button below — an interactive control nested inside another one is
                                      flattened or skipped by screen readers. Its aria-label stays short (name,
                                      price, unit, trend) and the row's own description and seasonality hint are
                                      attached as the accessible DESCRIPTION, so they are announced too: a label
                                      replaces the content, a description is read after it.
                                    */}
                                    {onSelectOfferItem && (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                onSelectOfferItem(item, effectivePrice);
                                                onClose();
                                            }}
                                            className="absolute -inset-px rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                                            aria-label={selectLabel(item, effectivePrice)}
                                            aria-describedby={showSeasonality ? `${descriptionId} ${seasonalityId}` : descriptionId}
                                        />
                                    )}

                                    {/* Thumbnail / Emoji */}
                                    <div className="w-11 h-11 rounded-xl bg-zinc-200/60 dark:bg-zinc-800 flex items-center justify-center flex-shrink-0 text-2xl overflow-hidden">
                                        {item.thumbnailUrl ? (
                                            <img src={item.thumbnailUrl} alt={item.name} className="w-full h-full object-cover" />
                                        ) : (
                                            item.emoji
                                        )}
                                    </div>

                                    {/* Description: at least 6rem wide; below that the price moves under it (at 320 px with 1.3x
                                        text the price took the whole row and left the name 0 px wide, in English too). */}
                                    <div className="flex-1 min-w-[6rem]">
                                        <div className="flex items-center gap-2">
                                            <h3 className="text-sm font-bold text-zinc-900 dark:text-zinc-100 truncate">{item.name}</h3>
                                            {/* relative z-10 for the same reason as the Report button: the select overlay is a
                                                positioned sibling, so it would otherwise paint over this dot and swallow the
                                                hover its title tooltip needs. */}
                                            <span
                                                className={`relative z-10 w-2 h-2 rounded-full flex-shrink-0 ${confidenceDot}`}
                                                title={tn(item.confidenceCount || 0, 'Confidence: {n} listings', 'Confidence: {n} listings')}
                                            />
                                        </div>
                                        <p id={descriptionId} className="text-xs text-zinc-500 dark:text-zinc-400 line-clamp-1 mt-0.5">{item.description}</p>
                                        {showSeasonality && (
                                            <p id={seasonalityId} className="text-[11px] text-emerald-600 dark:text-emerald-400 font-medium mt-0.5">
                                                <span aria-hidden="true">☀️</span> {item.seasonalityHint}
                                            </p>
                                        )}
                                    </div>

                                    {/* Price & Actions */}
                                    <div className="flex flex-col items-end flex-shrink-0 ml-auto">
                                        <div className="flex items-center gap-1 bg-bp-chip-ok-tint text-bp-chip-ok-ink px-2.5 py-1 rounded-lg border border-transparent text-xs font-bold">
                                            {/* The bean and the number are drawn; a screen reader hears the price as one sentence. */}
                                            <span><span aria-hidden="true">🫘 {formatNumber(effectivePrice)}</span><span className="sr-only">{beansWords(effectivePrice)}</span></span>
                                            {item.unit && <span className="text-[10px] text-emerald-600/80 dark:text-emerald-400/80 font-normal">/{item.unit}</span>}
                                            {item.trend === 'up' && <><span className="text-emerald-500 text-[10px] ml-0.5" aria-hidden="true">▲</span><span className="sr-only">{t(', price rising')}</span></>}
                                            {item.trend === 'down' && <><span className="text-rose-500 dark:text-rose-400 text-[10px] ml-0.5" aria-hidden="true">▼</span><span className="sr-only">{t(', price falling')}</span></>}
                                        </div>

                                        <div className="flex items-center gap-1 mt-1.5">
                                            {onSelectOfferItem && (
                                                <span
                                                    className="px-2 py-0.5 bg-bp-commit-fill text-bp-commit-on rounded text-[11px] font-semibold pointer-events-none"
                                                >
                                                    {t('Offer →')}
                                                </span>
                                            )}
                                            {/* relative z-10 keeps this above the select overlay spanning the row; the row's `isolate` keeps that z-10 local. */}
                                            <button
                                                type="button"
                                                onClick={() => setReportingItem(item)}
                                                className="relative z-10 min-w-[44px] min-h-[44px] flex items-center justify-center p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 text-xs rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                                                title={t('Report price feedback')}
                                                aria-label={t('Report price for {name}', { name: item.name })}
                                            >
                                                <span aria-hidden="true">🚩</span>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>

                {/* Report Feedback Modal */}
                {reportingItem && (
                    <div
                        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="report-modal-title"
                        onClick={(e) => {
                            if (e.target === e.currentTarget) setReportingItem(null);
                        }}
                    >
                        <div className="w-full max-w-sm bg-white dark:bg-zinc-900 rounded-2xl p-5 shadow-2xl border border-zinc-200 dark:border-zinc-800 animate-in fade-in zoom-in-95 duration-150">
                            {reportSuccess ? (
                                <div className="text-center py-6" role="status" aria-live="polite">
                                    <div className="text-4xl mb-2" aria-hidden="true">✨</div>
                                    <h3 className="text-base font-bold text-zinc-900 dark:text-zinc-100">{t('Feedback Submitted')}</h3>
                                    <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{t('Thank you for helping keep community prices fair.')}</p>
                                </div>
                            ) : (
                                <form onSubmit={handleSubmitReport}>
                                    <h3 id="report-modal-title" className="text-base font-bold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                                        <span aria-hidden="true">🚩</span> {t('Report Price')}
                                    </h3>
                                    <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 mb-4">
                                        {/* The item's name is the catalog's, as written; the bean and the number are drawn, and a
                                            screen reader hears the price as one sentence. */}
                                        <Sentence
                                            text={t('{name} • Current: {price}', { name: reportingItem.name })}
                                            parts={{
                                                price: (
                                                    <>
                                                        <span aria-hidden="true">🫘 {formatNumber(reportingItem.priceBeans)}</span>
                                                        <span className="sr-only">{beansWords(reportingItem.priceBeans)}</span>
                                                    </>
                                                ),
                                            }}
                                        />
                                    </p>

                                    <div className="grid grid-cols-3 gap-2 mb-3" role="radiogroup" aria-label={t('Feedback reason')}>
                                        <button
                                            type="button"
                                            role="radio"
                                            aria-checked={reportType === 'too_high'}
                                            onClick={() => setReportType('too_high')}
                                            className={`py-2 px-1 min-h-[44px] text-xs font-semibold rounded-xl border text-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                                                reportType === 'too_high'
                                                    ? 'bg-bp-chip-ok-tint border-bp-chip-ok-ink text-bp-chip-ok-ink'
                                                    : 'bg-zinc-50 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300'
                                            }`}
                                        >
                                            <span aria-hidden="true">📈</span> {t('Too High')}
                                        </button>
                                        <button
                                            type="button"
                                            role="radio"
                                            aria-checked={reportType === 'too_low'}
                                            onClick={() => setReportType('too_low')}
                                            className={`py-2 px-1 min-h-[44px] text-xs font-semibold rounded-xl border text-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                                                reportType === 'too_low'
                                                    ? 'bg-bp-chip-ok-tint border-bp-chip-ok-ink text-bp-chip-ok-ink'
                                                    : 'bg-zinc-50 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300'
                                            }`}
                                        >
                                            <span aria-hidden="true">📉</span> {t('Too Low')}
                                        </button>
                                        <button
                                            type="button"
                                            role="radio"
                                            aria-checked={reportType === 'other'}
                                            onClick={() => setReportType('other')}
                                            className={`py-2 px-1 min-h-[44px] text-xs font-semibold rounded-xl border text-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                                                reportType === 'other'
                                                    ? 'bg-bp-chip-ok-tint border-bp-chip-ok-ink text-bp-chip-ok-ink'
                                                    : 'bg-zinc-50 dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300'
                                            }`}
                                        >
                                            <span aria-hidden="true">💬</span> {t('Other')}
                                        </button>
                                    </div>

                                    <textarea
                                        rows={3}
                                        aria-label={t('Additional feedback notes')}
                                        placeholder={t('Optional: Why is this estimate wrong?')}
                                        value={reportComment}
                                        onChange={(e) => setReportComment(e.target.value)}
                                        className="w-full text-xs p-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800 border-none text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-emerald-500 mb-4"
                                    />

                                    <div className="flex gap-2">
                                        <button
                                            type="button"
                                            onClick={() => setReportingItem(null)}
                                            className="flex-1 py-2 min-h-[44px] rounded-xl text-xs font-semibold bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                                        >
                                            {t('Cancel')}
                                        </button>
                                        <button
                                            type="submit"
                                            disabled={reportSubmitting}
                                            className="flex-1 py-2 min-h-[44px] rounded-xl text-xs font-semibold bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50"
                                        >
                                            {reportSubmitting ? t('Submitting...') : t('Submit')}
                                        </button>
                                    </div>
                                </form>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
