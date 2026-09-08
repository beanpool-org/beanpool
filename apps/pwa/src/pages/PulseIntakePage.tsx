/**
 * Manual Pulse Ingestion Screen (The Pulse, Phase 4 / Package 05).
 *
 * Allows a community member to share a post to The Pulse manually.
 *
 * Flows & Features:
 * 1. URL Input: Member pastes or types a post URL.
 * 2. URL formatting with automatic live whitespace stripping.
 * 3. Channel matching: Auto-detects matching channel or allows picking from connected channels.
 * 4. Live SSRF-safe Preview: Resolves title, thumbnail, and deduplication status via POST /api/member/pulse/preview.
 * 5. Review & Confirm: Displays facade preview card with opt-in toggle before publishing.
 * 6. Submission: Submits to POST /api/member/pulse/submit.
 * 7. Inline Errors: Displays error messages directly next to input and submit buttons.
 *
 * Rules:
 * - Must render at 320dp width and 1.3x font scale without horizontal scroll.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import {
    type ChannelCategory as Category,
    CATEGORIES,
    platformMeta,
    isWebUrl,
} from '@beanpool/core';
import {
    type MemberCreatorChannel,
    getMemberChannels,
    previewPulsePost,
    submitPulsePost,
} from '../lib/api';
import { type BeanPoolIdentity } from '../lib/identity';
import { PulsePreviewCard, type PulsePreviewData } from '../components/PulsePreviewCard';

interface Props {
    identity: BeanPoolIdentity | null;
    initialUrl?: string;
    initialChannelId?: string;
    onBack: () => void;
    onManageChannels: () => void;
    onSuccess: () => void;
}

export function PulseIntakePage({
    identity,
    initialUrl,
    initialChannelId,
    onBack,
    onManageChannels,
    onSuccess,
}: Props) {
    const [channels, setChannels] = useState<MemberCreatorChannel[]>([]);
    const [loadingChannels, setLoadingChannels] = useState(true);
    const [channelError, setChannelError] = useState<string | null>(null);

    // Form inputs
    const [urlInput, setUrlInput] = useState<string>(initialUrl || '');
    const [selectedChannelId, setSelectedChannelId] = useState<string | null>(initialChannelId || null);
    const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);

    // Live preview resolution state
    const [resolving, setResolving] = useState(false);
    const [previewData, setPreviewData] = useState<PulsePreviewData | null>(null);
    const [urlError, setUrlError] = useState<string | null>(null);
    const [isOptedIn, setIsOptedIn] = useState(true);

    // Submission state
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [submitSuccess, setSubmitSuccess] = useState(false);

    const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastResolvedUrlRef = useRef<string | null>(null);

    /**
     * Load member's connected channels
     */
    const loadChannels = useCallback(async () => {
        if (!identity) {
            setChannelError('No identity available on this device.');
            setLoadingChannels(false);
            return;
        }
        try {
            const res = await getMemberChannels();
            const list = res.channels || [];
            setChannels(list);
            setChannelError(null);

            if (initialChannelId && list.some(c => c.id === initialChannelId)) {
                setSelectedChannelId(initialChannelId);
                const found = list.find(c => c.id === initialChannelId);
                if (found) setSelectedCategory(found.category);
            } else if (list.length === 1) {
                setSelectedChannelId(list[0].id);
                setSelectedCategory(list[0].category);
            }
        } catch (e: any) {
            setChannelError(e?.message || 'Failed to load channels.');
        } finally {
            setLoadingChannels(false);
        }
    }, [identity, initialChannelId]);

    useEffect(() => {
        void loadChannels();
    }, [loadChannels]);

    /**
     * Resolve post preview from server
     */
    const resolvePreview = useCallback(async (urlToResolve: string, channelIdOverride?: string | null) => {
        const cleanUrl = urlToResolve.trim();
        if (!cleanUrl || !isWebUrl(cleanUrl)) {
            setPreviewData(null);
            setUrlError(null);
            return;
        }

        if (!identity) return;

        setResolving(true);
        setUrlError(null);
        setSubmitError(null);

        try {
            const data = await previewPulsePost(cleanUrl, channelIdOverride || selectedChannelId || undefined);
            const p = data.preview;
            if (p) {
                setPreviewData({
                    url: p.url,
                    title: p.title,
                    thumbnailUrl: p.thumbnailUrl,
                    platform: p.platform,
                    category: p.category,
                    externalId: p.externalId || null,
                    isDuplicate: p.alreadyImported,
                    duplicateItemId: p.existingItemId,
                    authorCallsign: identity.callsign,
                    publishedAt: p.publishedAt,
                });

                if (p.channelId && !selectedChannelId) {
                    setSelectedChannelId(p.channelId);
                }
                if (p.category && !selectedCategory) {
                    setSelectedCategory(p.category);
                }
            }
        } catch (e: any) {
            setUrlError(e?.message || 'Unable to resolve post preview.');
            setPreviewData(null);
        } finally {
            setResolving(false);
        }
    }, [identity, selectedChannelId, selectedCategory]);

    /**
     * Live whitespace stripping and debounced preview resolution
     */
    const handleUrlChange = (text: string) => {
        const cleaned = text.replace(/\s+/g, '');
        setUrlInput(cleaned);
        setUrlError(null);
        setSubmitError(null);
        setSubmitSuccess(false);

        if (debounceTimerRef.current) {
            clearTimeout(debounceTimerRef.current);
        }

        if (cleaned && isWebUrl(cleaned)) {
            debounceTimerRef.current = setTimeout(() => {
                void resolvePreview(cleaned);
            }, 500);
        } else {
            setPreviewData(null);
        }
    };

    useEffect(() => {
        if (initialUrl) {
            const cleaned = initialUrl.trim().replace(/\s+/g, '');
            if (cleaned && cleaned !== lastResolvedUrlRef.current) {
                lastResolvedUrlRef.current = cleaned;
                setUrlInput(cleaned);
                void resolvePreview(cleaned);
            }
        }
    }, [initialUrl, resolvePreview]);

    useEffect(() => {
        return () => {
            if (debounceTimerRef.current) {
                clearTimeout(debounceTimerRef.current);
            }
        };
    }, []);

    const pasteFromClipboard = async () => {
        try {
            if (navigator.clipboard?.readText) {
                const text = await navigator.clipboard.readText();
                if (text) {
                    handleUrlChange(text.trim());
                }
            }
        } catch {}
    };

    const handleSubmit = async () => {
        if (!identity) return;
        if (resolving) return;
        if (!urlInput.trim()) {
            setUrlError('Please enter a post URL.');
            return;
        }
        if (!selectedChannelId) {
            setSubmitError('Please select which of your channels this post belongs to.');
            return;
        }
        if (!isOptedIn) {
            setSubmitError('Review toggle is currently opted out. Toggle "Publish to Pulse" to submit.');
            return;
        }

        setSubmitting(true);
        setSubmitError(null);

        try {
            await submitPulsePost({
                url: urlInput.trim(),
                channelId: selectedChannelId,
                title: previewData?.title || undefined,
                thumbnailUrl: previewData?.thumbnailUrl || undefined,
                category: selectedCategory || previewData?.category || undefined,
                externalId: previewData?.externalId || undefined,
            });

            setSubmitSuccess(true);
            setTimeout(() => {
                onSuccess();
            }, 900);
        } catch (e: any) {
            setSubmitError(e?.message || 'Submission failed. Please check the details and retry.');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="max-w-2xl mx-auto p-4 sm:p-6 pb-24 min-h-full">
            {/* Header */}
            <div className="flex items-center justify-between gap-3 mb-4 pb-4 border-b border-nature-200 dark:border-nature-800">
                <button
                    type="button"
                    onClick={onBack}
                    className="flex items-center gap-1 text-sm font-bold text-nature-600 dark:text-nature-400 hover:text-nature-900 dark:hover:text-white bg-transparent border-none cursor-pointer p-1 transition-colors"
                    aria-label="Go back"
                >
                    ‹ Back
                </button>

                <h2 className="text-lg sm:text-xl font-extrabold text-nature-950 dark:text-white m-0 tracking-tight text-center flex-1">
                    Add to Pulse
                </h2>
                <div className="w-12"></div>
            </div>

            <p className="text-xs sm:text-sm text-nature-600 dark:text-nature-400 mb-6 leading-relaxed">
                Share a single post or video from your external channels to your local community feed.
            </p>

            {/* No Channels Notice */}
            {!loadingChannels && channels.length === 0 && (
                <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-5 mb-6 text-center shadow-sm" role="alert">
                    <div className="text-3xl mb-2 select-none">ℹ️</div>
                    <h3 className="text-base font-bold text-nature-900 dark:text-white mb-2">
                        No Channels Connected
                    </h3>
                    <p className="text-xs sm:text-sm text-nature-600 dark:text-nature-400 max-w-sm mx-auto mb-4 leading-relaxed">
                        To share a post, you need to add your Instagram, TikTok, YouTube, or Blog channel first.
                    </p>
                    <button
                        type="button"
                        onClick={onManageChannels}
                        className="px-4 py-2 rounded-xl text-sm font-bold bg-terra-600 hover:bg-terra-500 text-white cursor-pointer shadow-sm"
                    >
                        Add a Channel
                    </button>
                </div>
            )}

            {channelError && (
                <div className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 text-red-700 dark:text-red-300 p-3 rounded-xl mb-4 text-xs sm:text-sm" role="alert">
                    {channelError}
                </div>
            )}

            {/* URL Input Section */}
            <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-4 sm:p-5 mb-5 shadow-sm">
                <div className="flex items-center justify-between mb-2">
                    <label htmlFor="pulse-post-url" className="text-xs sm:text-sm font-bold text-nature-900 dark:text-white">
                        Post URL
                    </label>
                    <button
                        type="button"
                        onClick={pasteFromClipboard}
                        className="text-xs font-semibold px-2 py-0.5 rounded-md border border-nature-200 dark:border-nature-700 bg-nature-50 dark:bg-nature-800 text-terra-600 dark:text-terra-400 hover:bg-nature-100 dark:hover:bg-nature-700 cursor-pointer"
                    >
                        Paste
                    </button>
                </div>

                <input
                    id="pulse-post-url"
                    type="url"
                    value={urlInput}
                    onChange={e => handleUrlChange(e.target.value)}
                    placeholder="https://instagram.com/p/... or tiktok.com/..."
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck="false"
                    className="w-full py-2.5 px-3.5 rounded-xl border border-nature-200 dark:border-nature-800 bg-nature-50 dark:bg-nature-950 text-nature-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-terra-400 font-mono"
                />

                {urlError && (
                    <div className="flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400 mt-2" role="alert">
                        <span>⚠️</span>
                        <span>{urlError}</span>
                    </div>
                )}

                {resolving && (
                    <div className="flex items-center gap-2 text-xs text-nature-500 dark:text-nature-400 mt-2.5">
                        <div className="w-3.5 h-3.5 rounded-full border-2 border-nature-300 dark:border-nature-600 border-t-terra-500 animate-spin"></div>
                        <span>Resolving post preview...</span>
                    </div>
                )}
            </div>

            {/* Channel Selector Section */}
            {channels.length > 0 && (
                <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-4 sm:p-5 mb-5 shadow-sm">
                    <label className="block text-xs sm:text-sm font-bold text-nature-900 dark:text-white mb-2.5">
                        Post from Channel
                    </label>
                    <div className="flex flex-wrap gap-2">
                        {channels.map(ch => {
                            const meta = platformMeta(ch.platform);
                            const isSelected = selectedChannelId === ch.id;
                            const handleText = ch.handle ? ` · ${ch.handle}` : '';

                            return (
                                <button
                                    key={ch.id}
                                    type="button"
                                    onClick={() => {
                                        setSelectedChannelId(ch.id);
                                        setSelectedCategory(ch.category);
                                        if (urlInput) void resolvePreview(urlInput, ch.id);
                                    }}
                                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all cursor-pointer ${
                                        isSelected
                                            ? 'bg-terra-500 border-terra-500 text-white shadow-sm'
                                            : 'bg-nature-50 dark:bg-nature-800 border-nature-200 dark:border-nature-700 text-nature-700 dark:text-nature-300 hover:bg-nature-100 dark:hover:bg-nature-700'
                                    }`}
                                    aria-pressed={isSelected}
                                >
                                    <span>{meta.icon}</span>
                                    <span className="truncate max-w-[180px]">{meta.label}{handleText}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Category Selector Section */}
            {channels.length > 0 && (
                <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-4 sm:p-5 mb-5 shadow-sm">
                    <label className="block text-xs sm:text-sm font-bold text-nature-900 dark:text-white mb-2.5">
                        Category
                    </label>
                    <div className="flex flex-wrap gap-2">
                        {CATEGORIES.map(cat => {
                            const isSelected = selectedCategory === cat.id;
                            return (
                                <button
                                    key={cat.id}
                                    type="button"
                                    onClick={() => setSelectedCategory(cat.id)}
                                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border transition-all cursor-pointer ${
                                        isSelected
                                            ? 'bg-terra-500 border-terra-500 text-white shadow-sm'
                                            : 'bg-nature-50 dark:bg-nature-800 border-nature-200 dark:border-nature-700 text-nature-700 dark:text-nature-300 hover:bg-nature-100 dark:hover:bg-nature-700'
                                    }`}
                                    aria-pressed={isSelected}
                                >
                                    <span>{cat.icon}</span>
                                    <span>{cat.label}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Review & Confirm Preview */}
            {previewData && (
                <div className="mb-6">
                    <label className="block text-xs sm:text-sm font-bold text-nature-900 dark:text-white mb-2.5">
                        Review & Confirm
                    </label>
                    <PulsePreviewCard
                        preview={{
                            ...previewData,
                            category: selectedCategory || previewData.category,
                        }}
                        callsign={identity?.callsign}
                        isOptedIn={isOptedIn}
                        onToggleOptIn={setIsOptedIn}
                        showReviewToggle={true}
                    />
                </div>
            )}

            {submitError && (
                <div className="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 text-red-700 dark:text-red-300 p-3 rounded-xl mb-4 text-xs sm:text-sm" role="alert">
                    {submitError}
                </div>
            )}

            {submitSuccess && (
                <div className="bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200 p-3 rounded-xl mb-4 text-xs sm:text-sm font-medium flex items-center gap-2" role="alert">
                    <span>✓</span>
                    <span>Post shared to The Pulse!</span>
                </div>
            )}

            {/* Submit Action Button */}
            <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting || resolving || submitSuccess || !urlInput.trim() || channels.length === 0}
                className="w-full py-3.5 px-6 rounded-2xl font-bold text-base bg-terra-600 hover:bg-terra-500 disabled:opacity-50 text-white cursor-pointer shadow-md transition-all active:scale-[0.99] flex items-center justify-center gap-2"
            >
                {submitting ? (
                    <>
                        <div className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin"></div>
                        <span>Submitting...</span>
                    </>
                ) : resolving ? (
                    <>
                        <div className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin"></div>
                        <span>Resolving preview...</span>
                    </>
                ) : (
                    <span>{previewData?.isDuplicate ? 'Update on Pulse' : 'Share to Pulse'}</span>
                )}
            </button>
        </div>
    );
}
