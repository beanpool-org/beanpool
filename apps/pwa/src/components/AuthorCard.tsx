/**
 * AuthorCard: the box that names the person behind an item on its own page. A listing's "Posted by" and an event's
 * "Hosted by" are this one box (Marty, 4 Nov 2026, on the phone's event page: "hosted by is so small and in plain text -
 * consider looking at the offer card and styling it like that one"; the phone's is components/AuthorCard.tsx): a rounded card,
 * the label in small capitals, the person's face, their name with the handshake and their ratings (stars, the average and how
 * many, and what they are rated as a provider and as a receiver).
 *
 * The box is the style box's page box (components/market-card-shell.ts PAGE_BOX, BOX_LABEL; DESIGN-detail-pages-fable.md §2.2,
 * slice DW1): corners 14, the card's outline, ground and shadow, 12 of padding, the label in small capitals; a face of 48 and
 * the name at 16/700, as the phone's box has them.
 *
 * The face and name are one button: a click opens the person's profile (`onOpen`; with none, the box shows the person and
 * opens nothing). `details` sits under the ratings inside that button (the listing's bio and contact line); `children` sit
 * under the button, inside the box (the listing's shop link and rough-place line). The page's own spacing is `className`.
 *
 * `useMemberRatings` is for a page that does not already read the person's ratings (the event page).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { t, formatNumber } from '@beanpool/core';
import { getMemberRatings } from '../lib/api';
import { MemberAvatar } from './MemberAvatar';
import { BOX_LABEL, PAGE_BOX } from './market-card-shell';

export interface AuthorRatings {
    average: number;
    count: number;
    asProvider?: { average: number; count: number };
    asReceiver?: { average: number; count: number };
}

const NO_RATINGS: AuthorRatings = { average: 0, count: 0 };

/** A person's ratings, for a page that shows them as a card. An unreadable rating stays "No ratings yet", never an error. */
export function useMemberRatings(pubkey: string | null | undefined): AuthorRatings {
    const [ratings, setRatings] = useState<AuthorRatings>(NO_RATINGS);
    useEffect(() => {
        // A page handed another person starts from nothing: never the last person's stars on this one, nor while theirs load.
        setRatings(NO_RATINGS);
        if (!pubkey) return;
        let live = true;
        try {
            getMemberRatings(pubkey)
                .then(r => { if (live) setRatings({ average: r.average, count: r.count, asProvider: r.asProvider, asReceiver: r.asReceiver }); })
                .catch(() => {});
        } catch { /* an unreadable rating is "No ratings yet" */ }
        return () => { live = false; };
    }, [pubkey]);
    return ratings;
}

interface AuthorCardProps {
    /** "Posted by", "Hosted by": the caller's own t(), so each key is read where it is drawn. */
    label: string;
    pubkey: string;
    callsign: string;
    avatarUrl?: string | null;
    /** The face is still being read (the listing's page reads the profile first): a grey disc stands in. */
    loadingAvatar?: boolean;
    ratings: AuthorRatings;
    onOpen?: () => void;
    details?: ReactNode;
    children?: ReactNode;
    /** The page's own spacing around the box (the listing's is `mb-4`). */
    className?: string;
    testId?: string;
}

export function AuthorCard({ label, pubkey, callsign, avatarUrl, loadingAvatar = false, ratings, onOpen, details, children, className = '', testId }: AuthorCardProps) {
    return (
        <div className={`${PAGE_BOX} ${className}`.trim()}>
            <p className={BOX_LABEL.muted}>
                {label}
            </p>
            <button
                type="button"
                data-testid={testId}
                onClick={() => { if (onOpen) onOpen(); }}
                className="flex items-start gap-4 text-left w-full hover:bg-oat-50/50 dark:hover:bg-black/20 p-2 -ml-2 rounded-xl transition-colors"
            >
                {/* Avatar */}
                {loadingAvatar ? (
                    <div className="w-12 h-12 rounded-full bg-nature-100 dark:bg-nature-800 animate-pulse shrink-0" />
                ) : (
                    <MemberAvatar avatarUrl={avatarUrl} pubkey={pubkey} callsign={callsign} size={48} className="border-2 border-white shadow-sm" />
                )}
                <div className="flex-1 min-w-0">
                    {/* The whole name, wrapping beside the face at 320 px and 130% text: a name cut short ("Damo (Th") says nobody's name. */}
                    <p className="font-bold text-base text-nature-950 dark:text-white mb-0.5 break-words">
                        <span className="text-base text-amber-600 mr-1.5">🤝</span>{callsign}
                    </p>
                    {/* Star rating */}
                    <p className="text-amber-500 text-sm mb-1.5 flex items-center flex-wrap gap-1">
                        {'★'.repeat(Math.round(ratings.average))}{'☆'.repeat(5 - Math.round(ratings.average))}
                        <span className="text-nature-500 text-xs ml-1 font-medium">
                            {ratings.count > 0 ? (
                                <>
                                    {t('{average} ({n})', { average: formatNumber(ratings.average, 1), n: ratings.count })}
                                    {ratings.asProvider && ratings.asProvider.count > 0 && (
                                        <span className="ml-2 text-[0.65rem] bg-amber-50 dark:bg-amber-950/40 px-1.5 py-0.5 rounded text-amber-700 dark:text-amber-300">
                                            📤 {formatNumber(ratings.asProvider.average, 1)}
                                        </span>
                                    )}
                                    {ratings.asReceiver && ratings.asReceiver.count > 0 && (
                                        <span className="ml-1 text-[0.65rem] bg-indigo-50 dark:bg-indigo-950/40 px-1.5 py-0.5 rounded text-indigo-700 dark:text-indigo-300">
                                            📥 {formatNumber(ratings.asReceiver.average, 1)}
                                        </span>
                                    )}
                                </>
                            ) : t('No ratings yet')}
                        </span>
                    </p>
                    {details}
                </div>
            </button>
            {children}
        </div>
    );
}
