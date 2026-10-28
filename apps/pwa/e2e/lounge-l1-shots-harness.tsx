import { createRoot } from 'react-dom/client';
import { FIND_COMMUNITY_WORDS, t, formatDate, communityAnswersLine } from '@beanpool/core';
import { KNOCK_MESSAGES } from '../src/lib/knock';
import '../src/index.css';

const params = new URLSearchParams(window.location.search);
/** The card's state: `waiting` (Cancel), `none` (the community holds nothing: Got it), `cancelled` (a Cancel that worked, this visit). */
const state = params.get('state') ?? 'waiting';
/** HomePage.tsx's FIND_ACTION, the Got it button's class. */
const FIND_ACTION = 'w-full min-h-[44px] px-4 rounded-xl border border-nature-300 dark:border-nature-700 bg-transparent text-sm font-bold text-nature-900 dark:text-white cursor-pointer break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500';

if (params.get('dark') === '1') {
    document.documentElement.classList.add('dark', 'dark-theme');
    document.documentElement.style.colorScheme = 'dark';
} else {
    document.documentElement.classList.remove('dark', 'dark-theme');
    document.documentElement.classList.add('light-theme');
    document.documentElement.style.colorScheme = 'light';
}

function Harness() {
    const k = {
        url: 'https://byron.example.org',
        name: 'Byron Shire BeanPool',
        sentAt: '2026-10-25T00:00:00.000Z',
    };
    const sentDate = formatDate(new Date(k.sentAt), 'day-month-year');
    const arrivedLine = t(FIND_COMMUNITY_WORDS.requestArrived);
    const answersLine = communityAnswersLine('week');

    return (
        <div className="max-w-md mx-auto p-4">
            <section
                data-testid="home-find-card"
                className="bg-white dark:bg-nature-900 rounded-2xl shadow-sm border border-nature-200 dark:border-nature-800 p-4"
            >
                <div className="flex items-baseline justify-between mb-2">
                    <h3 className="m-0 text-base font-semibold text-text-primary">
                        {t('Find your community')}
                    </h3>
                </div>
                <p className="m-0 text-sm text-nature-800 dark:text-nature-200">
                    {t('Connect with people sharing goods and services near you.')}
                </p>

                {/* Honest waiting card (L1) */}
                <div
                    data-testid={`home-waiting-card-${k.url}`}
                    className="mt-3 mb-3 p-3 rounded-xl border border-nature-200 dark:border-nature-700 bg-nature-50 dark:bg-nature-900/40"
                >
                    <p className="m-0 text-sm font-semibold text-text-primary" data-testid={`home-waiting-sent-${k.url}`}>
                        {t(FIND_COMMUNITY_WORDS.askedOnDate, { name: k.name, date: sentDate })}
                    </p>
                    <div role="status">
                        {state === 'cancelled' && (
                            <p dir="auto" className="m-0 mt-1 text-sm text-nature-700 dark:text-nature-200 break-words" data-testid={`home-waiting-cancelled-${k.url}`}>
                                {t(KNOCK_MESSAGES.cancelled)}
                            </p>
                        )}
                    </div>
                    {state !== 'cancelled' && (
                        <p className="m-0 mt-1 text-sm text-nature-700 dark:text-nature-200" data-testid={`home-waiting-arrived-${k.url}`}>
                            {state === 'none' ? t(KNOCK_MESSAGES.none) : arrivedLine}
                        </p>
                    )}
                    {state === 'waiting' && answersLine && (
                        <p className="m-0 mt-1 text-xs italic text-nature-600 dark:text-nature-300" data-testid={`home-waiting-answers-${k.url}`}>
                            {answersLine}
                        </p>
                    )}
                    {state === 'none' && (
                        <div className="mt-2">
                            <button type="button" data-testid={`home-gotit-knock-${k.url}`} className={FIND_ACTION}>
                                {t(FIND_COMMUNITY_WORDS.gotIt)}
                            </button>
                        </div>
                    )}
                    {state === 'waiting' && (
                        <div className="mt-2">
                            <button
                                type="button"
                                data-testid={`home-cancel-knock-${k.url}`}
                                className="min-h-[44px] px-3 py-2 text-sm font-medium rounded-lg border border-red-300 dark:border-red-700 bg-transparent text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                            >
                                {t(FIND_COMMUNITY_WORDS.cancelRequest)}
                            </button>
                        </div>
                    )}
                </div>

                <div className="flex flex-col gap-2 mt-3">
                    {/* HomePage.tsx's own Start a community button (home-find-start), then its Tell me button. */}
                    <button type="button"
                        className="w-full min-h-[44px] px-4 rounded-xl border-0 bg-bp-cta-fill hover:bg-bp-cta-hover text-bp-cta-on text-sm font-bold cursor-pointer break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                        {t(FIND_COMMUNITY_WORDS.start)}
                    </button>
                    <button type="button" className={FIND_ACTION}>
                        {t('Tell me when one starts here')}
                    </button>
                </div>
            </section>
        </div>
    );
}

const root = createRoot(document.getElementById('root')!);
root.render(<Harness />);
