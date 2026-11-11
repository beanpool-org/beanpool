import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { GatewayModule } from './GatewayModule';
import type { GatewayConfig } from '../../lib/node-client';

describe('GatewayModule component', () => {
    const mockGatewayConfig: GatewayConfig = {
        rateLimiting: {
            enabled: true,
            maxRequestsPerMinute: 600,
        },
        corsAllowedOrigins: ['https://app.beanpool.org', 'http://localhost:3001'],
        adminIpAllowlist: [],
        features: {
            servePwa: false,
        },
    };

    it('renders the owner-token unlock form when gateway is null', async () => {
        const onAuthenticateMock = vi.fn();
        render(
            <GatewayModule
                gateway={null}
                gatewayLoading={false}
                gatewaySuccess={null}
                onChangeGateway={vi.fn()}
                onSaveGateway={vi.fn()}
                onAuthenticate={onAuthenticateMock}
            />
        );

        expect(screen.getByText('Node Access Required')).toBeInTheDocument();
        expect(screen.getByText('Owner automation token')).toBeInTheDocument();
        const input = screen.getByPlaceholderText('bp_…');
        expect(input).toHaveAttribute('type', 'password');

        // Toggle token visibility
        const toggleBtn = screen.getByTitle('Show token');
        fireEvent.click(toggleBtn);
        expect(input).toHaveAttribute('type', 'text');
        expect(screen.getByTitle('Hide token')).toBeInTheDocument();

        // Submit form
        await userEvent.type(input, 'bp_secret-token');
        fireEvent.submit(input.closest('form')!);

        expect(onAuthenticateMock).toHaveBeenCalledWith('bp_secret-token');
    });

    it('asks for no admin password: the unlock form is for an owner automation token', () => {
        render(
            <GatewayModule
                gateway={null}
                gatewayLoading={false}
                gatewaySuccess={null}
                onChangeGateway={vi.fn()}
                onSaveGateway={vi.fn()}
                onAuthenticate={vi.fn()}
            />
        );

        expect(screen.queryByText('Node Admin Authentication Required')).toBeNull();
        expect(screen.queryByPlaceholderText(/admin password/i)).toBeNull();
        expect(screen.queryByTitle('Show password')).toBeNull();
        expect(screen.queryByText(/Admin Password/i)).toBeNull();
    });

    it('renders loading state when gateway is null and gatewayLoading is true', () => {
        render(
            <GatewayModule
                gateway={null}
                gatewayLoading={true}
                gatewaySuccess={null}
                onChangeGateway={vi.fn()}
                onSaveGateway={vi.fn()}
            />
        );

        expect(screen.getByText(/Loading node gateway configuration/i)).toBeInTheDocument();
    });

    it('renders gateway configuration controls when authenticated', () => {
        render(
            <GatewayModule
                gateway={mockGatewayConfig}
                gatewayLoading={false}
                gatewaySuccess="Settings saved successfully"
                onChangeGateway={vi.fn()}
                onSaveGateway={vi.fn()}
            />
        );

        expect(screen.getByText('🛡️ Node Gateway Self-Protection Config')).toBeInTheDocument();
        expect(screen.getByText('Settings saved successfully')).toBeInTheDocument();
    });

    it('handles the web app switch, the one switch left', () => {
        const onChangeMock = vi.fn();
        render(
            <GatewayModule
                gateway={mockGatewayConfig}
                gatewayLoading={false}
                gatewaySuccess={null}
                onChangeGateway={onChangeMock}
                onSaveGateway={vi.fn()}
            />
        );

        const pwaCheckbox = screen.getByLabelText(/Static PWA Asset Server/i);
        expect(pwaCheckbox).not.toBeChecked();

        fireEvent.click(pwaCheckbox);

        expect(onChangeMock).toHaveBeenCalledWith({
            ...mockGatewayConfig,
            features: { servePwa: true },
        });
    });

    it('offers no switch for invites, messaging, the Market or federation (Core settings S3)', () => {
        render(
            <GatewayModule
                gateway={mockGatewayConfig}
                gatewayLoading={false}
                gatewaySuccess={null}
                onChangeGateway={vi.fn()}
                onSaveGateway={vi.fn()}
            />
        );

        for (const gone of [/Marketplace/i, /Direct Messaging/i, /Multi-Node Federation/i, /Cryptographic Invites/i]) {
            expect(screen.queryByLabelText(gone)).toBeNull();
        }
        expect(screen.queryByText('Subsystem Feature Toggles')).toBeNull();
        expect(screen.getByText(/Who can join is set under Core settings/)).toBeInTheDocument();
    });

    it('displays rate limit disabled alert and enables rate limiting on quick fix click', () => {
        const onChangeMock = vi.fn();
        const disabledRateLimitConfig: GatewayConfig = {
            ...mockGatewayConfig,
            rateLimiting: { enabled: false, maxRequestsPerMinute: 600 },
        };

        render(
            <GatewayModule
                gateway={disabledRateLimitConfig}
                gatewayLoading={false}
                gatewaySuccess={null}
                onChangeGateway={onChangeMock}
                onSaveGateway={vi.fn()}
            />
        );

        expect(screen.getByText('RATE LIMITING DISABLED')).toBeInTheDocument();

        const enableBtn = screen.getByText('Enable Rate Limiting');
        fireEvent.click(enableBtn);

        expect(onChangeMock).toHaveBeenCalledWith({
            ...disabledRateLimitConfig,
            rateLimiting: { enabled: true, maxRequestsPerMinute: 600 },
        });
    });

    it('displays wildcard CORS alert and restricts origins on quick fix click', () => {
        const onChangeMock = vi.fn();
        const wildcardCorsConfig: GatewayConfig = {
            ...mockGatewayConfig,
            corsAllowedOrigins: ['*'],
        };

        render(
            <GatewayModule
                gateway={wildcardCorsConfig}
                gatewayLoading={false}
                gatewaySuccess={null}
                onChangeGateway={onChangeMock}
                onSaveGateway={vi.fn()}
            />
        );

        expect(screen.getByText('WILDCARD CORS ACTIVE (`*`)')).toBeInTheDocument();

        const restrictBtn = screen.getByText('Restrict CORS Origins');
        fireEvent.click(restrictBtn);

        expect(onChangeMock).toHaveBeenCalledWith({
            ...wildcardCorsConfig,
            corsAllowedOrigins: ['https://app.beanpool.org', 'http://localhost:3001', 'http://localhost:3000'],
        });
    });

    it('updates rate limit threshold and handles preset buttons', () => {
        const onChangeMock = vi.fn();
        render(
            <GatewayModule
                gateway={mockGatewayConfig}
                gatewayLoading={false}
                gatewaySuccess={null}
                onChangeGateway={onChangeMock}
                onSaveGateway={vi.fn()}
            />
        );

        const strictPresetBtn = screen.getByText('300 / min (Strict)');
        fireEvent.click(strictPresetBtn);

        expect(onChangeMock).toHaveBeenCalledWith({
            ...mockGatewayConfig,
            rateLimiting: { ...mockGatewayConfig.rateLimiting, maxRequestsPerMinute: 300 },
        });
    });

    it('calls onSaveGateway when save button is clicked', () => {
        const onSaveMock = vi.fn();
        render(
            <GatewayModule
                gateway={mockGatewayConfig}
                gatewayLoading={false}
                gatewaySuccess={null}
                onChangeGateway={vi.fn()}
                onSaveGateway={onSaveMock}
            />
        );

        const saveBtn = screen.getByRole('button', { name: /Save Gateway Config/i });
        fireEvent.click(saveBtn);

        expect(onSaveMock).toHaveBeenCalledTimes(1);
    });
});
