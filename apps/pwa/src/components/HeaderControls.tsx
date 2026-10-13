import { openHelp } from '../lib/tour-store';

/** The pill's width: profile, the "?" and Settings (72 px before the "?"). */
export const HEADER_PILL_PX = 100;
/** The sync dot's box on the header's left. */
export const HEADER_SYNC_PX = 26;
/**
 * The header's title sits in the middle of the room between the sync dot and the pill, not of the screen: at 320 px
 * with 130% text, centred on the screen it ran under the wider pill (measured: "Commons" by 24 px).
 */
export const HEADER_TITLE_SHIFT_PX = -(HEADER_PILL_PX - HEADER_SYNC_PX) / 2;

/** The "?" (DESIGN-getting-started-fable.md §4–§5): help for the screen you're on, in the pill and the sidebar. */
export function HelpIcon({ className }: { className: string }) {
    return (
        <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z" />
        </svg>
    );
}

/** The mobile header's pill: your profile, the "?" and Settings (its own file so its fit at 320 px can be measured alone). */
export function HeaderControls({ showSettings, setShowSettings, identityPubkey, onOpenProfile }: { showSettings: boolean, setShowSettings: (v: boolean) => void, identityPubkey?: string, onOpenProfile: (pk: string) => void }) {
    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            padding: '0.3rem 0.6rem',
            borderRadius: '9999px',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-secondary)',
            height: '26px', // Geometric balance with SyncStatus
            width: `${HEADER_PILL_PX}px`,
            justifyContent: 'center',
        }}>
            <button
                onClick={() => identityPubkey && onOpenProfile(identityPubkey)}
                aria-label="My profile"
                title="My profile"
                className="text-nature-600 dark:text-nature-400 hover:text-nature-900 dark:hover:text-nature-200 transition-colors flex items-center justify-center p-0"
            >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17.982 18.725A7.488 7.488 0 0 0 12 15.75a7.488 7.488 0 0 0-5.982 2.975m11.963 0a9 9 0 1 0-11.963 0m11.963 0A8.966 8.966 0 0 1 12 21a8.966 8.966 0 0 1-5.982-2.275M15 9.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                </svg>
            </button>

            <div className="w-[1px] h-[12px] bg-nature-200 dark:bg-nature-700 mx-[1px]" />

            <button
                onClick={openHelp}
                aria-label="Help for this screen"
                title="Help for this screen"
                data-testid="header-help"
                className="text-nature-600 dark:text-nature-400 hover:text-nature-900 dark:hover:text-nature-200 transition-colors flex items-center justify-center p-0"
            >
                <HelpIcon className="w-4 h-4" />
            </button>

            <div className="w-[1px] h-[12px] bg-nature-200 dark:bg-nature-700 mx-[1px]" />

            <button
                onClick={() => setShowSettings(!showSettings)}
                aria-label="Settings"
                aria-pressed={showSettings}
                title="Settings"
                className={`flex items-center justify-center transition-colors p-0 ${
                    showSettings 
                        ? 'text-accent dark:text-accent' 
                        : 'text-nature-600 dark:text-nature-400 hover:text-nature-900 dark:hover:text-nature-200'
                }`}
            >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 11-3 0m3 0a1.5 1.5 0 10-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 01-3 0m3 0a1.5 1.5 0 00-3 0m-9.75 0h9.75" />
                </svg>
            </button>
        </div>
    );
}
