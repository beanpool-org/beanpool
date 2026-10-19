/**
 * The rest of web sweep W3 in the pseudo-locale (`xx`: every sentence accented, padded ~35 % and bracketed): Home's card
 * menu, Add a card and a card's settings, Edit home, the tour bar, the new-account card, "Posting paused", Start a
 * community, Suggest a change, the radius picker, the install prompt, the header pill, the Commons preview's own
 * lines, and the guest lobby's Join card and tabs. Any text, label, title, placeholder or alert with letters outside a
 * bracket bypassed t().
 *
 * Shown as written: what members wrote, the brand and beanpool.org, a category's name (the Market's words, sweep W1),
 * and what joining takes and why a browser can't hold a key (the join screens' words, sweep W4).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultHomeLayout, starterCards, tourSteps, type TourStep } from '@beanpool/core';
import { HomeCard } from './HomeCard';
import { AddCardDialog, CardSettingsDialog } from './AddCardDialog';
import { EditHomeDialog } from './EditHomeDialog';
import { TourBar } from './TourBar';
import { NewAccountCard } from './NewAccountCard';
import { ModerationPauseCard } from './ModerationPauseCard';
import { StartCommunityScreen } from './StartCommunityScreen';
import { SuggestChangeForm } from './SuggestChangeForm';
import { RadiusPickerPage } from './RadiusPickerPage';
import { InstallPrompt } from './InstallPrompt';
import { HeaderControls, SidebarControls } from './HeaderControls';
import { CommonsPreview } from './ShowcasePreviews';
import { GuestLobby } from '../pages/GuestLobby';
import { cardLabelName, cardName, cardRowName, pickerGroups } from '../lib/home-layout';
import { MARKETPLACE_CATEGORIES } from '../lib/marketplace';
import { joinTakes, keyProblemSentence } from './WebJoin';
import { resetCommunityInfoOnce } from '../lib/visitor-lobby-gate';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import * as api from '../lib/api';
import { backToEnglish, bracketed, showIn, xx } from '../words-xx.test-support';
import { AS_WRITTEN, bypassing } from '../words-w3.test-support';

vi.mock('leaflet', () => {
    const layer = () => ({ addTo: vi.fn().mockReturnThis(), setLatLng: vi.fn(), on: vi.fn(), setRadius: vi.fn(), getBounds: vi.fn(() => ({})), getLatLng: vi.fn(() => ({ lat: 0, lng: 0 })) });
    return {
        default: {
            map: vi.fn(() => ({ setView: vi.fn(), fitBounds: vi.fn(), on: vi.fn(), off: vi.fn(), remove: vi.fn(), getZoom: vi.fn(() => 13), invalidateSize: vi.fn() })),
            tileLayer: vi.fn(() => ({ addTo: vi.fn() })),
            marker: vi.fn(layer), circle: vi.fn(layer), divIcon: vi.fn((o) => o),
        },
    };
});
vi.mock('leaflet/dist/leaflet.css', () => ({}));
vi.mock('../lib/sync', () => ({
    connectToAnchor: vi.fn(), reconnectToAnchor: vi.fn(),
    onSyncActivity: vi.fn(() => () => {}), onSyncChange: vi.fn(() => () => {}), onSystemAnnouncement: vi.fn(() => () => {}), onSocketOpen: vi.fn(() => () => {}),
    getSyncState: vi.fn(() => ({ connected: false, lastSyncTime: null, merkleRoot: null, accountCount: 0 })),
}));
vi.mock('../lib/api', async () => {
    const actual = await vi.importActual('../lib/api');
    return { ...actual, getCommunityMe: vi.fn(async () => null) };
});

const CATEGORY_NAMES = MARKETPLACE_CATEGORIES.map((c) => `${c.emoji} ${c.label}`);
const unwrapped = (root: ParentNode = document.body, others: string[] = []) => bypassing(root, { others: [...AS_WRITTEN, ...others] });
const LOCAL = { profile: 'local', features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true } };
const TWO_SEARCHES = {
    ...defaultHomeLayout(),
    cards: [...starterCards(), { id: 'search-aaaa', type: 'search', settings: { q: 'eggs', kind: 'need' } }, { id: 'search-bbbb', type: 'search', settings: { q: 'jam' } }],
};

beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ profile: 'local', features: {} }), { status: 200 })));
    resetCommunityInfoOnce();
});
afterEach(() => {
    cleanup();
    backToEnglish();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('Home\'s card menu, Add a card, a card\'s settings and Edit home in the pseudo-locale (words W3)', () => {
    it('a card\'s "…" and its items, named by the card in the member\'s language', async () => {
        await showIn('xx');
        render(<HomeCard id="events" title={cardName('events')} menu={{ label: cardName('events'), canMoveUp: true, canMoveDown: false, onRemove: () => {}, onSettings: () => {}, onMove: () => {} }}><p>{'·'}</p></HomeCard>);
        fireEvent.click(screen.getByRole('button', { name: xx('Card options for {card}').replace('{card}', xx('Coming up')) }));
        expect(screen.getByRole('button', { name: xx('Remove {card} from Home').replace('{card}', xx('Coming up')) })).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
    });

    it('Add a card: the groups, each type\'s name and line, Add, On Home and the count; full, its note', async () => {
        await showIn('xx');
        const { groups } = pickerGroups(LOCAL, TWO_SEARCHES, 'admin');
        render(<AddCardDialog groups={groups} full={false} onAdd={() => {}} onClose={() => {}} />);
        expect(screen.getByText(xx('For you'))).toBeInTheDocument();
        expect(screen.getByText(xx('{n} of {max} on Home').replace('{n}', '2').replace('{max}', '5'))).toBeInTheDocument();
        expect(bracketed()).toBeGreaterThan(20);
        expect(unwrapped()).toEqual([]);
        cleanup();
        render(<AddCardDialog groups={groups} full onAdd={() => {}} onClose={() => {}} />);
        expect(screen.getByTestId('home-add-note')).toHaveTextContent(xx('Home is full: remove a card to add one.'));
        expect(unwrapped()).toEqual([]);
    });

    it('a saved search\'s settings and the sun and moon card\'s, with Add to Home and Save', async () => {
        await showIn('xx');
        render(<CardSettingsDialog type="search" name={cardName('search')} mode="add" hasPoint onSubmit={() => {}} onClose={() => {}} />);
        expect(screen.getByText(xx('Words to look for'))).toBeInTheDocument();
        expect(screen.getByRole('button', { name: xx('{distance} km').replace('{distance}', '5') })).toBeInTheDocument();
        expect(unwrapped(document.body, CATEGORY_NAMES)).toEqual([]);
        cleanup();
        render(<CardSettingsDialog type="sky" name={cardName('sky')} mode="save" onSubmit={() => {}} onClose={() => {}} />);
        expect(screen.getByRole('button', { name: xx('Your area') })).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
    });

    it('Edit home: its rows by their names (a saved search by its words), the arrows, the "…", Reset and Done', async () => {
        await showIn('xx');
        const rows = TWO_SEARCHES.cards.map((c) => ({ id: c.id, name: cardRowName(c), label: cardLabelName(c), hasSettings: c.type === 'search' }));
        render(<EditHomeDialog rows={rows} notOnAccount onAdd={() => {}} onMove={() => {}} onSettings={() => {}} onRemove={() => {}} onReset={() => {}} onClose={() => {}} />);
        fireEvent.click(screen.getByTestId('home-edit-menu-search-aaaa'));
        expect(screen.getByTestId('home-edit-settings-search-aaaa')).toHaveTextContent(xx('Settings…'));
        expect(screen.getByTestId('home-edit-not-on-account')).toBeInTheDocument();
        expect(unwrapped(document.body, ['eggs', 'jam'])).toEqual([]);
    });
});

describe('the tour bar, the new-account card, "Posting paused", Start a community and Suggest a change in the pseudo-locale (words W3)', () => {
    it('the tour bar: every step\'s caption and words, Skip and Next, and the last step\'s chips', async () => {
        await showIn('xx');
        const steps: TourStep[] = tourSteps('web', { global: false, beans: true });
        const home = { chips: ['steps', 'market', 'beans'], chipName: (c: string) => cardName(c), onHome: (c: string) => c === 'market', addChip: () => {}, moreCards: () => {} };
        for (let i = 0; i < steps.length; i++) {
            render(<TourBar steps={steps} index={i} home={home} onNext={() => {}} onSkip={() => {}} onDone={() => {}} />);
            expect(screen.getByTestId('tour-step-caption')).toHaveTextContent(xx('Step {step} of {total}').replace('{step}', String(i + 1)).replace('{total}', String(steps.length)));
            expect(unwrapped()).toEqual([]);
            cleanup();
        }
    });

    it('the new-account card: each limit, what is left, when more comes back, the rule and the progress', async () => {
        const at = (ms: number) => new Date(Date.now() + ms).toISOString();
        vi.mocked(api.getCommunityMe).mockResolvedValue({
            probation: {
                onProbation: true, keptPosts: 1, keptPostsNeeded: 3, ageEndsAt: at(2 * 86_400_000), endsWhen: { hours: 72, keptPosts: 3 },
                limits: {
                    posts: { limit: 3, used: 1, remaining: 2, resetsAt: at(5 * 3_600_000) },
                    photos: { limit: 5, used: 5, remaining: 0, resetsAt: at(5 * 3_600_000) },
                    new_dm_recipients: { limit: 10, used: 0, remaining: 10, resetsAt: null },
                },
            },
        } as any);
        await showIn('xx');
        render(<NewAccountCard onClose={() => {}} />);
        expect(await screen.findByTestId('new-account-rule')).toBeInTheDocument();
        expect(screen.getByTestId('new-account-limit-photos')).toHaveTextContent(xx('You can add more {when}.').replace('{when}', xx('in about {n} hours').replace('{n}', '5')));
        expect(unwrapped()).toEqual([]);
    });

    it('"Posting paused": until a moderator lifts it, and until a time with its date and how long that is', async () => {
        vi.mocked(api.getCommunityMe).mockResolvedValue({ mute: { muted: true, until: '9999-12-31T23:59:59.999Z' } } as any);
        await showIn('xx');
        render(<ModerationPauseCard />);
        expect(await screen.findByTestId('moderation-pause-until')).toHaveTextContent(
            xx('The community’s moderators have paused your posting. You can’t post or send messages here {until}.').replace('{until}', xx('until a moderator lifts this')));
        expect(unwrapped()).toEqual([]);
        cleanup();

        vi.mocked(api.getCommunityMe).mockResolvedValue({ mute: { muted: true, until: new Date(Date.now() + 3 * 86_400_000).toISOString() } } as any);
        render(<ModerationPauseCard />);
        const line = await screen.findByTestId('moderation-pause-until');
        expect(line).toHaveTextContent(xx('in about {n} days').replace('{n}', '3'));
        expect(line).not.toHaveTextContent(xx('until a moderator lifts this'));
        expect(unwrapped()).toEqual([]);
    });

    it('Start a community: the ways, what to know, the links, the fields and the copy', async () => {
        await showIn('xx');
        render(<StartCommunityScreen onClose={() => {}} onNearYou={() => {}} />);
        expect(screen.getByText(xx('Before you start'))).toBeInTheDocument();
        expect(screen.getByPlaceholderText(xx('e.g. Riverbend'))).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
    });

    it('Suggest a change: the kinds, the fields, Send and Back', async () => {
        await showIn('xx');
        render(<SuggestChangeForm appVersion="1.2.29" onDone={() => {}} submit={async () => ({ ok: true }) as any} />);
        expect(screen.getByText(xx('What kind?'))).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
    });
});

describe('the radius picker, the install prompt, the header pill, the Commons preview and the lobby in the pseudo-locale (words W3)', () => {
    it('the radius picker: the header, the radius and its steps, the hint, Apply and Clear Filter', async () => {
        await showIn('xx');
        render(<RadiusPickerPage initial={{ lat: -28.6, lng: 153.5, radiusKm: 5, label: '5km radius' }} onApply={() => {}} onCancel={() => {}} onReset={() => {}} />);
        expect(screen.getByText(xx('Apply — {distance} radius').replace('{distance}', xx('{n}km').replace('{n}', '5')))).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
    });

    it('the install prompt, and its steps for this device', async () => {
        vi.useFakeTimers();
        window.matchMedia = vi.fn().mockImplementation((query: string) => ({ matches: false, media: query, onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() }));
        await showIn('xx');
        render(<InstallPrompt />);
        act(() => { vi.advanceTimersByTime(2000); });
        fireEvent.click(screen.getByRole('button', { name: xx('How?') }));
        expect(screen.getByRole('button', { name: xx('Hide steps') })).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
    });

    it('the header pill and the sidebar\'s controls', async () => {
        await showIn('xx');
        render(<><HeaderControls showSettings={false} setShowSettings={() => {}} identityPubkey="me" onOpenProfile={() => {}} /><SidebarControls showSettings setShowSettings={() => {}} /></>);
        expect(screen.getByRole('button', { name: xx('My profile') })).toBeInTheDocument();
        expect(unwrapped()).toEqual([]);
    });

    it('the Commons preview: the pool in Beans, How the Commons works, Pledge and Pause', async () => {
        await showIn('xx');
        render(<CommonsPreview />);
        const pool = screen.getByText(xx('Commons pool')).closest('section')!;
        expect(within(pool).getByText(xx('{n} Beans').replace('{n}', '640'))).toBeInTheDocument();
        expect(unwrapped(pool)).toEqual([]);
        expect(screen.getByText(xx('Pledge'))).toBeInTheDocument();
        expect(screen.getByText(xx('Pause'))).toBeInTheDocument();
    });

    it('the guest lobby: the Join card and the tabs, on the global community and on a local one', async () => {
        vi.stubGlobal('indexedDB', memoryIndexedDB());
        await showIn('xx');
        const info: any = { memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'global', features: { openJoin: true, guestListingsOnly: true, beans: false } };
        render(<GuestLobby info={info} onComplete={() => {}} />);
        const card = await screen.findByTestId('lobby-join-card');
        await waitFor(() => expect(within(card).getByTestId('lobby-join')).toBeEnabled());
        const others = [joinTakes(false), joinTakes(true), keyProblemSentence('old')];
        expect(unwrapped(card, others)).toEqual([]);
        expect(unwrapped(screen.getByTestId('lobby-bottom-nav'))).toEqual([]);
        cleanup();
        render(<GuestLobby info={{ ...info, profile: 'local', features: { openJoin: false, guestListingsOnly: true, beans: false } }} onComplete={() => {}} />);
        const local = await screen.findByTestId('lobby-join-card');
        expect(local).toHaveTextContent(xx('This community takes new members with an invite from one of them.'));
        expect(unwrapped(local, others)).toEqual([]);
        // Each tab: its emoji, then its name (the phone's tab words).
        expect([...screen.getByTestId('lobby-bottom-nav').querySelectorAll('button')].map((b) => b.textContent)).toEqual(['🏠Home', '🤝Market', '🗺️Map'].map((w) => w.replace(/\p{L}+$/u, (name) => xx(name))));
    });
});
