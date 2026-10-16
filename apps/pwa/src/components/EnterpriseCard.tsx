/**
 * One enterprise or project on the Commons, as the list draws it (ProjectsPage), and Example Valley's in the Commons
 * preview (ShowcasePreviews CommonsPreview): the same card fed the sample, `sample` adding the 🏘️ Local community pill.
 */
import { useState } from 'react';
import type { Treasury } from '../lib/api';
import { resolveAvatarUrl } from '../lib/avatar';
import { pledgeClosedLine } from '../lib/enterprise-pledge';
import { LocalCommunityPill } from './LocalCommunityMark';

/** Energy Balance sentence (docs/the-commons.md §2.2). */
function energySentence(energyBalance: number): string {
    const beans = Math.round(Math.abs(energyBalance) * 100) / 100;
    if (beans === 0) return 'Square — nothing owed either way';
    return energyBalance > 0
        ? `We owe them ${beans} bean${beans === 1 ? '' : 's'} of work`
        : `They owe us ${beans} bean${beans === 1 ? '' : 's'} of work`;
}

function getDaysRemaining(deadline: string | null | undefined) {
    if (!deadline) return null;
    const diff = new Date(deadline).getTime() - new Date().getTime();
    const days = Math.ceil(diff / (1000 * 60 * 60 * 24));
    if (days < 0) return 'Expired';
    if (days === 0) return 'Ends today';
    return `${days} days left`;
}

