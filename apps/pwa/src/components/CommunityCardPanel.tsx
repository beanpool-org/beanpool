import { COMMUNITY_CARD_WORDS as W, communityCardFacts, communityCardName, t, tn, type CommunityCard } from '@beanpool/core';
import { askDoor, onAndroid } from '../lib/community-card';

/**
 * A local community's public card (front doors S15), above the welcome page's invite form: what a stranger at its
 * address reads, as the node's own page at `/` says it (apps/server routes/community-card.ts), with its doors: Ask to
 * join, Already a member (the ways back) and Look around the global community. The form below is "I have an invite".
 * `compact`: the name and the facts only, for a visitor who came from the card's own "I have an invite".
 */
export function CommunityCardPanel({ card, onSignIn, compact = false }: { card: CommunityCard; onSignIn: () => void; compact?: boolean }) {
    const name = communityCardName(card, { t });
    const facts = communityCardFacts(card, { t, tn });
    const ask = askDoor(card, onAndroid());
    const door = 'block w-full min-h-[48px] px-4 py-3 rounded-xl text-center text-base font-bold no-underline break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-info';
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
                    {ask.href && (
                        <a href={ask.href} data-testid="community-card-ask" className={`${door} bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on`}>
                            {t(W.ask)}
                        </a>
                    )}
                    {ask.note === W.askViaGlobal && <p className="m-0 text-sm break-words text-text-primary">{t(W.askViaGlobal, { name })}</p>}
                    {ask.note === W.askInApp && <p data-testid="community-card-ask-app" className="m-0 text-sm break-words text-text-primary">{t(W.askInApp)}</p>}
                    <button type="button" onClick={onSignIn} data-testid="community-card-signin" className={`${door} bg-transparent border border-bp-ink-info text-bp-ink-info cursor-pointer`}>
                        {t(W.member)}
                    </button>
                    {card.globalUrl && (
                        <a href={card.globalUrl} rel="noopener noreferrer" data-testid="community-card-global" className={`${door} text-bp-ink-brand underline font-semibold`}>
                            {t(W.lookAround)}
                        </a>
                    )}
                </div>
            )}
        </section>
    );
}
