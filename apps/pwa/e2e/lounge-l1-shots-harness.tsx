import { createRoot } from 'react-dom/client';
import { FIND_COMMUNITY_WORDS, t, formatDate, communityAnswersLine } from '@beanpool/core';
import '../src/index.css';

const params = new URLSearchParams(window.location.search);

if (params.get('dark') === '1') {
    document.documentElement.classList.add('dark');
} else {
    document.documentElement.classList.remove('dark');
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
                    <p className="m-0 mt-1 text-sm text-nature-700 dark:text-nature-200" data-testid={`home-waiting-arrived-${k.url}`}>
                        {arrivedLine}
                    </p>
                    {answersLine && (
                        <p className="m-0 mt-1 text-xs italic text-nature-600 dark:text-nature-300" data-testid={`home-waiting-answers-${k.url}`}>
                            {answersLine}
                        </p>
                    )}
                    <div className="mt-2">
                        <button
                            type="button"
                            data-testid={`home-cancel-knock-${k.url}`}
                            className="min-h-[44px] px-3 py-2 text-sm font-medium rounded-lg border border-red-300 dark:border-red-700 bg-transparent text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                        >
                            {t(FIND_COMMUNITY_WORDS.cancelRequest)}
                        </button>
                    </div>
                </div>

                <div className="flex gap-2 mt-3">
                    <button
                        type="button"
                        className="min-h-[44px] px-4 py-2 text-sm font-medium rounded-lg bg-nature-800 text-white dark:bg-nature-100 dark:text-nature-900"
                    >
                        {t('Communities near you')}
                    </button>
                    <button
                        type="button"
                        className="min-h-[44px] px-4 py-2 text-sm font-medium rounded-lg border border-nature-300 dark:border-nature-700 bg-transparent text-text-primary"
                    >
                        {t(FIND_COMMUNITY_WORDS.start)}
                    </button>
                </div>
            </section>
        </div>
    );
}

const root = createRoot(document.getElementById('root')!);
root.render(<Harness />);
