import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { OwnerPhoneBanner } from './OwnerPhoneBanner';
import { OWNER_PHONE_EVENT, OWNER_PHONE_MESSAGE } from '../../lib/token-guard';

describe('OwnerPhoneBanner', () => {
    it('renders nothing initially when event has not fired', () => {
        render(<OwnerPhoneBanner nodeUrl="https://node1.beanpool.org" />);
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('shows banner when OWNER_PHONE_EVENT is dispatched on window', () => {
        render(<OwnerPhoneBanner nodeUrl="https://node1.beanpool.org" />);

        act(() => {
            window.dispatchEvent(new CustomEvent(OWNER_PHONE_EVENT));
        });

        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(screen.getByText(OWNER_PHONE_MESSAGE)).toBeInTheDocument();

        const link = screen.getByRole('link', { name: /sign in with your phone/i });
        expect(link).toHaveAttribute('href', 'https://node1.beanpool.org/settings/');
        expect(link).toHaveAttribute('target', '_blank');
    });

    it('renders message and dismiss button without a link when nodeUrl is undefined', () => {
        render(<OwnerPhoneBanner nodeUrl={undefined} />);

        act(() => {
            window.dispatchEvent(new CustomEvent(OWNER_PHONE_EVENT));
        });

        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(screen.getByText(OWNER_PHONE_MESSAGE)).toBeInTheDocument();
        expect(screen.queryByRole('link')).toBeNull();
    });

    it('hides the banner when Dismiss is clicked', () => {
        render(<OwnerPhoneBanner nodeUrl="https://node1.beanpool.org" />);

        act(() => {
            window.dispatchEvent(new CustomEvent(OWNER_PHONE_EVENT));
        });

        expect(screen.getByRole('alert')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));

        expect(screen.queryByRole('alert')).toBeNull();
    });

    it('resets banner visibility when nodeUrl prop changes', () => {
        const { rerender } = render(<OwnerPhoneBanner nodeUrl="https://node1.beanpool.org" />);

        act(() => {
            window.dispatchEvent(new CustomEvent(OWNER_PHONE_EVENT));
        });

        expect(screen.getByRole('alert')).toBeInTheDocument();

        rerender(<OwnerPhoneBanner nodeUrl="https://node2.beanpool.org" />);

        expect(screen.queryByRole('alert')).toBeNull();
    });
});
