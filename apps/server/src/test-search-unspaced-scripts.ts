/**
 * The posts search finds a word inside Chinese, Japanese and Thai text written without spaces (#1717).
 *
 * posts_fts tokenizes with unicode61, which parts words at spaces and punctuation. Chinese, Japanese and Thai are written
 * without spaces, so "新鲜鸡蛋出售" (fresh eggs for sale) is one token, and the engine's `"鸡蛋"*` asks only for tokens that
 * START with 鸡蛋: a word in the middle of a run was never found, on the phone's Market, the Home saved-search card or the
 * web. The engine now also looks for such a word anywhere in the title or description (posts.ts unspacedSearch).
 *
 * The search of spaced languages is checked unchanged beside it: a word still matches the start of a word ("bik" finds
 * "Bike"), still folds case and accents ("jardin" finds "Jardín"), and still does not match inside a word ("bike" does
 * not find "Motorbike").
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-search-unspaced-scripts.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { db } from './db/db.js';
import { initStateEngine, createPost, getPosts } from './state-engine.js';
import { getPostCount, setMemberPhoto } from '@beanpool/engine';
import { searchTermsFor } from '@beanpool/core';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';

function makeMember(callsign: string): string {
    const pk = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pk, callsign);
    setMemberPhoto(db, pk, AVATAR);
    return pk;
}

/** The titles a search finds, as the Market asks: the member's words through searchTermsFor, then the node's read. */
function found(words: string): string[] {
    const query = searchTermsFor(words).join(' ');
    return getPosts({ query, limit: 500 }).map(p => p.title).sort();
}
const finds = (words: string, title: string) => found(words).includes(title);

