/**
 * PostAuthorTrust — Hybrid Trust Display for PWA
 *
 * Shows an avatar + tier badge + star rating.
 * Avatar shows initials fallback or real image.
 * Clicking the component opens the PublicProfileModal.
 *
 * The tier is the node's own (@beanpool/core tierForCredit). `energyCycled` is the post's
 * authorEnergyCycled, which the node fills with the author's tier credit (vouch + earned + granted),
 * so the badge matches the tier on the author's own Ledger. Only the colours live here.
 */

import { useState } from 'react';
import { tierForCredit, type TierLevel, type TierName } from '@beanpool/core';

import { resolveAvatarUrl } from '../lib/avatar';

const TIER_LOOK: Record<TierName, { color: string; bg: string; border: string }> = {
    Newcomer: { color: 'text-nature-600 dark:text-nature-300', bg: 'bg-nature-500/10', border: 'border-nature-500/20' },
    Resident: { color: 'text-blue-600 dark:text-blue-400',     bg: 'bg-blue-500/10',   border: 'border-blue-500/20' },
    Steward:  { color: 'text-violet-600 dark:text-violet-400', bg: 'bg-violet-500/10', border: 'border-violet-500/20' },
    Elder:    { color: 'text-amber-600 dark:text-amber-500',   bg: 'bg-amber-500/15',  border: 'border-amber-500/30' },
};

export function getTrustTier(energyCycled: number = 0): TierLevel & { label: TierName; color: string; bg: string; border: string } {
    const tier = tierForCredit(energyCycled);
    return { ...tier, label: tier.name, ...TIER_LOOK[tier.name] };
}

export function isElder(energyCycled: number = 0): boolean {
    return tierForCredit(energyCycled).name === 'Elder';
}

interface PostAuthorTrustProps {
    callsign: string;
    energyCycled?: number;
    rating?: { average: number; count: number };
    /** 'compact' = grid cards, 'full' = list cards */
    mode?: 'compact' | 'full';
    className?: string;
    /** Avatar URL (image) — shows initials fallback if missing */
    avatarUrl?: string | null;
    /** Public key for profile navigation */
    publicKey?: string;
    onOpenProfile?: (pubkey: string) => void;
}

/** Small avatar circle with initials fallback */
function MiniAvatar({ callsign, avatarUrl, size }: { callsign: string; avatarUrl?: string | null; size: number }) {
    const initial = callsign.charAt(0).toUpperCase();
    const sizeClass = size === 18 ? 'w-[18px] h-[18px] text-[8px]' : 'w-[24px] h-[24px] text-[10px]';

    const resolved = resolveAvatarUrl(avatarUrl);

    if (resolved) {
        return (
            <img 
                src={resolved} 
                alt={callsign} 
                className={`${sizeClass} rounded-full object-cover flex-shrink-0 border border-nature-200 dark:border-nature-700`}
            />
        );
    }

    return (
        <span className={`${sizeClass} rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-500 flex items-center justify-center font-bold flex-shrink-0 border border-amber-200 dark:border-amber-800`}>
            {initial}
        </span>
    );
}

/**
 * Hybrid Trust Display: Avatar + Tier Badge + Star Rating
 * Tier badge always shows. Star rating only shows when count > 0.
 * Clicking opens the public profile modal.
 */
export function PostAuthorTrust({ callsign, energyCycled = 0, rating, mode = 'full', className = '', avatarUrl, publicKey, onOpenProfile }: PostAuthorTrustProps) {
    const tier = getTrustTier(energyCycled);

    const handleClick = (e: React.MouseEvent) => {
        if (publicKey && onOpenProfile) {
            e.stopPropagation();
            onOpenProfile(publicKey);
        }
    };

    // Make the clickable author chip operable by keyboard (Enter/Space) and focusable —
    // only when it actually opens a profile, so non-interactive chips aren't tab stops.
    const isInteractive = !!(publicKey && onOpenProfile);
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if ((e.key === 'Enter' || e.key === ' ') && isInteractive) {
            e.preventDefault();
            e.stopPropagation();
            onOpenProfile!(publicKey!);
        }
    };
    const interactiveProps = isInteractive
        ? { role: 'button', tabIndex: 0, onKeyDown: handleKeyDown, 'aria-label': `View ${callsign}'s profile` }
        : {};
    const focusRing = isInteractive ? 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nature-500 rounded-sm' : '';

    if (mode === 'compact') {
        return (
            <>
                <div
                    className={`flex items-center gap-1 ${publicKey ? 'cursor-pointer hover:opacity-80' : ''} ${focusRing} ${className}`}
                    onClick={handleClick}
                    {...interactiveProps}
                >
                    {/* Avatar */}
                    <MiniAvatar callsign={callsign} avatarUrl={avatarUrl} size={18} />
                    {/* Tier badge */}
                    <span className={`w-[18px] h-[18px] rounded-full border flex items-center justify-center text-[10px] ${tier.bg} ${tier.border}`}>
                        {tier.emoji}
                    </span>
                    {/* Callsign */}
                    <span className="text-xs text-nature-500 dark:text-nature-400 font-medium truncate flex-1">
                        {callsign}
                    </span>
                    {/* Stars (only if rated) */}
                    {rating && rating.count > 0 && (
                        <span className="text-[9px] text-amber-400 tracking-tighter">
                            {'★'.repeat(Math.min(Math.round(rating.average), 5))}
                        </span>
                    )}
                </div>
            </>
        );
    }

    // Full mode (list cards)
    return (
        <>
            <div
                className={`flex items-center gap-1.5 ${publicKey ? 'cursor-pointer hover:opacity-80' : ''} ${focusRing} ${className}`}
                onClick={handleClick}
                {...interactiveProps}
            >
                {/* Avatar */}
                <MiniAvatar callsign={callsign} avatarUrl={avatarUrl} size={24} />
                {/* Tier badge with label */}
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-extrabold ${tier.bg} ${tier.border} ${tier.color}`}>
                    <span className="text-[11px]">{tier.emoji}</span>
                    {tier.label}
                </span>
                {/* Callsign */}
                <span className="text-[13px] text-nature-600 dark:text-nature-400 font-semibold truncate flex-shrink">
                    {callsign}
                </span>
                {/* Star rating (only when rated) */}
                {rating && rating.count > 0 && (
                    <span className="flex items-center gap-0.5 flex-shrink-0">
                        <span className="text-[11px] text-amber-400 tracking-tighter">
                            {'★'.repeat(Math.min(Math.round(rating.average), 5))}
                            {'☆'.repeat(Math.max(0, 5 - Math.round(rating.average)))}
                        </span>
                        <span className="text-[10px] text-nature-400 font-semibold">({rating.count})</span>
                    </span>
                )}
            </div>
        </>
    );
}
