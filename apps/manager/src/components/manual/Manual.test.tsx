import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HelpLink, ManualProvider, useManual } from './Manual';
import { OPERATOR_MANUAL, manualPage } from '../../lib/manual';

function OpenContents() {
    const manual = useManual();
    return <button onClick={() => manual?.openManual()}>Open manual</button>;
}

describe('Manual in Settings', () => {
    it('a "?" opens its screen\'s page, with the page text and its Related pages', async () => {
        const user = userEvent.setup();
        render(<ManualProvider><HelpLink screen="economy/disputes" /></ManualProvider>);
        const page = manualPage('disputes')!;
        await user.click(screen.getByRole('button', { name: `Help: ${page.title}` }));

        const dialog = screen.getByRole('dialog', { name: 'Operator manual' });
        expect(within(dialog).getByRole('heading', { level: 1, name: page.title })).toBeInTheDocument();
        expect(dialog.textContent).toContain('You cannot rule on a deal you are part of');
        const related = manualPage(page.related[0])!;
        await user.click(within(dialog).getByRole('button', { name: new RegExp(related.title) }));
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

        await user.type(within(dialog).getByRole('searchbox', { name: 'Search the manual' }), 'backup');
        const results = within(dialog).getByRole('region', { name: 'Search results' });
        expect(within(results).getByRole('button', { name: /^Backups and replicas/ })).toBeInTheDocument();

        await user.keyboard('{Escape}');
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('renders bold as <strong> and never as raw asterisks', async () => {
        const user = userEvent.setup();
        render(<ManualProvider><HelpLink screen="appliance/access" /></ManualProvider>);
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
        render(<ManualProvider><HelpLink screen="appliance/access" /></ManualProvider>);
        await user.click(screen.getByRole('button', { name: /^Help: / }));

        const manualDialog = screen.getByRole('dialog', { name: 'Operator manual' });
        const img = within(manualDialog).getByRole('img', { name: 'The Access and Security screen in Settings' });
        expect(img).toBeInTheDocument();
        expect(img.getAttribute('src')).toMatch(/\/images\/appliance-access\.webp$/);

        // Tap to enlarge
        await user.click(within(manualDialog).getByRole('button', { name: /Enlarge: The Access and Security screen in Settings/ }));
        const lightbox = screen.getByRole('dialog', { name: 'The Access and Security screen in Settings' });
        expect(lightbox).toBeInTheDocument();
        const closeBtn = within(lightbox).getByRole('button', { name: 'Close enlarged image' });
        expect(closeBtn).toBeInTheDocument();
        expect(closeBtn.className).toContain('min-h-[48px]');
        expect(closeBtn.className).toContain('min-w-[48px]');

        // Image fills width and has no max-h-[70vh] constraint
        const lightboxImg = within(lightbox).getByRole('img', { name: 'The Access and Security screen in Settings' });
        expect(lightboxImg.className).toContain('w-full');
        expect(lightboxImg.className).not.toContain('max-h-[70vh]');

        // Escape closes the lightbox first, leaving manual open
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('dialog', { name: 'The Access and Security screen in Settings' })).not.toBeInTheDocument();
        expect(screen.getByRole('dialog', { name: 'Operator manual' })).toBeInTheDocument();

        // There is no separate "Enlarge 🔍" button in the figcaption (image itself is the button)
        expect(within(manualDialog).queryByRole('button', { name: 'Enlarge 🔍' })).not.toBeInTheDocument();

        // Open lightbox again and close with Close button
        await user.click(within(manualDialog).getByRole('button', { name: /Enlarge: The Access and Security screen in Settings/ }));
        const lightbox2 = screen.getByRole('dialog', { name: 'The Access and Security screen in Settings' });
        await user.click(within(lightbox2).getByRole('button', { name: 'Close enlarged image' }));
        expect(screen.queryByRole('dialog', { name: 'The Access and Security screen in Settings' })).not.toBeInTheDocument();
    });

    it('settings map renders linked cards and clicking navigates to target page', async () => {
        const user = userEvent.setup();
        function OpenSettingsMap() {
            const manual = useManual();
            return <button onClick={() => manual?.openManual('settings-map')}>Open settings map</button>;
        }
        render(<ManualProvider><OpenSettingsMap /></ManualProvider>);
        await user.click(screen.getByRole('button', { name: 'Open settings map' }));

        const dialog = screen.getByRole('dialog', { name: 'Operator manual' });
        expect(within(dialog).getByRole('heading', { level: 1, name: 'Settings map' })).toBeInTheDocument();

        // Linked card for Home screen
        const homeCard = within(dialog).getByRole('button', { name: /^Open The Home screen/ });
        expect(homeCard).toBeInTheDocument();
        await user.click(homeCard);

        // Navigated to Finding your way around Settings
        expect(within(dialog).getByRole('heading', { level: 1, name: 'Finding your way around Settings' })).toBeInTheDocument();
    });
});
