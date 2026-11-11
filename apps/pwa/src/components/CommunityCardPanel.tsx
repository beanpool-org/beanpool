import { useState } from 'react';
import { COMMUNITY_CARD_WORDS as W, communityCardFacts, communityCardName, t, tn, type CommunityCard } from '@beanpool/core';
import type { BeanPoolIdentity } from '../lib/identity';
import { askDoor, lookAroundUrl, onAndroid } from '../lib/community-card';
import { AskHere } from './AskHere';

/** How the panel offers Ask to join, where its page shows it (DESIGN-shared-listing-door-fable.md §2.3). */
export interface PanelAsk {
    /** The request went: this browser holds the key it asked with, and waits (App shows the waiting page). */
    onAsked: (identity: BeanPoolIdentity) => void;
    /** The form open from the start: `/app?door=ask`, where the card's own Ask to join (or its Android fallback) lands. */
    open?: boolean;
    /** The shared post's page, where the button stands away from the name: "Ask to join {name}". */
    named?: boolean;
    /** A phone's browser under the page's own Open in the BeanPool app: "or ask here in your browser", no app link. */
    appAbove?: boolean;
    /** The shared post's link ticket, sent with the request (shared-listing door A3): who answers reads where it came from. */
    peek?: string;
}

/**
 * A local community's public card (front doors S15), above the welcome page's invite form and on the shared post's page:
 * what a stranger at its address reads, as the node's own page at `/` says it (apps/server routes/community-card.ts), with
 * its doors in the order §2.3 sets: Ask to join (the form, right here: the browser asks this community directly, never
 * through another one), I have an invite (where the page asks for it: `onInvite`), Already a member, and Look around
 * the global community (with `?ask=<host>`). On an Android phone at the bare card, Ask to join opens the app's card
 * screen, and "or ask here in your browser" opens the form.
 * `compact`: the name and the facts only, for a visitor who came from the card's own "I have an invite".
 */
export function CommunityCardPanel({ card, onSignIn, onInvite, inviteTestId = 'community-card-invite', ask, lookFirst = false, compact = false }: {
    card: CommunityCard;
    onSignIn: () => void;
    onInvite?: () => void;
    inviteTestId?: string;
    ask?: PanelAsk;
    lookFirst?: boolean;
    compact?: boolean;
}) {
    const name = communityCardName(card, { t });
    const facts = communityCardFacts(card, { t, tn });
    const door = askDoor(card, onAndroid());
    const [formOpen, setFormOpen] = useState(!!ask?.open);
    const global = lookAroundUrl(card);
    const base = 'block w-full min-h-[48px] px-4 py-3 rounded-xl text-center text-base font-bold break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-info';
    const primary = `${base} no-underline border-none bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on cursor-pointer`;
    const secondary = `${base} bg-transparent border border-bp-ink-info text-bp-ink-info cursor-pointer`;
    // The app's card screen, where the page has no app door of its own and the browser is an Android phone's.
    const appLink = door?.href && !ask?.appAbove ? door.href : null;
    const browserAskLabel = ask?.appAbove || appLink ? t(W.askInBrowser) : ask?.named ? t(W.askName, { name }) : t(W.ask);
    return (
        <section data-testid="community-card" aria-label={name} className="text-left mb-6 pb-6 border-b border-nature-200 dark:border-nature-800">
            <p className="m-0 mb-1 text-sm font-semibold text-bp-ink-accent">{t(W.kicker)}</p>
            <h2 dir="auto" className="m-0 mb-3 text-2xl font-bold leading-tight break-words text-text-primary">{name}</h2>
            <ul className="list-none m-0 p-0 mb-4 grid gap-1 text-base text-text-primary">
                {facts.members && <li data-testid="community-card-members" className="break-words">{facts.members}</li>}
                {facts.area && <li data-testid="community-card-area" dir="auto" className="break-words">{facts.area}</li>}
                <li><span data-testid="community-card-joining" className="inline-block px-3 py-0.5 rounded-full text-sm font-bold bg-bp-chip-ok-tint text-bp-chip-ok-ink">{facts.joining}</span></li>
            </ul>
            {!compact && (
                <div className="grid gap-3">
                    {door && ask && (formOpen ? (
                        <AskHere name={name} peek={ask.peek} onAsked={ask.onAsked} onClose={() => setFormOpen(false)} testId="community-card-ask-form" />
                    ) : (
                        <>
                            {appLink && (
                                <a href={appLink} data-testid="community-card-ask-app" className={primary}>{t(W.ask)}</a>
                            )}
                            <button type="button" data-testid="community-card-ask" onClick={() => setFormOpen(true)}
                                className={ask.appAbove || appLink ? secondary : primary}>
                                {browserAskLabel}
                            </button>
                            <p data-testid="community-card-ask-note" className="m-0 text-sm break-words text-text-primary">{t(W.askNote, { name })}</p>
                        </>
                    ))}
                    {onInvite && (
                        <button type="button" data-testid={inviteTestId} onClick={onInvite} className={secondary}>{t(W.haveInvite)}</button>
                    )}
                    <button type="button" onClick={onSignIn} data-testid="community-card-signin" className={secondary}>
                        {t(W.member)}
                    </button>
                    {global && (
                        <a href={global} rel="noopener noreferrer" data-testid="community-card-global" className={`${base} text-bp-ink-brand underline font-semibold`}>
                            {lookFirst ? t(W.lookAroundFirst) : t(W.lookAround)}
                        </a>
                    )}
                </div>
            )}
        </section>
    );
}
