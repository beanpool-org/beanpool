import '@testing-library/jest-dom';

const createStorageMock = () => {
    let store: Record<string, string> = {};
    return {
        getItem: (key: string) => store[key] ?? null,
        setItem: (key: string, value: string) => { store[key] = String(value); },
        removeItem: (key: string) => { delete store[key]; },
        clear: () => { store = {}; },
        get length() { return Object.keys(store).length; },
        key: (i: number) => Object.keys(store)[i] ?? null,
    };
};

const storageMock = createStorageMock();

Object.defineProperty(globalThis, 'localStorage', {
    value: storageMock,
    configurable: true,
    writable: true,
});

if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', {
        value: storageMock,
        configurable: true,
        writable: true,
    });
}
