import { createRoot } from 'react-dom/client';
import { SharePostButtons } from '../src/components/SharePost';
import type { MarketplacePost } from '../src/lib/api';
import '../src/index.css';

const params = new URLSearchParams(window.location.search);
const row = params.get('row') || '1';
if (params.get('dark') === '1') {
    document.documentElement.classList.add('dark', 'dark-theme');
    document.documentElement.classList.remove('light-theme');
    document.documentElement.style.colorScheme = 'dark';
} else {
    document.documentElement.classList.add('light-theme');
    document.documentElement.classList.remove('dark', 'dark-theme');
    document.documentElement.style.colorScheme = 'light';
}

let mockFeatures: Record<string, unknown> = {};
let mockRole: string | null = 'member';

if (row === '1') {
    // Row 1: Sharing outside on
    mockFeatures = { door: 'members', shareOutside: true, knocks: true };
    mockRole = 'member';
} else if (row === '2') {
    // Row 2: Sharing outside off, any member may invite
    mockFeatures = { door: 'members', shareOutside: false };
    mockRole = 'member';
} else if (row === '3') {
    // Row 3: Sharing outside off, only admins invite, member not an admin
    mockFeatures = { door: 'admins', shareOutside: false };
    mockRole = 'member';
}

// Mock APIs before render
const origFetch = window.fetch;
window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
    if (url.includes('/api/community/info')) {
        return new Response(JSON.stringify({
            name: 'Castlemaine BeanPool',
            features: mockFeatures,
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }
    if (url.includes('/api/node-admin/me')) {
        return new Response(JSON.stringify({ role: mockRole }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    }
    try {
        return await origFetch(input, init);
    } catch {
        return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
};

const samplePost: MarketplacePost = {
    id: 'post-1234',
    type: 'offer',
    category: 'tools',
    title: 'Long ladder to lend',
    status: 'active',
    active: true,
    audienceScope: 'public',
    description: 'A 6 m extension ladder, light enough for one person.',
    credits: 15,
    createdAt: new Date().toISOString(),
    authorPublicKey: 'pk-sample-author',
    authorCallsign: 'Alice',
    repeatable: false,
};

function Harness() {
    return (
        <div className="w-[320px] mx-auto p-3">
            <div className="bg-white dark:bg-nature-900 rounded-2xl p-4 shadow-sm border border-nature-200 dark:border-nature-800">
                <div className="text-base font-bold text-nature-950 dark:text-white mb-1">
                    {samplePost.title}
                </div>
                <div className="text-sm text-text-secondary mb-3">
                    {samplePost.description}
                </div>
                <SharePostButtons post={samplePost} />
            </div>
        </div>
    );
}

createRoot(document.getElementById('root')!).render(<Harness />);
