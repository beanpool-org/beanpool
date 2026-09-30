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
import {
    validateGuide, manualSections, sectionPages, relatedPages, findGuidePage, FEEDBACK_LIVE, GUIDE_SLUGS,
    type Guide, type GuidePage, type GuideSection,
} from '@beanpool/core';

const repo = path.resolve(__dirname, '../../../..');
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), 'utf8');

// The screen shows the PUBLISHED guide the app bundles, which the director publishes after merge
// (packages/beanpool-guide/README.md). So these tests take their sample page from that copy, whatever it holds, and
// never name a page, a section or their words: a slug or a title pinned here would break at the publish, not in the PR
// that changed it. What the guide says, and what search finds, is pinned on the pages in the member app's guide tests
// (apps/native/utils/__tests__/guide.test.ts), which run on the same @beanpool/core code.
/** The first page of a manual section with a Related page, where every title the test clicks is on screen once. */
function samplePage(g: Guide): { section: GuideSection; page: GuidePage; related: GuidePage } {
    const titles = [...g.sections.map(s => s.title), ...g.guides.map(p => p.title)];
    const once = (t: string) => titles.filter(x => x === t).length === 1;
    for (const section of manualSections(g)) {
        for (const page of sectionPages(g, section)) {
            const related = relatedPages(g, page).find(r => once(r.title) && r.title !== section.title);
            if (related && once(section.title) && once(page.title)) return { section, page, related };
        }
    }
    throw new Error('the bundled guide has no manual page with a Related page');
}
const SAMPLE = samplePage(getBundledGuide());
/** The screen's Back button (a page's own words may say "← Back" too). */
const back = () => screen.getByRole('button', { name: '← Back' });

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
        const about = [GUIDE_SLUGS.howItWorks, GUIDE_SLUGS.rules, GUIDE_SLUGS.faq].map(s => findGuidePage(getBundledGuide(), s));
        expect(about.some(Boolean)).toBe(true);
        for (const p of about) if (p) expect(screen.getByText(p.title)).toBeInTheDocument();
        for (const s of manualSections(getBundledGuide())) expect(screen.getByText(s.title)).toBeInTheDocument();
        expect(screen.getByText('beanpool.org').closest('a')).toHaveAttribute('href', 'https://beanpool.org');
        expect(screen.getByText('beanpool.org').closest('a')).toHaveAttribute('rel', 'noopener noreferrer');
        expect(await screen.findByText("Can't reach it right now")).toBeInTheDocument();
        expect(screen.getByText(/built into the app/)).toBeInTheDocument();
    });

    it('opens a section, then a page with its Related pages, and Back walks back', () => {
        const onBack = vi.fn();
        render(<MemberGuide onBack={onBack} feedbackLive={false} />);
        const { section, page, related } = SAMPLE;
        fireEvent.click(screen.getByText(section.title));
        fireEvent.click(screen.getByText(page.title));
        expect(screen.getByRole('heading', { level: 1, name: page.title })).toBeInTheDocument();
        expect(screen.getByText('Related')).toBeInTheDocument();
        fireEvent.click(screen.getByText(related.title));
        expect(screen.getByRole('heading', { level: 1, name: related.title })).toBeInTheDocument();
        fireEvent.click(back());
        expect(screen.getByRole('heading', { level: 1, name: page.title })).toBeInTheDocument();
        fireEvent.click(back());
        fireEvent.click(back());
        expect(onBack).not.toHaveBeenCalled();
        fireEvent.click(back());
        expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('searches the bundled text offline', () => {
        render(<MemberGuide onBack={() => {}} feedbackLive={false} />);
        fireEvent.change(screen.getByLabelText('Search the guide'), { target: { value: SAMPLE.page.title } });
        expect(screen.getAllByText(SAMPLE.page.title).length).toBeGreaterThan(0);
        fireEvent.change(screen.getByLabelText('Search the guide'), { target: { value: 'zzqqxx' } });
        expect(screen.getByText('Nothing found')).toBeInTheDocument();
    });

    it('shows "Watch" only when a matching Learn video exists', async () => {
        render(<MemberGuide onBack={() => {}} feedbackLive={false} />);
        fireEvent.click(screen.getByText(SAMPLE.section.title));
        fireEvent.click(screen.getByText(SAMPLE.page.title));
        await waitFor(() => expect(api.getPulseFeed).toHaveBeenCalled());
        expect(screen.queryByRole('link', { name: /^Watch:/ })).toBeNull();
    });

    it('links a Learn video whose title is the page title', async () => {
        api.getPulseFeed.mockResolvedValue({
            items: [{ id: 'item_curated_abcdefghijk', category: 'learn', title: SAMPLE.page.title, url: 'https://www.youtube.com/watch?v=abcdefghijk', source: 'curated' }],
            nextCursor: null,
        });
        render(<MemberGuide onBack={() => {}} feedbackLive={false} />);
        fireEvent.click(screen.getByText(SAMPLE.section.title));
        fireEvent.click(screen.getByText(SAMPLE.page.title));
        const link = await screen.findByText(`Watch: ${SAMPLE.page.title}`);
        expect(link.closest('a')).toHaveAttribute('href', 'https://www.youtube.com/watch?v=abcdefghijk');
    });

    // Review round 1 (B1): any member can put items in the Learn lane, with any title and (via RSS) any https link.
    // The same rule on the 12-words page and the other pages it matters most on is pinned on the pages, in the member
    // app's guide tests; this checks the screen follows it.
    it('links only the curated YouTube video on a page, never a member item titled like it', async () => {
        const { section, page } = SAMPLE;
        api.getPulseFeed.mockResolvedValue({
            items: [
                { id: 'm1', category: 'learn', title: page.title, url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA', source: 'autolist' },
                { id: 'm2', category: 'learn', title: `${page.title.toUpperCase()}!!`, url: 'https://evil.example/x', source: 'autolist' },
                { id: 'm3', category: 'learn', title: page.title, url: 'https://evil.example/watch?v=AAAAAAAAAAA', source: 'curated' },
                // Last in the list: the members' items above would win if they were allowed to match.
                { id: 'c1', category: 'learn', title: page.title, url: 'https://www.youtube.com/watch?v=CCCCCCCCCCC', source: 'curated' },
            ],
            nextCursor: null,
        });
        render(<MemberGuide onBack={() => {}} feedbackLive={false} />);
        fireEvent.click(screen.getByText(section.title));
        fireEvent.click(screen.getByText(page.title));
        const link = await screen.findByText(`Watch: ${page.title}`);
        expect(link.closest('a')).toHaveAttribute('href', 'https://www.youtube.com/watch?v=CCCCCCCCCCC');
        expect(document.querySelector('a[href*="evil.example"]')).toBeNull();
        expect(document.querySelector('a[href*="AAAAAAAAAAA"]')).toBeNull();
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
