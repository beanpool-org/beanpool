import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';

const api = vi.hoisted(() => ({
    getCommunityHealth: vi.fn(),
    getPulseFeed: vi.fn(),
}));
vi.mock('../lib/api', () => api);
// Portuguese's titles file as its language chunk delivers it (lib/language.ts); filled below, as a drafting round would.
const ptTitles = vi.hoisted(() => ({ sections: {}, pages: {} } as Record<string, any>));
vi.mock('@beanpool/guide/content/pt/manifest.json', () => ({ default: ptTitles }));

import { MemberGuide } from './MemberGuide';
import { BeanPoolSettingsGroup } from '../pages/SettingsPage';
import { getBundledGuide, resetGuideSessionForTests } from '../lib/guide';
import { showLanguage } from '../lib/language';
import {
    validateGuide, manualSections, sectionPages, relatedPages, findGuidePage, FEEDBACK_LIVE, GUIDE_SLUGS, guideBodyHash, guideCacheKey, guideSourceHash, pseudoLocalise, setLanguage,
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
afterEach(async () => {
    await act(async () => { await showLanguage('en'); });
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

    it("opens at a page by slug (Home's Tips card, Read more), the front page behind it", () => {
        const onBack = vi.fn();
        const { page } = SAMPLE;
        render(<MemberGuide onBack={onBack} feedbackLive={false} initialPage={page.slug} />);
        expect(screen.getByRole('heading', { level: 1, name: page.title })).toBeInTheDocument();
        fireEvent.click(back());
        expect(screen.getByRole('searchbox', { name: 'Search the guide' })).toBeInTheDocument();
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

// The guide's titles in the member's language (slice S5a). The sample section and pages come from the published copy.
describe("MemberGuide in the member's language: the guide's titles, the English body said once", () => {
    const { section, page, related } = SAMPLE;
    const entry = (english: string, text: string) => ({ text, sourceHash: guideSourceHash(english) });
    beforeEach(() => {
        for (const k of Object.keys(ptTitles)) delete ptTitles[k];
        Object.assign(ptTitles, {
            sections: { [section.id]: { title: entry(section.title, 'Secção traduzida'), summary: entry(section.summary, 'O resumo da secção.') } },
            pages: {
                [page.slug]: { title: entry(page.title, 'Página traduzida'), summary: entry(page.summary, 'O resumo da página.') },
                // Drafted from English the page no longer says: the English shows.
                [related.slug]: { title: entry(`${related.title} (an older title)`, 'Título antigo') },
            },
        });
    });
    afterEach(async () => { await act(async () => { await showLanguage('en'); }); });

    it('the front page, a section and a page show the translations, the English where there are none or they are stale', async () => {
        await act(async () => { await showLanguage('pt'); });
        render(<MemberGuide onBack={() => {}} feedbackLive={false} />);
        expect(screen.getByText('Secção traduzida')).toBeInTheDocument();
        expect(screen.getByText('O resumo da secção.')).toBeInTheDocument();
        for (const s of manualSections(getBundledGuide()).filter(x => x.id !== section.id)) expect(screen.getByText(s.title)).toBeInTheDocument();
        fireEvent.click(screen.getByText('Secção traduzida'));
        expect(screen.getByRole('heading', { level: 1, name: 'Secção traduzida' })).toBeInTheDocument();
        fireEvent.click(screen.getByText('Página traduzida'));
        expect(screen.getByRole('heading', { level: 1, name: 'Página traduzida' })).toBeInTheDocument();
        expect(screen.getByText('O resumo da página.')).toBeInTheDocument();
        // One line says the body is English (in Portuguese once the words round drafts it), and the body is marked English.
        expect(screen.getAllByTestId('guide-english-note')).toHaveLength(1);
        const body = document.querySelector('article [lang="en"]');
        expect(body).not.toBeNull();
        expect(body!.textContent!.length).toBeGreaterThan(0);
        // The stale Related page reads its English title, and its page says nothing about English.
        expect(screen.queryByText('Título antigo')).toBeNull();
        fireEvent.click(screen.getByText(related.title));
        expect(screen.getByRole('heading', { level: 1, name: related.title })).toBeInTheDocument();
        expect(screen.queryByTestId('guide-english-note')).toBeNull();
        expect(document.querySelector('article [lang="en"]')).toBeNull();
    });

    it('the search finds a page by its translated title and by its English one, and shows the translation', async () => {
        await act(async () => { await showLanguage('pt'); });
        render(<MemberGuide onBack={() => {}} feedbackLive={false} />);
        // The search field's own words are Portuguese here.
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'traduzida' } });
        expect(screen.getByText('Página traduzida')).toBeInTheDocument();
        fireEvent.change(screen.getByRole('searchbox'), { target: { value: page.title } });
        expect(screen.getAllByText('Página traduzida').length).toBeGreaterThan(0);
    });

    it('a language switch is live: the open page goes from English to Portuguese and back', async () => {
        render(<MemberGuide onBack={() => {}} feedbackLive={false} initialPage={page.slug} />);
        expect(screen.getByRole('heading', { level: 1, name: page.title })).toBeInTheDocument();
        expect(screen.queryByTestId('guide-english-note')).toBeNull();
        await act(async () => { await showLanguage('pt'); });
        expect(screen.getByRole('heading', { level: 1, name: 'Página traduzida' })).toBeInTheDocument();
        expect(screen.getByTestId('guide-english-note')).toBeInTheDocument();
        await act(async () => { await showLanguage('en'); });
        expect(screen.getByRole('heading', { level: 1, name: page.title })).toBeInTheDocument();
        expect(screen.queryByTestId('guide-english-note')).toBeNull();
    });

    it('in the pseudo-locale every guide title and summary is pseudo-localised, and the English line too', async () => {
        await act(async () => { await showLanguage('xx'); });
        render(<MemberGuide onBack={() => {}} feedbackLive={false} initialPage={page.slug} />);
        expect(screen.getByRole('heading', { level: 1, name: pseudoLocalise(page.title) })).toBeInTheDocument();
        expect(screen.getByText(pseudoLocalise(page.summary))).toBeInTheDocument();
        expect(screen.getByTestId('guide-english-note')).toHaveTextContent(pseudoLocalise('This page is in English for now.'));
        fireEvent.click(screen.getByRole('button', { name: pseudoLocalise('← Back') }));
        for (const s of manualSections(getBundledGuide())) {
            expect(screen.getByText(pseudoLocalise(s.title))).toBeInTheDocument();
            expect(screen.getByText(pseudoLocalise(s.summary))).toBeInTheDocument();
        }
    });
});

describe("the three page states on web: current, behind with toggle, missing, and offline fallback", () => {
    const { section, page, related } = SAMPLE;
    const currentHash = guideBodyHash(page.blocks);
    const staleHash = '0000000000000000';

    beforeEach(() => {
        resetGuideSessionForTests();
        localStorage.clear();
        for (const k of Object.keys(ptTitles)) delete ptTitles[k];
        Object.assign(ptTitles, {
            sections: { [section.id]: { title: { text: 'Secção traduzida', sourceHash: guideSourceHash(section.title) } } },
            pages: {
                [page.slug]: { title: { text: 'Página traduzida', sourceHash: guideSourceHash(page.title) }, summary: { text: 'Resumo da página.', sourceHash: guideSourceHash(page.summary) } },
                [related.slug]: { title: { text: 'Relacionado traduzido', sourceHash: guideSourceHash(related.title) } },
            },
        });
    });
    afterEach(async () => {
        await act(async () => { await showLanguage('en'); });
    });

    it('current state: matching source-hash renders translated body without english or newer notes', async () => {
        const ptGuide: Guide = {
            schema: getBundledGuide().schema,
            version: 1,
            language: 'pt',
            hash: '1234567890abcdef',
            sections: [{ id: section.id, title: 'Secção traduzida', summary: 'Resumo.', slugs: [page.slug] }],
            guides: [{
                slug: page.slug,
                title: 'Página traduzida',
                summary: 'Resumo da página.',
                section: section.id,
                related: [],
                sourceHash: currentHash,
                blocks: [{ type: 'p', text: 'Corpo traduzido atual na web.' }],
            }],
        };
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(ptGuide) })));
        await act(async () => { await showLanguage('pt'); });
        render(<MemberGuide onBack={() => {}} feedbackLive={false} initialPage={page.slug} />);
        await waitFor(() => {
            expect(screen.getByText('Corpo traduzido atual na web.')).toBeInTheDocument();
        });
        expect(screen.queryByTestId('guide-english-note')).toBeNull();
        expect(screen.queryByTestId('guide-newer-note')).toBeNull();
        expect(screen.getByTestId('guide-draft-note')).toHaveTextContent('Translated by machine: some words may be wrong.');
    });

    it('behind state: older source-hash renders translated body with newer note and toggle to read English', async () => {
        const ptGuide: Guide = {
            schema: getBundledGuide().schema,
            version: 1,
            language: 'pt',
            hash: '1234567890abcdef',
            sections: [{ id: section.id, title: 'Secção traduzida', summary: 'Resumo.', slugs: [page.slug] }],
            guides: [{
                slug: page.slug,
                title: 'Página traduzida',
                summary: 'Resumo da página.',
                section: section.id,
                related: [],
                sourceHash: staleHash,
                blocks: [{ type: 'p', text: 'Corpo traduzido antigo na web.' }],
            }],
        };
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(ptGuide) })));
        await act(async () => { await showLanguage('pt'); });
        render(<MemberGuide onBack={() => {}} feedbackLive={false} initialPage={page.slug} />);
        await waitFor(() => {
            expect(screen.getByText('Corpo traduzido antigo na web.')).toBeInTheDocument();
        });
        expect(screen.getByTestId('guide-newer-note')).toHaveTextContent('This page is newer in English.');
        expect(screen.getByTestId('guide-draft-note')).toHaveTextContent('Translated by machine: some words may be wrong.');
        const toggle = screen.getByTestId('guide-toggle-english');
        expect(toggle).toHaveTextContent('Read in English');

        // Toggle to English
        fireEvent.click(toggle);
        expect(toggle).toHaveTextContent('Show translation');
        expect(screen.queryByTestId('guide-draft-note')).toBeNull();
        const englishDiv = document.querySelector('article [lang="en"]');
        expect(englishDiv).not.toBeNull();

        // Toggle back to Portuguese
        fireEvent.click(toggle);
        expect(toggle).toHaveTextContent('Read in English');
        expect(screen.getByText('Corpo traduzido antigo na web.')).toBeInTheDocument();
        expect(screen.getByTestId('guide-draft-note')).toHaveTextContent('Translated by machine: some words may be wrong.');
    });

    it('missing state: untranslated page renders English body with english note', async () => {
        const ptGuide: Guide = {
            schema: getBundledGuide().schema,
            version: 1,
            language: 'pt',
            hash: '1234567890abcdef',
            sections: [{ id: section.id, title: 'Secção traduzida', summary: 'Resumo.', slugs: [page.slug] }],
            guides: [{
                slug: page.slug,
                title: 'Página traduzida',
                summary: 'Resumo da página.',
                section: section.id,
                related: [],
                sourceHash: currentHash,
                blocks: [{ type: 'p', text: 'Corpo traduzido atual na web.' }],
            }],
        };
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(ptGuide) })));
        await act(async () => { await showLanguage('pt'); });
        render(<MemberGuide onBack={() => {}} feedbackLive={false} initialPage={related.slug} />);
        expect(screen.getByTestId('guide-english-note')).toHaveTextContent('This page is in English for now.');
        expect(screen.queryByTestId('guide-newer-note')).toBeNull();
        expect(screen.queryByTestId('guide-draft-note')).toBeNull();
        expect(document.querySelector('article [lang="en"]')).not.toBeNull();
    });

    it('offline fallback: fetch failure falls back to cached guide or English without error', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
        const ptGuide: Guide = {
            schema: getBundledGuide().schema,
            version: 1,
            language: 'pt',
            hash: '1234567890abcdef',
            sections: [{ id: section.id, title: 'Secção traduzida', summary: 'Resumo.', slugs: [page.slug] }],
            guides: [{
                slug: page.slug,
                title: 'Página traduzida em cache',
                summary: 'Resumo da página.',
                section: section.id,
                related: [],
                sourceHash: currentHash,
                blocks: [{ type: 'p', text: 'Corpo em cache offline na web.' }],
            }],
        };
        localStorage.setItem(guideCacheKey('pt'), JSON.stringify(ptGuide));
        await act(async () => { await showLanguage('pt'); });
        render(<MemberGuide onBack={() => {}} feedbackLive={false} initialPage={page.slug} />);
        await waitFor(() => {
            expect(screen.getByText('Corpo em cache offline na web.')).toBeInTheDocument();
        });
        expect(screen.queryByTestId('guide-english-note')).toBeNull();
        expect(screen.getByTestId('guide-draft-note')).toHaveTextContent('Translated by machine: some words may be wrong.');
    });

    it('English page has no draft line', async () => {
        await act(async () => { await showLanguage('en'); });
        render(<MemberGuide onBack={() => {}} feedbackLive={false} initialPage={page.slug} />);
        expect(screen.queryByTestId('guide-draft-note')).toBeNull();
    });

    it('a language whose catalogs are not machine draft has no draft line', async () => {
        await act(async () => { await showLanguage('pt'); });
        setLanguage('pt', [{ _meta: { language: 'pt', review: 'human', reviewed: true } }]);
        const ptGuide: Guide = {
            schema: getBundledGuide().schema,
            version: 1,
            language: 'pt',
            hash: '1234567890abcdef',
            sections: [{ id: section.id, title: 'Secção traduzida', summary: 'Resumo.', slugs: [page.slug] }],
            guides: [{
                slug: page.slug,
                title: 'Página traduzida',
                summary: 'Resumo da página.',
                section: section.id,
                related: [],
                sourceHash: currentHash,
                blocks: [{ type: 'p', text: 'Corpo traduzido humano na web.' }],
            }],
        };
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(ptGuide) })));
        render(<MemberGuide onBack={() => {}} feedbackLive={false} initialPage={page.slug} />);
        await waitFor(() => {
            expect(screen.getByText('Corpo traduzido humano na web.')).toBeInTheDocument();
        });
        expect(screen.queryByTestId('guide-draft-note')).toBeNull();
    });

    it('xx pseudo-locale render of a page with the new line at 320 px × 1.3', async () => {
        const xxGuide: Guide = {
            schema: getBundledGuide().schema,
            version: 1,
            language: 'xx',
            hash: '1234567890abcdef',
            sections: [{ id: section.id, title: 'Section', summary: 'Summary', slugs: [page.slug] }],
            guides: [{
                slug: page.slug,
                title: page.title,
                summary: page.summary,
                section: section.id,
                related: [],
                sourceHash: staleHash,
                blocks: [{ type: 'p', text: 'Corpo em pseudo na web.' }],
            }],
        };
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => JSON.stringify(xxGuide) })));
        await act(async () => { await showLanguage('xx'); });
        const { container } = render(
            <div style={{ width: 320, fontSize: '130%' }}>
                <MemberGuide onBack={() => {}} feedbackLive={false} initialPage={page.slug} />
            </div>
        );
        await waitFor(() => {
            expect(screen.getByTestId('guide-newer-note')).toHaveTextContent(pseudoLocalise('This page is newer in English.'));
        });
        expect(screen.queryByTestId('guide-draft-note')).toBeNull();
        const toggle = screen.getByTestId('guide-toggle-english');
        expect(toggle).toHaveTextContent(pseudoLocalise('Read in English'));
        expect(container).toBeInTheDocument();

        // Toggle to English in pseudo-locale
        fireEvent.click(toggle);
        expect(toggle).toHaveTextContent(pseudoLocalise('Show translation'));
        expect(document.querySelector('article [lang="en"]')).not.toBeNull();
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
