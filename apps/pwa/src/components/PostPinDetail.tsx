/**
 * Post Pin Detail & Actions (scratch/fable-design/DESIGN-pinning-fable.md §0.2, §2.7, §2.11):
 * Displays the "Pinned by your community · until {date}" line on a pinned post,
 * offers "Take the pin off" for owners, admins, and the post author,
 * and provides "…" menu with "Pin to the top…" and "Take the pin off".
 *
 * An app never offers what the node refuses: "Pin to the top…" is shown only when
 * features.pins is true on the node profile, and the post is eligible to be pinned
 * (local community post, public audience, active, and not ended/cancelled).
 */
import { useEffect, useRef, useState } from 'react';
import { formatDate, pinLive, t } from '@beanpool/core';
import { unpinMarketplacePost, type MarketplacePost } from '../lib/api';
import type { BeanPoolIdentity } from '../lib/identity';
import { PinSheet } from './PinSheet';

export interface PostPinDetailProps {
    post: MarketplacePost;
    identity?: BeanPoolIdentity | null;
    isOwnerOrAdmin?: boolean;
    featuresPins?: boolean;
    onPostUpdated: (updated: MarketplacePost) => void;
}

export function PostPinDetail({
    post,
    identity,
    isOwnerOrAdmin = false,
    featuresPins = false,
    onPostUpdated,
}: PostPinDetailProps) {
    const [showPinSheet, setShowPinSheet] = useState(false);
    const [showMenu, setShowMenu] = useState(false);
    const [unpinning, setUnpinning] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const menuRef = useRef<HTMLDivElement>(null);
    const menuBtnRef = useRef<HTMLButtonElement>(null);

    const isLive = pinLive(post as any);
    const isAuthor = Boolean(identity?.publicKey && post.authorPublicKey === identity.publicKey);
    const canUnpin = isLive && (isOwnerOrAdmin || isAuthor);

    const isPinnable =
        !post.originNode &&
        !(post as any)._remoteNode &&
        (!post.audienceScope || post.audienceScope === 'public') &&
        post.status === 'active' &&
        post.active !== false &&
        !(post as any).hiddenByReportsAt &&
        !(post as any).removedByModeratorAt &&
        (post.type !== 'event' || (post.eventState !== 'cancelled' && (!post.eventEndAt && !post.eventStartAt || Date.parse(post.eventEndAt ?? post.eventStartAt!) > Date.now()))) &&
        (post.type !== 'poll' || (!post.pollClosesAt || Date.parse(post.pollClosesAt) > Date.now()));

    const canPin = Boolean(identity?.publicKey) && featuresPins && isOwnerOrAdmin && isPinnable;

    // Close menu when clicking outside or pressing Escape
    useEffect(() => {
        if (!showMenu) return;
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                setShowMenu(false);
                menuBtnRef.current?.focus();
            }
        };
        const handleClickOutside = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setShowMenu(false);
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        document.addEventListener('mousedown', handleClickOutside);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
            document.removeEventListener('mousedown', handleClickOutside);
        };
    }, [showMenu]);

    const handleUnpin = async () => {
        if (unpinning) return;
        setUnpinning(true);
        setError(null);
        try {
            await unpinMarketplacePost(post.id);
            const updated: MarketplacePost = {
                ...post,
                pinnedUntil: null,
                pinnedAt: null,
            };
            onPostUpdated(updated);
            setShowMenu(false);
        } catch (e: any) {
            setError(e.message || t("Only an owner, an admin or the post's author can take a pin off."));
        } finally {
            setUnpinning(false);
        }
    };

    const hasAnyAction = canPin || canUnpin;

    return (
        <div data-testid="post-pin-container" className="mb-3">
            {/* Live Pinned Detail Line */}
            {isLive && post.pinnedUntil && (
                <div
                    data-testid="post-pinned-detail-banner"
                    className="flex flex-wrap items-center justify-between gap-2 p-3 mb-2 rounded-xl bg-nature-50/80 dark:bg-nature-900/50 border border-nature-200 dark:border-nature-800"
                >
                    <p
                        data-testid="post-pinned-detail-line"
                        className="m-0 text-xs font-semibold text-nature-700 dark:text-nature-300 truncate flex items-center gap-1.5"
                    >
                        <span>📌</span>
                        <span className="truncate">
                            {t('Pinned by your community · until {date}', {
                                date: formatDate(new Date(post.pinnedUntil), 'weekday-day-month'),
                            })}
                        </span>
                    </p>

                    {canUnpin && (
                        <button
                            type="button"
                            onClick={handleUnpin}
                            disabled={unpinning}
                            data-testid="take-pin-off-inline-btn"
                            className="text-xs font-bold text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 px-2.5 py-1 rounded-lg border border-red-200 dark:border-red-900/40 bg-white/70 dark:bg-nature-950/70 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors cursor-pointer disabled:opacity-50 min-h-[36px] flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nature-500"
                        >
                            {unpinning ? t('Updating…') : t('Take the pin off')}
                        </button>
                    )}
                </div>
            )}

            {/* Error Refusal Banner */}
            {error && (
                <div
                    role="alert"
                    data-testid="post-pin-error"
                    className="p-3 mb-2 rounded-xl bg-bp-chip-warn-tint text-bp-chip-warn-ink text-xs font-semibold break-words"
                >
                    {error}
                </div>
            )}

            {/* Actions: "…" Menu */}
            {hasAnyAction && (
                <div ref={menuRef} className="relative inline-block text-left mb-2">
                    <button
                        ref={menuBtnRef}
                        type="button"
                        onClick={() => setShowMenu(!showMenu)}
                        aria-expanded={showMenu}
                        aria-haspopup="menu"
                        aria-label={t('Options')}
                        data-testid="post-menu-trigger"
                        className="min-h-[44px] min-w-[44px] px-3 py-1.5 rounded-xl border border-nature-200 dark:border-nature-800 bg-white dark:bg-nature-900 hover:bg-nature-50 dark:hover:bg-nature-800 text-nature-700 dark:text-nature-200 text-sm font-bold flex items-center gap-1.5 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nature-500 shadow-xs"
                    >
                        <span>···</span>
                        <span className="text-xs font-semibold">{t('Options')}</span>
                    </button>

                    {showMenu && (
                        <div
                            role="menu"
                            aria-orientation="vertical"
                            data-testid="post-actions-menu"
                            className="absolute left-0 mt-1 w-56 rounded-2xl bg-white dark:bg-nature-950 border border-nature-200 dark:border-nature-800 shadow-xl py-1.5 z-40 focus:outline-none"
                        >
                            {canPin && (
                                <button
                                    role="menuitem"
                                    type="button"
                                    onClick={() => {
                                        setShowMenu(false);
                                        setShowPinSheet(true);
                                    }}
                                    data-testid="menu-pin-post"
                                    className="w-full text-left px-4 py-2.5 text-sm font-semibold text-nature-900 dark:text-white hover:bg-nature-100 dark:hover:bg-nature-900 flex items-center gap-2 cursor-pointer focus-visible:outline-none focus-visible:bg-nature-100 dark:focus-visible:bg-nature-900 min-h-[44px]"
                                >
                                    <span>📌</span>
                                    <span>{t('Pin to the top…')}</span>
                                </button>
                            )}

                            {canUnpin && (
                                <button
                                    role="menuitem"
                                    type="button"
                                    onClick={handleUnpin}
                                    disabled={unpinning}
                                    data-testid="menu-unpin-post"
                                    className="w-full text-left px-4 py-2.5 text-sm font-semibold text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 flex items-center gap-2 cursor-pointer focus-visible:outline-none focus-visible:bg-red-50 dark:focus-visible:bg-red-950/30 min-h-[44px] disabled:opacity-50"
                                >
                                    <span>✕</span>
                                    <span>{unpinning ? t('Updating…') : t('Take the pin off')}</span>
                                </button>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* Pin Sheet Modal */}
            <PinSheet
                post={post}
                isOpen={showPinSheet}
                onClose={() => {
                    setShowPinSheet(false);
                    menuBtnRef.current?.focus();
                }}
                onSuccess={(updated) => {
                    onPostUpdated(updated);
                    menuBtnRef.current?.focus();
                }}
            />
        </div>
    );
}
