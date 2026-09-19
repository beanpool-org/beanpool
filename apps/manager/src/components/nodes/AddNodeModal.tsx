import React, { useState } from 'react';
import { normalizeNodeUrl } from '../../lib/node-client';
import { ModalBackdrop } from '../common/ModalBackdrop';

interface AddNodeModalProps {
    onClose: () => void;
    onAdd: (name: string, url: string, adminPassword?: string) => void;
}

export function AddNodeModal({ onClose, onAdd }: AddNodeModalProps) {
    const [name, setName] = useState('');
    const [url, setUrl] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!name.trim() || !url.trim()) return;
        onAdd(name.trim(), normalizeNodeUrl(url), password.trim() || undefined);
    };

    return (
        <ModalBackdrop onClose={onClose} className="fixed inset-0 overflow-y-auto bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-fade-in font-sans">
            <div className="m-auto bg-nature-900 border border-nature-800 rounded-3xl p-6 max-w-md w-full space-y-5 shadow-2xl">
                <div className="flex items-center justify-between gap-3 lg:gap-0 border-b border-nature-800 pb-3">
                    <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        <div className="w-8 h-8 rounded-xl bg-terra-500/20 text-terra-400 flex items-center justify-center text-lg font-bold">
                            🌐
                        </div>
                        <h3 className="text-base font-bold text-white m-0">Connect Sovereign Node</h3>
                    </div>
                    <button
                        aria-label="Close"
                        onClick={onClose}
                        className="shrink-0 text-nature-500 hover:text-white transition-colors text-lg"
                    >
                        ✕
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4 text-xs">
                    <div>
                        <label className="block text-nature-300 font-semibold mb-1">Node Display Name</label>
                        <input
                            type="text"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g. Byron Community Node"
                            required
                            className="w-full bg-nature-950 border border-nature-800 px-3.5 py-2.5 rounded-xl text-white focus:outline-none focus:border-terra-500 shadow-inner"
                        />
                    </div>
                    <div>
                        <label className="block text-nature-300 font-semibold mb-1">Node API Base URL</label>
                        <input
                            type="url"
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            placeholder="https://node2.beanpool.org or https://localhost:8443"
                            required
                            className="w-full bg-nature-950 border border-nature-800 px-3.5 py-2.5 rounded-xl text-white font-mono focus:outline-none focus:border-terra-500 shadow-inner"
                        />
                    </div>
                    <div>
                        <label className="block text-nature-300 font-semibold mb-1">Admin Password (Optional)</label>
                        <div className="relative">
                            <input
                                type={showPassword ? 'text' : 'password'}
                                autoComplete="off"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="Node Admin Password"
                                className="w-full bg-nature-950 border border-nature-800 pl-3.5 pr-10 py-2.5 rounded-xl text-white font-mono focus:outline-none focus:border-terra-500 shadow-inner"
                            />
                            <button
                                type="button"
                                onClick={() => setShowPassword(!showPassword)}
                                className="absolute right-3 top-1/2 -translate-y-1/2 text-nature-400 hover:text-white transition-colors text-sm"
                                title={showPassword ? 'Hide password' : 'Show password'}
                            >
                                {showPassword ? '🙈' : '👁️'}
                            </button>
                        </div>
                    </div>

                    <div className="flex justify-end gap-3 pt-3">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-white font-bold transition-all"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            className="px-5 py-2 rounded-xl bg-terra-500 hover:bg-terra-600 text-white font-bold transition-all shadow-md active:scale-95"
                        >
                            Save Node Profile
                        </button>
                    </div>
                </form>
            </div>
        </ModalBackdrop>
    );
}