export function EnterpriseCard({ treasury: t, onOpen, sample = false }: { treasury: Treasury; onOpen?: (publicKey: string) => void; sample?: boolean }) {
    // Avatar URLs that failed to load; the card shows the no-avatar placeholder instead of alt text.
    const [failedAvatars, setFailedAvatars] = useState<ReadonlySet<string>>(() => new Set());
    const hasGoal = t.goalAmount != null && t.goalAmount > 0;
    const currentRaised = t.currentAmount != null ? t.currentAmount : Math.max(0, t.balance);
    const goal = t.goalAmount || 1;
    const progress = Math.min(100, (currentRaised / goal) * 100);
    const isFunded = hasGoal && (currentRaised >= goal || t.status === 'funded' || t.status === 'completed');
    const daysRemaining = getDaysRemaining(t.deadlineAt);
    const resolvedAvatar = resolveAvatarUrl(t.avatar || t.avatarUrl);
    const avatarSrc = resolvedAvatar && !failedAvatars.has(resolvedAvatar) ? resolvedAvatar : null;

    return (
        <div
            role="button"
            tabIndex={0}
            data-testid={sample ? 'sample-enterprise-card' : undefined}
            onClick={() => onOpen?.(t.publicKey)}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpen?.(t.publicKey);
                }
            }}
            className="bg-nature-900 border border-nature-800 hover:border-emerald-500/50 focus:outline-none focus:ring-2 focus:ring-emerald-500 rounded-2xl p-5 transition-all cursor-pointer shadow-sm hover:shadow-md flex flex-col justify-between group"
        >
            <div className="space-y-3">
                {/* Example Valley's: the pill on its own row, the card's full width (beside the name it ran past the card at 320 px). */}
                {sample && <div><LocalCommunityPill /></div>}
                {/* Top row: Avatar + Name + Lifecycle Tag */}
                <div className="flex items-start gap-3">
                    <div className="w-12 h-12 rounded-xl bg-nature-800 border border-nature-700 flex items-center justify-center overflow-hidden shrink-0 text-xl font-bold text-emerald-400">
                        {avatarSrc ? (
                            <img
                                src={avatarSrc}
                                alt={t.name}
                                onError={() => setFailedAvatars(prev => new Set(prev).add(avatarSrc))}
                                className="w-full h-full object-cover"
                            />
                        ) : (
                            <span>🌱</span>
                        )}
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            {/* The whole name, wrapped: at 320 px with 1.3x text one line held "Example …", and three held no more than
                                "A compost bay by the…" beside the photo. */}
                            <h3 className="font-bold text-base text-white group-hover:text-emerald-400 transition-colors break-words min-w-0">
                                {t.name}
                            </h3>
                            {t.paused && t.status !== 'winding_up' && t.status !== 'completed' && (
                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-amber-500/20 text-amber-400 border-amber-500/40">
                                    ⏸️ Paused
                                </span>
                            )}
                            {t.status === 'winding_up' && (
                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-rose-500/20 text-rose-400 border-rose-500/40">
                                    ⏳ Winding up
                                </span>
                            )}
                            {t.status === 'completed' && (
                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-stone-700 text-stone-300 border-stone-600">
                                    Closed
                                </span>
                            )}
                            {isFunded ? (
                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-emerald-950/50 text-emerald-300 border-emerald-800/60">
                                    🎉 Funded
                                </span>
                            ) : hasGoal || t.lifecycle === 'bounded' ? (
                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-amber-950/50 text-amber-300 border-amber-800/60">
                                    🌱 Project
                                </span>
                            ) : (
                                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-blue-950/50 text-blue-300 border-blue-800/60">
                                    🏛️ Enterprise
                                </span>
                            )}
                        </div>
                        <p className="text-xs text-nature-400 mt-0.5">
                            {t.callsign ? `@${t.callsign} · ` : ''}
                            {t.status === 'completed'
                                ? 'Completed · Closed'
                                : t.status === 'winding_up'
                                    ? 'Winding up'
                                    : t.paused
                                        ? 'Paused for season'
                                        : `${t.liveOffers ?? 0} live offer${(t.liveOffers ?? 0) === 1 ? '' : 's'}`}
                            {t.keepers && t.keepers.length > 0 ? ` · ${t.keepers.length} keeper${t.keepers.length === 1 ? '' : 's'}` : ''}
                        </p>
                    </div>
                </div>

                {/* Purpose statement (docs/the-commons.md §2.1) */}
                <p className="text-xs text-nature-300 line-clamp-2 leading-relaxed">
                    {t.purpose || t.description || 'Community enterprise'}
                </p>

                {/* Energy Balance sentence (docs/the-commons.md §2.2) */}
                {t.balance != null && (
                    <p className="text-[11px] text-nature-400 italic">
                        {energySentence(t.balance)}
                    </p>
                )}

                {/* Financial Ceiling indicator if surplus exists */}
                {t.earnedSurplus != null && t.earnedSurplus > 0 && (
                    <div className="flex items-center gap-1 text-[11px] text-emerald-400">
                        <span>📈</span>
                        <span>Earned Surplus: {t.earnedSurplus} 🫘</span>
                    </div>
                )}
            </div>

            <div className="mt-4 pt-3 border-t border-nature-800 space-y-2">
                {/* Balance Row */}
                <div className="flex justify-between items-center text-xs">
                    <div>
                        <div className="text-[10px] font-bold uppercase tracking-wider text-nature-400">
                            Balance
                        </div>
                        {t.balance < 0 && (
                            <div className="text-[11px] font-bold text-amber-400">
                                in deficit (keepers eat last)
                            </div>
                        )}
                    </div>
                    <div className={`font-black text-sm ${t.balance < 0 ? 'text-amber-400' : 'text-emerald-400'}`}>
                        {t.balance} 🫘
                    </div>
                </div>

                {/* Funding progress if Bounded Project */}
                {hasGoal && (
                    <div className="space-y-1.5 pt-1">
                        <div className="flex justify-between items-end text-xs">
                            <span className={`font-bold ${isFunded ? 'text-emerald-400' : 'text-white'}`}>
                                {currentRaised} 🫘 <span className="font-normal text-nature-400">raised of {t.goalAmount} 🫘</span>
                            </span>
                            {daysRemaining && (
                                <span className={`text-[11px] font-bold ${daysRemaining === 'Expired' ? 'text-red-400' : 'text-nature-400'}`}>
                                    ⏳ {daysRemaining}
                                </span>
                            )}
                        </div>
                        <div className="w-full bg-nature-800 h-2 rounded-full overflow-hidden">
                            <div
                                className={`h-full rounded-full transition-all ${isFunded ? 'bg-emerald-500' : 'bg-emerald-600'}`}
                                style={{ width: `${progress}%` }}
                            />
                        </div>

                        {/* Primary CTA if has goal, not funded, and the enterprise still takes pledges */}
                        {!isFunded && !pledgeClosedLine(t.status) && (
                            <div
                                aria-hidden="true"
                                className="w-full mt-2 py-2 px-3 rounded-xl bg-bp-commit-fill text-bp-commit-on font-bold text-xs shadow-sm flex items-center justify-center gap-1.5 pointer-events-none"
                            >
                                <span>🌱</span> Pledge Beans
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
