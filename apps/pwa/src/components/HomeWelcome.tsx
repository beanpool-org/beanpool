/**
 * Home's welcome on the web (scratch/fable-design/DESIGN-onboarding-home-landing-fable.md §4.1-§4.4 and §5, slice W2; Marty's
 * picks of 21 Nov 2026), the phone's WELCOME TO BEANPOOL! tile (components/home/WelcomeTile.tsx, S5) and the community's own
 * welcome beside it, from the same core rules and words (home-welcome.ts, home-frame.ts `welcomeShape`):
 *
 * - **BeanPool's tile**: three things to know, "Show me around" (the one-minute tour) and "Got it" (the tour record
 *   `skipped`, the one 1.4.7's Not now writes). From day 8 it folds to one band, "Welcome to BeanPool ›", with its ×; the
 *   band opens the tile again for the visit, writing nothing.
 * - **The community's welcome**: the phone's card (components/home/CommunityWelcomeCard.tsx, slice S7) from the same core
 *   rule and words (`communityWelcomeCard`, `COMMUNITY_WELCOME_CARD_WORDS`): its caption on a clay band with its own ×, the
 *   owners' words as they wrote them (never translated), who brought the member ("Ana invited you. Say hello ›") or an
 *   owner alone's "You're the first one here", to an owner where none is written "Write your community's welcome ›", and
 *   the count. Once it has gone, the community card's "Riverside's welcome ›" ({@link CommunityWelcomeAgain}) shows the
 *   owners' words again.
 *
 * One full row of Home's grid: side by side on a wide Home (BeanPool's part on the left), stacked in one column, as on the
 * phone. Not a card: no "…", no hold, no arrows; in Arrange it goes quiet, as a card's body does. The look is shapes, never
 * pictures, from the central tokens (packages/beanpool-core/src/brand-colours.ts): the emerald `commit` ground, the `gold`
 * sun and button, the terracotta `cta` bean, and the pale ring in `chip.ok.tint` as the light set has it, on the tile in
 * every set (§4.4), so it is the same tile in light, Classic and Dark. Words sit only on the emerald (white, 5.48:1) and on
 * the gold button (charcoal); never on the sun or the pale shapes, which stay in the corners.
 */
import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import {
    COMMUNITY_CARD_WORDS, COMMUNITY_WELCOME_CARD_WORDS, WELCOME_TILE_WORDS, brandColours, formatCount, t, tn,
    type CommunityWelcomeCard, type WelcomeTileIcon, type WelcomeTileLine,
} from '@beanpool/core';
import { WELCOME_WORDS } from '../lib/home-cards';
import { CardBody, PackedBlock } from './HomeCard';

/** The pale ring and the facts' round badges: core's `chip.ok.tint` as the light set has it, in every set (§4.4). */
const PALE = brandColours('light').chip.ok.tint;

/** Each fact's mark, a text glyph in the badge (the phone draws the same idea with its bundled icons). Read by no one. */
const GLYPHS: Record<WelcomeTileIcon, string> = { swap: '⇄', scale: '⚖︎', zero: '◎', meet: '☺︎', none: '•' };

const FOCUS = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bp-commit-fill focus-visible:ring-bp-commit-on';
const TILE_BUTTON = `grow basis-[130px] min-h-[48px] px-3.5 py-2.5 rounded-xl text-base font-extrabold text-center break-words cursor-pointer ${FOCUS}`;
/** The community's welcome, in the words and links today's Welcome card used (light and dark). */
const SAID = 'm-0 text-[0.9375rem] text-nature-900 dark:text-nature-100 break-words';
const LINK = 'min-h-[44px] px-1 -mx-1 bg-transparent border-0 rounded-lg text-sm font-bold text-emerald-800 dark:text-emerald-300 cursor-pointer text-left break-words no-underline inline-flex items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';

export interface WelcomeTileProps {
    shape: 'full' | 'band';
    /** "You're in Riverside." (core welcomeFacts); none when the community's name isn't known. */
    place: string | null;
    lines: readonly WelcomeTileLine[];
    /** "Show me around", or "Pick up the tour at step 3 ›" for a tour part way. */
    tourLabel: string;
    onTour: () => void;
    /** Got it, and the band's ×. */
    onGotIt: () => void;
}

export interface CommunityWelcomeProps {
    /** What it holds, when it is drawn: core `communityWelcomeCard`, the phone's one rule (slice S7). */
    card: CommunityWelcomeCard;
    onSayHello: (key: string) => void;
    /** Absent: the reader can't invite here (core readerMayInvite), so "You're the first one here." stands alone. */
    onInvite?: () => void;
    /** Where "Write your community's welcome ›" goes (the card's `ownerPrompt`): the community's Settings, where it is written (slice S6). */
    writeHref: string;
    onAway: () => void;
}

