/**
 * PulseFeedCard — Facade presentation card for Pulse community feed items (Phase 3).
 *
 * Rules:
 * - Facade cards, NOT embeds. Renders a static thumbnail, title, platform, category, and author.
 * - External linking: Clicking opens post URL in a new tab via window.open, strictly validated via isWebUrl.
 * - Emphasizes community: "my neighbour made this" — author avatar, callsign, and verified status.
 * - Owner Mute: When item is owned by viewer, provides a mute action with confirmation.
 * - Responsive at 320dp and 1.3x font scale without horizontal overflow.
 */

import { useState } from 'react';
import {
    isWebUrl,
    platformMeta,
    categoryMeta,
    VIDEO_PLATFORMS,
} from '@beanpool/core';
import { type PulseFeedItem } from '../lib/api';
import { formatRelativeTime, isOfficialSource } from '../lib/pulse';
import { resolveAvatarUrl } from '../lib/avatar';

interface Props {
    item: PulseFeedItem;
    currentPubkey?: string | null;
    onMute?: (itemId: string) => void | Promise<void>;
    onOpenProfile?: (pubkey: string) => void;
}

export function PulseFeedCard({ item, currentPubkey, onMute, onOpenProfile }: Props) {
    const [imageFailed, setImageFailed] = useState(false);
    const [showMuteConfirm, setShowMuteConfirm] = useState(false);

    const isOwner = Boolean(currentPubkey && item.ownerPubkey === currentPubkey);
    const platMeta = platformMeta(item.platform);
    const catMeta = categoryMeta(item.category);
    const isVideo = VIDEO_PLATFORMS.includes(item.platform as any);
    const timeAgo = formatRelativeTime(item.publishedAt);
    const authorName = item.callsign?.trim() || (item.ownerPubkey ? `${item.ownerPubkey.slice(0, 8)}…` : 'Neighbour');
    const avatarResolved = resolveAvatarUrl(item.avatarUrl);

    const handleOpenPost = () => {
        if (!item.url) return;
        const targetUrl = item.url.trim();
        if (!isWebUrl(targetUrl)) {
            console.warn('[PulseFeedCard] Refusing non-web URL scheme:', targetUrl);
            return;
        }
        window.open(targetUrl, '_blank', 'noopener,noreferrer');
    };

    const handleAuthorClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (item.ownerPubkey && onOpenProfile) {
            onOpenProfile(item.ownerPubkey);
        }
    };

    const handleMuteClick = (e: React.MouseEvent) => {
        e.stopPropagation();
        setShowMuteConfirm(true);
    };

    const confirmMute = () => {
        setShowMuteConfirm(false);
        if (onMute) {
            void onMute(item.id);
        }
    };

    return (
        <article
            className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl mb-4 overflow-hidden shadow-sm hover:shadow-md transition-shadow duration-200"
            aria-label={`${item.title || 'Community post'} by ${authorName} on ${platMeta.label}`}
        >
            {/* Header: Neighbour details + Category + Owner actions */}
            <div className="flex items-center justify-between p-3 sm:p-3.5 gap-2 border-b border-nature-100 dark:border-nature-800/60">
                <button
                    type="button"
                    onClick={handleAuthorClick}
                    className="flex items-center gap-2.5 min-w-0 flex-1 text-left bg-transparent border-none p-0 cursor-pointer group"
                    aria-label={`View ${authorName}'s public profile`}
                >
                    <div className="w-9 h-9 rounded-full overflow-hidden bg-oat-100 dark:bg-nature-800 border border-nature-200 dark:border-nature-700 flex items-center justify-center shrink-0">
                        {avatarResolved ? (
                            <img src={avatarResolved} alt="" className="w-full h-full object-cover" />
                        ) : (
                            <span className="text-sm font-black text-nature-500 dark:text-nature-400">
                                {authorName.charAt(0).toUpperCase()}
                            </span>
                        )}
                    </div>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1 leading-tight">
                            <span className="font-bold text-sm text-nature-900 dark:text-white truncate group-hover:text-terra-600 dark:group-hover:text-terra-400 transition-colors">
                                {authorName}
                            </span>
                            {item.isVerified && (
                                <span
                                    className="w-3.5 h-3.5 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[9px] font-black shrink-0"
                                    title="Verified account"
                                    aria-label="Verified account"
                                >
                                    ✓
                                </span>
                            )}
                        </div>
                        <div className="flex items-center gap-1 text-xs text-nature-500 dark:text-nature-400 mt-0.5 truncate">
                            <span className={isOfficialSource(item) ? "font-bold text-terra-600 dark:text-terra-400" : "font-medium"}>
                                {isOfficialSource(item) ? '📰 Local source' : `${platMeta.icon} ${platMeta.label}`}
                            </span>
                            {timeAgo && <span className="shrink-0">· {timeAgo}</span>}
                        </div>
                    </div>
                </button>

                <div className="flex items-center gap-2 shrink-0">
                    <span
                        className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-nature-100 dark:bg-nature-800 text-nature-700 dark:text-nature-300 border border-nature-200 dark:border-nature-700"
                        title={`Category: ${catMeta.label}`}
                    >
                        <span>{catMeta.icon}</span>
                        <span className="hidden xs:inline">{catMeta.label}</span>
                    </span>

                    {isOwner && onMute && (
                        <button
                            type="button"
                            onClick={handleMuteClick}
                            className="text-xs font-semibold px-2 py-1 rounded-lg bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/50 border border-red-200 dark:border-red-900/40 cursor-pointer transition-colors"
                            aria-label="Hide this item from feed"
                        >
                            Hide
                        </button>
                    )}
                </div>
            </div>

            {/* Facade Poster / Thumbnail with Open Link Handler */}
            <div
                onClick={handleOpenPost}
                role="link"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleOpenPost(); }}
                className="cursor-pointer group block focus:outline-none focus:ring-2 focus:ring-terra-400"
                aria-label={`Open post on ${platMeta.label}`}
            >
                <div className="w-full aspect-video relative bg-nature-100 dark:bg-nature-800 overflow-hidden flex items-center justify-center">
                    {item.thumbnailUrl && !imageFailed ? (
                        <img
                            src={item.thumbnailUrl}
                            alt=""
                            onError={() => setImageFailed(true)}
                            className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-300"
                            loading="lazy"
                        />
                    ) : (
                        <div className="text-4xl select-none opacity-60">
                            {platMeta.icon}
                        </div>
                    )}

                    {isVideo && (
                        <div className="absolute inset-0 flex items-center justify-center bg-black/20 pointer-events-none">
                            <div className="w-12 h-12 rounded-full bg-black/60 border border-white/80 flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                                <span className="text-white text-lg ml-0.5 leading-none">▶</span>
                            </div>
                        </div>
                    )}

                    <div className="absolute bottom-2 right-2 bg-black/75 backdrop-blur-sm text-white text-[11px] font-bold px-2 py-0.5 rounded-md shadow">
                        {platMeta.label} ↗
                    </div>
                </div>

                {/* Title and permalink action */}
                <div className="p-3 sm:p-3.5">
                    <h3 className="font-bold text-sm sm:text-base text-nature-950 dark:text-white line-clamp-3 leading-snug group-hover:text-terra-600 dark:group-hover:text-terra-400 transition-colors m-0">
                        {item.title || `View post on ${platMeta.label}`}
                    </h3>
                    <div className="flex items-center gap-1 text-xs font-semibold text-terra-600 dark:text-terra-400 mt-2">
                        <span>Open on {platMeta.label}</span>
                        <span aria-hidden="true">↗</span>
                    </div>
                </div>
            </div>

            {/* Mute confirmation modal */}
            {showMuteConfirm && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150">
                    <div className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl max-w-sm w-full p-5 shadow-2xl">
                        <h4 className="text-base font-bold text-nature-900 dark:text-white mb-2">
                            Hide this post from feed?
                        </h4>
                        <p className="text-sm text-nature-600 dark:text-nature-400 mb-5 leading-relaxed">
                            "{item.title || 'This item'}" will no longer be visible to your neighbours on the community feed.
                        </p>
                        <div className="flex gap-2 justify-end">
                            <button
                                type="button"
                                onClick={() => setShowMuteConfirm(false)}
                                className="px-4 py-2 rounded-xl text-sm font-semibold border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-700 dark:text-nature-200 hover:bg-nature-50 dark:hover:bg-nature-700 transition-colors cursor-pointer"
                            >
                                Keep post
                            </button>
                            <button
                                type="button"
                                onClick={confirmMute}
                                className="px-4 py-2 rounded-xl text-sm font-bold bg-red-600 hover:bg-red-700 text-white transition-colors cursor-pointer"
                            >
                                Hide from feed
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </article>
    );
}
