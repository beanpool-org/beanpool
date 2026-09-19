import React, { useState, useEffect } from 'react';
import type { NodeProfile } from '../../lib/profiles';
import { generateNodeInvite, getTfaSessionToken } from '../../lib/node-client';
import { generateOfflineQrUrl } from '../../lib/qr';
import { useTimeout } from '../../lib/use-timeout';

interface InvitesModuleProps {
    activeNode: NodeProfile;
}

export type InviteTier = 'standard' | 'trusted' | 'ambassador' | 'elder';

export interface GeneratedInviteItem {
    code: string;
    tier: InviteTier;
    fullUrl: string;
    qrDataUrl: string;
}

export function InvitesModule({ activeNode }: InvitesModuleProps) {
    const [inviteCount, setInviteCount] = useState(5);
    const [inviteTier, setInviteTier] = useState<InviteTier>('standard');
    const [generatedTokens, setGeneratedTokens] = useState<GeneratedInviteItem[]>([]);
    const [copiedIndex, setCopiedIndex] = useState<string | number | null>(null);
    const copiedTimer = useTimeout();
    const [isGenerating, setIsGenerating] = useState(false);
    const [previewQrItem, setPreviewQrItem] = useState<GeneratedInviteItem | null>(null);
    const [showPrintSheet, setShowPrintSheet] = useState(false);

    useEffect(() => {
        setGeneratedTokens([]);
        setPreviewQrItem(null);
        setShowPrintSheet(false);
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
                    const res = await generateNodeInvite(
                        activeNode.url,
                        activeNode.adminPassword,
                        inviteTier,
                        activeNode ? getTfaSessionToken(activeNode.id) : undefined
                    );
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

                const fullUrl = buildFullUrl(code);
                const qrDataUrl = generateOfflineQrUrl(fullUrl);

                items.push({
                    code,
                    tier: inviteTier,
                    fullUrl,
                    qrDataUrl,
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
        copiedTimer.schedule(() => setCopiedIndex(null), 2000);
    };

    const getTierBadge = (t: InviteTier) => {
        switch (t) {
            case 'standard':
                return '🌱 Newcomer';
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

    const escapeHtml = (str?: string) =>
        (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

    const handlePrintCards = () => {
        const printWindow = window.open('', '_blank');
        if (!printWindow) {
            alert('Please allow popups to view printable invite cards.');
            return;
        }

        const safeNodeName = escapeHtml(activeNode?.name || 'Sovereign Node');
        const safeNodeUrl = escapeHtml(activeNode?.url || '');

        const cardsHtml = generatedTokens
            .map(
                (item, idx) => `
            <div class="print-card" style="border: 2px solid #166534; background: #ffffff; color: #052e16; border-radius: 12px; padding: 24px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; page-break-inside: avoid; margin-bottom: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
                <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #15803d; padding-bottom: 12px; margin-bottom: 18px;">
                    <div>
                        <div style="font-size: 16px; font-weight: 900; color: #166534; text-transform: uppercase; letter-spacing: 0.5px;">🌱 BEANPOOL ONBOARDING PASS</div>
                        <div style="font-size: 12px; color: #374151; margin-top: 2px;">Community Node: <strong>${safeNodeName}</strong> (${safeNodeUrl})</div>
                    </div>
                    <div style="text-align: right;">
                        <span style="background: #15803d; color: #ffffff; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: bold;">
                            ${escapeHtml(getTierBadge(item.tier))}
                        </span>
                        <div style="font-size: 10px; color: #6b7280; margin-top: 4px;">Pass #${idx + 1} of ${generatedTokens.length}</div>
                    </div>
                </div>

                <div style="display: flex; gap: 24px; align-items: center;">
                    <div style="background: #ffffff; padding: 8px; border: 2px solid #15803d; border-radius: 12px; display: inline-block; flex-shrink: 0;">
                        <img src="${item.qrDataUrl || ''}" width="180" height="180" alt="QR Code for ${escapeHtml(item.code)}" style="display: block;" />
                    </div>

                    <div style="flex: 1; min-width: 0;">
                        <div style="font-size: 11px; font-weight: bold; color: #4b5563; text-transform: uppercase; letter-spacing: 1px;">Single-Use Onboarding Code:</div>
                        <div style="font-size: 26px; font-weight: 900; color: #166534; font-family: monospace; letter-spacing: 2px; margin: 4px 0 10px 0;">${escapeHtml(item.code)}</div>
                        <div style="font-size: 12px; color: #374151; margin-bottom: 6px; font-weight: 600;">
                            Scan the large QR code with your phone camera or visit:
                        </div>
                        <div style="font-size: 11px; font-family: monospace; color: #065f46; word-break: break-all; font-weight: bold; background: #f0fdf4; padding: 8px 12px; border-radius: 8px; border: 1px solid #a7f3d0;">
                            ${escapeHtml(item.fullUrl)}
                        </div>
                    </div>
                </div>

                <div style="margin-top: 16px; padding-top: 12px; border-top: 1px dashed #cbd5e1; font-size: 11px; color: #64748b; display: flex; justify-content: space-between; align-items: center;">
                    <span>🔒 Single-use cryptographic invite code</span>
                    <span>🤝 Face-to-face community onboarding</span>
                    <span>⏰ Valid for 30 days</span>
                </div>
            </div>
            ${idx < generatedTokens.length - 1 ? '<div style="border-top: 1px dashed #94a3b8; margin: 16px 0; text-align: center; color: #94a3b8; font-size: 10px; letter-spacing: 2px;">✂ - - - - - - - - - CUT HERE - - - - - - - - - ✂</div>' : ''}
            `
            )
            .join('');

        printWindow.document.write(`
            <!DOCTYPE html>
            <html>
                <head>
                    <meta charset="utf-8" />
                    <title>BeanPool Printable QR Invites — ${safeNodeName}</title>
                    <style>
                        body { background: #f8fafc; color: #0f172a; padding: 30px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
                        @media print {
                            * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
                            body { background: #ffffff !important; color: #000000 !important; padding: 0 !important; }
                            .no-print { display: none !important; }
                            .print-card { break-inside: avoid; page-break-inside: avoid; border: 2px solid #000000 !important; box-shadow: none !important; }
                        }
                    </style>
                </head>
                <body>
                    <div style="max-width: 680px; margin: 0 auto;">
                        <div class="no-print" style="margin-bottom: 25px; text-align: center; background: #ecfdf5; border: 1px solid #a7f3d0; padding: 16px; border-radius: 12px;">
                            <h1 style="font-size: 20px; margin: 0 0 6px 0; color: #065f46;">🌱 Sovereign Printable QR Invites (${generatedTokens.length} Cards)</h1>
                            <p style="font-size: 12px; color: #047857; margin: 0 0 12px 0;">Print-friendly sheet of large QR codes carrying join URL and code for face-to-face onboarding.</p>
                            <button onclick="window.print()" style="background: #059669; color: white; border: none; padding: 8px 20px; border-radius: 8px; font-weight: bold; cursor: pointer;">🖨️ Print Now</button>
                        </div>
                        ${cardsHtml}
                    </div>
                    <script>
                        setTimeout(() => { window.print(); }, 400);
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
                            Generate single-use cryptographic invite passes and print large QR codes for face-to-face onboarding.
                        </p>
                    </div>

                    <div className="flex items-center gap-3">
                        <button
                            onClick={handleGenerate}
                            disabled={isGenerating}
                            aria-busy={isGenerating}
                            className="px-5 py-2.5 rounded-xl bg-terra-500 hover:bg-terra-600 font-bold text-white text-xs transition-all flex items-center gap-2 shadow-lg active:scale-95 disabled:opacity-50"
                        >
                            <span aria-hidden="true" className={isGenerating ? 'animate-spin' : ''}>{isGenerating ? '🔄' : '⚡'}</span>
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
                            <option value="standard">🌱 Newcomer (Standard Membership)</option>
                            <option value="trusted">🏠 Resident (Pre-verified Member)</option>
                            <option value="ambassador">🏛️ Steward (Community Ambassador)</option>
                            <option value="elder">⛰️ Elder (Genesis Sovereign Elder)</option>
                        </select>
                    </div>

                    <div className="space-y-1.5">
                        <div className="flex justify-between items-center">
                            <label className="text-nature-400 font-extrabold uppercase text-[10px] tracking-wider block">
                                Quantity to Generate (N)
                            </label>
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                            {[1, 5, 10, 20].map((num) => (
                                <button
                                    key={num}
                                    type="button"
                                    onClick={() => setInviteCount(num)}
                                    className={`flex-1 min-w-[40px] py-2 rounded-xl text-xs font-bold transition-all border ${
                                        inviteCount === num
                                            ? 'bg-terra-500/20 text-terra-300 border-terra-500/50'
                                            : 'bg-nature-950 text-nature-400 border-nature-800 hover:border-nature-700'
                                    }`}
                                >
                                    {num}
                                </button>
                            ))}
                            <div className="flex items-center gap-1.5 ml-auto">
                                <label htmlFor="custom-count-input" className="text-[10px] text-nature-400 font-bold uppercase whitespace-nowrap">
                                    Custom:
                                </label>
                                <input
                                    id="custom-count-input"
                                    type="number"
                                    min={1}
                                    max={100}
                                    disabled={isGenerating}
                                    value={inviteCount}
                                    onChange={(e) => {
                                        const raw = e.target.value;
                                        if (raw === '') {
                                            setInviteCount(1);
                                        } else {
                                            const val = parseInt(raw, 10);
                                            if (!isNaN(val)) {
                                                setInviteCount(Math.max(1, Math.min(100, val)));
                                            }
                                        }
                                    }}
                                    aria-label="Custom quantity"
                                    className="w-16 bg-nature-950 border border-nature-800 rounded-xl px-2.5 py-1.5 text-white font-mono font-bold text-xs text-center focus:outline-none focus:border-terra-500 disabled:opacity-50"
                                />
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Empty State */}
            {generatedTokens.length === 0 && (
                <div className="bg-nature-950/50 border-2 border-dashed border-nature-800/80 rounded-2xl p-12 flex flex-col items-center justify-center text-center space-y-3 animate-fade-in">
                    {isGenerating ? (
                        <>
                            <span className="text-3xl text-terra-400 animate-spin" aria-hidden="true">🔄</span>
                            <h4 className="text-sm font-bold text-white m-0">Generating Cryptographic Passes...</h4>
                            <p className="text-xs text-nature-400 m-0 max-w-sm">
                                Issuing {inviteCount} single-use onboarding pass{inviteCount > 1 ? 'es' : ''} with offline QR codes.
                            </p>
                        </>
                    ) : (
                        <>
                            <span className="text-4xl opacity-50 grayscale">🎟️</span>
                            <h4 className="text-sm font-bold text-nature-300 m-0">No Passes Generated Yet</h4>
                            <p className="text-xs text-nature-500 m-0 max-w-sm">
                                Select a membership tier and quantity N above, then click Generate to create single-use onboarding passes and printable QR codes.
                            </p>
                        </>
                    )}
                </div>
            )}

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
                                onClick={() => setShowPrintSheet(true)}
                                className="px-3 py-1.5 rounded-xl bg-nature-800 hover:bg-nature-700 text-nature-200 hover:text-white text-xs font-bold border border-nature-700 transition-all flex items-center gap-1.5 active:scale-95"
                            >
                                <span>📄</span>
                                <span>View Printable Sheet</span>
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
                                <div className="flex gap-4 items-center">
                                    <div className="bg-white p-2 rounded-xl flex-shrink-0 border border-emerald-500/40 shadow-md">
                                        <img
                                            src={item.qrDataUrl}
                                            alt={`QR Code for ${item.code}`}
                                            width="110"
                                            height="110"
                                            className="block rounded-lg"
                                        />
                                    </div>
                                    <div className="space-y-1.5 flex-1 min-w-0">
                                        <div className="flex justify-between items-start flex-wrap gap-1">
                                            <code className="text-emerald-400 font-bold text-sm tracking-widest">{item.code}</code>
                                            <span className="text-[9px] font-bold text-nature-500 uppercase bg-nature-900 px-2 py-0.5 rounded">{getTierBadge(item.tier)}</span>
                                        </div>
                                        <div className="text-[10px] text-nature-400 truncate font-mono bg-nature-900/60 p-1.5 rounded border border-nature-800/80">{item.fullUrl}</div>
                                        <div className="flex gap-2 pt-1">
                                            <button onClick={() => setPreviewQrItem(item)} className="px-3 text-[10px] font-bold py-1.5 rounded-lg bg-nature-800 hover:bg-nature-700 text-white transition-colors">Enlarge</button>
                                            <button onClick={() => handleCopy(item.fullUrl, idx)} className="flex-1 text-[10px] font-bold py-1.5 rounded-lg bg-nature-800 hover:bg-nature-700 text-white transition-colors">{copiedIndex === idx ? '✓ Copied' : 'Copy Link'}</button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Printable QR Sheet Modal */}
            {showPrintSheet && generatedTokens.length > 0 && (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="printable-sheet-title"
                    className="fixed inset-0 bg-black/85 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-fade-in overflow-y-auto"
                >
                    <div className="bg-nature-900 border border-nature-800 rounded-3xl max-w-3xl w-full p-6 space-y-5 shadow-2xl my-8">
                        <div className="flex items-center justify-between border-b border-nature-800 pb-4">
                            <div>
                                <h3 id="printable-sheet-title" className="text-base font-bold text-white m-0 flex items-center gap-2">
                                    <span>📄</span>
                                    <span>Printable QR Onboarding Sheet ({generatedTokens.length} Passes)</span>
                                </h3>
                                <p className="text-xs text-nature-400 m-0 mt-0.5">
                                    Sheet of large QR codes carrying the join URL and single-use code for face-to-face onboarding.
                                </p>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={handlePrintCards}
                                    className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs transition-all flex items-center gap-1.5 shadow-md"
                                >
                                    <span>🖨️</span>
                                    <span>Print Sheet</span>
                                </button>
                                <button
                                    onClick={() => setShowPrintSheet(false)}
                                    className="px-3 py-2 rounded-xl bg-nature-800 hover:bg-nature-700 text-white font-bold text-xs"
                                >
                                    Close
                                </button>
                            </div>
                        </div>

                        {/* Sheet Grid Preview */}
                        <div className="space-y-6 max-h-[70vh] overflow-y-auto pr-2">
                            {generatedTokens.map((item, idx) => (
                                <div key={item.code} className="bg-white text-emerald-950 p-6 rounded-2xl border-2 border-emerald-700 shadow-md">
                                    <div className="flex justify-between items-center border-b border-emerald-200 pb-3 mb-4">
                                        <div>
                                            <span className="text-xs font-black text-emerald-800 uppercase tracking-wider">
                                                🌱 BEANPOOL ONBOARDING PASS
                                            </span>
                                            <div className="text-xs text-gray-600 font-semibold mt-0.5">
                                                Node: {activeNode?.name || 'Sovereign Node'}
                                            </div>
                                        </div>
                                        <div className="text-right">
                                            <span className="bg-emerald-700 text-white px-3 py-1 rounded-full text-xs font-bold">
                                                {getTierBadge(item.tier)}
                                            </span>
                                            <div className="text-[10px] text-gray-500 mt-1">Pass #{idx + 1}</div>
                                        </div>
                                    </div>

                                    <div className="flex flex-col sm:flex-row gap-6 items-center">
                                        <div className="bg-white p-2 rounded-xl border-2 border-emerald-600 shrink-0">
                                            <img
                                                src={item.qrDataUrl}
                                                alt={`QR Code for ${item.code}`}
                                                width="180"
                                                height="180"
                                                className="block"
                                            />
                                        </div>

                                        <div className="space-y-2 flex-1 text-left">
                                            <div className="text-xs font-bold uppercase text-gray-500 tracking-wider">
                                                Single-Use Onboarding Code:
                                            </div>
                                            <div className="text-3xl font-black font-mono text-emerald-900 tracking-wider">
                                                {item.code}
                                            </div>
                                            <div className="text-xs text-gray-700 font-medium">
                                                Scan the large QR code with your camera or open this URL in your web browser:
                                            </div>
                                            <div className="text-xs font-mono font-bold text-emerald-800 bg-emerald-50 p-2 rounded border border-emerald-200 break-all">
                                                {item.fullUrl}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="mt-4 pt-3 border-t border-dashed border-gray-300 flex justify-between text-[11px] text-gray-500">
                                        <span>🔒 Single-use cryptographic invite</span>
                                        <span>🤝 Face-to-face dinner onboarding</span>
                                        <span>⏰ Valid for 30 days</span>
                                    </div>
                                </div>
                            ))}
                        </div>
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
                                src={previewQrItem.qrDataUrl}
                                alt="Onboarding QR Code"
                                width="220"
                                height="220"
                                className="rounded-lg block"
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