export function WelcomeTile({ shape, place, lines, tourLabel, onTour, onGotIt }: WelcomeTileProps) {
    // The band opens the tile in place, for this visit only: nothing is written by it.
    const [open, setOpen] = useState(false);
    const titleId = useId();
    if (shape === 'band' && !open) {
        return (
            <div data-testid="home-welcome-tile" data-shape="band" className="flex items-center min-w-0 rounded-2xl overflow-hidden bg-bp-commit-fill text-bp-commit-on">
                {/* Its name is its words less the "›" (WCAG 2.5.3 Label in Name). */}
                <button type="button" data-testid="home-welcome-band-open" aria-label={t(WELCOME_TILE_WORDS.name)} onClick={() => setOpen(true)}
                    className={`flex-1 min-w-0 min-h-[48px] pl-4 pr-2 py-2 text-left text-base font-extrabold break-words bg-transparent border-0 text-bp-commit-on hover:bg-bp-commit-hover cursor-pointer ${FOCUS}`}>
                    {t(WELCOME_TILE_WORDS.band)}
                </button>
                <button type="button" data-testid="home-welcome-band-x" aria-label={t(WELCOME_TILE_WORDS.away)} onClick={onGotIt}
                    className={`shrink-0 min-w-[48px] min-h-[48px] flex items-center justify-center bg-transparent border-0 text-2xl font-bold text-bp-commit-on hover:bg-bp-commit-hover cursor-pointer ${FOCUS}`}>
                    <span aria-hidden="true">×</span>
                </button>
            </div>
        );
    }
    const at = (style: CSSProperties) => ({ position: 'absolute', ...style }) as CSSProperties;
    return (
        <section data-testid="home-welcome-tile" data-shape="full" aria-labelledby={titleId}
            className="relative min-w-0 overflow-hidden rounded-[22px] bg-bp-commit-fill text-bp-commit-on px-4 pb-4 pt-[86px]">
            {/* The shapes, behind everything and out of the reader's way. */}
            <div aria-hidden="true" data-testid="home-welcome-shapes" className="pointer-events-none absolute inset-0">
                <span className="rounded-full bg-bp-commit-hover" style={at({ width: 720, height: 720, left: -216, bottom: -640 })} />
                <span className="rounded-full bg-bp-gold-fill" style={at({ width: 128, height: 128, top: -50, right: -36 })} />
                <span className="bg-bp-cta-fill" style={at({ width: 78, height: 50, top: 22, right: 86, borderRadius: '40px 26px 34px 24px', transform: 'rotate(-24deg)' })} />
                <span className="rounded-full" style={at({ width: 54, height: 54, top: 18, left: -20, border: `10px solid ${PALE}` })} />
                <span className="rounded-full" style={at({ width: 14, height: 14, top: 20, left: 58, backgroundColor: PALE })} />
                <span className="rounded-full bg-bp-gold-fill" style={at({ width: 10, height: 10, top: 52, left: 88 })} />
            </div>
            <h2 id={titleId} tabIndex={-1} data-testid="home-welcome-title" className="relative m-0 text-[1.75rem] leading-[1.1] font-black uppercase break-words text-bp-commit-on">
                {t(WELCOME_TILE_WORDS.title)}
            </h2>
            {place && <p data-testid="home-welcome-where" className="relative m-0 mt-2 text-base font-bold break-words text-bp-commit-on">{place}</p>}
            <ul className="relative list-none m-0 mt-3.5 mb-4 p-0 flex flex-col gap-3">
                {lines.map((l, i) => (
                    <li key={i} data-testid={`home-welcome-fact-${l.icon}`} className="flex items-start gap-3 min-w-0">
                        <span aria-hidden="true" className="shrink-0 w-[34px] h-[34px] rounded-full flex items-center justify-center text-lg font-black text-bp-commit-hover" style={{ backgroundColor: PALE }}>
                            {GLYPHS[l.icon]}
                        </span>
                        <span className="min-w-0 flex-1 pt-[5px] text-base font-semibold break-words text-bp-commit-on">{l.text}</span>
                    </li>
                ))}
            </ul>
            {/* Side by side where they fit, stacked at 320 px and 130% text. */}
            <div className="relative flex flex-wrap gap-2.5">
                <button type="button" data-testid="home-start-look" onClick={onTour}
                    className={`${TILE_BUTTON} border-0 bg-bp-gold-fill hover:bg-bp-gold-hover text-bp-gold-on`}>
                    {tourLabel}
                </button>
                <button type="button" data-testid="home-start-skip" onClick={onGotIt}
                    className={`${TILE_BUTTON} border-2 border-solid border-bp-commit-on bg-transparent hover:bg-bp-commit-hover text-bp-commit-on`}>
                    {t(WELCOME_TILE_WORDS.gotIt)}
                </button>
            </div>
        </section>
    );
}

