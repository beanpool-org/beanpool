/**
 * The credit bar in the member's language (words S3, web sweep W2): its gauge label, the tag over the track, the offer
 * ladder's caption (each one sentence, its bold parts inside it), the fee ladder and the anchors under the track, all
 * through t()/tn(); the numbers in the language's digits. In English every word reads as it did.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CreditBar } from './CreditBar';
import { backToEnglish, bracketed, bypassing, showIn, xx } from '../words-w2.test-support';

afterEach(() => { cleanup(); backToEnglish(); });

/**
 * The bold parts of a translated sentence (`**1 offer** unlocks …`): a <b> drawn inside a bracket its sentence opened, so
 * it came through t() with the rest of the sentence. Their own text has no bracket of its own, so they are told apart
 * here rather than read as words that bypassed t().
 */
function boldInSentences(root: ParentNode = document.body): string[] {
    const out: string[] = [];
    for (const b of Array.from(root.querySelectorAll('b, strong'))) {
        let depth = 0;
        for (const n of Array.from(b.parentNode?.childNodes ?? [])) {
            if (n === b) break;
            for (const c of n.textContent ?? '') depth += c === '[' ? 1 : c === ']' ? -1 : 0;
        }
        if (depth > 0 && b.textContent) out.push(b.textContent);
    }
    return out;
}

describe('the credit bar in the pseudo-locale', () => {
    it('with live offers unlocking part of the line: the gauge, the tag, the caption with the next rung, the anchors', async () => {
        await showIn('xx');
        render(<CreditBar balance={-100} floor={-1000} usableFloor={-200} liveOffers={1} />);
        expect(screen.getByRole('meter', { name: xx('Credit balance gauge') })).toHaveAttribute('aria-valuetext', xx('{amount} Beans').replace('{amount}', '-100'));
        expect(screen.getByText(xx('your limit'))).toBeInTheDocument();
        expect(screen.getByText(xx('sweet spot'))).toBeInTheDocument();
        expect(screen.getByText(xx('fee-free'))).toBeInTheDocument();
        expect(screen.getByText(xx('← carry credit'))).toBeInTheDocument();
        expect(screen.getByText(xx('hold credit →'))).toBeInTheDocument();
        const bold = boldInSentences();
        expect(bold).toHaveLength(2);
        expect(bracketed()).toBeGreaterThan(5);
        expect(bypassing(document.body, { others: bold })).toEqual([]);
    });

    it('with no live offer: the caption that says one opens the line', async () => {
        await showIn('xx');
        render(<CreditBar balance={0} floor={-1000} usableFloor={0} liveOffers={0} knownGrant={1000} />);
        const bold = boldInSentences();
        expect(bold.length).toBeGreaterThan(0);
        expect(bypassing(document.body, { others: bold })).toEqual([]);
    });

    it('above the fee-free line: the fee ladder and the tag with its monthly rate', async () => {
        await showIn('xx');
        render(<CreditBar balance={600} floor={-500} />);
        expect(screen.getByText(xx('fee/mo'))).toBeInTheDocument();
        expect(bypassing()).toEqual([]);
    });
});

describe('the credit bar in English', () => {
    it('every word as it was', () => {
        render(<CreditBar balance={-100} floor={-1000} usableFloor={-200} liveOffers={1} />);
        expect(bracketed()).toBe(0);
        expect(screen.getByRole('meter', { name: 'Credit balance gauge' })).toHaveAttribute('aria-valuetext', '-100 Beans');
        expect(screen.getByText('-100 B')).toBeInTheDocument();
        expect(screen.getByText(/unlocks/).textContent).toBe('1 offer unlocks −200 · 2 offers → −500');
        for (const w of ['your limit', 'sweet spot', 'fee-free', '← carry credit', 'hold credit →']) expect(screen.getByText(w)).toBeInTheDocument();
        cleanup();

        render(<CreditBar balance={0} floor={-1000} usableFloor={0} liveOffers={0} />);
        expect(screen.getByText(/to open your credit line/).textContent).toBe('Post an Offer to open your credit line — 3 offers unlock your full −1000.');
        cleanup();

        render(<CreditBar balance={0} floor={-1000} usableFloor={0} liveOffers={0} knownGrant={1000} />);
        expect(screen.getByText(/to open your credit line/).textContent).toBe('Post an Offer to open your credit line — 1 offer unlocks your full −1000.');
        cleanup();

        render(<CreditBar balance={600} floor={-500} />);
        expect(screen.getByText('+600 B · ≈1.5%/mo')).toBeInTheDocument();
        expect(screen.getByText('fee/mo')).toBeInTheDocument();
        expect(screen.getByText('1.5%')).toBeInTheDocument();
    });
});
