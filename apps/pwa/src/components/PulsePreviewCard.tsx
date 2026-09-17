/**
 * Facade Card for previewing Pulse posts before manual submission (The Pulse, Package 05).
 *
 * Displays:
 * - Thumbnail image (with clean fallback when unavailable or loading fails).
 * - Post title (multi-line reflow, capped max lines, resilient to 1.3x font scaling).
 * - Platform badge (via @beanpool/core).
 * - Category badge (via @beanpool/core).
 * - Author callsign / verification badge.
 * - Deduplication banner notice if the post is already in the feed.
 * - Optional review toggle ("Include in Pulse") for deliberate per-item review.
 *
 * Rules:
 * - Renders at 320dp width and 1.3x font scale without clipping or horizontal overflow.
 */

import { useState, useEffect } from 'react';
import {
    platformMeta,
    categoryMeta,
    isWebUrl,
    type ChannelPlatform,
    type ChannelCategory,
} from '@beanpool/core';

export interface PulsePreviewData {
    url: string;
    title: string | null;
    thumbnailUrl: string | null;
    platform: ChannelPlatform;
    category: ChannelCategory;
    externalId?: string | null;
    isDuplicate?: boolean;
    duplicateItemId?: string | null;
    authorCallsign?: string;
    isVerified?: boolean;
    publishedAt?: string | null;
}

interface Props {
    preview: PulsePreviewData;
    callsign?: string;
    isOptedIn?: boolean;
    onToggleOptIn?: (optedIn: boolean) => void;
    showReviewToggle?: boolean;
}

export function PulsePreviewCard({
    preview,
    callsign,
    isOptedIn = true,
    onToggleOptIn,
    showReviewToggle = false,
}: Props) {
    const [imageError, setImageError] = useState(false);

    useEffect(() => {
        setImageError(false);
    }, [preview.thumbnailUrl]);

    const platform = platformMeta(preview.platform);
    const category = categoryMeta(preview.category);
    const displayCallsign = preview.authorCallsign || callsign || 'You';
    const hasValidThumbnail = Boolean(preview.thumbnailUrl && isWebUrl(preview.thumbnailUrl) && !imageError);

    return (
        <div
            className={`bg-white dark:bg-nature-900 border rounded-2xl p-3.5 sm:p-4 mb-3 shadow-sm transition-all ${
                preview.isDuplicate
                    ? 'border-amber-400 dark:border-amber-600'
                    : 'border-nature-200 dark:border-nature-800'
            } ${!isOptedIn ? 'opacity-60 bg-nature-50 dark:bg-nature-950' : ''}`}
            role="region"
            aria-label={`Preview of ${platform.label} post: ${preview.title || 'Untitled'}`}
        >
            {/* Header: Author Callout & Badges */}
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-nature-100 dark:bg-nature-800 text-nature-800 dark:text-nature-200 border border-nature-200 dark:border-nature-700">
                    <span aria-hidden="true">{platform.icon}</span>
                    <span className="truncate max-w-[150px]">{displayCallsign}</span>
                    {preview.isVerified && (
                        <span
                            className="w-3.5 h-3.5 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[9px] font-black shrink-0"
                            title="Verified creator"
                            aria-label="Verified creator"
                        >
                            ✓
                        </span>
                    )}
                </div>

                <div className="inline-flex items-center gap-1 text-xs font-medium text-nature-500 dark:text-nature-400 px-2 py-0.5 rounded-md bg-nature-50 dark:bg-nature-800/50">
                    <span aria-hidden="true">{category.icon}</span>
                    <span>{category.label}</span>
                </div>
            </div>

            {/* Media & Content */}
            <div className="flex items-start gap-3">
                {hasValidThumbnail ? (
                    <img
                        src={preview.thumbnailUrl!}
                        alt=""
                        onError={() => setImageError(true)}
                        className="w-20 h-20 rounded-xl object-cover bg-nature-100 dark:bg-nature-800 shrink-0"
                    />
                ) : (
                    <div className="w-20 h-20 rounded-xl bg-nature-100 dark:bg-nature-800 border border-nature-200 dark:border-nature-700 flex items-center justify-center shrink-0 text-3xl opacity-75 select-none">
                        {platform.icon}
                    </div>
                )}

                <div className="flex-1 min-w-0">
                    <h4
                        className={`font-semibold text-sm sm:text-base text-nature-950 dark:text-white line-clamp-3 leading-snug mb-1.5 ${
                            !isOptedIn ? 'line-through text-nature-400 dark:text-nature-500' : ''
                        }`}
                    >
                        {preview.title || 'Untitled Post'}
                    </h4>
                    <p className="text-xs text-nature-500 dark:text-nature-400 truncate font-mono">
                        {preview.url}
                    </p>
                </div>
            </div>

            {/* Duplicate Notice Banner */}
            {preview.isDuplicate && (
                <div
                    className="flex items-center gap-2 mt-3 p-2.5 rounded-xl text-xs font-medium bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-800/60"
                    role="alert"
                >
                    <span aria-hidden="true">ℹ️</span>
                    <span className="flex-1 leading-tight">
                        Already published to Pulse. Submitting will update the title or category.
                    </span>
                </div>
            )}

            {/* Review Opt-out Toggle */}
            {showReviewToggle && onToggleOptIn && (
                <div className="flex items-center justify-between mt-3 pt-3 border-t border-nature-100 dark:border-nature-800/60">
                    <div className="pr-3 min-w-0">
                        <div className="text-xs sm:text-sm font-semibold text-nature-900 dark:text-white">
                            Publish to Pulse
                        </div>
                        <div className="text-[11px] sm:text-xs text-nature-500 dark:text-nature-400 truncate">
                            {isOptedIn ? 'Will be shared with your local community' : 'Excluded from this publish'}
                        </div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer shrink-0">
                        <input
                            type="checkbox"
                            checked={isOptedIn}
                            onChange={(e) => onToggleOptIn(e.target.checked)}
                            className="sr-only peer"
                            aria-label="Publish to Pulse"
                        />
                        <div className="w-11 h-6 bg-nature-200 peer-focus-visible:ring-2 peer-focus-visible:ring-terra-500 peer-focus-visible:ring-offset-2 dark:peer-focus-visible:ring-offset-nature-900 rounded-full peer dark:bg-nature-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-terra-500"></div>
                    </label>
                </div>
            )}
        </div>
    );
}
