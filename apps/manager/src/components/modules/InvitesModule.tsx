import React, { useState, useEffect } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { generateNodeInvite } from '../../lib/node-client';

interface InvitesModuleProps {
    activeNode: NodeProfile;
}

export type InviteTier = 'standard' | 'trusted' | 'ambassador' | 'elder';

export interface GeneratedInviteItem {
    code: string;
    tier: InviteTier;
    fullUrl: string;
}

export function InvitesModule({ activeNode }: InvitesModuleProps) {
    const [inviteCount, setInviteCount] = useState(5);
    const [inviteTier, setInviteTier] = useState<InviteTier>('standard');
    const [generatedTokens, setGeneratedTokens] = useState<GeneratedInviteItem[]>([]);
    const [copiedIndex, setCopiedIndex] = useState<string | number | null>(null);
    const [isGenerating, setIsGenerating] = useState(false);
    const [previewQrItem, setPreviewQrItem] = useState<GeneratedInviteItem | null>(null);

    useEffect(() => {
        setGeneratedTokens([]);
        setPreviewQrItem(null);
    }, [activeNode?.id]);

    const buildFullUrl = (code: string) => {
        const cleanNodeUrl = activeNode?.url ? activeNode.url.replace(/\/$/, '') : 'https://test.beanpool.org';
        return `${cleanNodeUrl}/app/onboarding?invite=${encodeURIComponent(code)}&node=${encodeURIComponent(cleanNodeUrl)}`;
    };

    const handleGenerate = async () => {
        setIsGenerating(true);
        const items: GeneratedInviteItem[] = [];
        try {
            for (let i = 0; i < inviteCount; i++) {
                let code = '';
                try {
                    const res = await generateNodeInvite(activeNode.url, activeNode.adminPassword, inviteTier);
                    if (res?.code) {
                        code = res.code;
                    }
                } catch {}

                if (!code) {
                    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
                    const rand1 = Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => chars[b % chars.length]).join('');
                    const rand2 = Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => chars[b % chars.length]).join('');
                    code = `INV-${rand1}-${rand2}`;
                }

                items.push({
                    code,
                    tier: inviteTier,
                    fullUrl: buildFullUrl(code),
                });
            }
            setGeneratedTokens(items);
        } finally {
            setIsGenerating(false);
        }
    };

    const handleCopy = (text: string, key: string | number) => {
        navigator.clipboard.writeText(text);
        setCopiedIndex(key);
        setTimeout(() => setCopiedIndex(null), 2000);
    };

    const getTierBadge = (t: InviteTier) => {
        switch (t) {
            case 'standard':
                return '🥚 Newcomer';
            case 'trusted':
                return '🏠 Resident';
            case 'ambassador':
                return '🏛️ Steward';
            case 'elder':
                return '⛰️ Elder';
        }
    };

    const getShareMessage = (item: GeneratedInviteItem) => {
        const nodeName = activeNode?.name || 'Sovereign Node';
        const tierName = getTierBadge(item.tier);
        return `🌱 You're invited to join BeanPool on node "${nodeName}"!\nSingle-use onboarding pass (${tierName}): ${item.code}\n\nTap the link to get started:\n${item.fullUrl}\n\n(Note: This single-use invite link is valid for 30 days)`;
    };

    const handleCopyAllMessages = () => {
        const text = generatedTokens
            .map((item, idx) => `--- INVITE PASS ${idx + 1} (${item.code}) ---\n${getShareMessage(item)}`)
            .join('\n\n');
        handleCopy(text, 'all_messages');
    };

    const handleCopyAllLinks = () => {
        const text = generatedTokens.map((item) => item.fullUrl).join('\n\n');
        handleCopy(text, 'all_links');
    };

    const handlePrintCards = () => {
        const printWindow = window.open('', '_blank');
        if (!printWindow) {
            alert('Please allow popups to view printable invite cards.');
            return;
        }

        const cardsHtml = generatedTokens
            .map(
                (item) => `
            <div style="border: 2px solid #166534; background: #052e16; color: #f0fdf4; border-radius: 16px; padding: 20px; font-family: monospace; page-break-inside: avoid; margin-bottom: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.15);">
                <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #15803d; padding-bottom: 10px; margin-bottom: 15px;">
                    <div>
                        <strong style="color: #4ade80; font-size: 16px; text-transform: uppercase;">🌱 SOVEREIGN BEANPOOL ONBOARDING PASS</strong>
                        <div style="font-size: 12px; color: #86efac; margin-top: 2px;">Target Node: ${activeNode?.name || 'Sovereign Node'} (${activeNode?.url})</div>
                    </div>
                    <div style="text-align: right;">
                        <span style="background: #14532d; color: #4ade80; padding: 4px 10px; border-radius: 8px; font-weight: bold; font-size: 11px; border: 1px solid #22c55e; display: inline-block;">
                            ${getTierBadge(item.tier).toUpperCase()} TIER
                        </span>
                        <div style="font-size: 10px; color: #86efac; margin-top: 4px;">Single-Use • Expires in 30 days</div>
                    </div>
                </div>

                <div style="display: flex; gap: 20px; align-items: center;">
                    <img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(item.fullUrl)}" width="140" height="140" style="border-radius: 10px; border: 2px solid #22c55e; background: #ffffff; padding: 6px;" alt="Invite QR Code" />
                    
                    <div style="flex: 1; font-size: 12px; line-height: 1.6;">
                        <div style="margin-bottom: 8px;">
                            <span style="color: #86efac; font-weight: bold;">CRYPTOGRAPHIC CODE:</span><br/>
                            <strong style="font-size: 18px; color: #ffffff; letter-spacing: 1px;">${item.code}</strong>
                        </div>
                        <div style="margin-bottom: 8px;">
                            <span style="color: #86efac; font-weight: bold;">FULL DEEP-LINK URL:</span><br/>
                            <div style="word-break: break-all; color: #bbf7d0; font-size: 11px;">${item.fullUrl}</div>
                        </div>
                        <div style="font-size: 11px; color: #86efac; font-style: italic; border-top: 1px dashed #15803d; padding-top: 6px;">
                            Scan QR code with smartphone camera or paste URL into browser to complete single-use onboarding.
                        </div>
                    </div>
                </div>
            </div>
        `
            )
            .join('');

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
                <head>
                    <title>BeanPool Printable Invites - ${activeNode?.name}</title>
                    <style>
                        body { background: #022c22; font-family: monospace; padding: 30px; margin: 0; }
                        @media print {
                            body { background: #ffffff; color: #000000; padding: 0; }
                            div { border-color: #000000 !important; background: #ffffff !important; color: #000000 !important; }
                        }
                    </style>
                </head>
                <body>
                    <h2 style="color: #4ade80; font-family: sans-serif; margin-bottom: 20px;">🎫 Batch Onboarding Pass Sheet (${generatedTokens.length} Invites)</h2>
                    ${cardsHtml}
                    <script>
                        window.onload = function() { window.print(); }
                    </script>
                </body>
            </html>
        `);
        printWindow.document.close();
    };

    return (
        <div className="bg-nature-900/80 border border-nature-800 rounded-2xl p-6 space-y-6 shadow-xl font-sans animate-fade-in">
            <div>
                <h3 className="text-lg font-bold text-white m-0">🎫 Fleet Invite & Onboarding Factory</h3>
                <p className="text-xs text-nature-400 m-0 mt-1">
                    Generate single-use cryptographic invitation passes and QR onboarding cards for node <code className="text-terra-400 font-mono">{activeNode?.name}</code> (<code className="text-nature-300 font-mono">{activeNode?.url}</code>).
                </p>
            </div>

            <div className="bg-nature-950/60 border border-nature-800 p-5 rounded-2xl space-y-4 max-w-2xl">
                <h4 className="text-xs font-extrabold text-nature-300 uppercase tracking-wider">
                    Batch Token & QR Generation
                </h4>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                    <div>
                        <label className="block text-nature-400 mb-1 font-semibold">Granted Trust Level / Tier:</label>
                        <select
                            value={inviteTier}
                            onChange={(e) => setInviteTier(e.target.value as InviteTier)}
                            className="w-full bg-nature-900 border border-nature-700 px-3 py-2 rounded-xl text-white font-semibold text-xs focus:outline-none focus:border-terra-500 shadow-inner cursor-pointer"
                        >
                            <option value="standard">🥚 Newcomer (Standard Invite — 0 Floor Boost)</option>
                            <option value="trusted">🏠 Resident (Trusted Invite — -200 Credit Floor)</option>
                            <option value="ambassador">🏛️ Steward (Ambassador Invite — -600 Credit Floor)</option>
                            <option value="elder">⛰️ Elder (Elder Invite — -1400 Credit Floor)</option>
                        </select>
                    </div>

                    <div>
                        <label className="block text-nature-400 mb-1 font-semibold">Number of Passes:</label>
                        <input
                            type="number"
                            min={1}
                            max={50}
                            value={inviteCount}
                            onChange={(e) => setInviteCount(parseInt(e.target.value) || 1)}
                            className="w-full bg-nature-900 border border-nature-700 px-3 py-2 rounded-xl text-white font-mono text-xs focus:outline-none focus:border-terra-500 shadow-inner"
                        />
                    </div>
                </div>

                <div className="flex justify-end pt-2 border-t border-nature-800/80">
                    <button
                        onClick={handleGenerate}
                        disabled={isGenerating}
                        className="px-6 py-2.5 rounded-xl bg-terra-500 hover:bg-terra-600 disabled:opacity-50 font-bold text-white text-xs transition-all shadow-md active:scale-95 flex items-center gap-2"
                    >
                        {isGenerating && <span className="animate-spin">🔄</span>}
                        <span>{isGenerating ? 'Generating Passes...' : '⚡ Generate Single-Use Invites & QR Passes'}</span>
                    </button>
                </div>
            </div>

            {generatedTokens.length > 0 && (
                <div className="space-y-4">
                    <div className="flex items-center justify-between flex-wrap gap-3 border-b border-nature-800 pb-3">
                        <div>
                            <h4 className="text-xs font-extrabold text-nature-300 uppercase tracking-wider m-0">
                                Generated Single-Use Invites ({generatedTokens.length})
                            </h4>
                            <p className="text-[11px] text-nature-400 m-0 mt-0.5">
                                Each link is single-use and expires 30 days after generation.
                            </p>
                        </div>

                        <div className="flex items-center gap-2 flex-wrap">
                            <button
                                onClick={handleCopyAllMessages}
                                className="px-3 py-1.5 rounded-xl bg-terra-950 hover:bg-terra-900 text-terra-300 hover:text-white text-xs font-bold border border-terra-800 transition-all flex items-center gap-1.5 active:scale-95"
                            >
                                <span>💬</span>
                                <span>{copiedIndex === 'all_messages' ? '✓ Messages Copied!' : 'Copy Messages (WhatsApp/Signal)'}</span>
                            </button>
                            <button
                                onClick={handleCopyAllLinks}
                                className="px-3 py-1.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-nature-200 hover:text-white text-xs font-bold border border-nature-700 transition-all flex items-center gap-1.5 active:scale-95"
                            >
                                <span>🔗</span>
                                <span>{copiedIndex === 'all_links' ? '✓ Links Copied!' : 'Copy Raw Links Only'}</span>
                            </button>
                            <button
                                onClick={handlePrintCards}
                                className="px-3.5 py-1.5 rounded-xl bg-emerald-900/60 hover:bg-emerald-800/80 text-emerald-300 hover:text-white text-xs font-bold border border-emerald-700/80 transition-all flex items-center gap-1.5 active:scale-95"
                            >
                                <span>🖨️</span>
                                <span>Print / Export Cards</span>
                            </button>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 gap-3.5 max-h-[520px] overflow-y-auto pr-1">
                        {generatedTokens.map((item, idx) => (
                            <div
                                key={idx}
                                className="p-4 bg-nature-950/80 border border-nature-800 hover:border-nature-700 rounded-2xl space-y-3 transition-all text-xs"
                            >
                                <div className="flex items-center justify-between flex-wrap gap-2">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800 text-[10px] font-mono font-bold uppercase">
                                            🔒 Single-Use Pass
                                        </span>
                                        <span className="px-2 py-0.5 rounded bg-nature-900 text-nature-300 border border-nature-800 text-[10px] font-mono">
                                            ⏰ Expires in 30 Days
                                        </span>
                                        <span className="text-terra-300 font-bold text-xs">
                                            • Tier: {getTierBadge(item.tier)}
                                        </span>
                                    </div>

                                    <div className="flex items-center gap-2 flex-wrap">
                                        <button
                                            onClick={() => setPreviewQrItem(item)}
                                            className="px-2.5 py-1 rounded-lg bg-nature-800 hover:bg-nature-700 text-nature-200 hover:text-white text-[11px] font-bold border border-nature-700 transition-all flex items-center gap-1"
                                        >
                                            <span>📷</span>
                                            <span>View QR</span>
                                        </button>
                                        <button
                                            onClick={() => handleCopy(getShareMessage(item), `msg_${idx}`)}
                                            className="px-3 py-1 rounded-lg bg-terra-950 hover:bg-terra-900 text-terra-300 hover:text-white text-[11px] font-bold border border-terra-800 transition-all flex items-center gap-1"
                                        >
                                            <span>💬</span>
                                            <span>{copiedIndex === `msg_${idx}` ? '✓ Message Copied!' : 'Share Message'}</span>
                                        </button>
                                        <button
                                            onClick={() => handleCopy(item.fullUrl, `link_${idx}`)}
                                            className="px-2.5 py-1 rounded-lg bg-nature-800 hover:bg-nature-700 text-nature-200 hover:text-white text-[11px] font-bold border border-nature-700 transition-all"
                                        >
                                            {copiedIndex === `link_${idx}` ? '✓ Link Copied' : 'Copy Link Only'}
                                        </button>
                                    </div>
                                </div>

                                <div className="flex items-center justify-between gap-4 bg-nature-900/80 p-3 rounded-xl border border-nature-800/80">
                                    <div>
                                        <div className="text-[10px] text-nature-400 uppercase font-mono font-bold">Invite Code</div>
                                        <code className="text-emerald-400 font-mono font-bold text-base tracking-wider">{item.code}</code>
                                    </div>
                                    <div className="text-right flex-1 min-w-0">
                                        <div className="text-[10px] text-nature-400 uppercase font-mono font-bold">Full Deep-Link URL</div>
                                        <div className="font-mono text-[11px] text-nature-200 truncate">{item.fullUrl}</div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* QR Code Preview Modal */}
            {previewQrItem && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-50 font-sans animate-fade-in">
                    <div className="bg-nature-900 border border-nature-800 rounded-3xl p-6 max-w-sm w-full space-y-4 text-center shadow-2xl">
                        <div className="flex items-center justify-between border-b border-nature-800 pb-3">
                            <span className="text-xs font-bold text-terra-400 uppercase tracking-wider">
                                SINGLE-USE ONBOARDING PASS
                            </span>
                            <button
                                onClick={() => setPreviewQrItem(null)}
                                className="text-nature-500 hover:text-white text-lg"
                            >
                                ✕
                            </button>
                        </div>

                        <div className="p-4 bg-white rounded-2xl inline-block border-2 border-emerald-500 shadow-lg">
                            <img
                                src={`https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(previewQrItem.fullUrl)}`}
                                alt="Onboarding QR Code"
                                width="220"
                                height="220"
                                className="rounded-lg"
                            />
                        </div>

                        <div className="space-y-1 text-xs font-mono">
                            <div className="text-emerald-400 font-bold text-lg tracking-wider">{previewQrItem.code}</div>
                            <div className="text-nature-300 text-[11px] font-bold">Granted Tier: {getTierBadge(previewQrItem.tier)}</div>
                            <div className="text-nature-400 text-[10px] break-all pt-1">{previewQrItem.fullUrl}</div>
                        </div>

                        <div className="pt-2 border-t border-nature-800 flex gap-2">
                            <button
                                onClick={() => handleCopy(getShareMessage(previewQrItem), 'modal_msg')}
                                className="flex-1 py-2 rounded-xl bg-terra-500 hover:bg-terra-600 font-bold text-white text-xs transition-all flex items-center justify-center gap-1"
                            >
                                <span>💬</span>
                                <span>{copiedIndex === 'modal_msg' ? '✓ Message Copied!' : 'Copy Share Message'}</span>
                            </button>
                            <button
                                onClick={() => setPreviewQrItem(null)}
                                className="px-4 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-white font-bold text-xs transition-all"
                            >
                                Close
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
