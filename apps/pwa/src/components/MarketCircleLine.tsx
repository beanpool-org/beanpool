import { useEffect, useState } from 'react';
import { PLACE_CIRCLE_WORDS, circleWaitingLine, t, type CircleDemand } from '@beanpool/core';
import { getFindCard } from '../lib/api';

/**
 * The empty Market's way to the people waiting near (Lounge L2, §3.2), the phone's MarketCircleLine: "{n} people near you
 * are waiting for a community too · Meet them ›". Nothing at all below 3. Home's Find card holds their circle, or the
 * button to say they'd help.
 */
export function MarketCircleLine({ onMeet }: { onMeet?: () => void }) {
    const [demand, setDemand] = useState<CircleDemand | null>(null);
    useEffect(() => {
        let alive = true;
        getFindCard().then(card => { if (alive) setDemand(card.demand ?? null); }).catch(() => { /* a line, not a screen */ });
        return () => { alive = false; };
    }, []);
    const line = circleWaitingLine(demand);
    if (!line) return null;
    return (
        <p data-testid="market-circle-line" className="m-0 mb-3 text-sm text-nature-700 dark:text-nature-300 break-words">
            <span>{line} </span>
            {onMeet && (
                <button type="button" onClick={onMeet} data-testid="market-meet-them"
                    className="inline-flex items-center min-h-[44px] text-sm font-bold text-nature-800 dark:text-nature-100 underline cursor-pointer">
                    {t(PLACE_CIRCLE_WORDS.meetThem)}
                </button>
            )}
        </p>
    );
}
