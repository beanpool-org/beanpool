import { describe, expect, it } from 'vitest';
import { LANGS } from '../words.js';
import { GUIDE_FILLER_WORDS, GUIDE_SEARCH_SYNONYMS, searchGuide, type Guide, type GuidePage } from '../member-guide.js';

// Members type questions ("how do I send a gift"), but a page that explains how to send a gift never says "how" or "do".
// So the question and filler words of a query do not have to match (they are dropped before matching), as long as
// something is left to search for: a query made only of them searches as typed. #3101's order (the page named for what is
// typed first) is untouched; guide-search.test.ts pins it.

const page = (slug: string, title: string, summary: string, paragraphs: string[]): GuidePage => ({
    slug, title, summary, section: 'about', related: [], blocks: paragraphs.map(text => ({ type: 'p' as const, text })),
});
const guide = (...guides: GuidePage[]): Guide => ({
    schema: 2, version: 1, hash: 'h',
    sections: [{ id: 'about', title: 'About', summary: 'S', slugs: guides.map(g => g.slug) }],
    guides,
});
const slugs = (g: Guide, q: string) => searchGuide(g, q).map(r => r.page.slug);

const REPEATS = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}: a gift of Beans, and what a gift changes; give a gift and the gift counts.`);
const GIVER = page('credit-risk', 'Credit risk: what it reads', 'What the people who give credit see.', REPEATS);
const GIFTS = page('gifts', 'Sending a gift', 'Send beans to someone, with no trade.', ['A gift cannot be taken back.', 'Gifts have no fee.']);
const HOW = page('how-it-works', 'How BeanPool works', 'Beans, trading and offers.', ['How do you trade? Beans move between members.', 'What is BeanPool? It is the network.']);
const POSTING = page('posting', 'Posting an Offer or a Need', 'Put up something you will give or do for others.', ['Open Market and tap Post.']);
const PULSE = page('the-pulse', 'The Pulse', 'What your neighbours make and share elsewhere, in one feed.', ['A feed of your neighbours.']);
const MAP = page('map-pins', 'What the map shows', 'The pins on the Map.', ['What each pin means.']);
const EN = guide(GIVER, GIFTS, HOW, POSTING, PULSE, MAP);

describe('searchGuide: question and filler words do not have to match', () => {
    it('"how do I send a gift" finds the gifts page first, though the page never says "how" or "do"', () => {
        for (const q of ['how do I send a gift', 'how to send a gift', 'how send gift', 'How can I send a gift?', 'how would I send a gift please']) {
            expect(slugs(EN, q)[0], q).toBe('gifts');
        }
    });

    it('"how do I post an offer" finds the post-an-offer page first', () => {
        for (const q of ['how do I post an offer', 'how to post an offer', 'how do i post a need']) {
            expect(slugs(EN, q)[0], q).toBe('posting');
        }
    });

    it('"what is the pulse" finds the Pulse first; so do "what\'s the pulse" and "where is the pulse"', () => {
        for (const q of ['what is the pulse', "what's the pulse", 'whats the pulse', 'where is the pulse']) {
            expect(slugs(EN, q)[0], q).toBe('the-pulse');
        }
    });

    it('a question that opens a page title keeps finding it: "what the map shows", "how BeanPool works"', () => {
        expect(slugs(EN, 'what the map shows')[0]).toBe('map-pins');
        expect(slugs(EN, 'How BeanPool works')[0]).toBe('how-it-works');
        expect(slugs(EN, 'how it works')[0]).toBe('how-it-works');
    });

    it('#3101 still holds: the page named for the typed word leads, however the question is put', () => {
        for (const q of ['gift', 'gifts', 'give Beans', 'send a gift', 'how do I give beans', 'what is a gift']) {
            expect(slugs(EN, q)[0], q).toBe('gifts');
        }
        expect(slugs(EN, 'what is credit risk')[0]).toBe('credit-risk');
    });

    it('a query that is exactly a page title still leads with that page, though its filler word is not required', () => {
        const yours = page('my-deals', 'Your deals', 'Every trade you are in.', ['Your deals.']);
        const standing = page('standing-deals', 'Standing deals', 'Paying by the week.', Array.from({ length: 6 }, () => 'Standing deals, each deal paid in advance.'));
        const g = guide(standing, yours);
        // Without "your" both pages are named "deals" alike and the higher score puts Standing deals first...
        expect(slugs(g, 'deals')).toEqual(['standing-deals', 'my-deals']);
        // ...but "your deals" is the title of the other one, whether it is typed with other punctuation or case.
        expect(slugs(g, 'your deals')).toEqual(['my-deals', 'standing-deals']);
        expect(slugs(g, 'Your Deals!')).toEqual(['my-deals', 'standing-deals']);
        // Anything more than the title is not the title: the usual order.
        expect(slugs(g, 'what are your deals')).toEqual(['standing-deals', 'my-deals']);
        // The title's translation counts, and so does its English (a page shown in another language).
        const pt = { ...yours, title: 'Os seus negócios', english: { title: 'Your deals' } };
        expect(slugs(guide(standing, pt), 'your deals')[0]).toBe('my-deals');

        // The filler word is not a word of any other page's title: "How to send" is not what "how do I send a gift" asks for.
        const howTo = page('how-to-send', 'How to send', 'Send a gift or a payment.', ['Send beans.']);
        expect(slugs(guide(howTo, GIFTS), 'how do I send a gift')).toEqual(['gifts', 'how-to-send']);
        // ...and a real question never ranks a page just for opening with the same word: "how do I join a community".
        const joining = page('joining', 'Joining BeanPool', 'Two ways in: a community, with an invite.', ['Join a community.', 'Join with an invite.']);
        const works = page('how-your-community-works', 'How this community works', 'Who can join.', ['A community.']);
        expect(slugs(guide(works, joining), 'how do I join a community')[0]).toBe('joining');
        // A query of filler only has nothing left out: the old rules, exactly.
        expect(slugs(guide(GIFTS, HOW, PULSE), 'how')).toEqual(['how-it-works']);
    });

    it('every other word must still match: dropping the filler does not loosen the rest', () => {
        // "send" is on the gifts page and "pulse" on the Pulse page, never on one page.
        expect(slugs(EN, 'how do I send a pulse')).toEqual([]);
        expect(slugs(EN, 'how do I zzqqxx')).toEqual([]);
        expect(slugs(EN, 'what is the zzqqxx')).toEqual([]);
        // ...and a word that is not filler is still required: "hello" and "able" are on no page.
        expect(slugs(EN, 'hello how do I want to be able to send a gift')).toEqual([]);
    });

    it('a query made only of question and filler words searches as typed', () => {
        // Only the page that says both "how" and "do" is found, exactly as before: nothing is dropped, nothing is added.
        expect(slugs(EN, 'how do i')).toEqual(['how-it-works']);
        expect(slugs(EN, 'how do')).toEqual(['how-it-works']);
        expect(slugs(EN, 'how')).toEqual(['how-it-works']);
        // "what is the" finds the pages that have all three words, as typed (the Pulse page has no "is").
        expect(slugs(EN, 'what is the')).toEqual(['how-it-works']);
        expect(slugs(EN, 'zzqqxx how')).toEqual([]);
    });

    it('a long question is not cut short by its filler: the eight-word limit counts what is searched', () => {
        // Ten different words; the first eight are all filler, so "gift" was the ninth and fell off the end.
        expect(slugs(EN, 'how can I do it if I want to send a gift to you')).toEqual(['gifts']);
    });

    it('words in the guide that are also question words in another language are not dropped from a query that needs them', () => {
        // "ban" is a synonym of "block"; "ai" a guide word; neither is a filler in any language.
        const g = guide(
            page('blocking', 'Blocking someone', 'Hide their posts.', ['Block a member.']),
            page('admins-ai', 'When an admin uses an AI assistant', 'What it reads.', ['An AI assistant reads.']),
        );
        expect(slugs(g, 'ban someone')).toEqual(['blocking']);
        expect(slugs(g, 'ai assistant')).toEqual(['admins-ai']);
        expect(slugs(g, 'how do I ban someone')).toEqual(['blocking']);
    });
});

// One question in each language the guide has. The page is titled in that language, the query is a question a member
// would type for it, and nothing on the page says the question words. Before the filler list, every one of these found nothing.
const CASES: Record<Exclude<(typeof LANGS)[number], 'en'>, { title: string; summary: string; query: string; other: string }> = {
    es: { title: 'Enviar un regalo', summary: 'Manda Beans a alguien, sin trato.', query: '¿Cómo puedo enviar un regalo?', other: 'Cómo funciona BeanPool' },
    pt: { title: 'Enviar um presente', summary: 'Envie Beans a alguém, sem troca.', query: 'Como posso enviar um presente?', other: 'Como o BeanPool funciona' },
    fr: { title: 'Envoyer un don', summary: 'Envoyer des Beans à quelqu\'un, sans échange.', query: 'Comment puis-je envoyer un don ?', other: 'Comment BeanPool fonctionne' },
    it: { title: 'Inviare un dono', summary: 'Invia Beans a qualcuno, senza scambio.', query: 'Come posso inviare un dono?', other: 'Come funziona BeanPool' },
    de: { title: 'Bohnen schenken', summary: 'Beans an jemanden schicken, ohne Handel.', query: 'Wie kann ich Bohnen schenken?', other: 'Wie BeanPool funktioniert' },
    ru: { title: 'Отправить подарок', summary: 'Отправьте Beans кому-то, без сделки.', query: 'Как мне отправить подарок?', other: 'Как работает BeanPool' },
    uk: { title: 'Надіслати подарунок', summary: 'Надішліть Beans комусь, без угоди.', query: 'Як мені надіслати подарунок?', other: 'Як працює BeanPool' },
    tr: { title: 'Hediye gönderme', summary: 'Birine Beans gönder, takas olmadan.', query: 'Hediye gönderme nasıl yapılır?', other: 'BeanPool nasıl çalışır' },
    id: { title: 'Mengirim hadiah', summary: 'Kirim Beans ke seseorang, tanpa perdagangan.', query: 'Bagaimana cara mengirim hadiah?', other: 'Bagaimana BeanPool bekerja' },
    fil: { title: 'Magpadala ng regalo', summary: 'Magpadala ng Beans sa isang tao.', query: 'Paano magpadala ng regalo?', other: 'Paano gumagana ang BeanPool' },
    sw: { title: 'Kutuma zawadi', summary: 'Tuma Beans kwa mtu, bila biashara.', query: 'Jinsi ya kutuma zawadi?', other: 'Jinsi BeanPool inavyofanya kazi' },
    vi: { title: 'Gửi quà tặng', summary: 'Gửi Beans cho ai đó, không giao dịch.', query: 'Làm thế nào để gửi quà tặng?', other: 'BeanPool hoạt động như thế nào' },
    el: { title: 'Αποστολή δώρου', summary: 'Στείλτε Beans σε κάποιον, χωρίς συναλλαγή.', query: 'Πώς μπορώ να κάνω αποστολή δώρου;', other: 'Πώς λειτουργεί το BeanPool' },
    ar: { title: 'إرسال هدية', summary: 'أرسل Beans إلى شخص، بدون تبادل.', query: 'كيف يمكنني إرسال هدية؟', other: 'كيف يعمل BeanPool' },
    fa: { title: 'ارسال هدیه', summary: 'Beans را برای کسی بفرستید.', query: 'چگونه هدیه ارسال کنم؟', other: 'BeanPool چگونه کار می‌کند' },
    ur: { title: 'تحفہ بھیجنا', summary: 'کسی کو Beans بھیجیں، بغیر تجارت کے۔', query: 'تحفہ کیسے بھیج سکتا ہوں؟', other: 'BeanPool کیسے کام کرتا ہے' },
    hi: { title: 'उपहार भेजना', summary: 'किसी को Beans भेजें, बिना लेन-देन के।', query: 'उपहार भेजना कैसे करें?', other: 'BeanPool कैसे काम करता है' },
    bn: { title: 'উপহার পাঠানো', summary: 'কাউকে Beans পাঠান, লেনদেন ছাড়া।', query: 'উপহার পাঠানো কিভাবে করব?', other: 'BeanPool কিভাবে কাজ করে' },
    ta: { title: 'பரிசு அனுப்புதல்', summary: 'ஒருவருக்கு Beans அனுப்பவும்.', query: 'பரிசு அனுப்புதல் எப்படி செய்வது?', other: 'BeanPool எப்படி செயல்படுகிறது' },
    ml: { title: 'സമ്മാനം അയയ്ക്കൽ', summary: 'ഒരാൾക്ക് Beans അയയ്ക്കുക.', query: 'സമ്മാനം അയയ്ക്കൽ എങ്ങനെ ചെയ്യാം?', other: 'BeanPool എങ്ങനെ പ്രവർത്തിക്കുന്നു' },
    ja: { title: 'ギフトを送る', summary: '取引なしで誰かにBeansを送る。', query: 'どうやって ギフトを送る', other: 'どうやって BeanPool は動く' },
    ko: { title: '선물 보내기', summary: '거래 없이 누군가에게 Beans를 보냅니다.', query: '선물 보내기 어떻게 하나요?', other: '어떻게 BeanPool이 작동하나요' },
    'zh-Hans': { title: '赠送豆子', summary: '不经交易，把豆子送给别人。', query: '怎么 赠送豆子？', other: '怎么 使用 BeanPool' },
    'zh-Hant': { title: '贈送豆子', summary: '不經交易，把豆子送給別人。', query: '怎麼 贈送豆子', other: '怎麼 使用 BeanPool' },
};

describe('searchGuide: the question words of each language the guide has', () => {
    it('the table has every language but English, and nothing else', () => {
        expect(Object.keys(CASES).sort()).toEqual(LANGS.filter(l => l !== 'en').sort());
    });

    for (const [lang, c] of Object.entries(CASES)) {
        it(`${lang}: "${c.query}" finds the page titled "${c.title}"`, () => {
            const target = page('gifts', c.title, c.summary, ['x']);
            // The other page says the question words in its title, so before they were dropped it could only be found by them.
            const other = page('how-it-works', c.other, 'Beans.', ['y']);
            expect(slugs(guide(other, target), c.query)).toEqual(['gifts']);
        });
    }
});

describe('GUIDE_FILLER_WORDS', () => {
    it('has a list for every language, English included, and each entry is one word', () => {
        expect(Object.keys(GUIDE_FILLER_WORDS).sort()).toEqual([...LANGS].sort());
        for (const lang of LANGS) {
            const list = GUIDE_FILLER_WORDS[lang];
            expect(list.length, lang).toBeGreaterThan(5);
            for (const w of list) {
                expect(/^[^\s!-/:-@[-`{-~]+$/.test(w), `${lang} ${w}: one word, no punctuation`).toBe(true);
                expect(w.length, `${lang} ${w}: a one-letter word is never searched, so never listed`).toBeGreaterThanOrEqual(2);
            }
        }
    });

    it('no filler word is a word members search by: not a synonym, nor a word a synonym stands for', () => {
        // Lists are used together, whatever the language of the query, so Vietnamese "ban" (you) must not drop English "ban".
        const fold = (w: string) => w.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
        const searchedBy = new Set(Object.entries(GUIDE_SEARCH_SYNONYMS).flatMap(([typed, said]) => [typed, ...said]));
        expect(searchedBy.size).toBeGreaterThan(20);
        for (const lang of LANGS) {
            for (const w of GUIDE_FILLER_WORDS[lang]) expect(searchedBy.has(fold(w)), `${lang} ${w}`).toBe(false);
        }
    });

    it('holds the question words a member types in English', () => {
        for (const w of ['how', 'do', 'does', 'to', 'the', 'can', 'what', 'where', 'when', 'is', 'are', 'of', 'for', 'in', 'on', 'it', 'with', 'you', 'your', 'my', 'me', 'an']) {
            expect(GUIDE_FILLER_WORDS.en, w).toContain(w);
        }
    });
});
