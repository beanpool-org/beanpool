import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OperatorGuideBlock, OperatorGuidePage } from '@beanpool/core';
import { HelpLink, ManualProvider, useManual } from './Manual';
import { OPERATOR_MANUAL, SCREEN_HELP, manualPage, type HelpScreen } from '../../lib/manual';

// Settings shows the PUBLISHED manual, which the director publishes after merge (packages/beanpool-guide/README.md).
// So these tests take their sample pages from that copy, whatever it holds, and never name a page or its words: a slug
// or a sentence pinned here would break at the publish, not in the PR that changed it. What the pages must say (and
// that they still have a picture, a linked card and bold text for these tests to find) is pinned on the pages, in
// lib/manual.test.ts.
type Img = Extract<OperatorGuideBlock, { type: 'img' }>;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const imgs = (p: OperatorGuidePage) => p.blocks.filter((b): b is Img => b.type === 'img');
const hasBold = (p: OperatorGuidePage) => p.blocks.some(b => (b.type === 'ul' ? b.items : b.type === 'img' ? [] : [b.text]).some(t => t.includes('**')));
/** A picture on its own (not a linked card) whose caption is on its page once. */
const lonePicture = (p: OperatorGuidePage) => imgs(p).find(i => !i.href && imgs(p).filter(j => j.alt === i.alt).length === 1);
/** A linked card that opens a published page, and whose caption is on its page once. */
const linkedCard = (p: OperatorGuidePage) => imgs(p).find(i => i.href && manualPage(i.href) && imgs(p).filter(j => j.alt === i.alt).length === 1);

/** A Settings screen whose "?" opens a published page that has `what`. */
function screenWith(what: string, ok: (p: OperatorGuidePage) => boolean): { screen: HelpScreen; page: OperatorGuidePage } {
    for (const [screen, slug] of Object.entries(SCREEN_HELP) as Array<[HelpScreen, string]>) {
        const page = manualPage(slug);
        if (page && ok(page)) return { screen, page };
    }
    throw new Error(`no "?" in Settings opens a published manual page with ${what}`);
}

function OpenContents() {
    const manual = useManual();
    return <button onClick={() => manual?.openManual()}>Open manual</button>;
}

