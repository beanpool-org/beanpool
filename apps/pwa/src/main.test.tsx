import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.mock for react-dom/client ESM module
vi.mock('react-dom/client', () => {
    return {
        createRoot: vi.fn(),
    };
});

// Mock App component so main.tsx execution is isolated
vi.mock('./App', () => ({
    App: () => <div data-testid="app-root">App Component</div>
}));

import { createRoot } from 'react-dom/client';

describe('main.tsx - App entry point render and fatal error handling', () => {
    let rootEl: HTMLElement;
    let consoleErrorSpy: any;

    beforeEach(() => {
        vi.resetModules();
        document.body.innerHTML = '';
        rootEl = document.createElement('div');
        rootEl.id = 'root';
        document.body.appendChild(rootEl);

        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('mounts the React app successfully when #root exists', async () => {
        const renderSpy = vi.fn();
        vi.mocked(createRoot).mockReturnValue({
            render: renderSpy,
            unmount: vi.fn(),
        } as any);

        await import('./main');

        expect(createRoot).toHaveBeenCalledWith(rootEl);
        expect(renderSpy).toHaveBeenCalled();
    });

    it('handles fatal error during createRoot render gracefully', async () => {
        vi.mocked(createRoot).mockImplementation(() => {
            throw new Error('ReactDOM createRoot failed');
        });

        await import('./main');

        expect(consoleErrorSpy).toHaveBeenCalledWith('[BeanPool] FATAL:', expect.any(Error));
        expect(rootEl.innerHTML).toContain('⚠️ BeanPool failed to start');
        expect(rootEl.innerHTML).toContain('ReactDOM createRoot failed');
    });

    it('handles non-Error objects/strings thrown during initialization', async () => {
        vi.mocked(createRoot).mockImplementation(() => {
            throw 'String error thrown during startup';
        });

        await import('./main');

        expect(consoleErrorSpy).toHaveBeenCalledWith('[BeanPool] FATAL:', 'String error thrown during startup');
        expect(rootEl.innerHTML).toContain('⚠️ BeanPool failed to start');
        expect(rootEl.innerHTML).toContain('String error thrown during startup');
    });

    it('handles missing #root element gracefully when createRoot throws', async () => {
        rootEl.remove(); // Remove #root from DOM

        vi.mocked(createRoot).mockImplementation(() => {
            throw new Error('createRoot failed without #root');
        });

        await import('./main');

        expect(consoleErrorSpy).toHaveBeenCalledWith('[BeanPool] FATAL:', expect.any(Error));
        expect(document.getElementById('root')).toBeNull();
    });
});
