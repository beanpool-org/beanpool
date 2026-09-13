import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { App } from './App';

describe('App Component', () => {
    beforeEach(() => {
        localStorage.clear();
        vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
            if (url.includes('/api/local/admin/gateway')) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () =>
                        Promise.resolve({
                            features: { marketplace: true, messaging: true },
                            corsAllowedOrigins: ['*'],
                            rateLimiting: { enabled: true },
                        }),
                });
            }
            return Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve({ success: true, health: { flags: [] }, reports: [] }),
            });
        }));
    });

    it('renders App with FleetSidebar and default Overview module', async () => {
        await act(async () => {
            render(<App />);
        });

        expect(screen.getByText('BeanPool')).toBeInTheDocument();
        expect(screen.getByText('Fleet Manager v1.2')).toBeInTheDocument();
        expect(screen.getAllByRole('button', { name: /fleet telemetry/i }).length).toBeGreaterThanOrEqual(1);
    });

    it('switches tabs when tab navigation buttons are clicked', async () => {
        await act(async () => {
            render(<App />);
        });

        const gatewayTab = screen.getByRole('button', { name: /gateway security/i });
        await act(async () => {
            fireEvent.click(gatewayTab);
        });

        expect(screen.getByText('Target Control Node:')).toBeInTheDocument();
    });

    it('opens Add Node modal when clicking + Add Node button in sidebar', async () => {
        await act(async () => {
            render(<App />);
        });

        const addButton = screen.getByRole('button', { name: /\+ add node/i });
        await act(async () => {
            fireEvent.click(addButton);
        });

        expect(screen.getByText('Connect Sovereign Node')).toBeInTheDocument();
    });
});
