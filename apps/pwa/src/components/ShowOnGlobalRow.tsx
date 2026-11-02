/**
 * "Also show this on the global community" on an in-person event, an Offer or a Need, as on the phone (apps/native components/
 * ShowOnGlobalRow.tsx, slices G2′, G1′ and G3): off by default, and never a join by itself. The composer's tick, and the same
 * offer on the host's page, which says when it is shown and offers to stop. The global community itself shows none of this,
 * nor a community that names no global.
 *
 * Nothing is asked of the global community until the member taps: the row is drawn from what this browser kept of its last
 * answer. Told this key is a stranger there, it offers the door, in a new tab so a form in progress isn't lost. Their 12 words
 * are the way in there: "I'm new" would make a second account, and the tick would still say Join.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { listingFreeTags, postTagsOf, t, type HomeEvent } from '@beanpool/core';
import { useCommunityInfo } from '../lib/features';
import { globalCommunityLink } from '../lib/global-entry';
import type { BeanPoolIdentity } from '../lib/identity';
import type { MarketplacePost } from '../lib/api';
import { askGlobalStanding, copyPairOf, hostHere, readGlobalStanding, showPostOnGlobal, stopLaterLine, stopShowing, type GlobalStanding } from '../lib/show-on-global';

export const showOnGlobalLabel = () => t('Also show this on the global community');
export const showOnGlobalHint = () => t("Anyone there can see it, with its times, its rough area and this community's name. Not your name, the place or your note. To go, they ask to join.");
/** `need`: a Need is answered, not bought (its line on a copy, @beanpool/core copyPriceLine). */
export const showListingOnGlobalHint = (need = false) => need
    ? t("Anyone there can see it, with its photos, its rough area, its price and this community's name. Not your name or the exact place. To answer it, they ask to join.")
    : t("Anyone there can see it, with its photos, its rough area, its price and this community's name. Not your name or the exact place. To buy or take it, they ask to join.");
const joinFirstWords = () => t('Join the global community to show this there');
const sameAccountWords = () => t('Use your 12 words there, so it stays one account.');

const say = (line: string | null) => { if (line) alert(`${showOnGlobalLabel()}\n\n${line}`); };
const unreachable = () => say(t("The global community can't be reached right now."));

/** A post as the node gave it, as core reads one. */
const homeOf = (post: MarketplacePost): HomeEvent => ({ ...post, tags: postTagsOf(post.tags), freeTags: listingFreeTags(post) }) as unknown as HomeEvent;

/** The member's own copy, sent from here: it holds up nothing, and what it owes them comes as its own line. */
export async function showEventOnGlobal(post: MarketplacePost, identity: BeanPoolIdentity): Promise<void> {
    say(await showPostOnGlobal(homeOf(post), identity));
}

interface Offer {
    offer: 'tick' | 'join' | null;
    global: string | null;
    ask: () => Promise<GlobalStanding>;
}

/** What the row offers, from this browser's memory. `enabled`: what the form or the page knows; the community names the rest. */
function useOffer(enabled: boolean, identity: BeanPoolIdentity | null | undefined): Offer {
    const info = useCommunityInfo(enabled);
    const link = globalCommunityLink(info, hostHere());
    const publicKey = identity?.publicKey;
    const [kept, setKept] = useState<GlobalStanding>('unknown');
    useEffect(() => {
        if (enabled && publicKey) setKept(readGlobalStanding(publicKey));
    }, [enabled, publicKey]);
    const ask = async (): Promise<GlobalStanding> => {
        if (!identity?.privateKey) return 'unknown';
        const standing = await askGlobalStanding(identity);
        setKept(standing);
        return standing;
    };
    return { offer: !enabled || !identity?.privateKey || !link ? null : kept === 'stranger' ? 'join' : 'tick', global: link?.href ?? null, ask };
}

function JoinDoor({ href }: { href: string | null }) {
    return (
        <div data-testid="show-on-global-join" className="min-w-0">
            {href
                ? <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center min-h-[44px] text-sm font-bold text-nature-800 dark:text-oat-50 underline break-words">{joinFirstWords()}</a>
                : <p className="m-0 text-sm font-bold text-nature-800 dark:text-oat-50 break-words">{joinFirstWords()}</p>}
            <p className="m-0 mt-1 text-xs text-nature-600 dark:text-nature-300 leading-snug break-words">{sameAccountWords()}</p>
        </div>
    );
}

/**
 * The composer's tick. Off until the member ticks it, and off again if the form moves away from what it is for (Online, a group,
 * another host): a tick nobody can see must not go with the post. `online`: an event that would have the offer but for being
 * online, told why not. `listing`: an Offer or a Need, whose words say what goes of one; `need`, which of them.
 */
