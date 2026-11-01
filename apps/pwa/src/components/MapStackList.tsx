import { useEffect, useRef } from 'react';
import { stackHeading, t } from '@beanpool/core';
import type { StackPin } from '../lib/map-stack';

/**
 * The pins of a bubble that cannot split (Marty, 2 Nov; the phone's components/MapStackList.tsx is its twin): a panel over
 * the bottom half of the map, every pin a compact row, whether 3 or 100. A row opens that post; ✕, Escape or a tap on the
 * map closes the panel. The map under it does not move. Focus goes to the header, so a screen reader says the count and a
 * keyboard carries on into the rows.
 */
export function MapStackList({ pins, covered, onClose }: { pins: readonly StackPin[]; covered: boolean; onClose: () => void }) {
    const headingRef = useRef<HTMLHeadingElement>(null);
    useEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, []);

    return (
        <section
            data-testid="map-stack-list"
            aria-labelledby="map-stack-heading"
            className="absolute bottom-0 left-0 right-0 z-[150] flex flex-col overflow-hidden bg-white dark:bg-nature-900 rounded-t-[20px] border-t border-nature-200 dark:border-nature-800 shadow-[0_-8px_20px_rgba(0,0,0,0.15)]"
            // The bottom half of the map a member can see: on a phone the nav bar sits over the last of it.
            style={{
                height: 'calc((100% - var(--bottom-nav-offset, 0px)) / 2 + var(--bottom-nav-offset, 0px))',
                paddingBottom: 'var(--bottom-nav-offset, 0px)',
                ...(covered ? { display: 'none' } : {}),
            }}
        >
            <header className="flex items-center gap-1 pl-4 pr-1 min-h-[52px] flex-shrink-0 border-b border-nature-200 dark:border-nature-800">
                <h2
                    id="map-stack-heading"
                    ref={headingRef}
                    tabIndex={-1}
                    // Not a control: it takes focus so the count is read out, and a ring round it would say it can be pressed.
                    style={{ outline: 'none' }}
                    className="m-0 py-2 flex-1 min-w-0 break-words text-base font-extrabold text-gray-900 dark:text-white"
                >
                    {stackHeading(pins.length)}
                </h2>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label={t('Close')}
                    className="flex-shrink-0 min-h-[44px] min-w-[44px] bg-transparent border-none text-sm font-extrabold text-gray-600 dark:text-gray-300"
                >
                    ✕
                </button>
            </header>
            <ul className="m-0 p-0 list-none flex-1 min-h-0 overflow-y-auto overscroll-contain">
                {pins.map((pin) => (
                    <li key={pin.key} className="border-b border-nature-100 dark:border-nature-800 [content-visibility:auto] [contain-intrinsic-size:auto_72px]">
                        <button
                            type="button"
                            onClick={pin.open}
                            className="w-full min-h-[72px] flex items-center gap-3 px-4 py-2 bg-transparent border-none text-left hover:bg-nature-50 dark:hover:bg-nature-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500"
                        >
                            <span className="flex-shrink-0 w-[56px] h-[56px] rounded-[10px] overflow-hidden bg-nature-100 dark:bg-nature-800 flex items-center justify-center" aria-hidden="true">
                                {pin.photo
                                    ? <img src={pin.photo} alt="" loading="lazy" className="w-full h-full object-cover" />
                                    : <span className="text-2xl">{pin.emoji}</span>}
                            </span>
                            <span className="flex-1 min-w-0 flex flex-col">
                                <span className="text-[0.9375rem] font-bold leading-snug text-gray-900 dark:text-white break-words line-clamp-2">{pin.title}</span>
                                <span className="mt-0.5 text-[0.8125rem] font-semibold text-gray-600 dark:text-gray-300">{pin.type}</span>
                                {pin.when && <span className="mt-0.5 text-[0.8125rem] font-bold leading-snug text-violet-800 dark:text-violet-200 break-words">{pin.when}</span>}
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
        </section>
    );
}
