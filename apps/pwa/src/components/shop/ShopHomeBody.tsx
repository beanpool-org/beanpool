/**
 * Home's "Your shop and tools" body on the web (parity with apps/native/components/shop/ShopHomeBody.tsx).
 */
import { t } from '@beanpool/core';
import { HomeLine } from '../HomeCard';
import { shopStateLine, shopTitle, type ShopHomeCard } from '../../lib/shop';

export function ShopHomeBody({
    card,
    onNavigate,
}: {
    card: { shop: ShopHomeCard['shop'] | null };
    onNavigate: (tab: string, ctx?: string) => void;
}) {
    const tools = (
        <HomeLine
            onClick={() => onNavigate('tools')}
            label={t('Tools: things you can do on your own.')}
            testId="home-shop-tools"
        >
            <span className="min-w-0 flex-1">
                <span className="block break-words font-semibold text-nature-900 dark:text-white">{t('Tools')}</span>
                <span className="block text-xs text-nature-600 dark:text-nature-300 break-words">{t('Things you can do on your own')}</span>
            </span>
        </HomeLine>
    );

    if (!card.shop) {
        return (
            <div className="flex flex-col divide-y divide-nature-100 dark:divide-nature-800">
                <HomeLine
                    onClick={() => onNavigate('shop-mine')}
                    label={t('Open your shop: a front window on your own account, for the Offers you choose.')}
                    testId="home-shop-open"
                >
                    <span className="min-w-0 flex-1">
                        <span className="block break-words font-bold text-nature-900 dark:text-white">{t('Open your shop')}</span>
                        <span className="block text-xs text-nature-600 dark:text-nature-300 break-words">
                            {t('A front window on your own account, for the Offers you choose.')}
                        </span>
                    </span>
                </HomeLine>
                {tools}
            </div>
        );
    }

    const title = shopTitle(card.shop);
    const state = shopStateLine(card.shop);

    return (
        <div className="flex flex-col divide-y divide-nature-100 dark:divide-nature-800">
            <HomeLine
                onClick={() => onNavigate('shop-mine')}
                label={t('{shop}: {state}. Opens your shop.', { shop: title, state })}
                testId="home-shop-line"
            >
                <span className="min-w-0 flex-1">
                    <span className="block break-words font-bold text-nature-900 dark:text-white">{title}</span>
                    <span className="block text-xs text-nature-600 dark:text-nature-300 break-words">{state}</span>
                </span>
            </HomeLine>
            {tools}
        </div>
    );
}