export function ShowOnGlobalTick({ enabled, online = false, checked, onChange, identity, listing = false, need = false }: {
    enabled: boolean; online?: boolean; checked: boolean; onChange: (next: boolean) => void; identity: BeanPoolIdentity | null | undefined; listing?: boolean; need?: boolean;
}) {
    const hint = listing ? showListingOnGlobalHint(need) : showOnGlobalHint();
    const { offer, global, ask } = useOffer(enabled || online, identity);
    const [busy, setBusy] = useState(false);
    // The form outlives this row: an answer landing once it has gone would tick the next post, against "off, every time".
    const here = useRef(true);
    useEffect(() => {
        here.current = true;
        return () => { here.current = false; };
    }, []);
    useEffect(() => {
        if (!enabled && checked) onChange(false);
    }, [enabled, checked, onChange]);
    if (online) {
        if (!offer) return null;
        return <p data-testid="show-on-global-online" className="m-0 mb-3 text-xs text-nature-600 dark:text-nature-300 leading-snug break-words">{t("Online events can't be shown on the global community yet.")}</p>;
    }
    if (offer === 'join') return <div className="mb-3"><JoinDoor href={global} /></div>;
    if (offer !== 'tick') return null;
    const tap = async () => {
        if (checked) return onChange(false);
        setBusy(true);
        try {
            const standing = await ask();
            if (!here.current) return;
            if (standing === 'member') onChange(true);
            else if (standing === 'unknown') unreachable();
        } finally {
            if (here.current) setBusy(false);
        }
    };
    return (
        <label data-testid="show-on-global-tick" className={`flex items-start gap-2.5 mb-3 min-h-[44px] py-1 cursor-pointer ${busy ? 'opacity-60' : ''}`}>
            <input type="checkbox" checked={checked} disabled={busy} onChange={() => void tap()} className="mt-0.5 w-5 h-5 shrink-0 accent-terra-600" />
            <span className="min-w-0">
                <span className="block text-sm font-bold text-nature-800 dark:text-oat-50 leading-snug break-words">{showOnGlobalLabel()}</span>
                <span className="block mt-1 text-xs text-nature-600 dark:text-nature-300 leading-snug break-words">{hint}</span>
            </span>
        </label>
    );
}

/** The host's page: shown, with Stop showing; or the same offer as the composer, for a post made without it. */
export function ShowOnGlobalHostRow({ post, identity, enabled, listing = false }: {
    post: MarketplacePost; identity: BeanPoolIdentity | null | undefined; enabled: boolean; listing?: boolean;
}) {
    const { offer, global, ask } = useOffer(enabled, identity);
    const [shown, setShown] = useState(false);
    const [resting, setResting] = useState(false);
    const [busy, setBusy] = useState(false);
    const publicKey = identity?.publicKey;
    const read = useCallback(() => {
        if (!enabled || !publicKey) return;
        void copyPairOf(post.id, publicKey).then((p) => {
            setShown(!!p);
            setResting(!!p?.resting);
        }).catch(() => {});
    }, [enabled, post.id, publicKey]);
    useEffect(read, [read]);
    // A listing off the board here is offered nothing: only what it has running stays to stop. This is what the row knows, and
    // core asks the community itself, for what it can't (a hide by reports).
    const offBoard = listing && post.status !== 'active';
    if (!enabled || !identity?.privateKey || !global || (!shown && (!offer || offBoard))) return null;
    if (!shown && offer === 'join') return <div className="mt-3"><JoinDoor href={global} /></div>;
    const show = async () => {
        const standing = await ask();
        if (standing === 'unknown') return unreachable();
        if (standing === 'member') await showEventOnGlobal(post, identity);
    };
    // A stop that didn't reach global reads as done once the row flips back, so the member is told it is still up.
    const stop = async () => {
        if (!(await stopShowing(post.id, identity))) say(stopLaterLine());
    };
    const act = async () => {
        setBusy(true);
        try {
            await (shown ? stop() : show());
        } finally {
            read();
            setBusy(false);
        }
    };
    return (
        <div data-testid="show-on-global-host" className="mt-3 min-w-0">
            {shown
                ? <p className="m-0 text-sm font-bold text-nature-800 dark:text-oat-50 leading-snug break-words">{!resting ? t('Shown on the global community')
                    : listing ? t("It comes down while this is off the board here, and goes back up when it's on again.")
                    : t("It comes down while you're on holiday, and goes back up when you're back.")}</p>
                : <p className="m-0 text-xs text-nature-600 dark:text-nature-300 leading-snug break-words">{listing ? showListingOnGlobalHint(post.type === 'need') : showOnGlobalHint()}</p>}
            <button type="button" onClick={() => void act()} disabled={busy} data-testid="show-on-global-act"
                className={`min-h-[44px] text-left text-sm font-bold text-nature-800 dark:text-oat-50 underline break-words cursor-pointer ${busy ? 'opacity-60' : ''}`}>
                {shown ? t('Stop showing') : showOnGlobalLabel()}
            </button>
        </div>
    );
}
