/**
 * The sync chip as it is drawn: the dot, the word, and how long ago the last sync was. SyncStatus decides what it says;
 * this file has no state and no imports, so e2e/tour-check.mjs measures the mobile header against the real chip.
 * `stacked` (the mobile header) puts how long ago under the word, as the phone's chip does, so the chip is no wider than
 * its word and the tab's title keeps its room at 320 px (side by side, "Offline 59m ago" is 152 px at 130% text); its sides
 * are the phone chip's 8. `dotOnly` (a mobile header too narrow for the tab's title beside the words, HeaderControls'
 * useDotOnlyChip) draws the dot alone: the words stay laid out, hidden, so the header can tell when they fit again, and the
 * chip's name (and its title, on hover) still says which state it is. The dot has its own colour: alone it carries the
 * state, so it holds 3:1 against the chip (WCAG 1.4.11); #10b981 on the white chip is 2.5:1, emerald-600 3.8:1.
 */

export type SyncMode = 'online' | 'guest' | 'offline';

const STATUS_CONFIG = {
    online: {
        borderColor: 'rgba(16, 185, 129, 0.3)',
        color: '#10b981',
        dot: '#059669',
        label: 'Online',
        bg: 'var(--bg-card)',
    },
    guest: {
        borderColor: 'rgba(217, 119, 6, 0.4)',
        color: 'var(--sync-guest, #d97706)',
        dot: '#d97706',
        label: 'Guest',
        bg: 'var(--sync-guest-bg, #fffbeb)',
    },
    offline: {
        borderColor: 'rgba(239, 68, 68, 0.3)',
        color: 'var(--sync-offline, #ef4444)',
        dot: '#ef4444',
        label: 'Offline',
        bg: 'var(--bg-card)',
    },
} as const;

export function SyncChip({ mode, ago, pulsing, stacked = false, dotOnly = false }: { mode: SyncMode; ago: string | null; pulsing: boolean; stacked?: boolean; dotOnly?: boolean }) {
    const config = STATUS_CONFIG[mode];
    const twoLines = stacked && !!ago;
    const name = `${config.label}${ago ? `, last synced ${ago}` : ''}`;
    const word = (
        <span style={{ color: config.color, whiteSpace: 'nowrap' }}>
            {config.label}
        </span>
    );
    const when = ago && (
        <span style={{ color: 'var(--text-faint)', fontSize: '0.7rem', whiteSpace: 'nowrap' }}>
            {ago}
        </span>
    );
    return (
        <div
            role="status"
            aria-live="polite"
            aria-label={`Network status: ${name}`}
            title={dotOnly ? name : undefined}
            data-testid="sync-chip"
            data-dot-only={dotOnly}
            style={{
                position: 'relative',
                overflow: 'hidden',
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: `${twoLines && !dotOnly ? '0.15rem' : '0.3rem'} ${stacked ? '0.5rem' : '0.75rem'}`,
                borderRadius: '9999px',
                background: config.bg,
                border: `1px solid ${config.borderColor}`,
                fontSize: '0.75rem',
                fontWeight: 500,
                transition: 'all 0.3s ease',
            }}
        >
            <span
                aria-hidden="true"
                data-chip-dot
                style={{
                    width: '7px',
                    height: '7px',
                    borderRadius: '50%',
                    background: config.dot,
                    animation: pulsing ? 'pulse 2s infinite' : 'none',
                    flexShrink: 0,
                }}
            />
            <span
                data-chip-words
                aria-hidden={dotOnly || undefined}
                style={{
                    display: 'flex',
                    alignItems: twoLines ? undefined : 'center',
                    flexDirection: twoLines ? 'column' : 'row',
                    gap: twoLines ? undefined : '0.4rem',
                    lineHeight: twoLines ? 1.1 : undefined,
                    ...(dotOnly ? { position: 'absolute', visibility: 'hidden', pointerEvents: 'none' } : {}),
                }}
            >
                {word}
                {when}
            </span>
        </div>
    );
}
