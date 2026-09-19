import { useCallback, useState } from 'react';

/**
 * The desktop (`lg` and wider) Settings sidebar collapses in two steps, like Meta's consoles (Marty,
 * 2026-09-19): full → an icon strip → hidden, with a ☰ at the top-left bringing it back in full. The
 * phone layout (below `lg`) does not use this. Remembered per browser; the default is full.
 */
export type SidebarMode = 'full' | 'icons' | 'hidden';

export const SIDEBAR_MODE_KEY = 'bp-settings-sidebar';

export function readSidebarMode(storage: Pick<Storage, 'getItem'> | undefined = safeLocalStorage()): SidebarMode {
    try {
        const v = storage?.getItem(SIDEBAR_MODE_KEY);
        return v === 'icons' || v === 'hidden' ? v : 'full';
    } catch {
        return 'full';
    }
}

/** The collapse button's next step: full → icons → hidden. */
export function nextSidebarMode(mode: SidebarMode): SidebarMode {
    return mode === 'full' ? 'icons' : 'hidden';
}

function safeLocalStorage(): Storage | undefined {
    try {
        return typeof window !== 'undefined' ? window.localStorage : undefined;
    } catch {
        return undefined;
    }
}

export function useSidebarMode(): [SidebarMode, (mode: SidebarMode) => void] {
    const [mode, setModeState] = useState<SidebarMode>(() => readSidebarMode());
    const setMode = useCallback((next: SidebarMode) => {
        setModeState(next);
        try {
            safeLocalStorage()?.setItem(SIDEBAR_MODE_KEY, next);
        } catch { /* still changes for this visit */ }
    }, []);
    return [mode, setMode];
}
