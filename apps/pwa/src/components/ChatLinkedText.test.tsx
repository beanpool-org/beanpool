/**
 * The links in a chat message's words (components/ChatLinkedText.tsx, switched on in FoldedChatText) at the part's own level:
 * what an <a> carries, what is left as words, and that a long message with a link still folds with …more.
 */
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ChatLinkedText, hasChatLink } from './ChatLinkedText';
import { FoldedChatText } from './FoldedChatText';
import { installFoldLayout, removeFoldLayout } from '../chat-fold-layout.test-support';

afterEach(cleanup);

describe('hasChatLink', () => {
    it('is true only for a run that links', () => {
        expect(hasChatLink('see https://byron.beanpool.org')).toBe(true);
        expect(hasChatLink('see www.beanpool.org')).toBe(true);
        expect(hasChatLink('see byron.beanpool.org')).toBe(false);
        expect(hasChatLink('ftp://x.org')).toBe(false);
        expect(hasChatLink('')).toBe(false);
        expect(hasChatLink(null)).toBe(false);
        expect(hasChatLink(undefined)).toBe(false);
    });
});

describe('ChatLinkedText', () => {
    it('draws each link as an <a> with its address, a new tab and noopener noreferrer, and the rest as words', () => {
        const { container } = render(<p><ChatLinkedText text={'One https://a.org/x and two www.b.org.'} /></p>);
        const links = Array.from(container.querySelectorAll('a'));
        expect(links.map(a => a.getAttribute('href'))).toEqual(['https://a.org/x', 'https://www.b.org']);
        expect(links.map(a => a.textContent)).toEqual(['https://a.org/x', 'www.b.org.']);
        for (const a of links) {
            expect(a.getAttribute('target')).toBe('_blank');
            expect(a.getAttribute('rel')).toBe('noopener noreferrer');
        }
        expect(container.querySelector('p')!.textContent).toBe('One https://a.org/x and two www.b.org.');
    });

    it('never writes an address that is not http(s)', () => {
        const { container } = render(<p><ChatLinkedText text={'javascript:alert(1) ftp://a.org mailto:a@b.org data:text/html,x'} /></p>);
        expect(container.querySelectorAll('a')).toHaveLength(0);
    });

    it('puts hostile words in the address as one attribute and in the line as text, never as markup', () => {
        // The link ends at the first space; the rest is plain words. Neither can close the attribute or start an element.
        const nasty = 'https://a.org/"><img src=x onerror=alert(1)>';
        const { container } = render(<p><ChatLinkedText text={nasty} /></p>);
        expect(container.querySelector('img')).toBeNull();
        expect(container.querySelectorAll('a')).toHaveLength(1);
        expect(container.querySelector('a')!.getAttribute('href')).toBe('https://a.org/"><img');
        expect(container.querySelector('p')!.textContent).toBe(nasty);
        expect(container.querySelector('p')!.children).toHaveLength(1);
        expect(container.querySelector('[onerror]')).toBeNull();
    });

    it("takes the ink it is given: the central link colour, or the bubble's own on the accent one", () => {
        const { container, rerender } = render(<ChatLinkedText text="https://a.org" />);
        expect((container.querySelector('a') as HTMLElement).style.color).toBe('var(--link)');
        expect((container.querySelector('a') as HTMLElement).style.fontWeight).toBe('');
        rerender(<ChatLinkedText text="https://a.org" ink="inherit" />);
        expect((container.querySelector('a') as HTMLElement).style.color).toBe('inherit');
        expect((container.querySelector('a') as HTMLElement).style.fontWeight).toBe('600');
    });
});

describe('FoldedChatText with links', () => {
    beforeEach(() => installFoldLayout());
    afterEach(() => removeFoldLayout());

    const withLink = Array.from({ length: 40 }, (_, i) => `Job ${i + 1} at https://byron.beanpool.org/jobs/${i + 1}`).join('\n');

    it('does not draw links unless asked', () => {
        const { container } = render(<FoldedChatText text="See https://byron.beanpool.org" />);
        expect(container.querySelector('a')).toBeNull();
        expect(container.textContent).toBe('See https://byron.beanpool.org');
    });

    it('a short text is its words and its links, and a text without a link is as it was', () => {
        const { container, rerender } = render(<div><FoldedChatText text="See https://byron.beanpool.org" links /></div>);
        expect(container.querySelectorAll('a')).toHaveLength(1);
        expect(container.querySelector('div')!.textContent).toBe('See https://byron.beanpool.org');
        rerender(<div><FoldedChatText text="See you at nine" links /></div>);
        expect(container.querySelector('div')!.innerHTML).toBe('See you at nine');
    });

    it('a long message with links still folds under …more, opens and folds again, links whole in each state', () => {
        render(<FoldedChatText text={withLink} links />);
        const words = screen.getByTestId('chat-text');
        expect(words.dataset.fold).toBe('folded');
        expect(words.querySelectorAll('a')).toHaveLength(40);
        expect(words.textContent).toBe(withLink);

        fireEvent.click(screen.getByRole('button', { name: '…more' }));
        expect(screen.getByTestId('chat-text').dataset.fold).toBe('open');
        expect(screen.getByTestId('chat-text').querySelectorAll('a')).toHaveLength(40);
        fireEvent.click(screen.getByRole('button', { name: 'less' }));
        expect(screen.getByTestId('chat-text').dataset.fold).toBe('folded');
    });

    it("takes the bubble's ink: inherit on the member's own bubble, a given ink on a failed line, else the link colour", () => {
        const { container, rerender } = render(<FoldedChatText text="https://a.org" links mine />);
        expect((container.querySelector('a') as HTMLElement).style.color).toBe('inherit');
        rerender(<FoldedChatText text="https://a.org" links ink="var(--bp-chip-danger-ink)" />);
        expect((container.querySelector('a') as HTMLElement).style.color).toBe('var(--bp-chip-danger-ink)');
        rerender(<FoldedChatText text="https://a.org" links />);
        expect((container.querySelector('a') as HTMLElement).style.color).toBe('var(--link)');
    });
});
