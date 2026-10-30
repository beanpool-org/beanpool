import { useEffect, useRef, useState } from 'react';
import { t, word } from '@beanpool/core';
import { getListedCommunityByHost } from '../lib/api';
import { communityFacts, type HomeCommunity } from '../lib/home-cards';
import type { BeanPoolIdentity } from '../lib/identity';
import { AskToJoin } from './AskToJoin';

/**
 * The words of the Find card's asked community. Asking to join is the web app's own (front doors S2: components/AskToJoin,
 * the phone's form). Never a link to the community's address: that is the card the visitor came from, whose Ask to join
 * brought them here.
 */
export const ASKED_COMMUNITY_WORDS = {
    notListed: word("{name} isn't in the list of communities yet. Try again in an hour, or ask one of its members for an invite."),
    close: word('Close'),
} as const;

/**
 * Home's Find card, opened on a community a stranger came to ask to join (`/?ask=<host>`, from that community's card:
 * front doors S15), or above Home's cards where Home draws no Find card: its name and facts from this community's own
 * list of communities, and Ask to join it right here. Scrolled into view when it opens. `asked` says whether this browser
 * already holds an open request to an address (Home's remembered knocks), so a request is never sent twice from here.
 */
export function AskedCommunity({ host, identity, asked, onAsked, onClose }: {
    host: string;
    identity: BeanPoolIdentity;
    asked: (url: string | null) => boolean;
    onAsked?: () => void;
    onClose: () => void;
}) {
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
        // The ✕'s room is kept beside the name and facts only, so Ask to join's form below has the box's whole width.
        <div ref={at} data-testid="home-find-asked" className="relative mb-2 rounded-xl border-2 border-bp-ink-info p-3">
            <p dir="auto" className="m-0 pr-10 text-base font-bold break-words text-text-primary">{name}</p>
            {facts && <p className="m-0 pr-10 text-sm break-words text-text-primary">{facts}</p>}
            {row !== 'loading' && !listed && (
                <p role="status" className="m-0 mt-1 pr-10 text-sm break-words text-text-primary">{t(ASKED_COMMUNITY_WORDS.notListed, { name })}</p>
            )}
            {listed && (
                <AskToJoin community={listed} identity={identity} asked={asked(listed.url)} onAsked={onAsked} testId="home-find-asked-ask" />
            )}
            <button type="button" onClick={onClose} aria-label={t(ASKED_COMMUNITY_WORDS.close)} data-testid="home-find-asked-close"
                className="absolute top-1 right-1 w-11 h-11 rounded-full bg-transparent border-0 text-lg text-text-primary cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-info">
                <span aria-hidden="true">✕</span>
            </button>
        </div>
    );
}
