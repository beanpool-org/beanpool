import '@testing-library/jest-dom';

// In Node >=22, Node provides an uninitialized native globalThis.localStorage accessor
// that throws/warns when accessed without --localstorage-file. Vitest 3.x's populateGlobal
// iterates dom.window properties but skips any property k already present in globalThis
// unless k is explicitly listed in Vitest's static KEYS list (if (k in global) return
// keysArray.includes(k)). Because 'localStorage' and 'sessionStorage' were omitted from
// Vitest's KEYS list, Vitest leaves Node's native uninitialized storage on globalThis
// instead of forwarding JSDOM's real storage instances.
// We forward JSDOM's real storage instances from globalThis.jsdom.window onto globalThis.
const dom = (globalThis as any).jsdom;
if (dom && dom.window) {
    Object.defineProperty(globalThis, 'localStorage', {
        value: dom.window.localStorage,
        writable: true,
        configurable: true,
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
        value: dom.window.sessionStorage,
        writable: true,
        configurable: true,
    });
}



