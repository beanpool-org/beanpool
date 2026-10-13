/**
 * The sync chip as it is drawn: the dot, the word, and how long ago the last sync was. SyncStatus decides what it says;
 * this file has no state and no imports, so e2e/tour-check.mjs measures the mobile header against the real chip.
 * `stacked` (the mobile header) puts how long ago under the word, as the phone's chip does, so the chip is no wider than
 * its word and the tab's title keeps its room at 320 px (side by side, "Offline 59m ago" is 152 px at 130% text); its sides
 * are the phone chip's 8.
 */

export type SyncMode = 'online' | 'guest' | 'offline';

const STATUS_CONFIG = {
    online: {
        borderColor: 'rgba(16, 185, 129, 0.3)',
        color: '#10b981',
        label: 'Online',
        bg: 'var(--bg-card)',
    },
    guest: {
        borderColor: 'rgba(217, 119, 6, 0.4)',
        color: '#d97706',
        label: 'Guest',
        bg: '#fffbeb',
    },
    offline: {
        borderColor: 'rgba(239, 68, 68, 0.3)',
        color: '#ef4444',
        label: 'Offline',
        bg: 'var(--bg-card)',
    },
} as const;

export function SyncChip({ mode, ago, pulsing, stacked = false }: { mode: SyncMode; ago: string | null; pulsing: boolean; stacked?: boolean }) {
    const config = STATUS_CONFIG[mode];
    const twoLines = stacked && !!ago;
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
            aria-label={`Network status: ${config.label}${ago ? `, last synced ${ago}` : ''}`}
            data-testid="sync-chip"
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.4rem',
                padding: `${twoLines ? '0.15rem' : '0.3rem'} ${stacked ? '0.5rem' : '0.75rem'}`,
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
                style={{
                    width: '7px',
                    height: '7px',
                    borderRadius: '50%',
                    background: config.color,
                    animation: pulsing ? 'pulse 2s infinite' : 'none',
                    flexShrink: 0,
                }}
            />
            {twoLines ? (
                <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.1 }}>
                    {word}
                    {when}
                </span>
            ) : (
                <>
                    {word}
                    {when}
                </>
            )}
        </div>
    );
}
