/**
 * One post shared outside its community (front doors S6, scratch/fable-design/DESIGN-entry-points-fable.md §3.4): what a
 * stranger reads in the browser after the node's share page's "See it in your browser", at `/app?post=<id>&peek=<t>`.
 *
 * The post as the node answers a ticket (lib/peek.ts getPeekPost: guestPost, nobody in it, its area only), drawn as the
 * global lobby draws a listing for a visitor (components/VisitorListing.tsx), under "A member of {community} shared this
 * with you"; then the community's own doors (components/CommunityCardPanel.tsx: Ask to join, Already a member, Look around
 * the global community), I have an invite, and on a phone Open in the BeanPool app and Get the app. A link that opens
 * nothing now says so, and shows the same doors. Nothing here signs or keeps anything: a stranger has no key yet.
 */
import { useEffect, useState } from 'react';
import { PEEK_WORDS as W, communityCardName, t, type CommunityCard } from '@beanpool/core';
import type { MarketplacePost } from '../lib/api';
import { getCommunityCard, getNodeApiUrl } from '../lib/api';
import { communityInfoOnce } from '../lib/visitor-lobby-gate';
import { beansOn } from '../lib/visitor-lobby';
import { getPeekPost, peekAppDoors } from '../lib/peek';
import { VisitorPostDetail } from '../components/VisitorListing';
import { CommunityCardPanel } from '../components/CommunityCardPanel';

type Loaded = { kind: 'loading' } | { kind: 'post'; post: MarketplacePost } | { kind: 'stopped' };

const DOOR = 'block w-full min-h-[48px] px-4 py-3 rounded-xl text-center text-base font-bold break-words no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-info';

export function PeekPage({ postId, ticket, onWelcome }: {
    postId: string;
    ticket: string;
    /** The welcome page, at its invite form or its ways back: the visitor has an invite, or is already a member. */
    onWelcome: (door: 'invite' | 'signin') => void;
}) {
    const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
    const [card, setCard] = useState<CommunityCard | null>(null);
    const [beans, setBeans] = useState(true);
    useEffect(() => {
        let cancelled = false;
        getPeekPost(postId, ticket).then(post => { if (!cancelled) setLoaded(post ? { kind: 'post', post } : { kind: 'stopped' }); });
        getCommunityCard().then(c => { if (!cancelled) setCard(c); }).catch(() => {});
        communityInfoOnce().then(info => { if (!cancelled && info) setBeans(beansOn(info)); }).catch(() => {});
        return () => { cancelled = true; };
    }, [postId, ticket]);

    const origin = getNodeApiUrl() || (typeof window !== 'undefined' ? window.location.origin : '');
    const community = card ? communityCardName(card, { t }) : (typeof window !== 'undefined' ? window.location.host : '');
    const phone = peekAppDoors(postId, ticket, origin);

    const doors = (
        <div data-testid="peek-doors" className="grid gap-3 mt-2">
            {phone && (
                <>
                    <a href={phone.app} data-testid="peek-open-app" className={`${DOOR} bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on`}>{t(W.openInApp)}</a>
                    <a href={phone.store} rel="noopener noreferrer" data-testid="peek-get-app" className={`${DOOR} border border-bp-ink-info text-bp-ink-info`}>{t(W.getApp)}</a>
                </>
            )}
            {card && <CommunityCardPanel card={card} onSignIn={() => onWelcome('signin')} />}
            <button type="button" data-testid="peek-invite" onClick={() => onWelcome('invite')}
                className={`${DOOR} bg-transparent border border-bp-ink-info text-bp-ink-info cursor-pointer`}>
                {t('I have an invite')}
            </button>
        </div>
    );

    if (loaded.kind === 'loading') {
        return <p role="status" className="p-6 text-center text-text-primary">{t('Loading...')}</p>;
    }

    if (loaded.kind === 'stopped') {
        return (
            <main data-testid="peek-stopped" className="p-4 max-w-lg mx-auto">
                <p role="status" className="m-0 mb-4 p-4 rounded-xl bg-bp-chip-ok-tint text-bp-chip-ok-ink font-semibold break-words">{t(W.stopped)}</p>
                {doors}
            </main>
        );
    }

    return (
        <main data-testid="peek-page" className="max-w-lg mx-auto">
            <VisitorPostDetail
                post={loaded.post}
                beans={beans}
                distanceKm={null}
                onJoin={() => onWelcome('invite')}
                header={(
                    <p data-testid="peek-shared" className="m-0 mb-3 text-sm font-semibold text-bp-ink-accent break-words">
                        {t(W.sharedWithYou, { community })}
                    </p>
                )}
                footer={(
                    <>
                        <p data-testid="peek-names-note" className="m-0 mb-4 text-sm text-text-primary break-words">{t(W.namesWhenJoin, { community })}</p>
                        {doors}
                    </>
                )}
            />
        </main>
    );
}
