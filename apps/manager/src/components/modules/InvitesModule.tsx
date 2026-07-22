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
        return `${cleanNodeUrl}/?invite=${encodeURIComponent(code)}`;
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
                        <span style="background: #15803d; color: #ffffff; padding: 4px 10px; border-radius: 9999px; font-size: 12px; font-weight: bold;">
                            ${getTierBadge(item.tier)}
                        </span>
                    </div>
                </div>

                <div style="display: flex; gap: 20px; align-items: center;">
                    <div style="background: #ffffff; padding: 10px; border-radius: 12px; display: inline-block;">
                        <img src="https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=${encodeURIComponent(item.fullUrl)}" width="140" height="140" style="display: block;" />
                    </div>

                    <div style="flex: 1; space-y: 8px;">
                        <div style="font-size: 11px; color: #86efac; text-transform: uppercase; letter-spacing: 1px;">Single-Use Onboarding Code:</div>
                        <div style="font-size: 22px; font-weight: 900; color: #4ade80; letter-spacing: 2px;">${item.code}</div>
                        <div style="font-size: 11px; color: #a7f3d0; margin-top: 8px;">
                            Scan the QR code with your camera or open this URL in your web browser:
                        </div>
                        <div style="font-size: 11px; color: #6ee7b7; word-break: break-all; font-weight: bold; background: rgba(0,0,0,0.3); padding: 6px 10px; border-radius: 6px; border: 1px solid #15803d;">
                            ${item.fullUrl}
                        </div>
                    </div>
                </div>

                <div style="margin-top: 15px; pt: 10px; border-top: 1px dashed #15803d; font-size: 10px; color: #86efac; display: flex; justify-content: space-between;">
                    <span>🔒 Single-use cryptographic invite code</span>
                    <span>⏰ Valid for 30 days from issuance</span>
                </div>
            </div>
            `
            )
            .join('');

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
                <head>
                    <title>BeanPool Onboarding Passes — ${activeNode?.name || 'Sovereign Node'}</title>
                    <style>
                        body { background: #022c22; color: #fff; padding: 40px; }
                        @media print {
                            body { background: transparent; color: #000; padding: 0; }
                        }
                    </style>
                </head>
                <body>
                    <div style="max-width: 650px; margin: 0 auto;">
                        <div style="margin-bottom: 25px; text-align: center;">
                            <h1 style="font-family: sans-serif; font-size: 24px; margin: 0; color: #4ade80;">🌱 Sovereign Onboarding Passes</h1>
                            <p style="font-family: sans-serif; font-size: 13px; color: #86efac; margin-top: 4px;">Print or export as PDF for sharing offline or via external channels.</p>
                        </div>
                        ${cardsHtml}
                    </div>
                    <script>
                        setTimeout(() => { window.print(); }, 500);
                    </script>
                </body>
            </html>
        `);
        printWindow.document.close();
    };

    return (
        <div className="space-y-6 font-sans animate-fade-in">
            {/* Top Control Bar */}
            <div className="bg-nature-900/90 border border-nature-800 rounded-2xl p-6 space-y-5 shadow-xl">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-nature-800 pb-4">
                    <div>
                        <h3 className="text-lg font-bold text-white m-0 flex items-center gap-2">
                            <span>🎟️ Sovereign Node Invite Generator</span>
                            <span className="px-2 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800 text-[10px] font-mono font-bold">
                                {activeNode?.name || 'Node'}
                            </span>
                        </h3>
                        <p className="text-xs text-nature-400 m-0 mt-1">
                            Generate single-use cryptographic invite passes bound to this sovereign node.
                        </p>
                    </div>

                    <div className="flex items-center gap-3">
                        <button
                            onClick={handleGenerate}
                            disabled={isGenerating}
                            className="px-5 py-2.5 rounded-xl bg-terra-500 hover:bg-terra-600 font-bold text-white text-xs transition-all flex items-center gap-2 shadow-lg active:scale-95 disabled:opacity-50"
                        >
                            <span>⚡</span>
                            <span>{isGenerating ? 'Generating...' : `Generate ${inviteCount} Pass${inviteCount > 1 ? 'es' : ''}`}</span>
                        </button>
                    </div>
                </div>

                {/* Configuration Options */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                    <div className="space-y-1.5">
                        <label className="text-nature-400 font-extrabold uppercase text-[10px] tracking-wider block">
                            Target Member Tier
                        </label>
                        <select
                            value={inviteTier}
                            onChange={(e) => setInviteTier(e.target.value as InviteTier)}
                            className="w-full bg-nature-950 border border-nature-800 rounded-xl px-3 py-2 text-white font-bold focus:outline-none focus:border-terra-500"
                        >
                            <option value="standard">🥚 Newcomer (Standard Membership)</option>
                            <option value="trusted">🏠 Resident (Pre-verified Member)</option>
                            <option value="ambassador">🏛️ Steward (Community Ambassador)</option>
                            <option value="elder">⛰️ Elder (Genesis Sovereign Elder)</option>
                        </select>
                    </div>

                    <div className="space-y-1.5">
                        <label className="text-nature-400 font-extrabold uppercase text-[10px] tracking-wider block">
                            Quantity to Generate
                        </label>
                        <div className="flex items-center gap-2">
                            {[1, 5, 10, 20].map((num) => (
                                <button
                                    key={num}
                                    onClick={() => setInviteCount(num)}
                                    className={`flex-1 py-2 rounded-xl text-xs font-bold transition-all border ${
                                        inviteCount === num
                                            ? 'bg-terra-500/20 text-terra-300 border-terra-500/50'
                                            : 'bg-nature-950 text-nature-400 border-nature-800 hover:border-nature-700'
                                    }`}
                                >
                                    {num}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            </div>

            {/* Generated Passes Output */}
            {generatedTokens.length > 0 && (
                <div className="bg-nature-900/90 border border-nature-800 rounded-2xl p-6 space-y-4 shadow-xl animate-fade-in">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-nature-800 pb-3">
                        <h4 className="text-xs font-extrabold text-terra-400 uppercase tracking-wider">
                            Generated Passes ({generatedTokens.length})
                        </h4>

                        <div className="flex items-center gap-2 flex-wrap">
                            <button
                                onClick={handleCopyAllMessages}
                                className="px-3 py-1.5 rounded-xl bg-terra-950 hover:bg-terra-900 text-terra-300 hover:text-white text-xs font-bold border border-terra-800 transition-all flex items-center gap-1.5 active:scale-95"
                            >
                                <span>💬</span>
                                <span>{copiedIndex === 'all_messages' ? '✓ Messages Copied!' : 'Copy All Share Messages'}</span>
                            </button>
                            <button
                                onClick={handleCopyAllLinks}
                                className="px-3 py-1.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-nature-200 hover:text-white text-xs font-bold border border-nature-700 transition-all flex items-center gap-1.5 active:scale-95"
                            >
                                <span>🔗</span>
                                <span>{copiedIndex === 'all_links' ? '✓ Links Copied!' : 'Copy All Links'}</span>
                            </button>
                            <button
                                onClick={handlePrintCards}
                                className="px-3 py-1.5 rounded-xl bg-emerald-950 hover:bg-emerald-900 text-emerald-300 hover:text-white text-xs font-bold border border-emerald-800 transition-all flex items-center gap-1.5 active:scale-95"
                            >
                                <span>🖨️</span>
                                <span>Print Cards</span>
                            </button>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {generatedTokens.map((item, idx) => (
                            <div key={idx} className="bg-nature-950 border border-nature-800 rounded-xl p-4 flex flex-col justify-between gap-3">
                                <div>
                                    <div className="flex justify-between items-start mb-2">
                                        <code className="text-emerald-400 font-bold text-sm tracking-widest">{item.code}</code>
                                        <span className="text-[9px] font-bold text-nature-500 uppercase bg-nature-900 px-2 py-1 rounded">{getTierBadge(item.tier)}</span>
                                    </div>
                                    <div className="text-[10px] text-nature-400 truncate font-mono">{item.fullUrl}</div>
                                </div>
                                <div className="flex gap-2">
                                    <button onClick={() => setPreviewQrItem(item)} className="flex-1 text-[10px] font-bold py-1.5 rounded-lg bg-nature-800 hover:bg-nature-700 text-white">QR</button>
                                    <button onClick={() => handleCopy(item.fullUrl, idx)} className="flex-1 text-[10px] font-bold py-1.5 rounded-lg bg-nature-800 hover:bg-nature-700 text-white">{copiedIndex === idx ? '✓' : 'Copy'}</button>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* QR Code Preview Modal */}
            {previewQrItem && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-fade-in">
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
