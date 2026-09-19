/**
 * usePatternBackground — the doodle wallpaper, or a plain background.
 *
 * One stored preference per device, like the theme. On = the tiled art behind the app;
 * off adds .plain-background to <html>, which blanks the pattern variables in index.css
 * and leaves the flat colour.
 *
 * `applyPatternPreference()` runs before React mounts so a member who chose "plain" never
 * sees the pattern flash in on load. Every storage access is wrapped: in a private window
 * localStorage can throw, and the preference simply lasts for the visit.
 */

const STORAGE_KEY = 'beanpool-background-pattern';
const PLAIN_CLASS = 'plain-background';

function readStorage(): string | null {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

function writeStorage(value: string) {
    try { localStorage.setItem(STORAGE_KEY, value); } catch { /* private mode: this visit only */ }
}

/** On unless the member turned it off. */
export function loadPatternPreference(): boolean {
    return readStorage() !== 'plain';
}

export function applyPatternPreference(enabled = loadPatternPreference()) {
    const root = document.documentElement;
    if (enabled) root.classList.remove(PLAIN_CLASS);
    else root.classList.add(PLAIN_CLASS);
}

export function setPatternPreference(enabled: boolean) {
    writeStorage(enabled ? 'pattern' : 'plain');
    applyPatternPreference(enabled);
}
