/*
 * The web app's theme before the first paint. index.html loads this as a plain, blocking script in <head>, so <html>
 * has its theme class, color-scheme and theme-color before anything is drawn: no light page before the default Dark,
 * and no dark one before a chosen Light. The node's policy allows no inline script (apps/server/src/app-document-csp.ts),
 * so it is a file of its own, served from the node like the rest of the app.
 *
 * It only reads. src/lib/useTheme.ts owns the rule and every write, and takes over once the app mounts;
 * src/lib/theme-boot.test.ts holds the two to the same answer for every stored state. Change them together.
 */
(function () {
    var theme = 'dark';
    try {
        var stored = localStorage.getItem('beanpool-theme-mode');
        var migrated = localStorage.getItem('beanpool-theme-default-light-v1') !== null;
        var legacy = localStorage.getItem('beanpool-theme');
        var preference = 'dark';
        if (stored === 'light' || stored === 'dark' || (stored === 'system' && migrated)) preference = stored;
        else if (stored !== 'system' && (legacy === 'light' || legacy === 'dark')) preference = legacy;
        if (preference === 'system') {
            theme = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        } else {
            theme = preference;
        }
    } catch (e) { /* storage blocked: the default */ }

    var root = document.documentElement;
    if (theme === 'dark') {
        root.classList.add('dark', 'dark-theme');
        root.classList.remove('light-theme');
    } else {
        root.classList.remove('dark', 'dark-theme');
        root.classList.add('light-theme');
    }
    root.style.colorScheme = theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#1d231d' : '#fbfaf8');
})();
