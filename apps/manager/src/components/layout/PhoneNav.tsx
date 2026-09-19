import React, { useEffect, useRef } from 'react';
import { singleNodeNavItems, type TabId } from './FleetSidebar';
import { subTabLabel } from '../../lib/sections';
import type { BackLink } from '../../lib/came-from';
import { PhoneReturnLink } from './ReturnLinks';

/**
 * Node Settings on a phone (below `lg`): a top bar that always names the screen you are on, and the section menu in
 * a sheet that slides in from the left. Owners reach Settings from the app's "Manage" button, which opens it in the
 * phone's in-app browser, so this is the layout most of them see.
 */

export function PhoneTopBar({ communityName, tab, sub, menuOpen, onOpenMenu, back }: {
    communityName: string;
    tab: TabId;
    sub?: string;
    menuOpen: boolean;
    onOpenMenu: () => void;
    /** Back to where the member came from (lib/came-from.ts); the menu repeats it in full with "View my profile". */
    back?: BackLink;
}) {
    const item = singleNodeNavItems.find(i => i.id === tab);
    const subLabel = subTabLabel(tab, sub);
    // One string, not separate spans: the section's name already appears on the page as its heading.
    const where = item ? `${item.icon} ${item.label}${subLabel ? ` › ${subLabel}` : ''}` : '';
    return (
        <header className="lg:hidden sticky top-0 z-40 bg-nature-900/95 backdrop-blur-md border-b border-nature-800">
            <div className={`flex items-center gap-1 pl-1 ${back ? 'pr-1' : 'pr-3'} min-h-[56px]`}>
                <button
                    type="button"
                    onClick={onOpenMenu}
                    aria-label="Menu"
                    aria-haspopup="dialog"
                    aria-expanded={menuOpen}
                    aria-controls="settings-menu"
                    className="min-w-[48px] min-h-[48px] rounded-xl flex items-center justify-center text-2xl leading-none text-nature-100 hover:bg-nature-800/60 shrink-0"
                >
                    ☰
                </button>
                <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-terra-400 m-0 truncate">{`${communityName || 'BeanPool'} · Settings`}</p>
                    <p className="text-sm font-bold text-white m-0 truncate" aria-live="polite">{where}</p>
                </div>
                {back && <PhoneReturnLink back={back} />}
            </div>
        </header>
    );
}

/** The menu sheet. Escape, the backdrop and the ✕ close it; the phone's Back button does too (see useSettingsHistory). */
export function PhoneMenu({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
    const panelRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            window.removeEventListener('keydown', onKey);
            document.body.style.overflow = prevOverflow;
        };
    }, [onClose]);
    return (
        <div className="lg:hidden fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Settings menu">
            <div className="absolute inset-0 bg-black/70" onClick={onClose} aria-hidden="true" />
            <div ref={panelRef} className="absolute inset-y-0 left-0 w-[min(20rem,88vw)] shadow-2xl border-r border-nature-800 overflow-y-auto">
                {children}
            </div>
        </div>
    );
}

/**
 * Settings screens in the browser's history, so the phone's Back button goes to the previous screen and closes the
 * menu before leaving Settings. The URL never changes: /settings stays /settings, and the key hand-off's fragment is
 * already gone (lib/key-session.ts removes it first).
 *
 * Each entry carries `{ bpSettings: { tab, sub, menu? } }`. A change of screen made in the page pushes an entry; Back
 * pops one and `onRestore` puts that screen back; an entry with `menu: true` is the open menu.
 */
export type SettingsHistoryEntry = { tab: TabId; sub?: string; menu?: boolean };

export function readSettingsEntry(state: unknown): SettingsHistoryEntry | null {
    const e = (state as { bpSettings?: SettingsHistoryEntry } | null)?.bpSettings;
    return e && typeof e.tab === 'string' ? e : null;
}

export function useSettingsHistory({ enabled, tab, sub, onRestore }: {
    enabled: boolean;
    tab: TabId;
    /** Normalised: the section's default sub-tab rather than undefined, so choosing it again is not a new entry. */
    sub?: string;
    onRestore: (entry: SettingsHistoryEntry) => void;
}) {
    const onRestoreRef = useRef(onRestore);
    onRestoreRef.current = onRestore;

    useEffect(() => {
        if (!enabled || typeof window === 'undefined') return;
        const cur = readSettingsEntry(window.history.state);
        if (cur && cur.tab === tab && cur.sub === sub && !cur.menu) return;
        const next = { bpSettings: { tab, sub } };
        if (!cur || cur.menu) {
            // First screen of the visit, or the menu's own entry: the menu is replaced by where it took you, so Back
            // from there does not reopen the menu.
            window.history.replaceState(next, '');
        } else {
            window.history.pushState(next, '');
        }
        window.scrollTo?.(0, 0);
    }, [enabled, tab, sub]);

    useEffect(() => {
        if (!enabled || typeof window === 'undefined') return;
        const onPop = (e: PopStateEvent) => {
            const entry = readSettingsEntry(e.state);
            if (entry) onRestoreRef.current(entry);
        };
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, [enabled]);
}

/** Open the menu as its own history entry, so Back closes it. */
export function pushMenuEntry(tab: TabId, sub?: string) {
    if (typeof window === 'undefined') return;
    window.history.pushState({ bpSettings: { tab, sub, menu: true } }, '');
}

/** Close the menu, and drop its history entry so the next Back is not spent on a menu that is already shut. */
export function closeMenuEntry(close: () => void) {
    close();
    if (typeof window !== 'undefined' && readSettingsEntry(window.history.state)?.menu) {
        window.history.back();
    }
}
