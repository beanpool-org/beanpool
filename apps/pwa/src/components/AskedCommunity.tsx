import { useEffect, useRef, useState } from 'react';
import { t, word } from '@beanpool/core';
import { getListedCommunityByHost } from '../lib/api';
import { communityFacts, type HomeCommunity } from '../lib/home-cards';

/**
 * The words of the Find card's asked community. Asking to join is the BeanPool app's today (its Find a community); the
 * web app's own Ask to join is front doors S2, which takes this place when it lands. Never a link to the community's
 * address: that is the card the visitor came from, whose Ask to join brought them here.
 */
export const ASKED_COMMUNITY_WORDS = {
    howToAsk: word('To ask {name} to join, open Find a community in the BeanPool app and choose {name}.'),
    notListed: word("{name} isn't in the list of communities yet. Try again in an hour, or ask one of its members for an invite."),
    close: word('Close'),
} as const;

/**
 * Home's Find card, opened on a community a stranger came to ask to join (`/?ask=<host>`, from that community's card:
 * front doors S15), or above Home's cards where Home draws no Find card: its name and facts from this community's own
 * list of communities, and how to ask it. Scrolled into view when it opens.
 */
export function AskedCommunity({ host, onClose }: { host: string; onClose: () => void }) {
    const [row, setRow] = useState<HomeCommunity | null | 'loading'>('loading');
    const at = useRef<HTMLDivElement>(null);
    useEffect(() => {
        let cancelled = false;
        getListedCommunityByHost(host)
            .then((r) => { if (!cancelled) setRow(r); })
            .catch(() => { if (!cancelled) setRow(null); });
        return () => { cancelled = true; };
    }, [host]);
    useEffect(() => {
        try { at.current?.scrollIntoView({ block: 'center' }); } catch { /* an old browser: it is on the page anyway */ }
    }, []);
    const listed = row !== 'loading' && row !== null ? row : null;
    const name = listed?.name ?? host;
    const facts = listed ? communityFacts(listed) : '';
    return (
        <div ref={at} data-testid="home-find-asked" className="relative mb-2 rounded-xl border-2 border-bp-ink-info p-3 pr-12">
            <p dir="auto" className="m-0 text-base font-bold break-words text-text-primary">{name}</p>
            {facts && <p className="m-0 text-sm break-words text-text-primary">{facts}</p>}
            {row !== 'loading' && (
                <p role="status" className="m-0 mt-1 text-sm break-words text-text-primary">
                    {listed ? t(ASKED_COMMUNITY_WORDS.howToAsk, { name }) : t(ASKED_COMMUNITY_WORDS.notListed, { name })}
                </p>
            )}
            <button type="button" onClick={onClose} aria-label={t(ASKED_COMMUNITY_WORDS.close)} data-testid="home-find-asked-close"
                className="absolute top-1 right-1 w-11 h-11 rounded-full bg-transparent border-0 text-lg text-text-primary cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-info">
                <span aria-hidden="true">✕</span>
            </button>
        </div>
    );
}
