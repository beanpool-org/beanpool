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
import { t, tierForCredit, type TierLevel, type TierName } from '@beanpool/core';
import { tierWords } from '../lib/trust-tier';

import { MemberAvatar } from './MemberAvatar';

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
    /** Avatar URL (image) — the ready-made picture the author's key picks if missing */
    avatarUrl?: string | null;
    /** Public key for profile navigation */
    publicKey?: string;
    onOpenProfile?: (pubkey: string) => void;
    /**
     * False where Beans live in a local community for this reader (lib/features `marked`): no tier badge. A tier is
     * earned through Beans, so on such a node every author would read Newcomer for good. Default true.
     */
    showTier?: boolean;
    /** Whether author needs a founding trade (no prior trades completed) */
    isFounding?: boolean;
}

/** Small avatar circle: the author's picture, or the ready-made one their key picks (never an initial). */
function MiniAvatar({ callsign, avatarUrl, publicKey, size }: { callsign: string; avatarUrl?: string | null; publicKey?: string; size: number }) {
    return (
        <MemberAvatar avatarUrl={avatarUrl} pubkey={publicKey} callsign={callsign} size={size} className="flex-shrink-0 border border-nature-200 dark:border-nature-700" />
    );
}

/**
 * Hybrid Trust Display: Avatar + Tier Badge + Star Rating
 * Tier badge shows unless `showTier` is false. Star rating only shows when count > 0; otherwise founding mark shows if isFounding is true.
 * Clicking opens the public profile modal.
 */
export function PostAuthorTrust({ callsign, energyCycled = 0, rating, mode = 'full', className = '', avatarUrl, publicKey, onOpenProfile, showTier = true, isFounding = false }: PostAuthorTrustProps) {
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
        ? { role: 'button', tabIndex: 0, onKeyDown: handleKeyDown, 'aria-label': t("View {name}'s profile", { name: callsign }) }
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
                    <MiniAvatar callsign={callsign} avatarUrl={avatarUrl} publicKey={publicKey} size={18} />
                    {/* Tier badge */}
                    {showTier && (
                        <span data-testid="author-tier" className={`w-[18px] h-[18px] rounded-full border flex items-center justify-center text-[10px] ${tier.bg} ${tier.border}`}>
                            {tier.emoji}
                        </span>
                    )}
                    {/* Callsign */}
                    <span className="text-xs text-nature-500 dark:text-nature-400 font-medium truncate flex-1">
                        {callsign}
                    </span>
                    {/* Stars / Founding mark */}
                    {rating && rating.count > 0 ? (
                        <span className="text-[9px] text-amber-400 tracking-tighter">
                            {'★'.repeat(Math.min(Math.round(rating.average), 5))}
                        </span>
                    ) : (
                        isFounding && (
                            <span data-testid="author-founding" className="text-[10px] font-extrabold text-nature-700 dark:text-nature-400 ml-0.5" title={t('Founding')} aria-label={t('Founding')}>🌱</span>
                        )
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
                <MiniAvatar callsign={callsign} avatarUrl={avatarUrl} publicKey={publicKey} size={24} />
                {/* Tier badge with label */}
                {showTier && (
                    <span data-testid="author-tier" className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-extrabold ${tier.bg} ${tier.border} ${tier.color}`}>
                        <span className="text-[11px]">{tier.emoji}</span>
                        <span>{tierWords(tier.label)}</span>
                    </span>
                )}
                {/* Callsign */}
                <span className="text-[13px] text-nature-600 dark:text-nature-400 font-semibold truncate flex-shrink">
                    {callsign}
                </span>
                {/* Star rating / Founding badge */}
                {rating && rating.count > 0 ? (
                    <span className="flex items-center gap-0.5 flex-shrink-0">
                        <span className="text-[11px] text-amber-400 tracking-tighter">
                            {'★'.repeat(Math.min(Math.round(rating.average), 5))}
                            {'☆'.repeat(Math.max(0, 5 - Math.round(rating.average)))}
                        </span>
                        <span className="text-[10px] text-nature-400 font-semibold">({rating.count})</span>
                    </span>
                ) : (
                    isFounding && (
                        <span data-testid="author-founding" className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md border text-[10px] font-extrabold bg-nature-500/10 border-nature-500/20 text-nature-700 dark:text-nature-300 ml-1">
                            {t('🌱 FOUNDING')}
                        </span>
                    )
                )}
            </div>
        </>
    );
}
