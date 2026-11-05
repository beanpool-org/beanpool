import React, { useEffect, useState } from 'react';
import { buildAdminHeaders, resolveNodeApiUrl } from '../../lib/node-client';
import { historyLineWords, voucherPanelHeader, type VoucherCard } from '../../lib/voucher-words';

export interface MemberVoucherPanelProps {
    nodeUrl: string;
    pubkey: string;
    displayName: string;
    adminPassword?: string;
    tfaToken?: string;
    initialCard?: VoucherCard | null;
}

export function MemberVoucherPanel({
    nodeUrl,
    pubkey,
    displayName: _displayName,
    adminPassword,
    tfaToken,
    initialCard,
}: MemberVoucherPanelProps) {
    const [card, setCard] = useState<VoucherCard | null>(initialCard ?? null);
    const [loading, setLoading] = useState(initialCard === undefined);

    useEffect(() => {
        if (initialCard !== undefined) {
            setCard(initialCard);
            setLoading(false);
            return;
        }
        let mounted = true;
        setLoading(true);
        const endpoint = resolveNodeApiUrl(nodeUrl, `/api/names/vouchers/${encodeURIComponent(pubkey)}`);
        fetch(endpoint, {
            headers: buildAdminHeaders(adminPassword, tfaToken),
        })
            .then((res) => {
                if (!res.ok) return null;
                return res.json();
            })
            .then((data: VoucherCard | null) => {
                if (!mounted) return;
                setCard(data && typeof data === 'object' && typeof data.left === 'number' ? data : null);
                setLoading(false);
            })
            .catch(() => {
                if (!mounted) return;
                setCard(null);
                setLoading(false);
            });

        return () => {
            mounted = false;
        };
    }, [nodeUrl, pubkey, adminPassword, tfaToken, initialCard]);

    if (loading || !card) return null;

    const header = voucherPanelHeader(card);

    return (
        <section
            aria-label="Voucher details"
            data-testid="member-voucher-panel"
            className="p-3 rounded-2xl bg-nature-900/60 border border-nature-800 space-y-2 text-xs"
        >
            <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-nature-200" data-testid="voucher-panel-header">
                    {header}
                </span>
            </div>

            <div className="min-w-0 border-t border-nature-800 pt-2" data-testid="voucher-budget-history">
                <p className="m-0 font-bold text-nature-300">Budget history</p>
                {card.history && card.history.length > 0 ? (
                    <ul className="m-0 mt-1 p-0 list-none space-y-1">
                        {card.history.map((h, i) => (
                            <li
                                key={`${h.at}-${h.kind}-${i}`}
                                className="min-w-0 text-nature-200 leading-relaxed break-words"
                            >
                                {historyLineWords(h)}
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="m-0 mt-1 text-nature-400">No budget history yet.</p>
                )}
            </div>
        </section>
    );
}
