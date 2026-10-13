/**
 * The "?" in the top bar (scratch/global-node/DESIGN-getting-started-fable.md §4): which guide page or section explains
 * the screen a member is on, and what its sheet says. One table, screen key → page slug or section id; the words are the
 * page's own `help:` line (one or two sentences written for "you are here"), bundled with the guide in both apps so they
 * work offline. Fallbacks, in order: `help` → the page's summary → the section's summary → a sheet with only Search and
 * the tour. The "?" is never dead and never says "no help here".
 *
 * Pure: no I/O and no Node built-ins (the barrel is bundled for the phone).
 */
import { findGuidePage, findGuideSection, type Guide, type GuidePage } from './member-guide.js';

/** Where a screen's help is: a guide page by slug, or a section by id (a tab with no overview page). */
export type HelpTarget = { slug: string } | { section: string };

/**
 * Every screen with a "?", by key: the phone's tab (and a tab's sub-view, as `tab/view`), the web app's tab, Settings
 * and its screens, and the web lobby's tabs (`lobby/…`).
 */
export const HELP_MAP: Readonly<Record<string, HelpTarget>> = {
    home: { slug: 'home' },
    market: { slug: 'browsing-the-market' },
    'market/deals': { slug: 'my-deals' },
    'market/polls': { slug: 'polls' },
    map: { slug: 'map-pins' },
    talk: { slug: 'messages' },
    'talk/groups': { slug: 'groups' },
    'talk/people': { slug: 'people' },
    commons: { section: 'commons' },
    ledger: { slug: 'your-balance' },
    pulse: { slug: 'the-pulse' },
    people: { slug: 'people' },
    settings: { section: 'settings' },
    'settings/your-area': { slug: 'your-area' },
    'settings/notifications': { slug: 'notifications' },
    'settings/appearance': { slug: 'appearance' },
    'settings/privacy': { slug: 'privacy' },
    'settings/blocking': { slug: 'blocking' },
    'settings/recovery': { slug: 'recovery' },
    'lobby/home': { slug: 'home' },
    'lobby/market': { slug: 'browsing-the-market' },
    'lobby/map': { slug: 'map-pins' },
    'lobby/join': { slug: 'joining' },
};

/** The longest a page's `help:` line may be (the sheet's body at 320 dp). */
export const HELP_LINE_MAX_CHARS = 160;

/**
 * The screen key for a phone path (`usePathname()`), with an optional sub-view a tab screen set (`setHelpContext`):
 * `/market` → `market`, `/` → `home`, `/chats` + `groups` → `talk/groups`. A path with no "?" of its own is Home's.
 */
export function phoneHelpKey(pathname: string, view?: string | null): string {
    const first = pathname.replace(/^\/+/, '').replace(/^\(tabs\)\/?/, '').split('/')[0] ?? '';
    const tab = first === '' || first === 'index' ? 'home' : first === 'chats' ? 'talk' : first === 'projects' ? 'commons' : first;
    const key = view ? `${tab}/${view}` : tab;
    if (HELP_MAP[key]) return key;
    return HELP_MAP[tab] ? tab : 'home';
}

/**
 * The screen key for the web app: the tab (`marketplace` → `market`, `messages` → `talk`, `projects` → `commons`), or
 * Settings (and its screen) while it is open, or the lobby's tab for a visitor.
 */
export function webHelpKey(state: { tab: string; settings?: boolean; settingsView?: string | null; lobby?: boolean }): string {
    if (state.settings) {
        const sub = state.settingsView ? `settings/${state.settingsView}` : 'settings';
        return HELP_MAP[sub] ? sub : 'settings';
    }
    const tab = state.tab === 'marketplace' ? 'market' : state.tab === 'messages' ? 'talk' : state.tab === 'projects' ? 'commons' : state.tab;
    if (state.lobby) {
        const key = `lobby/${tab}`;
        return HELP_MAP[key] ? key : 'lobby/home';
    }
    return HELP_MAP[tab] ? tab : 'home';
}

/** What the sheet shows for a screen. `slug` for Read the guide page, `section` for a section's front; both absent: Search and the tour only. */
export interface HelpSheet {
    title: string | null;
    text: string | null;
    slug: string | null;
    section: string | null;
}

/**
 * The sheet for a screen key from the bundled guide: the page's title and `help:` line, else its summary; for a section,
 * its title and summary. A key not in the map, or a page or section the guide doesn't have: no words, Search and the
 * tour only.
 */
export function helpSheetFor(guide: Guide<GuidePage> | null | undefined, key: string): HelpSheet {
    const none: HelpSheet = { title: null, text: null, slug: null, section: null };
    const target = HELP_MAP[key];
    if (!target || !guide) return none;
    if ('slug' in target) {
        const page = findGuidePage(guide, target.slug);
        if (page) return { title: page.title, text: page.help ?? page.summary, slug: page.slug, section: page.section };
        return none;
    }
    const section = findGuideSection(guide, target.section);
    return section ? { title: section.title, text: section.summary, slug: null, section: section.id } : none;
}

/** Every page slug and section id the map names: the guide must have each, with a `help:` line on each page. */
export function helpTargets(): { slugs: string[]; sections: string[] } {
    const slugs = new Set<string>();
    const sections = new Set<string>();
    for (const t of Object.values(HELP_MAP)) {
        if ('slug' in t) slugs.add(t.slug);
        else sections.add(t.section);
    }
    return { slugs: [...slugs], sections: [...sections] };
}
