import React, { useState } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { normalizeNodeUrl, fetchDiagnostics } from '../../lib/node-client';

interface EditNodeModalProps {
    node: NodeProfile;
    onClose: () => void;
    onSave: (id: string, updates: Partial<NodeProfile>) => void;
}

export function EditNodeModal({ node, onClose, onSave }: EditNodeModalProps) {
    const [name, setName] = useState(node.name);
    const [url, setUrl] = useState(node.url);
    const [password, setPassword] = useState(node.adminPassword || '');
    const [showPassword, setShowPassword] = useState(false);
    const [testStatus, setTestStatus] = useState<string | null>(null);
    const [testLoading, setTestLoading] = useState(false);

    const handleTestConnection = async () => {
        setTestLoading(true);
        setTestStatus(null);
        try {
            const cleanUrl = normalizeNodeUrl(url);
            const data = await fetchDiagnostics(cleanUrl, password.trim() || undefined);
            setTestStatus(`✅ Connection OK! Status: ${data.status.toUpperCase()} (${data.communityName || 'BeanPool Node'})`);
        } catch (e: any) {
            setTestStatus(`❌ Connection Error: ${e.message}`);
        } finally {
            setTestLoading(false);
        }
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onSave(node.id, {
            name: name.trim() || node.name,
            url: normalizeNodeUrl(url),
            adminPassword: password.trim() || undefined,
        });
        onClose();
    };

    return (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-50 font-sans animate-fade-in">
            <div className="bg-nature-900 border border-nature-800 rounded-3xl p-6 max-w-md w-full space-y-5 shadow-2xl">
                <div className="flex items-center justify-between border-b border-nature-800 pb-3">
                    <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-xl bg-terra-500/20 text-terra-400 flex items-center justify-center text-base font-bold">
                            ⚙️
                        </div>
                        <h3 className="text-base font-bold text-white m-0">Configure Node Credentials</h3>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-nature-500 hover:text-white transition-colors text-lg"
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
                            required
                            className="w-full bg-nature-950 border border-nature-800 px-3.5 py-2.5 rounded-xl text-white font-mono focus:outline-none focus:border-terra-500 shadow-inner"
                        />
                    </div>
                    <div>
                        <label className="block text-nature-300 font-semibold mb-1">Node Admin Password</label>
                        <div className="relative">
                            <input
                                type={showPassword ? 'text' : 'password'}
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="Enter Admin Password for authentication"
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

                    {testStatus && (
                        <div className="p-3 rounded-xl bg-nature-950 border border-nature-800 font-mono text-[11px]">
                            {testStatus}
                        </div>
                    )}

                    <div className="flex items-center justify-between pt-2 border-t border-nature-800/80">
                        <button
                            type="button"
                            onClick={handleTestConnection}
                            disabled={testLoading}
                            className="px-3 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-nature-200 font-bold transition-all border border-nature-700 active:scale-95"
                        >
                            {testLoading ? 'Testing...' : '⚡ Test Connection'}
                        </button>

                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={onClose}
                                className="px-3.5 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-white font-bold transition-all"
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                className="px-4 py-2 rounded-xl bg-terra-500 hover:bg-terra-600 text-white font-bold transition-all shadow-md active:scale-95"
                            >
                                Save Settings
                            </button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    );
}
