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
});
