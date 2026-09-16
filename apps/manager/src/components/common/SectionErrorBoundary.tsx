import React, { Component, type ErrorInfo, type ReactNode } from 'react';

interface SectionErrorBoundaryProps {
    sectionName: string;
    children: ReactNode;
    onReset?: () => void;
}

interface SectionErrorBoundaryState {
    hasError: boolean;
    error: Error | null;
    showDetails: boolean;
}

export class SectionErrorBoundary extends Component<SectionErrorBoundaryProps, SectionErrorBoundaryState> {
    constructor(props: SectionErrorBoundaryProps) {
        super(props);
        this.state = {
            hasError: false,
            error: null,
            showDetails: false,
        };
    }

    static getDerivedStateFromError(error: Error): Partial<SectionErrorBoundaryState> {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
        console.error(`[SectionErrorBoundary] Error in section "${this.props.sectionName}":`, error, errorInfo);
    }

    componentDidUpdate(prevProps: SectionErrorBoundaryProps): void {
        if (prevProps.sectionName !== this.props.sectionName && this.state.hasError) {
            this.handleRetry();
        }
    }

    handleRetry = (): void => {
        this.setState({ hasError: false, error: null, showDetails: false });
        this.props.onReset?.();
    };

    render(): ReactNode {
        if (this.state.hasError) {
            return (
                <div
                    className="p-6 rounded-2xl bg-nature-900/90 border border-red-800/80 shadow-xl space-y-4 font-sans animate-fade-in my-4"
                    role="alert"
                >
                    <div className="flex items-center gap-3 border-b border-red-800/50 pb-4">
                        <div className="w-10 h-10 rounded-xl bg-red-950 border border-red-700/60 flex items-center justify-center text-xl text-red-400 shrink-0">
                            ⚠️
                        </div>
                        <div>
                            <h3 className="text-base font-bold text-white m-0">
                                Unable to load {this.props.sectionName}
                            </h3>
                            <p className="text-xs text-red-300/80 m-0 mt-0.5">
                                A rendering error occurred while loading this section.
                            </p>
                        </div>
                    </div>

                    <div className="p-3.5 rounded-xl bg-nature-950 border border-red-900/60 text-xs text-red-200 font-mono break-words">
                        {this.state.error?.message || 'An unexpected error occurred.'}
                    </div>

                    <div className="flex items-center gap-3">
                        <button
                            type="button"
                            onClick={this.handleRetry}
                            className="px-4 py-2 rounded-xl bg-terra-600 hover:bg-terra-500 text-xs font-bold text-white transition-all shadow-sm active:scale-95"
                        >
                            Retry Section
                        </button>
                        {this.state.error?.stack && (
                            <button
                                type="button"
                                onClick={() => this.setState((prev) => ({ showDetails: !prev.showDetails }))}
                                className="px-3 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-xs text-nature-300 font-medium transition-all"
                            >
                                {this.state.showDetails ? 'Hide Details' : 'Show Details'}
                            </button>
                        )}
                    </div>

                    {this.state.showDetails && this.state.error?.stack && (
                        <pre className="p-3.5 rounded-xl bg-nature-950 border border-nature-800 text-[11px] text-nature-400 overflow-x-auto font-mono whitespace-pre-wrap">
                            {this.state.error.stack}
                        </pre>
                    )}
                </div>
            );
        }

        return this.props.children;
    }
}