export function CommunityWelcome({ card, onSayHello, onInvite, writeHref, onAway }: CommunityWelcomeProps) {
    const titleId = useId();
    const ink = 'var(--bp-card-clay-ink)';
    // In the phone's order (CommunityWelcomeCard.tsx): the owners' words, whose invite, the owner's prompt, the count.
    return (
        <section data-testid="home-welcome-community" aria-labelledby={titleId}
            className="min-w-0 bg-bg-card rounded-2xl shadow-sm border border-border-primary p-4">
            <div className="-mx-4 -mt-4 px-4 mb-3 py-1 rounded-t-2xl flex items-center justify-between min-h-[48px] gap-2 min-w-0"
                style={{ backgroundColor: 'var(--bp-card-clay-tint)', color: ink }}>
                <h2 id={titleId} tabIndex={-1} className="m-0 min-w-0 break-words text-[0.7rem] font-extrabold uppercase tracking-wider" style={{ color: ink }}>
                    {card.caption}
                </h2>
                <button type="button" data-testid="home-welcome-community-x" aria-label={t(COMMUNITY_WELCOME_CARD_WORDS.away)} onClick={onAway}
                    className="shrink-0 min-w-[44px] min-h-[44px] -my-1 -mr-2 flex items-center justify-center rounded-full bg-transparent border-0 text-xl font-bold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                    style={{ color: ink }}>
                    <span aria-hidden="true">×</span>
                </button>
            </div>
            {/* The owners' own words, as written: their line breaks kept, their language's direction, no link made tappable. */}
            {card.words !== null && <p data-testid="home-welcome-community-words" dir="auto" className={`${SAID} mb-2 whitespace-pre-line`}>{card.words}</p>}
            {card.inviter ? (
                <Line testId="home-welcome-invited" text={t(WELCOME_WORDS.invitedYou, { name: card.inviter.name })}>
                    <button type="button" data-testid="home-welcome-hello" onClick={() => onSayHello(card.inviter!.key)} className={LINK}>
                        {t(WELCOME_WORDS.sayHello)}
                    </button>
                </Line>
            ) : card.firstHere ? (
                <Line testId="home-welcome-first" text={t(WELCOME_WORDS.firstHere)}>
                    {onInvite && <button type="button" data-testid="home-welcome-invite" onClick={onInvite} className={LINK}>{t(WELCOME_WORDS.inviteSomeone)}</button>}
                </Line>
            ) : null}
            {card.ownerPrompt && (
                <a data-testid="home-welcome-community-write" href={writeHref} className={LINK}>{t(COMMUNITY_WELCOME_CARD_WORDS.write)}</a>
            )}
            {card.members !== null && (
                <p data-testid="home-welcome-community-members" className="m-0 mt-1 text-sm text-nature-700 dark:text-nature-200 break-words">
                    {tn(card.members, COMMUNITY_CARD_WORDS.members.one, COMMUNITY_CARD_WORDS.members.other, { n: formatCount(card.members) })}
                </p>
            )}
        </section>
    );
}

/**
 * The community card's line (DESIGN-onboarding-home-landing-fable.md §4.2 "Day 30"; the phone's CommunityWelcomeAgain, slice
 * S7): "Riverside's welcome ›" (core `communityWelcomeAgainLine`) opens the owners' words in place, under it; again folds them.
 * For whenever the welcome itself is not drawn (put away, or past the newcomer's days). Nothing is written.
 */
export function CommunityWelcomeAgain({ line, words }: { line: string; words: string }) {
    const [open, setOpen] = useState(false);
    const wordsId = useId();
    return (
        <>
            <button type="button" data-testid="home-community-welcome-again" aria-expanded={open} aria-controls={wordsId} onClick={() => setOpen(o => !o)}
                className="w-full min-h-[44px] text-left p-0 mb-2 bg-transparent border-none cursor-pointer text-sm text-text-primary hover:text-text-secondary transition-colors break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded-lg">
                {line}
            </button>
            {open && <p id={wordsId} data-testid="home-community-welcome-words" dir="auto" className={`${SAID} mb-2 whitespace-pre-line`}>{words}</p>}
        </>
    );
}

function Line({ testId, text, children }: { testId: string; text: string; children?: ReactNode }) {
    return (
        <p data-testid={testId} className={`${SAID} flex flex-wrap items-center gap-x-2`}>
            <span className="min-w-0 break-words">{text}</span>
            {children}
        </p>
    );
}

/**
 * The welcome's row in Home's grid: BeanPool's tile and the community's welcome, side by side on a wide Home (`side`) and
 * stacked in one column; either alone takes the whole row. `id` names it for the packing (`home-card-<id>`).
 */
export function HomeWelcomeRow({ id, tile, community, side, quiet, style, onHeight }: {
    id: string;
    tile: WelcomeTileProps | null;
    community: CommunityWelcomeProps | null;
    side: boolean;
    /** Arrange is open: quiet, as a card's body is. */
    quiet?: boolean;
    style?: CSSProperties;
    onHeight?: (height: number) => void;
}) {
    const both = !!tile && !!community;
    return (
        <PackedBlock data-testid={`home-card-${id}`} onHeight={onHeight} style={style} className="mb-3 min-w-0">
            <CardBody id={id} quiet={quiet}>
                <div data-testid="home-welcome-row" data-side={both && side ? 'true' : 'false'}
                    className={both && side ? 'grid grid-cols-2 gap-3 items-start' : 'flex flex-col gap-3'}>
                    {tile && <WelcomeTile {...tile} />}
                    {community && <CommunityWelcome {...community} />}
                </div>
            </CardBody>
        </PackedBlock>
    );
}