describe('Manual in Settings', () => {
    it('a "?" opens its screen\'s page, with the page text and its Related pages', async () => {
        const user = userEvent.setup();
        const { screen: helpScreen, page } = screenWith('a paragraph and a Related page', p =>
            p.blocks.some(b => b.type === 'p') && p.related.some(slug => manualPage(slug)));
        render(<ManualProvider><HelpLink screen={helpScreen} /></ManualProvider>);
        await user.click(screen.getByRole('button', { name: `Help: ${page.title}` }));

        const dialog = screen.getByRole('dialog', { name: 'Operator manual' });
        expect(within(dialog).getByRole('heading', { level: 1, name: page.title })).toBeInTheDocument();
        const paragraph = page.blocks.find(b => b.type === 'p') as { text: string };
        expect(dialog.textContent).toContain(paragraph.text.replace(/\*\*/g, ''));
        const related = manualPage(page.related.find(slug => manualPage(slug))!)!;
        await user.click(within(dialog).getByRole('button', { name: new RegExp(`^${esc(related.title)}`) }));
        expect(within(dialog).getByRole('heading', { level: 1, name: related.title })).toBeInTheDocument();
    });

    it('opens at the contents, lists every section, searches, and closes with Escape', async () => {
        const user = userEvent.setup();
        render(<ManualProvider><OpenContents /></ManualProvider>);
        await user.click(screen.getByRole('button', { name: 'Open manual' }));
        const dialog = screen.getByRole('dialog', { name: 'Operator manual' });
        for (const s of OPERATOR_MANUAL.sections) {
            expect(within(dialog).getByRole('heading', { level: 2, name: s.title })).toBeInTheDocument();
        }

        // A page's own title finds it. (What a word like "backup" finds is pinned on the pages, in lib/manual.test.ts.)
        const sample = manualPage(SCREEN_HELP['appliance/backups']) ?? OPERATOR_MANUAL.guides[0];
        await user.type(within(dialog).getByRole('searchbox', { name: 'Search the manual' }), sample.title);
        const results = within(dialog).getByRole('region', { name: 'Search results' });
        expect(within(results).getAllByRole('button', { name: new RegExp(`^${esc(sample.title)}`) }).length).toBeGreaterThan(0);

        await user.keyboard('{Escape}');
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('renders bold as <strong> and never as raw asterisks', async () => {
        const user = userEvent.setup();
        render(<ManualProvider><HelpLink screen={screenWith('bold text', hasBold).screen} /></ManualProvider>);
        await user.click(screen.getByRole('button', { name: /^Help: / }));
        const dialog = screen.getByRole('dialog');
        expect(dialog.textContent).not.toContain('**');
        expect(dialog.querySelector('strong')).not.toBeNull();
    });

    it('the "?" renders nothing outside a ManualProvider', () => {
        const { container } = render(<HelpLink screen="home" />);
        expect(container).toBeEmptyDOMElement();
    });

    it('renders inline images with resolved paths and opens lightbox on tap', async () => {
        const user = userEvent.setup();
        const { screen: helpScreen, page } = screenWith('a picture', p => Boolean(lonePicture(p)));
        const picture = lonePicture(page)!;
        const alt = picture.alt;
        render(<ManualProvider><HelpLink screen={helpScreen} /></ManualProvider>);
        await user.click(screen.getByRole('button', { name: /^Help: / }));

        const manualDialog = screen.getByRole('dialog', { name: 'Operator manual' });
        const img = within(manualDialog).getByRole('img', { name: alt });
        expect(img).toBeInTheDocument();
        expect(img.getAttribute('src')).toMatch(new RegExp(`/${esc(picture.src.replace(/^\//, ''))}$`));

        // Tap to enlarge
        await user.click(within(manualDialog).getByRole('button', { name: `Enlarge: ${alt}` }));
        const lightbox = screen.getByRole('dialog', { name: alt });
        expect(lightbox).toBeInTheDocument();
        const closeBtn = within(lightbox).getByRole('button', { name: 'Close enlarged image' });
        expect(closeBtn).toBeInTheDocument();
        expect(closeBtn.className).toContain('min-h-[48px]');
        expect(closeBtn.className).toContain('min-w-[48px]');

        // Image fills width and has no max-h-[70vh] constraint
        const lightboxImg = within(lightbox).getByRole('img', { name: alt });
        expect(lightboxImg.className).toContain('w-full');
        expect(lightboxImg.className).not.toContain('max-h-[70vh]');

        // Escape closes the lightbox first, leaving manual open
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('dialog', { name: alt })).not.toBeInTheDocument();
        expect(screen.getByRole('dialog', { name: 'Operator manual' })).toBeInTheDocument();

        // There is no separate "Enlarge 🔍" button in the figcaption (image itself is the button)
        expect(within(manualDialog).queryByRole('button', { name: 'Enlarge 🔍' })).not.toBeInTheDocument();

        // Open lightbox again and close with Close button
        await user.click(within(manualDialog).getByRole('button', { name: `Enlarge: ${alt}` }));
        const lightbox2 = screen.getByRole('dialog', { name: alt });
        await user.click(within(lightbox2).getByRole('button', { name: 'Close enlarged image' }));
        expect(screen.queryByRole('dialog', { name: alt })).not.toBeInTheDocument();
    });

    it('linked cards (the settings map) render, and clicking one opens the page it shows', async () => {
        const user = userEvent.setup();
        const found = OPERATOR_MANUAL.guides.find(p => linkedCard(p));
        if (!found) throw new Error('no published manual page has a linked card');
        const mapPage: OperatorGuidePage = found;
        function OpenSettingsMap() {
            const manual = useManual();
            return <button onClick={() => manual?.openManual(mapPage.slug)}>Open settings map</button>;
        }
        const card = linkedCard(mapPage)!;
        const target = manualPage(card.href!)!;
        render(<ManualProvider><OpenSettingsMap /></ManualProvider>);
        await user.click(screen.getByRole('button', { name: 'Open settings map' }));

        const dialog = screen.getByRole('dialog', { name: 'Operator manual' });
        expect(within(dialog).getByRole('heading', { level: 1, name: mapPage.title })).toBeInTheDocument();

        // A linked card opens the page it shows.
        const linked = within(dialog).getByRole('button', { name: `Open ${card.alt}` });
        expect(linked).toBeInTheDocument();
        await user.click(linked);
        expect(within(dialog).getByRole('heading', { level: 1, name: target.title })).toBeInTheDocument();
    });
});