async function main(): Promise<void> {
    initStateEngine();
    const author = makeMember('Mei');
    const post = (title: string, description = '', type: 'offer' | 'need' | 'poll' = 'offer') => {
        const p = type === 'poll'
            ? createPost('poll', 'general', title, description, 0, 'fixed', author, undefined, undefined, undefined, undefined, undefined, undefined,
                { pollOptions: [{ id: 'a', text: 'Yes' }, { id: 'b', text: 'No' }] })
            : createPost(type, 'food', title, description, 5, 'fixed', author);
        if (!p) throw new Error(`createPost refused "${title}"`);
        return p;
    };

    post('新鲜鸡蛋出售', '价格面议，周末可以自取。');                // Chinese: fresh eggs for sale; the price is negotiable, collect at the weekend
    post('二手自行车', '');                                          // Chinese: second-hand bicycle
    post('日本語の家庭教師', '');                                    // Japanese: Japanese-language tutor
    post('手作りパン', '毎朝焼きたてのパンを届けます');              // Japanese: home-made bread; fresh bread delivered every morning
    post('ขายไข่ไก่สด', '');                                         // Thai: selling fresh chicken eggs
    post('ซ่อมจักรยาน', 'รับซ่อมทุกยี่ห้อ');                           // Thai: bicycle repair; all brands repaired
    post('Bike repair', 'Tubes and chains');
    post('Motorbike parts', '');
    post('Jardín comunitario', 'Semillas');
    post('Fresh duck eggs', '');
    post('Rice 100% organic', '');
    post('鸡蛋还是鸭蛋？', '', 'poll');                              // a poll about eggs: a goods search leaves polls out

    console.log('\n— Chinese, Japanese and Thai: a word inside a run of text');
    assert(finds('鸡蛋', '新鲜鸡蛋出售'), '"鸡蛋" (eggs) finds "新鲜鸡蛋出售" (fresh eggs for sale), from the middle of the run');
    assert(finds('出售', '新鲜鸡蛋出售'), '"出售" (for sale) finds it from the end of the run');
    assert(finds('蛋', '新鲜鸡蛋出售'), 'one character, "蛋", finds it too');
    assert(finds('自取', '新鲜鸡蛋出售'), 'a word inside the description ("自取", collect yourself) finds it');
    assert(finds('自行车', '二手自行车'), '"自行车" (bicycle) finds "二手自行车" (second-hand bicycle)');
    assert(finds('家庭教師', '日本語の家庭教師'), 'Japanese: "家庭教師" (tutor) finds "日本語の家庭教師"');
    assert(finds('パン', '手作りパン'), 'Japanese katakana: "パン" (bread) finds "手作りパン" (home-made bread)');
    assert(finds('焼きたて', '手作りパン'), 'Japanese: "焼きたて" (freshly baked) finds it in the description');
    assert(finds('ไข่ไก่', 'ขายไข่ไก่สด'), 'Thai: "ไข่ไก่" (chicken eggs) finds "ขายไข่ไก่สด" (selling fresh chicken eggs)');
    assert(finds('จักรยาน', 'ซ่อมจักรยาน'), 'Thai: "จักรยาน" (bicycle) finds "ซ่อมจักรยาน" (bicycle repair)');
    assert(finds('ทุกยี่ห้อ', 'ซ่อมจักรยาน'), 'Thai: "ทุกยี่ห้อ" (all brands) finds it in the description');
    assert(JSON.stringify(found('牛奶')) === '[]', '"牛奶" (milk), in nothing, finds nothing');
    assert(JSON.stringify(found('鸡蛋')) === JSON.stringify(['新鲜鸡蛋出售']), '"鸡蛋" finds the listing only: not the poll that also says 鸡蛋');
    assert(getPosts({ query: '鸭蛋', type: 'poll', limit: 50 }).map(p => p.title).join() === '鸡蛋还是鸭蛋？', 'a search of polls finds the poll by a word inside it (鸭蛋, duck eggs)');
    assert(found('鸡蛋 bike').join('|') === ['Bike repair', '新鲜鸡蛋出售'].sort().join('|'), 'words in two scripts: either one finds a listing, as before');
    assert(found('自行车 ซ่อมจักรยาน').join('|') === ['ซ่อมจักรยาน', '二手自行车'].sort().join('|'), 'two unspaced words: each finds its own listing');

    console.log('\n— What the member types is matched as typed, never as a pattern');
    assert(JSON.stringify(getPosts({ query: '蛋%', limit: 50 }).map(p => p.title)) === '[]', '"蛋%" is 蛋 then a percent sign: it finds nothing, not every listing with 蛋');
    assert(JSON.stringify(getPosts({ query: '鸡_', limit: 50 }).map(p => p.title)) === '[]', '"鸡_" is 鸡 then an underscore: it finds nothing, not 鸡 plus any one character');
    assert(JSON.stringify(getPosts({ query: '鸡\\', limit: 50 }).map(p => p.title)) === '[]', 'a backslash after 鸡 is a backslash, and the read does not fail');

    console.log('\n— Spaced languages: unchanged');
    assert(finds('bik', 'Bike repair'), '"bik" still finds "Bike repair": a word matches the start of a word');
    assert(!finds('bike', 'Motorbike parts'), '"bike" still does not find "Motorbike parts": not the inside of a word');
    assert(finds('jardin', 'Jardín comunitario'), '"jardin" still finds "Jardín comunitario": case and accents fold');
    assert(finds('CHAINS', 'Bike repair'), '"CHAINS" still finds "Bike repair" by its description, whatever the case');
    assert(finds('duck', 'Fresh duck eggs') && !finds('duck', '新鲜鸡蛋出售'), '"duck" finds the duck eggs, and not the Chinese listing');
    assert(JSON.stringify(found('organic')) === JSON.stringify(['Rice 100% organic']), '"organic" finds exactly the listing that says it');

    console.log('\n— The count a read gives agrees with the read');
    assert(getPostCount(db, { query: '鸡蛋' }) === 1, 'getPostCount: "鸡蛋" counts the one listing');
    assert(getPostCount(db, { query: 'ไข่ไก่ 自行车' }) === 2, 'getPostCount: a Thai word and a Chinese word count two');
    assert(getPostCount(db, { query: '蛋%' }) === 0, 'getPostCount: "蛋%" counts nothing');
    assert(getPostCount(db, { query: 'bik' }) === 1, 'getPostCount: "bik" still counts one');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
