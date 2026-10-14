/** The lobby's "?" (DESIGN-getting-started-fable.md §4): the sidebar's and the mobile header's, each with its own size. */
export function LobbyHelpButton({ onClick, className }: { onClick: () => void; className: string }) {
    return (
        <button type="button" onClick={onClick} aria-label="Help for this screen" title="Help for this screen" data-testid="lobby-help"
            className={`${className} flex items-center justify-center border-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400`}>
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z" />
            </svg>
        </button>
    );
}

/** The lobby's Join, in the sidebar and in the mobile header. */
export function LobbyJoin({ onClick, disabled, className }: { onClick: () => void; disabled: boolean; className: string }) {
    return (
        <button type="button" data-testid="header-join" onClick={onClick} disabled={disabled}
            className={`border-0 bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white font-bold cursor-pointer ${className}`}>
            Join
        </button>
    );
}

/**
 * The lobby's mobile header, as a member's: the bean, the page's name, and the "?" with Join where the pill sits (the "?"
 * gold on a 38 px charcoal disc in its 44 px target, as the member's pill draws it). The name is centred in the room
 * between the bean and that group, not on the screen: centred on the screen at 320 px with 130% text it ran under the
 * "?" ("Mark?", review of #1857 B3). A name too long for the room ends in "…".
 */
export function LobbyHeader({ tab, title, onHelp, onJoin, joinDisabled }: { tab: string; title: string; onHelp: () => void; onJoin: () => void; joinDisabled: boolean }) {
    return (
        <header className="relative shadow-md md:hidden" data-testid="lobby-header" style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '0.3rem 0.75rem',
            minHeight: '46px',
            borderBottom: tab === 'map' ? 'none' : '1px solid rgba(255,255,255,0.1)',
            position: tab === 'map' ? 'absolute' : 'sticky',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 100,
            backgroundImage: "url('/assets/neon-vines-banner.png')",
            backgroundSize: '150% auto',
            backgroundPosition: 'center',
        }}>
            <div className="absolute inset-0 bg-black/10 dark:bg-black/50 pointer-events-none" />
            <img src="/bean.png" alt="" aria-hidden="true" className="relative z-10 w-8 h-8 shrink-0 object-contain drop-shadow-sm" data-testid="lobby-bean" />
            <h1 className="relative z-10 flex-1 min-w-0 mx-2 my-0 text-center font-extrabold text-[1.4rem] tracking-tight text-rainbow drop-shadow-[0_2px_4px_rgba(0,0,0,0.9)] whitespace-nowrap overflow-hidden text-ellipsis"
                data-testid="lobby-title">
                {title}
            </h1>
            <div className="relative z-10 shrink-0 flex items-center gap-1" data-testid="lobby-header-right">
                <LobbyHelpButton onClick={onHelp} className="min-w-[44px] min-h-[44px] p-[3px] bg-clip-content rounded-full bg-bp-gold-on text-bp-gold-fill hover:text-bp-gold-hover" />
                <LobbyJoin onClick={onJoin} disabled={joinDisabled} className="min-h-[36px] px-4 rounded-full text-sm shadow-md" />
            </div>
        </header>
    );
}
