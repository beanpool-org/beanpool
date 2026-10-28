/**
 * The screens of web sweep W3 (settings, profiles, onboarding, the app shell), one per `?screen=`, drawn by the app's own
 * components and stylesheet in the language of `?lang=` (the pseudo-locale for the 320 px check). Served by Vite's dev
 * server for e2e/words-w3-screens-check.mjs, which answers /api itself; nothing here talks to a node.
 */
import '../../src/index.css';
import { useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { defaultHomeLayout, setLanguage, starterCards, tourSteps, type UiLang } from '@beanpool/core';
import { showLanguage } from '../../src/lib/language';
import { createIdentity, type BeanPoolIdentity } from '../../src/lib/identity';
import { SettingsPage } from '../../src/pages/SettingsPage';
import { PublicProfilePage } from '../../src/pages/PublicProfilePage';
import { ProfilePage } from '../../src/pages/ProfilePage';
import { GuestLobby } from '../../src/pages/GuestLobby';
import { ProfileSetup } from '../../src/components/ProfileSetup';
import { ArchetypeQuizModal } from '../../src/components/ArchetypeQuizModal';
import { AddCardDialog, CardSettingsDialog } from '../../src/components/AddCardDialog';
import { EditHomeDialog } from '../../src/components/EditHomeDialog';
import { HomeCard } from '../../src/components/HomeCard';
import { TourBar } from '../../src/components/TourBar';
import { DesktopInstallSteps } from '../../src/components/InstallPrompt';
import { NewAccountCard } from '../../src/components/NewAccountCard';
import { StartCommunityScreen } from '../../src/components/StartCommunityScreen';
import { SuggestChangeForm } from '../../src/components/SuggestChangeForm';
import { RadiusPickerPage } from '../../src/components/RadiusPickerPage';
import { OnboardingGuide } from '../../src/components/OnboardingGuide';
import { cardLabelName, cardName, cardRowName, pickerGroups } from '../../src/lib/home-layout';
import { App } from '../../src/App';

const WORDS = ['abandon', 'ability', 'able', 'about', 'above', 'absent', 'absorb', 'abstract', 'absurd', 'abuse', 'access', 'accident'];
export const ME = { publicKey: 'me-pk-0000000000000000000000000000', privateKey: '', callsign: 'Alice', mnemonic: WORDS } as unknown as BeanPoolIdentity;
export const PEER = 'peer-pk-000000000000000000000000000';
const LOCAL = { profile: 'local', features: { beans: true, escrow: true, enterprises: true, invites: true, decisions: true } };
const LAYOUT = {
    ...defaultHomeLayout(),
    cards: [...starterCards(), { id: 'search-aaaa', type: 'search', settings: { q: 'eggs and honey from the valley', kind: 'need' } }, { id: 'search-bbbb', type: 'search', settings: { q: 'jam' } }],
};
const noop = () => {};

/** A screen at the width of the phone, in the page's own padding, as the app draws its pages. */
const Page = ({ children }: { children: ReactNode }) => <div className="min-h-screen bg-white dark:bg-nature-950">{children}</div>;

function Quiz() {
    const [open] = useState(true);
    return <ArchetypeQuizModal visible={open} onClose={noop} onComplete={async () => {}} />;
}

const SCREENS: Record<string, () => ReactNode> = {
    'settings': () => <SettingsPage identity={ME} onIdentityUpdated={noop} onBack={noop} themePreference="light" onThemePreferenceChange={noop} onReRunSetup={noop} nodeVersion="1.2.29" />,
    'settings-seed': () => <SettingsPage identity={ME} onIdentityUpdated={noop} onBack={noop} themePreference="light" onThemePreferenceChange={noop} initialMode="seed" />,
    'settings-diagnostics': () => <SettingsPage identity={ME} onIdentityUpdated={noop} onBack={noop} themePreference="light" onThemePreferenceChange={noop} initialMode="diagnostics" />,
    'settings-notifications': () => <SettingsPage identity={ME} onIdentityUpdated={noop} onBack={noop} themePreference="light" onThemePreferenceChange={noop} initialMode="notifications" />,
    'settings-blocked': () => <SettingsPage identity={ME} onIdentityUpdated={noop} onBack={noop} themePreference="light" onThemePreferenceChange={noop} initialMode="blocked-users" />,
    'settings-advanced': () => <SettingsPage identity={ME} onIdentityUpdated={noop} onBack={noop} themePreference="light" onThemePreferenceChange={noop} initialMode="advanced" />,
    'settings-suggest': () => <SettingsPage identity={ME} onIdentityUpdated={noop} onBack={noop} themePreference="light" onThemePreferenceChange={noop} initialMode="suggest" />,
    'settings-guide': () => <SettingsPage identity={ME} onIdentityUpdated={noop} onBack={noop} themePreference="light" onThemePreferenceChange={noop} initialMode="guide" />,
    'profile-peer': () => <PublicProfilePage identity={ME} pubkey={PEER} onBack={noop} onMessage={noop} onNavigatePost={noop} />,
    'profile-self': () => <PublicProfilePage identity={ME} pubkey={ME.publicKey} onBack={noop} onMessage={noop} onNavigatePost={noop} onEditProfile={noop} onNavigateTab={noop} />,
    'profile-edit': () => <Page><ProfilePage identity={ME} onBack={noop} /></Page>,
    'profile-setup': () => <ProfileSetup identity={{ ...ME, callsign: 'A' }} onDone={noop} />,
    'onboarding-guide': () => <Page><div className="p-6"><OnboardingGuide /></div></Page>,
    'quiz': () => <Quiz />,
    'add-card': () => <AddCardDialog groups={pickerGroups(LOCAL, LAYOUT, 'admin').groups} full={false} onAdd={noop} onClose={noop} />,
    'card-settings': () => <CardSettingsDialog type="search" name={cardName('search')} mode="add" hasPoint onSubmit={noop} onClose={noop} />,
    'edit-home': () => <EditHomeDialog rows={LAYOUT.cards.map((c) => ({ id: c.id, name: cardRowName(c), label: cardLabelName(c), hasSettings: c.type === 'search' }))} notOnAccount
        onAdd={noop} onMove={noop} onSettings={noop} onRemove={noop} onReset={noop} onClose={noop} />,
    'home-card': () => <Page><div className="p-4"><HomeCard id="events" title={cardName('events')} menu={{ label: cardName('events'), canMoveUp: true, canMoveDown: true, onRemove: noop, onSettings: noop, onMove: noop }}><p className="m-0 text-sm">·</p></HomeCard></div></Page>,
    'tour': () => {
        const steps = tourSteps('web', { global: false, beans: true });
        return <TourBar steps={steps} index={steps.length - 1} home={{ chips: ['steps', 'market', 'beans'], chipName: (c) => cardName(c), onHome: (c) => c === 'market', addChip: noop, moreCards: noop }} onNext={noop} onSkip={noop} onDone={noop} />;
    },
    'tour-step': () => <TourBar steps={tourSteps('web', { global: false, beans: true })} index={1} home={null} onNext={noop} onSkip={noop} onDone={noop} />,
    'install': () => <Page><div className="p-4"><DesktopInstallSteps /></div></Page>,
    'new-account': () => <Page><div className="p-4"><NewAccountCard onClose={noop} /></div></Page>,
    'start-community': () => <StartCommunityScreen onClose={noop} onNearYou={noop} />,
    'suggest': () => <Page><div className="p-4"><SuggestChangeForm appVersion="1.2.29" onDone={noop} /></div></Page>,
    'radius': () => <RadiusPickerPage initial={{ lat: -28.6, lng: 153.5, radiusKm: 50, label: '50km radius' }} onApply={noop} onCancel={noop} onReset={noop} />,
    'lobby': () => <GuestLobby info={{ memberCount: 3, postCount: 0, transactionCount: 0, commonsBalance: 0, profile: 'global', features: { openJoin: true, guestListingsOnly: true, beans: false } } as never} onComplete={noop} />,
    'shell': () => <App />,
};

async function main() {
    const params = new URLSearchParams(location.search);
    const name = params.get('screen') ?? 'settings';
    const lang = (params.get('lang') ?? 'xx') as UiLang;
    await showLanguage(lang);
    // `words=phone`: the phone's catalog for this language, whose tab words (word(…, 'tab')) are already translated in
    // every language and are the same keys the web's tabs use, so the tabs measure as they will read.
    if (params.get('words') === 'phone' && lang !== 'xx' && lang !== 'en') {
        const phone = await import(`../../../native/words/${lang}.json`);
        setLanguage(lang, [phone.default]);
    }
    // The app shell is a member's: an account in this browser, as after a join.
    if (name === 'shell') await createIdentity('Alice').catch(() => {});
    const draw = SCREENS[name];
    const root = document.getElementById('root')!;
    if (!draw) { root.textContent = `No screen ${name}`; return; }
    createRoot(root).render(draw());
    document.body.dataset.ready = 'true';
}

void main();
