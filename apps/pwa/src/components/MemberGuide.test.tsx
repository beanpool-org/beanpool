import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';

const api = vi.hoisted(() => ({
    getCommunityHealth: vi.fn(),
    getPulseFeed: vi.fn(),
}));
vi.mock('../lib/api', () => api);

import { MemberGuide } from './MemberGuide';
import { BeanPoolSettingsGroup } from '../pages/SettingsPage';
import { getBundledGuide, resetGuideSessionForTests } from '../lib/guide';
import { validateGuide, manualSections, FEEDBACK_LIVE } from '@beanpool/core';

const repo = path.resolve(__dirname, '../../../..');
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');

beforeEach(() => {
    resetGuideSessionForTests();
    api.getCommunityHealth.mockReset().mockResolvedValue({ ok: true });
    api.getPulseFeed.mockReset().mockResolvedValue({ items: [], nextCursor: null });
    // No network in tests: the website check fails fast and the bundled copy stays.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
});

describe('one source: the web app bundles the same guide as the member app and the website', () => {
    it('the bundled guide is the exact bytes of the generated file and the website copy', () => {
        const generated = read('packages/beanpool-guide/generated/guide.json');
        const website = read('apps/website/guide/guide.json');
        expect(website).toBe(generated);
        expect(getBundledGuide()).toEqual(validateGuide(JSON.parse(generated)));
    });

    it('no source file in the web app keeps its own copy of the guide', () => {
        const srcDir = path.join(repo, 'apps/pwa/src');
        const files = fs.readdirSync(srcDir, { recursive: true }).map(String).filter(f => /\.(ts|tsx|json)$/.test(f));
        const offenders = files.filter(f => {
            const text = fs.readFileSync(path.join(srcDir, f), 'utf8');
            if (f.endsWith('.json')) return /"guides"\s*:/.test(text);
            return /guide\.json/.test(text) && !/from '@beanpool\/guide\/generated\/guide\.json'/.test(text) && !f.endsWith('.test.tsx');
        });
        expect(offenders).toEqual([]);
    });
});

describe('MemberGuide (Settings → BeanPool → Help & how it works)', () => {
    it('shows the guides, every manual section and the website link, and works with no connection', async () => {
        api.getCommunityHealth.mockRejectedValue(new Error('offline'));
        render(<MemberGuide onBack={() => {}} feedbackLive={false} />);
        expect(screen.getByText('How BeanPool works')).toBeInTheDocument();
        for (const s of manualSections(getBundledGuide())) expect(screen.getByText(s.title)).toBeInTheDocument();
        expect(screen.getByText('beanpool.org').closest('a')).toHaveAttribute('href', 'https://beanpool.org');
        expect(screen.getByText('beanpool.org').closest('a')).toHaveAttribute('rel', 'noopener noreferrer');
        expect(await screen.findByText("Can't reach it right now")).toBeInTheDocument();
        expect(screen.getByText(/built into the app/)).toBeInTheDocument();
    });

    it('opens a section, then a page with its Related pages, and Back walks back', () => {
        const onBack = vi.fn();
        render(<MemberGuide onBack={onBack} feedbackLive={false} />);
        fireEvent.click(screen.getByText('Ledger'));
        fireEvent.click(screen.getByText('Sending a gift'));
        expect(screen.getByRole('heading', { level: 1, name: 'Sending a gift' })).toBeInTheDocument();
        expect(screen.getByText('Related')).toBeInTheDocument();
        fireEvent.click(screen.getByText('Your balance and history'));
        expect(screen.getByRole('heading', { level: 1, name: 'Your balance and history' })).toBeInTheDocument();
        fireEvent.click(screen.getByText('← Back'));
        expect(screen.getByRole('heading', { level: 1, name: 'Sending a gift' })).toBeInTheDocument();
        fireEvent.click(screen.getByText('← Back'));
        fireEvent.click(screen.getByText('← Back'));
        expect(onBack).not.toHaveBeenCalled();
        fireEvent.click(screen.getByText('← Back'));
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('searches the bundled text offline', () => {
        render(<MemberGuide onBack={() => {}} feedbackLive={false} />);
        fireEvent.change(screen.getByLabelText('Search the guide'), { target: { value: 'gift' } });
        expect(screen.getByText('Sending a gift')).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText('Search the guide'), { target: { value: 'zzqqxx' } });
        expect(screen.getByText('Nothing found')).toBeInTheDocument();
    });

    it('shows "Watch" only when a matching Learn video exists', async () => {
        render(<MemberGuide onBack={() => {}} feedbackLive={false} />);
        fireEvent.click(screen.getByText('Pulse'));
        fireEvent.click(screen.getByText('The Learn lane'));
        await waitFor(() => expect(api.getPulseFeed).toHaveBeenCalled());
        expect(screen.queryByRole('link', { name: /^Watch:/ })).toBeNull();
    });

    it('links a Learn video whose title is the page title', async () => {
        api.getPulseFeed.mockResolvedValue({
            items: [{ id: 'item_curated_abcdefghijk', category: 'learn', title: 'Sending a gift', url: 'https://www.youtube.com/watch?v=abcdefghijk' }],
            nextCursor: null,
        });
        render(<MemberGuide onBack={() => {}} feedbackLive={false} />);
        fireEvent.click(screen.getByText('Ledger'));
        fireEvent.click(screen.getByText('Sending a gift'));
        const link = await screen.findByText('Watch: Sending a gift');
        expect(link.closest('a')).toHaveAttribute('href', 'https://www.youtube.com/watch?v=abcdefghijk');
    });
});

describe('Suggest a change follows FEEDBACK_LIVE in both entry points', () => {
    it('Settings shows it exactly when FEEDBACK_LIVE is on (the default comes from the flag)', () => {
        render(<BeanPoolSettingsGroup onHelp={() => {}} onSuggest={() => {}} />);
        expect(screen.getByText('Help & how it works')).toBeInTheDocument();
        expect(screen.getByText('beanpool.org')).toBeInTheDocument();
        expect(screen.queryByText('Suggest a change') !== null).toBe(FEEDBACK_LIVE);
    });

    it('the sheet shows it exactly when FEEDBACK_LIVE is on (the default comes from the flag)', () => {
        render(<MemberGuide onBack={() => {}} onSuggest={() => {}} />);
        expect(screen.queryByText('Suggest a change') !== null).toBe(FEEDBACK_LIVE);
    });

    it('both hide it when the flag is off', () => {
        const a = render(<BeanPoolSettingsGroup onHelp={() => {}} onSuggest={() => {}} feedbackLive={false} />);
        expect(within(a.container).queryByText('Suggest a change')).toBeNull();
        a.unmount();
        render(<MemberGuide onBack={() => {}} onSuggest={() => {}} feedbackLive={false} />);
        expect(screen.queryByText('Suggest a change')).toBeNull();
    });

    it('shown in both when live, and both open the same screen', () => {
        const onSuggest = vi.fn();
        const settings = render(<BeanPoolSettingsGroup onHelp={() => {}} onSuggest={onSuggest} feedbackLive />);
        fireEvent.click(within(settings.container).getByText('Suggest a change'));
        settings.unmount();
        render(<MemberGuide onBack={() => {}} onSuggest={onSuggest} feedbackLive />);
        fireEvent.click(screen.getByText('Suggest a change'));
        expect(onSuggest).toHaveBeenCalledTimes(2);
    });
});
