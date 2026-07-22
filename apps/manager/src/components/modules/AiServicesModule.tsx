import React, { useState } from 'react';
import { loadAiConfig, saveAiConfig, askAiCopilot, type AiConfig } from '../../lib/ai-client';
import type { NodeProfile } from '../../lib/profiles';

interface AiServicesModuleProps {
    activeNode: NodeProfile;
    contextData: { telemetry?: any; gateway?: any; members?: any; logs?: any[] };
}

export function AiServicesModule({ activeNode, contextData }: AiServicesModuleProps) {
    const [config, setConfig] = useState<AiConfig>(() => loadAiConfig());
    const [prompt, setPrompt] = useState<string>('');
    const [response, setResponse] = useState<string | null>(null);
    const [loading, setLoading] = useState<boolean>(false);
    const [saveFeedback, setSaveFeedback] = useState<boolean>(false);

    const handleSaveConfig = () => {
        saveAiConfig(config);
        setSaveFeedback(true);
        setTimeout(() => setSaveFeedback(false), 2500);
    };

    const handleAsk = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!prompt.trim()) return;
        setLoading(true);
        setResponse(null);
        try {
            const res = await askAiCopilot(prompt.trim(), contextData, config);
            setResponse(res);
        } catch (e: any) {
            setResponse(`❌ AI Copilot Error: ${e.message}`);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="bg-nature-900/80 border border-nature-800 rounded-2xl p-6 space-y-6 shadow-xl font-sans animate-fade-in">
            <div className="flex items-center justify-between border-b border-nature-800 pb-4">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-terra-500 to-amber-500 flex items-center justify-center text-xl text-white shadow-lg">
                        🤖
                    </div>
                    <div>
                        <h3 className="text-lg font-bold text-white m-0">Sovereign AI Copilot (`@beanpool/ai`)</h3>
                        <p className="text-xs text-nature-400 m-0 mt-0.5">
                            Autonomous diagnostic assistant & AI moderation intelligence for <code className="text-terra-400 font-mono">{activeNode?.name}</code>.
                        </p>
                    </div>
                </div>
            </div>

            {/* Prompt & Q&A Box */}
            <div className="space-y-4">
                <form onSubmit={handleAsk} className="space-y-3">
                    <label className="block text-xs font-extrabold text-nature-300 uppercase tracking-wider">
                        Ask Node Copilot
                    </label>
                    <div className="flex gap-3">
                        <input
                            type="text"
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            placeholder="e.g. Analyze current node diagnostics and memory health, or check for rate limit risks..."
                            className="flex-1 bg-nature-950 border border-nature-800 px-4 py-3 rounded-xl text-white text-xs focus:outline-none focus:border-terra-500 shadow-inner"
                        />
                        <button
                            type="submit"
                            disabled={loading || !prompt.trim()}
                            className="px-5 py-3 rounded-xl bg-terra-500 hover:bg-terra-600 font-bold text-white text-xs transition-all shadow-md active:scale-95 disabled:opacity-50 shrink-0 flex items-center gap-2"
                        >
                            <span>{loading ? 'Analyzing...' : 'Ask Copilot 🚀'}</span>
                        </button>
                    </div>
                </form>

                {response && (
                    <div className="p-5 rounded-2xl bg-nature-950 border border-nature-800 text-xs text-nature-200 space-y-3 shadow-inner">
                        <div className="flex items-center justify-between border-b border-nature-800/80 pb-2 text-[10px] uppercase font-bold text-terra-400">
                            <span>Sovereign Copilot Output</span>
                            <span className="font-mono">{config.provider.toUpperCase()} ({config.model})</span>
                        </div>
                        <div className="whitespace-pre-wrap font-sans leading-relaxed text-nature-100">
                            {response}
                        </div>
                    </div>
                )}
            </div>

            {/* AI Provider Config */}
            <div className="bg-nature-950/60 border border-nature-800 p-5 rounded-2xl space-y-4 pt-4">
                <div className="flex items-center justify-between">
                    <h4 className="text-xs font-extrabold text-nature-300 uppercase tracking-wider">
                        AI Provider Configuration
                    </h4>
                    <button
                        onClick={handleSaveConfig}
                        className="px-3 py-1.5 rounded-lg bg-nature-800 hover:bg-nature-700 text-white text-xs font-bold transition-all border border-nature-700 active:scale-95"
                    >
                        {saveFeedback ? '✓ Settings Saved' : 'Save AI Config'}
                    </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                    <div>
                        <label className="block text-nature-400 mb-1 font-semibold">LLM Provider:</label>
                        <select
                            value={config.provider}
                            onChange={(e) => setConfig({ ...config, provider: e.target.value as any })}
                            className="w-full bg-nature-900 border border-nature-800 px-3 py-2 rounded-xl text-white font-mono text-xs focus:outline-none focus:border-terra-500"
                        >
                            <option value="ollama">Ollama (Local Node LLM)</option>
                            <option value="openrouter">OpenRouter (Cloud API)</option>
                        </select>
                    </div>

                    <div>
                        <label className="block text-nature-400 mb-1 font-semibold">Base URL / Endpoint:</label>
                        <input
                            type="text"
                            value={config.baseUrl}
                            onChange={(e) => setConfig({ ...config, baseUrl: e.target.value })}
                            placeholder="http://localhost:11434"
                            className="w-full bg-nature-900 border border-nature-800 px-3 py-2 rounded-xl text-white font-mono text-xs focus:outline-none focus:border-terra-500"
                        />
                    </div>

                    <div>
                        <label className="block text-nature-400 mb-1 font-semibold">Model Name:</label>
                        <input
                            type="text"
                            value={config.model}
                            onChange={(e) => setConfig({ ...config, model: e.target.value })}
                            placeholder="llama3:latest"
                            className="w-full bg-nature-900 border border-nature-800 px-3 py-2 rounded-xl text-white font-mono text-xs focus:outline-none focus:border-terra-500"
                        />
                    </div>
                </div>

                {config.provider === 'openrouter' && (
                    <div className="text-xs">
                        <label className="block text-nature-400 mb-1 font-semibold">OpenRouter API Key:</label>
                        <input
                            type="password"
                            value={config.apiKey || ''}
                            onChange={(e) => setConfig({ ...config, apiKey: e.target.value })}
                            placeholder="sk-or-v1-..."
                            className="w-full bg-nature-900 border border-nature-800 px-3 py-2 rounded-xl text-white font-mono text-xs focus:outline-none focus:border-terra-500"
                        />
                    </div>
                )}
            </div>
        </div>
    );
}
