/**
 * App.tsx's mobile header row and its side bar's status rows, in their own file so e2e/header-alerts-harness.tsx draws the
 * very rows the app does, and can change the tab and the needs on one mounted header as the app does (PR #2478's deciding
 * review measured a copy of App's row, and a copy drifts).
 */
import type { ReactNode } from 'react';
import { t } from '@beanpool/core';
import { SyncStatus } from './SyncStatus';
import { HeaderControls, HeaderTitle, SidebarControls, useDotOnlyChip } from './HeaderControls';
import { NeedsYouIcons } from './NeedsYouIcons';

/**
 * The header under 768 px (md:hidden): the sync chip, the tab's name with the needs-you icons beside it (HeaderTitle and
 * its `end`), and the pill. On the map (`title` null) the community's logo is drawn over the middle, and the icons stop
 * short of it. One NeedsYouIcons for every tab, so a change of tab never takes down what measures their room.
 */
export function MobileHeader({
    activeTab, showSettings, title, isGuest, identityPubkey, displayVersion, communityStatus, onTitleClick,
    settingsSeen, setShowSettings, onOpenProfile, onNavigate,
}: {
    activeTab: string;
    /** Settings is drawn over the tab (the map's row is then an ordinary one, with Settings' tab's name). */
    showSettings: boolean;
    /** The tab's name; null on the map, which shows the community's logo. */
    title: string | null;
    isGuest: boolean | null;
    identityPubkey?: string;
    displayVersion: string;
    /** What opens under the title, or under the logo on the map (the community's status). */
    communityStatus: ReactNode;
    onTitleClick: () => void;
    /** Whether the pill's Settings shows as open. */
    settingsSeen: boolean;
    setShowSettings: (v: boolean) => void;
    onOpenProfile: (pubkey: string) => void;
    onNavigate: (tab: string, ctxId?: string, txId?: string) => void;
}) {
    // The sync chip as its dot alone where the title wouldn't fit beside the chip's words.
    const [headerRef, chipDotOnly] = useDotOnlyChip(title);
    const overMap = activeTab === 'map' && !showSettings;
    return (
        <header ref={headerRef} className="relative shadow-md md:hidden" style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '0.3rem 0.75rem',
            borderBottom: overMap ? 'none' : '1px solid #111',
            position: overMap ? 'absolute' : 'sticky',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 100,
            backgroundImage: "url('/assets/neon-vines-banner.png')",
            backgroundSize: '150% auto',
            backgroundPosition: 'center',
        }}>
            <div className="absolute inset-0 bg-black/10 dark:bg-black/50 pointer-events-none" />

            <div className="relative z-10 shrink-0" style={{ marginTop: '12px' }}>
                <SyncStatus isMember={!isGuest} stacked dotOnly={chipDotOnly} />
            </div>

            {/* The tab's own name, as the lobby's, in the room between the chip and the pill (never under either), and the
                needs-you icons in what it leaves. */}
            <HeaderTitle
                title={title}
                onClick={onTitleClick}
                end={<NeedsYouIcons identityPubkey={identityPubkey} onNavigate={onNavigate} activeTab={activeTab} besideLogo={title === null} />}
            >
                {communityStatus}
            </HeaderTitle>
            {title === null && (
                <div data-testid="header-logo" className="absolute left-1/2 -translate-x-1/2 flex justify-center items-center z-10">
                    <div
                        className="relative flex items-center gap-1.5 pointer-events-auto cursor-pointer"
                        style={{ transform: 'translateX(-12px) translateY(-2px)' }}
                        onClick={onTitleClick}
                    >
                        <img src="/bean.png" alt={t('BeanPool Icon')} style={{ width: '40px', height: '40px', objectFit: 'contain' }} className="drop-shadow-sm" />
                        <span className="font-extrabold text-[1.6rem] tracking-tight text-rainbow drop-shadow-[0_2px_4px_rgba(0,0,0,0.9)]">{t('BeanPool')}</span>
                        <span
                            className="absolute -right-6 bottom-0.5 text-[10px] font-bold text-amber-500 tracking-wider whitespace-nowrap"
                            aria-label={t('Version {version}', { version: displayVersion })}
                        >{t('v{version}', { version: displayVersion })}</span>
                    </div>
                    {communityStatus}
                </div>
            )}

            <HeaderControls
                showSettings={settingsSeen}
                setShowSettings={setShowSettings}
                identityPubkey={identityPubkey}
                onOpenProfile={onOpenProfile}
            />
        </header>
    );
}

/**
 * The side bar's status (768 px and up): the needs-you icons on a row of their own, then the connection status with the
 * "?" and Settings. The side bar is 256 px: its row holds the status and those two, and a row of icons beside them pushed
 * Settings off it, so they don't share it.
 */
export function SidebarStatus({ isGuest, identityPubkey, activeTab, onNavigate, settingsSeen, setShowSettings }: {
    isGuest: boolean | null;
    identityPubkey?: string;
    activeTab: string;
    onNavigate: (tab: string, ctxId?: string, txId?: string) => void;
    settingsSeen: boolean;
    setShowSettings: (v: boolean) => void;
}) {
    return (
        <>
            <NeedsYouIcons identityPubkey={identityPubkey} onNavigate={onNavigate} activeTab={activeTab} variant="sidebar" />
            <div className="flex items-center justify-between px-2 py-1">
                <SyncStatus isMember={!isGuest} />
                <SidebarControls showSettings={settingsSeen} setShowSettings={setShowSettings} />
            </div>
        </>
    );
}
