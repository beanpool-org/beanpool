/**
 * The web's credit card (DESIGN-credit-bar-amend-fable.md, slice R1): one button whose label is core's spoken sentence, no
 * `role="meter"` (its range ended at 200 and said nothing of the limit, F11), the drawing hidden from screen readers, every
 * word equal to core's, and the source holds no hex and no size under 12 (§8). Replaces main's meter tests.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { creditBarPicture, creditStandingCard, type CreditStandingAnswer } from '@beanpool/core';
import { CreditBar } from './CreditBar';

/** Marty on 14 Nov: owes 50 of a 500 line, all of it Damo's vouch, one live Offer. */
const MARTY: CreditStandingAnswer = {
    balance_c: -5000, floor_c: -50000, usableFloor_c: -50000, knownGrant_c: 0, roomHeld_c: 50000, earnedCredit_c: 0, liveOffers: 1,
    vouchedBy: [{ callsign: 'Damo', amount_c: 50000 }],
};
/** A confirmed member with a vouch of 100: the line is 1,100, never "100" (F7). */
const CONFIRMED_AND_VOUCH: CreditStandingAnswer = {
    balance_c: 0, floor_c: -110000, usableFloor_c: -110000, knownGrant_c: 100000, roomHeld_c: 10000, earnedCredit_c: 0, liveOffers: 1,
    vouchedBy: [{ callsign: 'Olive', amount_c: 10000 }],
};

describe('the web credit card is one button, its words core\'s', () => {
    it('Marty\'s card: the button\'s label is core\'s spoken sentence, and there is no meter', () => {
        render(<CreditBar answer={MARTY} />);
        const card = creditStandingCard(MARTY);
        const button = screen.getByRole('button', { name: card.spoken });
        expect(button).toHaveAttribute('type', 'button');
        expect(card.spoken).toBe('You owe 50 Beans. You can spend 450 more of your 500 credit line. Your limit is minus 500. Your credit line: @Damo vouched 500. Opens how this works.');
        expect(screen.queryByRole('meter')).toBeNull();
        expect(document.querySelector('[role="meter"]')).toBeNull();
    });

    it('shows core\'s headline, sentence and parts line, and hides the drawing from screen readers', () => {
        render(<CreditBar answer={MARTY} />);
        const card = creditStandingCard(MARTY);
        expect(screen.getByTestId('credit-headline').textContent).toBe(card.headline);
        expect(screen.getByTestId('credit-sentence').textContent).toBe(card.sentence);
        expect(screen.getByTestId('credit-parts').textContent).toBe(card.parts);
        expect(screen.getByTestId('credit-parts').textContent).toBe('Credit line 500: ■ Earned by trading 0 so far · □ @Damo vouched 500');
        expect(screen.getByTestId('credit-drawing')).toHaveAttribute('aria-hidden', 'true');
        expect(screen.getByTestId('credit-label').textContent).toBe('−50 Beans');
    });

    it('a confirmed member with a vouch reads the whole line (F7)', () => {
        render(<CreditBar answer={CONFIRMED_AND_VOUCH} />);
        expect(screen.getByTestId('credit-parts').textContent).toBe('Credit line 1,100: ■ Earned by trading 0 so far · □ Confirmed member 1,000 · □ @Olive vouched 100');
        expect(screen.queryByText(/Your credit line: 100/)).toBeNull();
    });

    it('draws the strip\'s blocks where core puts them, and no stray mark: one live Offer opens a vouched line whole', () => {
        render(<CreditBar answer={MARTY} />);
        const blocks = Array.from(screen.getByTestId('credit-strip').querySelectorAll('[data-kind]'));
        expect(blocks.map((b) => b.getAttribute('data-kind'))).toEqual(['vouch']);
        expect(screen.queryByTestId('credit-stripes')).toBeNull();
        const pic = creditBarPicture(MARTY);
        expect((blocks[0] as HTMLElement).style.left).toBe(`calc(${pic.blocks[0]!.from}% + 1px)`);
    });

    it('a tap opens what the Ledger gives it', () => {
        const onOpen = vi.fn();
        render(<CreditBar answer={MARTY} onOpen={onOpen} />);
        screen.getByRole('button').click();
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('a newcomer sees the bar, its left half striped, "no credit line yet", and the note', () => {
        render(<CreditBar answer={{ balance_c: 0, floor_c: 0, activated: false } as CreditStandingAnswer} />);
        expect(screen.getByTestId('credit-stripes')).toBeInTheDocument();
        expect(screen.getByText('no credit line yet')).toBeInTheDocument();
        expect(screen.getByTestId('credit-note').textContent).toContain('Your credit line opens with your first completed trade');
    });
});

describe('the source', () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'CreditBar.tsx'), 'utf8');
    it('holds no hex colour', () => {
        expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    });
    it('holds no size under 12, and sizes in rem so the member\'s own text size scales them', () => {
        // Tailwind's text-xs is 0.75rem (12 px at 100 %); text-base 1rem; an arbitrary size is written in rem.
        const rems = [...src.matchAll(/text-\[(\d*\.?\d+)rem\]/g)].map((m) => Number(m[1]) * 16);
        expect(rems.length).toBeGreaterThan(0);
        expect(rems.filter((px) => px < 12)).toEqual([]);
        expect(src).toMatch(/\btext-xs\b/);
        expect(src).not.toMatch(/text-\[\d+(?:\.\d+)?px\]|fontSize:|text-xxs|text-2xs/);
    });
    it('reads no old credit variable and draws no meter', () => {
        expect(src).not.toMatch(/--credit-|role="meter"|aria-valuenow/);
    });
});
