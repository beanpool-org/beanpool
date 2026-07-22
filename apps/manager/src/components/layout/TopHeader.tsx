import React from 'react';
import type { NodeProfile } from '../../lib/profiles';

interface TopHeaderProps {
    activeNode: NodeProfile;
    adminPasswordInput: string;
    onPasswordChange: (pass: string) => void;
    onAuthenticate: () => void;
    onRefresh: () => void;
    isLoading: boolean;
}

export function TopHeader({
    activeNode,
    adminPasswordInput,
    onPasswordChange,
    onAuthenticate,
    onRefresh,
    isLoading,
}: TopHeaderProps) {
    return (
        <header className="border-b border-nature-800/80 bg-nature-900/90 backdrop-blur-md px-6 py-3.5 flex flex-wrap items-center justify-between gap-4 sticky top-0 z-20 font-sans">
            <div className="flex items-center gap-3">
                <div className="flex items-center gap-2 bg-nature-950 border border-nature-800 rounded-xl px-3 py-1.5 text-xs font-mono">
                    <span className="text-nature-400">Target Node:</span>
                    <span className="text-terra-400 font-bold">{activeNode?.name}</span>
                    <span className="text-nature-600">|</span>
                    <code className="text-sky-400">{activeNode?.url}</code>
                </div>
            </div>

            <div className="flex items-center gap-3 text-xs">
                <div className="flex items-center gap-2">
                    <span className="text-nature-400 hidden sm:inline">Admin Password:</span>
                    <input
                        type="password"
                        value={adminPasswordInput}
                        onChange={(e) => onPasswordChange(e.target.value)}
                        placeholder="Enter Admin Password"
                        className="bg-nature-950 border border-nature-800 px-3 py-1.5 rounded-xl text-white font-mono focus:outline-none focus:border-terra-500 w-44 text-xs shadow-inner"
                    />
                    <button
                        onClick={onAuthenticate}
                        className="px-3.5 py-1.5 rounded-xl bg-terra-600 hover:bg-terra-500 text-white font-bold transition-all shadow-sm active:scale-95"
                    >
                        Authenticate
                    </button>
                </div>

                <button
                    onClick={onRefresh}
                    disabled={isLoading}
                    className="px-3 py-1.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-white font-bold transition-all border border-nature-700 flex items-center gap-1.5 active:scale-95"
                >
                    <span className={isLoading ? 'animate-spin' : ''}>🔄</span>
                    <span>{isLoading ? 'Refreshing...' : 'Refresh'}</span>
                </button>
            </div>
        </header>
    );
}
