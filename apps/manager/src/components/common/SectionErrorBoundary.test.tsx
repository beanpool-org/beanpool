import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SectionErrorBoundary } from './SectionErrorBoundary';

const ThrowingComponent = ({ shouldThrow }: { shouldThrow: boolean }) => {
    if (shouldThrow) {
        throw new Error('Test render crash in section');
    }
    return <div>Normal Section Content</div>;
};

describe('SectionErrorBoundary', () => {
    it('renders children when no error occurs', () => {
        render(
            <SectionErrorBoundary sectionName="People & Safety">
                <ThrowingComponent shouldThrow={false} />
            </SectionErrorBoundary>
        );

        expect(screen.getByText('Normal Section Content')).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('catches render error and displays section error card naming the section', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

        render(
            <SectionErrorBoundary sectionName="Shared Projects & Economy">
                <ThrowingComponent shouldThrow={true} />
            </SectionErrorBoundary>
        );

        expect(screen.getByRole('alert')).toBeInTheDocument();
        expect(screen.getByText('Unable to load Shared Projects & Economy')).toBeInTheDocument();
        expect(screen.getByText(/Test render crash in section/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /retry section/i })).toBeInTheDocument();

        spy.mockRestore();
    });

    it('allows retrying after error state', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const onReset = vi.fn();

        const { rerender } = render(
            <SectionErrorBoundary sectionName="People & Safety" onReset={onReset}>
                <ThrowingComponent shouldThrow={true} />
            </SectionErrorBoundary>
        );

        expect(screen.getByText('Unable to load People & Safety')).toBeInTheDocument();

        // Fix the underlying component so it won't throw on re-render
        rerender(
            <SectionErrorBoundary sectionName="People & Safety" onReset={onReset}>
                <ThrowingComponent shouldThrow={false} />
            </SectionErrorBoundary>
        );

        fireEvent.click(screen.getByRole('button', { name: /retry section/i }));
        expect(onReset).toHaveBeenCalled();
        expect(screen.getByText('Normal Section Content')).toBeInTheDocument();

        spy.mockRestore();
    });
});
