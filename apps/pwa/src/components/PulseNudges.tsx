/**
 * Pulse Nudges — Clipboard & Post-Count Ingestion Prompts (The Pulse, Package 05).
 *
 * 1. Clipboard Nudge:
 *    - Reads clipboard text safely if permitted.
 *    - Matches URL against member's connected channels.
 *    - Uses localStorage ('pulse_seen_clip_' + url) to offer adding once per URL.
 *    - Banner with "Add to Pulse" and "Dismiss".
 *
 * 2. Post-Count Nudge:
 *    - Compares channel's probed count vs post_count_seen via /api/member/pulse/nudges.
 *    - "Share" button opens manual intake.
 *    - "Dismiss" calls /api/member/pulse/channels/:id/dismiss-nudge.
 *
 * Rules:
 * - Reflows cleanly at 320dp width and 1.3x font scale.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { platformMeta, isWebUrl, type ChannelPlatform } from '@beanpool/core';
import {
    type MemberCreatorChannel,
    type PostCountNudge,
    getPulseNudges,
    dismissPulseNudge,
} from '../lib/api';

interface Props {
    channels?: MemberCreatorChannel[];
    onNudgeDismissed?: () => void;
    onAddFromClipboard?: (url: string) => void;
    onShareChannel?: (channelId: string) => void;
}

export function PulseNudges({
    channels,
    onNudgeDismissed,
    onAddFromClipboard,
    onShareChannel,
}: Props) {
    const [clipboardUrl, setClipboardUrl] = useState<string | null>(null);
    const [clipboardPlatform, setClipboardPlatform] = useState<ChannelPlatform | null>(null);
    const [postCountNudges, setPostCountNudges] = useState<PostCountNudge[]>([]);
    const checkedClipboardsRef = useRef<Set<string>>(new Set());

    /**
     * Check clipboard content non-intrusively
     */
    const checkClipboard = useCallback(async () => {
        if (!channels || channels.length === 0) return;
        if (typeof navigator === 'undefined' || !navigator.clipboard?.readText) return;

        try {
            // Note: readText() can reject if page doesn't have focus or permission is denied
            if (typeof document !== 'undefined' && !document.hasFocus()) return;
            const text = await navigator.clipboard.readText();
            if (!text || !text.trim()) return;

            const clean = text.trim();
            if (!isWebUrl(clean)) return;

            if (checkedClipboardsRef.current.has(clean)) return;
            checkedClipboardsRef.current.add(clean);

            // Check localStorage to offer only ONCE per URL
            const seenKey = `pulse_seen_clip_${clean}`;
            if (localStorage.getItem(seenKey)) return;

            // Check if URL matches any connected channel
            const lowerUrl = clean.toLowerCase();
            let matchedPlatform: ChannelPlatform | null = null;

            for (const ch of channels) {
                if (ch.platform === 'instagram' && (lowerUrl.includes('instagram.com/p/') || lowerUrl.includes('instagram.com/reel/'))) {
                    matchedPlatform = 'instagram';
                    break;
                }
                if (ch.platform === 'tiktok' && lowerUrl.includes('tiktok.com/')) {
                    matchedPlatform = 'tiktok';
                    break;
                }
                if (ch.platform === 'youtube' && (lowerUrl.includes('youtube.com/watch') || lowerUrl.includes('youtube.com/shorts/') || lowerUrl.includes('youtu.be/'))) {
                    matchedPlatform = 'youtube';
                    break;
                }
                if (ch.platform === 'facebook' && lowerUrl.includes('facebook.com/')) {
                    matchedPlatform = 'facebook';
                    break;
                }
                if (ch.platform === 'soundcloud' && (lowerUrl.includes('soundcloud.com/') || lowerUrl.includes('snd.sc/'))) {
                    matchedPlatform = 'soundcloud';
                    break;
                }
                if ((ch.platform === 'website' || ch.platform === 'rss') && ch.url) {
                    try {
                        const chHost = new URL(ch.url).hostname.replace(/^www\./, '').toLowerCase();
                        const urlHost = new URL(clean).hostname.replace(/^www\./, '').toLowerCase();
                        if (urlHost === chHost || urlHost.endsWith(`.${chHost}`)) {
                            matchedPlatform = ch.platform;
                            break;
                        }
                    } catch {
                        // ignore malformed URL
                    }
                }
            }

            if (matchedPlatform) {
                setClipboardUrl(clean);
                setClipboardPlatform(matchedPlatform);
            }
        } catch {
            // Non-fatal, never throw on clipboard read errors
        }
    }, [channels]);

    /**
     * Fetch post count nudges from server
     */
    const loadPostCountNudges = useCallback(async () => {
        try {
            const res = await getPulseNudges();
            if (Array.isArray(res.nudges)) {
                setPostCountNudges(res.nudges);
            }
        } catch {
            // ignore network errors
        }
    }, []);

    useEffect(() => {
        const timer = setTimeout(() => {
            void checkClipboard();
            void loadPostCountNudges();
        }, 800);
        return () => clearTimeout(timer);
    }, [checkClipboard, loadPostCountNudges]);

    // Check clipboard on window focus
    useEffect(() => {
        const onFocus = () => {
            void checkClipboard();
        };
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, [checkClipboard]);

    const dismissClipboard = () => {
        if (!clipboardUrl) return;
        const url = clipboardUrl;
        setClipboardUrl(null);
        setClipboardPlatform(null);
        try {
            localStorage.setItem(`pulse_seen_clip_${url}`, '1');
        } catch {}
    };

    const handleAddClipboard = () => {
        if (!clipboardUrl) return;
        const url = clipboardUrl;
        dismissClipboard();
        if (onAddFromClipboard) {
            onAddFromClipboard(url);
        }
    };

    const handleDismissPostCountNudge = async (nudge: PostCountNudge) => {
        setPostCountNudges(prev => prev.filter(n => n.channelId !== nudge.channelId));
        try {
            await dismissPulseNudge(nudge.channelId, nudge.currentCount);
            if (onNudgeDismissed) onNudgeDismissed();
        } catch {}
    };

    if (!clipboardUrl && postCountNudges.length === 0) {
        return null;
    }

    return (
        <div className="w-full mb-3 space-y-2.5">
            {/* Clipboard Nudge Banner */}
            {clipboardUrl && clipboardPlatform && (
                <div
                    className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-3.5 sm:p-4 shadow-sm"
                    role="alert"
                >
                    <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-1.5 font-bold text-sm text-nature-900 dark:text-white">
                            <span aria-hidden="true">{platformMeta(clipboardPlatform).icon}</span>
                            <span>Link from Clipboard</span>
                        </div>
                        <button
                            type="button"
                            onClick={dismissClipboard}
                            className="text-nature-400 hover:text-nature-700 dark:hover:text-nature-200 p-1 rounded-lg bg-transparent border-none cursor-pointer"
                            aria-label="Dismiss clipboard suggestion"
                        >
                            ✕
                        </button>
                    </div>

                    <p className="text-xs font-mono text-nature-600 dark:text-nature-400 bg-nature-50 dark:bg-nature-950 p-2 rounded-lg truncate my-2 border border-nature-100 dark:border-nature-800">
                        {clipboardUrl}
                    </p>

                    <p className="text-xs sm:text-sm text-nature-700 dark:text-nature-300 leading-relaxed mb-3">
                        Found a link to your {platformMeta(clipboardPlatform).label} channel. Would you like to share it to The Pulse?
                    </p>

                    <div className="flex items-center justify-end gap-2">
                        <button
                            type="button"
                            onClick={dismissClipboard}
                            className="px-3 py-1.5 rounded-xl text-xs sm:text-sm font-semibold border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-700 dark:text-nature-300 hover:bg-nature-50 dark:hover:bg-nature-700 cursor-pointer transition-colors"
                        >
                            Dismiss
                        </button>
                        <button
                            type="button"
                            onClick={handleAddClipboard}
                            className="px-3.5 py-1.5 rounded-xl text-xs sm:text-sm font-bold bg-terra-600 hover:bg-terra-500 text-white cursor-pointer shadow-sm transition-colors"
                        >
                            Add to Pulse
                        </button>
                    </div>
                </div>
            )}

            {/* Post-Count Nudges */}
            {postCountNudges.map((nudge) => {
                const meta = platformMeta(nudge.platform);
                const count = nudge.newPostsCount;
                const countText = count === 1 ? '1 new thing' : `${count} new things`;

                return (
                    <div
                        key={nudge.channelId}
                        className="bg-white dark:bg-nature-900 border border-nature-200 dark:border-nature-800 rounded-2xl p-3.5 sm:p-4 shadow-sm"
                        role="alert"
                    >
                        <div className="flex items-center justify-between mb-1.5">
                            <div className="flex items-center gap-1.5 font-bold text-sm text-nature-900 dark:text-white">
                                <span aria-hidden="true">{meta.icon}</span>
                                <span>{meta.label} Updates</span>
                            </div>
                            <button
                                type="button"
                                onClick={() => handleDismissPostCountNudge(nudge)}
                                className="text-nature-400 hover:text-nature-700 dark:hover:text-nature-200 p-1 rounded-lg bg-transparent border-none cursor-pointer"
                                aria-label="Dismiss update notice"
                            >
                                ✕
                            </button>
                        </div>

                        <p className="text-xs sm:text-sm text-nature-700 dark:text-nature-300 leading-relaxed mb-3">
                            You've posted {countText} on {meta.label} since your last visit.
                        </p>

                        <div className="flex items-center justify-end gap-2">
                            <button
                                type="button"
                                onClick={() => handleDismissPostCountNudge(nudge)}
                                className="px-3 py-1.5 rounded-xl text-xs sm:text-sm font-semibold border border-nature-200 dark:border-nature-700 bg-white dark:bg-nature-800 text-nature-700 dark:text-nature-300 hover:bg-nature-50 dark:hover:bg-nature-700 cursor-pointer transition-colors"
                            >
                                Dismiss
                            </button>
                            <button
                                type="button"
                                onClick={() => onShareChannel && onShareChannel(nudge.channelId)}
                                className="px-3.5 py-1.5 rounded-xl text-xs sm:text-sm font-bold bg-terra-600 hover:bg-terra-500 text-white cursor-pointer shadow-sm transition-colors"
                            >
                                Share
                            </button>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
