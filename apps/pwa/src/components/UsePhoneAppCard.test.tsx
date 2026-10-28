import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { UsePhoneAppCard, isUsePhoneAppDismissed, dismissUsePhoneApp } from './UsePhoneAppCard';
import { BeanPoolSettingsGroup } from '../pages/SettingsPage';

describe('UsePhoneAppCard & S4 Settings rows', () => {
    beforeEach(() => {
        localStorage.clear();
        Object.defineProperty(window, 'matchMedia', {
            writable: true,
            value: vi.fn().mockImplementation((query: string) => ({
                matches: false,
                media: query,
                onchange: null,
                addListener: vi.fn(),
                removeListener: vi.fn(),
                addEventListener: vi.fn(),
                removeEventListener: vi.fn(),
                dispatchEvent: vi.fn(),
            })),
        });
    });

    describe('UsePhoneAppCard', () => {
        it('renders heading, description, store badges, and direct APK download', () => {
            render(<UsePhoneAppCard publicKey="pk123" />);

            expect(screen.getByText('Use the phone app')).toBeInTheDocument();
            expect(screen.getByText('Your account comes with you.')).toBeInTheDocument();
            expect(screen.getByTestId('store-badges')).toBeInTheDocument();
            expect(screen.getByLabelText('Download on the App Store')).toHaveAttribute(
                'href',
                'https://apps.apple.com/au/app/bean-pool/id6761870086'
            );
            expect(screen.getByLabelText('Get it on Google Play')).toHaveAttribute(
                'href',
                'https://play.google.com/store/apps/details?id=org.beanpool.pillar'
            );
            expect(screen.getByText('No Google Play? Download the app')).toHaveAttribute(
                'href',
                'https://beanpool.org/android'
            );
        });

        it('dismisses card and marks localStorage', () => {
            const onDismiss = vi.fn();
            render(<UsePhoneAppCard publicKey="pk123" onDismiss={onDismiss} />);

            expect(isUsePhoneAppDismissed('pk123')).toBe(false);
            fireEvent.click(screen.getByLabelText('Dismiss'));

            expect(isUsePhoneAppDismissed('pk123')).toBe(true);
            expect(onDismiss).toHaveBeenCalledTimes(1);
        });

        it('renders phoneLater lines when provided', () => {
            const lines = [
                'To use BeanPool on your phone later: install the app, tap **Already a member** and type your 12 words.',
            ];
            render(<UsePhoneAppCard publicKey="pk123" phoneLater={lines} />);

            expect(screen.getByText(/To use BeanPool on your phone later/)).toBeInTheDocument();
        });
    });

    describe('BeanPoolSettingsGroup rows (front doors S4)', () => {
        it('renders "Use the phone app" row and expands with badges', () => {
            render(<BeanPoolSettingsGroup onHelp={() => {}} onSuggest={() => {}} />);

            const phoneRow = screen.getByTestId('settings-use-phone-app');
            expect(phoneRow).toBeInTheDocument();
            expect(screen.queryByTestId('settings-use-phone-app-details')).toBeNull();

            fireEvent.click(phoneRow);
            expect(screen.getByTestId('settings-use-phone-app-details')).toBeInTheDocument();
            expect(screen.getByLabelText('Download on the App Store')).toBeInTheDocument();
            expect(screen.getByLabelText('Get it on Google Play')).toBeInTheDocument();
        });

        it('shows "Install on this computer" row on desktop when not installed', () => {
            render(<BeanPoolSettingsGroup onHelp={() => {}} onSuggest={() => {}} />);

            const installRow = screen.getByTestId('settings-install-computer');
            expect(installRow).toBeInTheDocument();
            expect(screen.queryByTestId('desktop-install-steps')).toBeNull();

            fireEvent.click(installRow);
            expect(screen.getByTestId('desktop-install-steps')).toBeInTheDocument();
        });

        it('hides "Install on this computer" on phone browsers', () => {
            (window.matchMedia as any).mockImplementation((query: string) => ({
                matches: query.includes('(pointer: coarse)'),
                media: query,
            }));

            render(<BeanPoolSettingsGroup onHelp={() => {}} onSuggest={() => {}} />);
            expect(screen.queryByTestId('settings-install-computer')).toBeNull();
            // "Use the phone app" row is still present on phones
            expect(screen.getByTestId('settings-use-phone-app')).toBeInTheDocument();
        });

        it('hides "Install on this computer" when standalone mode is already active', () => {
            (window.matchMedia as any).mockImplementation((query: string) => ({
                matches: query.includes('standalone'),
                media: query,
            }));

            render(<BeanPoolSettingsGroup onHelp={() => {}} onSuggest={() => {}} />);
            expect(screen.queryByTestId('settings-install-computer')).toBeNull();
        });
    });
});
