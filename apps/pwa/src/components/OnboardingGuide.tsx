/**
 * The "how BeanPool works" guide cards. Shared so first-run onboarding and the
 * re-runnable profile setup show identical content — edit the explanation here.
 */
export function OnboardingGuide() {
    return (
        <div className="text-left space-y-4">
            {/* Card 1: Energy Exchange */}
            <div className="p-4 rounded-xl border border-nature-200 dark:border-nature-800 bg-nature-50/50 dark:bg-nature-950/50">
                <h4 className="font-bold text-sm mb-1 text-nature-950 dark:text-oat-50">⚡ Energy Exchange Marketplace</h4>
                <p className="text-xs text-nature-600 dark:text-nature-400 leading-relaxed">
                    BeanPool runs on cooperation, not accumulation. The goal is to keep energy flowing.
                </p>
                <div className="mt-3 p-3 rounded-lg border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/50 dark:bg-emerald-950/20 text-emerald-800 dark:text-emerald-300 text-xs leading-normal">
                    🟢 <strong>The best place to be is zero (0 Beans).</strong> This means you have given as much value to your community as you have received from it.
                </div>
                <div className="mt-3 p-3 rounded-lg border border-amber-200 dark:border-amber-900/50 bg-amber-50/50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300 text-xs leading-normal">
                    🫘 <strong>Contributions First.</strong> To keep the credit pool healthy, you must list at least one Offer of what you can give back before you can post Needs or accept Offers from others.
                </div>
            </div>

            {/* Card 2: The Ledger Rules */}
            <div className="p-4 rounded-xl border border-nature-200 dark:border-nature-800 bg-nature-50/50 dark:bg-nature-950/50 space-y-4">
                <h4 className="font-bold text-sm text-nature-950 dark:text-oat-50">🪙 The Mutual Credit Ledger</h4>

                <div className="flex gap-3 items-start">
                    <span className="text-lg leading-none">🤝</span>
                    <div>
                        <h5 className="font-bold text-xs text-nature-850 dark:text-nature-300">Trust-Backed Credit</h5>
                        <p className="text-[11px] text-nature-500 dark:text-nature-400 leading-relaxed">
                            Everyone starts with a 0 Bean limit. Complete your first real marketplace trade and your community credit line opens — then it deepens steadily with the value you trade and the people you trade with, up to -2000 Beans. No interest, no bank fees.
                        </p>
                    </div>
                </div>

                <div className="flex gap-3 items-start border-t border-nature-100 dark:border-nature-900 pt-3">
                    <span className="text-lg leading-none">🌾</span>
                    <div>
                        <h5 className="font-bold text-xs text-nature-850 dark:text-nature-300">Community Commons Pool</h5>
                        <p className="text-[11px] text-nature-500 dark:text-nature-400 leading-relaxed">
                            Positive balances above 200 Beans decay by 1.5% monthly (progressive circulation). This prevents hoarding and funds local community projects.
                        </p>
                    </div>
                </div>

                <div className="flex gap-3 items-start border-t border-nature-100 dark:border-nature-900 pt-3">
                    <span className="text-lg leading-none">⏱️</span>
                    <div>
                        <h5 className="font-bold text-xs text-nature-850 dark:text-nature-300">Reference Rate</h5>
                        <p className="text-[11px] text-nature-500 dark:text-nature-400 leading-relaxed">
                            40 Beans represents roughly 1 hour of community service or time, helping you easily value what you offer or need.
                        </p>
                    </div>
                </div>
            </div>

            {/* Card 3: Safe Handshake Held in Trust */}
            <div className="p-4 rounded-xl border border-nature-200 dark:border-nature-800 bg-nature-50/50 dark:bg-nature-950/50">
                <h4 className="font-bold text-sm mb-1 text-nature-950 dark:text-oat-50">🔒 Held in Trust</h4>
                <p className="text-xs text-nature-600 dark:text-nature-400 leading-relaxed">
                    To ensure fairness, when you accept an offer or request a job, your credits are safely held in a temporary Trust Wallet. They are only released to the provider once you confirm delivery.
                </p>
            </div>

            {/* Card 4: Where to Start */}
            <div className="p-4 rounded-xl border border-nature-200 dark:border-nature-800 bg-nature-50/50 dark:bg-nature-950/50 space-y-2">
                <h4 className="font-bold text-sm text-nature-950 dark:text-oat-50">🚀 Where to Start?</h4>
                <p className="text-xs text-nature-600 dark:text-nature-400 leading-relaxed">
                    📍 Explore the <strong>Map</strong> to find offers (blue) and needs (orange) near you.
                </p>
                <p className="text-xs text-nature-600 dark:text-nature-400 leading-relaxed">
                    💬 Tap <strong>Message</strong> on any post to chat securely (E2E encrypted) with neighbors.
                </p>
                <p className="text-xs text-nature-600 dark:text-nature-400 leading-relaxed">
                    ➕ Click <strong>Post</strong> to list what you need or what you can offer to the community.
                </p>
                <p className="text-xs text-nature-600 dark:text-nature-400 leading-relaxed">
                    💳 Use the <strong>Ledger</strong> tab to send credits to neighbors instantly.
                </p>
            </div>
        </div>
    );
}

export default OnboardingGuide;
