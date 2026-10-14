/**
 * The header's profile, "?" and Settings are gold from the shared library (Marty, 14 Oct 2026, of the pill over the header
 * photo: "these either need to be bigger or a different colour or both" … "maybe gold"): the gold fill as 24 px icons on a
 * charcoal pill drawn above the header's dimming layer, in 44 px tall targets; Settings open is the gold disc with a
 * charcoal icon. The sidebar's "?" and Settings take the library's gold for icons on a page, and the lobby's "?" the pill's
 * gold on a charcoal disc. Measured on the real photo at 320 px with 130% text: e2e/tour-check.mjs and the PR's renders.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { brandTailwindColours } from '@beanpool/core/brand-colours';
import { HeaderControls, SidebarControls } from './HeaderControls';
import { LobbyHeader } from './LobbyHeader';

afterEach(cleanup);

const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
const pill = (showSettings: boolean) => render(<HeaderControls showSettings={showSettings} setShowSettings={() => {}} identityPubkey="ab" onOpenProfile={() => {}} />);
const pillButtons = () => [screen.getByTestId('header-profile'), screen.getByTestId('header-help'), screen.getByTestId('header-settings')];

describe('the header pill', () => {
    it('is charcoal, above the dimming layer, with the three controls gold 24 px icons in 44 px tall targets', () => {
        pill(false);
        const p = screen.getByTestId('header-pill');
        expect(classes(p)).toEqual(expect.arrayContaining(['bg-bp-gold-on', 'relative', 'z-[5]']));
        expect(p.style.width).toBe('100px'); // the layout around it is unchanged (HEADER_PILL_PX)
        for (const b of pillButtons()) {
            expect(classes(b)).toEqual(expect.arrayContaining(['text-bp-gold-fill', 'hover:text-bp-gold-hover', 'h-[44px]']));
            expect(classes(b).filter(c => /^text-(nature|accent)/.test(c) || /^dark:text-/.test(c))).toEqual([]);
            expect(classes(b.querySelector('svg')!)).toEqual(expect.arrayContaining(['w-[24px]', 'h-[24px]']));
        }
        expect(screen.getByTestId('header-settings').getAttribute('aria-pressed')).toBe('false');
        expect(screen.getByTestId('header-settings').querySelector('.bg-bp-gold-fill')).toBeNull();
    });

    it('shows Settings open as the gold disc with a charcoal icon, and the other two stay gold', () => {
        pill(true);
        const settings = screen.getByTestId('header-settings');
        expect(settings.getAttribute('aria-pressed')).toBe('true');
        const disc = settings.querySelector('span')!;
        expect(classes(disc)).toEqual(expect.arrayContaining(['bg-bp-gold-fill', 'text-bp-gold-on', 'rounded-full']));
        expect(classes(settings)).toContain('text-bp-gold-on');
        expect(classes(settings)).not.toContain('text-bp-gold-fill');
        for (const b of pillButtons().slice(0, 2)) expect(classes(b)).toContain('text-bp-gold-fill');
    });
});

describe('the sidebar controls', () => {
    it('are the library gold for icons on a page, 24 px in 44 px targets; Settings open is the gold fill with charcoal', () => {
        const { rerender } = render(<SidebarControls showSettings={false} setShowSettings={() => {}} />);
        for (const id of ['sidebar-help', 'sidebar-settings']) {
            const b = screen.getByTestId(id);
            expect(classes(b)).toEqual(expect.arrayContaining(['text-bp-ink-warning', 'min-w-[44px]', 'min-h-[44px]']));
            expect(classes(b.querySelector('svg')!)).toEqual(expect.arrayContaining(['w-6', 'h-6']));
        }
        rerender(<SidebarControls showSettings setShowSettings={() => {}} />);
        const settings = screen.getByTestId('sidebar-settings');
        expect(settings.getAttribute('aria-pressed')).toBe('true');
        expect(classes(settings)).toEqual(expect.arrayContaining(['bg-bp-gold-fill', 'text-bp-gold-on']));
        expect(classes(screen.getByTestId('sidebar-help'))).toContain('text-bp-ink-warning');
    });
});

describe("the lobby's ?", () => {
    it('is the pill gold on a charcoal disc, and nothing clears the disc', () => {
        render(<LobbyHeader tab="home" title="Market" onHelp={() => {}} onJoin={() => {}} joinDisabled={false} />);
        const help = screen.getByTestId('lobby-help');
        expect(classes(help)).toEqual(expect.arrayContaining(['bg-bp-gold-on', 'bg-clip-content', 'text-bp-gold-fill', 'min-w-[44px]', 'min-h-[44px]']));
        // LobbyHelpButton's own bg-transparent came later in the stylesheet and hid the disc.
        expect(classes(help)).not.toContain('bg-transparent');
    });
});

describe('the colours come from the library', () => {
    it('names roles the Tailwind config really has', () => {
        const bp = brandTailwindColours().bp;
        for (const role of ['gold-fill', 'gold-hover', 'gold-on', 'ink-warning']) expect(bp[role]).toMatch(/^var\(--bp-/);
    });

    it('paints these controls with no hex, rgb, raw ink or raw gold fill (a neutral hover tint is fine)', () => {
        render(<>
            <HeaderControls showSettings setShowSettings={() => {}} identityPubkey="ab" onOpenProfile={() => {}} />
            <SidebarControls showSettings setShowSettings={() => {}} />
            <LobbyHeader tab="home" title="Market" onHelp={() => {}} onJoin={() => {}} joinDisabled={false} />
        </>);
        const controls = [screen.getByTestId('header-pill'), ...pillButtons(), screen.getByTestId('sidebar-help'), screen.getByTestId('sidebar-settings'), screen.getByTestId('lobby-help')];
        const painted = controls.flatMap(el => [el, ...el.querySelectorAll('*')]).flatMap(el => [...classes(el), el.getAttribute('style') ?? '']);
        expect(painted.filter(c => /#[0-9a-fA-F]{3,8}\b|rgba?\(|^(?:dark:|hover:)?text-(?:amber|yellow|orange|nature|accent|white)\b|^(?:dark:|hover:)?bg-(?:amber|yellow|orange)\b/.test(c))).toEqual([]);
    });
});
