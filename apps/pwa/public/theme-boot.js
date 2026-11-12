/*
 * The web app's look before the first paint. index.html loads this as a plain, blocking script in <head>, so <html>
 * has its theme class, data-bp-theme, color-scheme and theme-color before anything is drawn: no Classic page before a
 * chosen Light or Dark, and no light one before the default Classic. The node's policy allows no inline script
 * (apps/server/src/app-document-csp.ts), so it is a file of its own, served from the node like the rest of the app.
 *
 * It only reads. src/lib/useTheme.ts owns the rule and every write, and takes over once the app mounts;
 * src/lib/theme-boot.test.ts holds the two to the same answer for every stored state, and holds this file's copy of
 * core's resolveLook (look.ts) to the real one. Change them together.
 *
 * The stored values are core's LookChoice: 'system' | 'dark' (Classic) | 'light' | 'night' (Dark, always dark). Nothing
 * stored, or a value this build does not know, is Classic.
 */
(function () {
    var set = 'dark';
    try {
        var stored = localStorage.getItem('beanpool-theme-mode');
        if (stored === 'light' || stored === 'dark' || stored === 'night') {
            set = stored;
        } else if (stored === 'system') {
            set = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }
    } catch (e) { /* storage blocked: the default */ }
    var theme = set === 'light' ? 'light' : 'dark';

    var root = document.documentElement;
    if (theme === 'dark') {
        root.classList.add('dark', 'dark-theme');
        root.classList.remove('light-theme');
    } else {
        root.classList.remove('dark', 'dark-theme');
        root.classList.add('light-theme');
    }
    // Dark is :root.dark-theme[data-bp-theme="night"]; Light and Classic carry no attribute.
    if (set === 'night') root.setAttribute('data-bp-theme', 'night');
    else root.removeAttribute('data-bp-theme');
    root.style.colorScheme = theme;
    if (typeof navigator !== 'undefined' && navigator.connection && navigator.connection.saveData) {
        root.setAttribute('data-save-data', 'true');
    }
    // The banner's ground in each set (brandGrounds(set).web.banner; theme-boot.test.ts holds this table to the library).
    var BAR = { light: '#fbfaf8', dark: '#1d231d', night: '#202126' };
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', BAR[set]);
})();
