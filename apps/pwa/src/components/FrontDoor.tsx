import { useState, type ReactNode } from 'react';
import { brandColours, t } from '@beanpool/core';

/** The block's shapes and ground: one value in every colour set (design §4.4), so light and dark draw the same block. */
const BLOCK = brandColours('light');
/** The mark, never translated in any language (scripts/words/GLOSSARY.csv: BeanPool, untranslatable). */
const MARK = 'BeanPool';

/** One row of More ways in: a button, or a link to another page. */
export type MoreWay = { label: string; testId: string } & ({ onClick: () => void } | { href: string });

/**
 * The web's front door (DESIGN-onboarding-home-landing-fable.md §5, slice W1; Marty, 21 Nov 2026: "Yes, all of Fable's
 * picks"): the phone's first screen (apps/native/components/welcome/FrontDoor.tsx) in the same words and order, in place of
 * "Used BeanPool before?" and the long invite page. Which of three people are you.
 *
 * - The colour block: `commit.fill` ground, `commit.on` words, the shapes in its corners carrying no words.
 * - **I have an invite**, the main button (`cta.fill`): Your invite. On the web an invite is nearly always in the address
 *   the person opened, which skips this screen; with none, a plain box (no paste button: a page reading the clipboard
 *   raises the browser's prompt, and the browser's own paste works in a box).
 * - **No invite? Look around**: the global community, or the lobby's listings where the page opened over them; not drawn
 *   where the community names no global community.
 * - **I've used BeanPool before**: the ways back.
 * - **More ways in ›**: what this address offers besides (its Ask to join, its Claim), only where it offers any.
 *
 * Nothing waits on anything: every button works whatever the community has said, offline included.
 */
export function FrontDoor({ onInvite, lookAround, onUsedBefore, more, children }: {
    onInvite: () => void;
    lookAround: { href: string } | { onClick: () => void } | null;
    onUsedBefore: () => void;
    more: MoreWay[];
    /** What this community says under the buttons (a private preview's sentence). */
    children?: ReactNode;
}) {
    const [open, setOpen] = useState(false);
    const quiet = 'block w-full min-h-[52px] px-4 py-3 mb-3 rounded-2xl border border-border-primary bg-transparent text-text-primary text-[17px] font-bold text-center no-underline break-words cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand';
    const link = 'min-h-[48px] px-3 bg-transparent border-none text-bp-ink-brand text-base font-bold break-words cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand';
    const row = 'block w-full min-h-[52px] px-3 py-3 text-left text-[17px] font-semibold text-text-primary bg-transparent border-0 border-b border-solid border-border-primary no-underline break-words cursor-pointer';
    return (
        <div data-testid="front-door" className="text-center">
            <div className="relative overflow-hidden rounded-3xl pt-16 pb-6 px-6 mb-4 text-left" style={{ background: BLOCK.commit.fill, color: BLOCK.commit.on }}>
                {/* The shapes keep to the corners: words never sit on the sun, the ring or the bean. */}
                <div aria-hidden="true" className="absolute inset-0 pointer-events-none">
                    <span className="absolute block rounded-full" style={{ width: 260, height: 260, left: -150, bottom: -190, background: BLOCK.commit.hover }} />
                    <span className="absolute block rounded-full" style={{ width: 96, height: 96, left: -34, top: -38, border: `10px solid ${BLOCK.chip.ok.tint}` }} />
                    <span className="absolute block rounded-full" style={{ width: 48, height: 48, right: 16, top: 8, background: BLOCK.gold.fill }} />
                    <span className="absolute block rounded-full" style={{ width: 54, height: 30, right: 22, bottom: -12, background: BLOCK.cta.fill, transform: 'rotate(-18deg)' }} />
                </div>
                <h2 className="relative m-0 mb-2 text-[2rem] font-extrabold leading-tight">{MARK}</h2>
                <p className="relative m-0 text-[17px] leading-normal font-semibold break-words">{t('Trade skills, goods and favours with your neighbours.')}</p>
            </div>

            <button type="button" onClick={onInvite} data-testid="front-door-invite"
                className="block w-full min-h-[52px] px-4 py-3.5 mb-3 rounded-2xl border-none bg-bp-cta-fill hover:bg-bp-cta-hover text-bp-cta-on text-lg font-bold break-words cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-bp-ink-brand">
                {t('I have an invite')}
            </button>
            {lookAround && ('href' in lookAround ? (
                <a href={lookAround.href} rel="noopener noreferrer" data-testid="front-door-look-around" className={quiet}>{t('No invite? Look around')}</a>
            ) : (
                <button type="button" onClick={lookAround.onClick} data-testid="front-door-look-around" className={quiet}>{t('No invite? Look around')}</button>
            ))}
            <button type="button" onClick={onUsedBefore} data-testid="front-door-used-before" className={quiet}>{t("I've used BeanPool before")}</button>
            {children}

            {more.length > 0 && (
                <>
                    <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} data-testid="front-door-more" className={link}>
                        {t('More ways in ›')}
                    </button>
                    {open && (
                        <div data-testid="front-door-more-sheet" className="mt-2 p-2 rounded-2xl border border-border-primary bg-bg-card text-left">
                            {more.map((way) => ('href' in way ? (
                                <a key={way.testId} href={way.href} data-testid={way.testId} className={row}>{way.label}</a>
                            ) : (
                                <button key={way.testId} type="button" data-testid={way.testId} className={row} onClick={() => { setOpen(false); way.onClick(); }}>{way.label}</button>
                            )))}
                            <button type="button" onClick={() => setOpen(false)} className={`${link} block w-full mt-1 text-text-primary`}>{t('Cancel')}</button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
