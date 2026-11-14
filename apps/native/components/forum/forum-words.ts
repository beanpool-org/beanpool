/**
 * The forum's words on the phone (slice F3): the very sentences the web app's forum says (apps/pwa/src/pages/ForumPage.tsx and
 * components/forum/), so both apps read the same lines from core's catalogs in every language. A line only one app has is
 * named in the PR.
 */
import { word, wordn } from '@beanpool/core';

export const FORUM_WORDS = {
    allSections: word('All sections'),
    pickSection: word('Section to show'),
    newTopic: word('＋ New topic'),
    firstLooks: word('Waiting for a first look ({n}) ›'),
    none: word('No topics here yet. Start the first one.'),
    more: word('Show more topics'),
    replies: wordn('{n} reply', '{n} replies'),
    unread: word('New replies'),
    waitingMine: word('Your first topic “{title}” is waiting for a first look.'),
    usually: wordn('Usually within {n} hour.', 'Usually within {n} hours.'),
    withdraw: word('Withdraw it'),
    sentForLook: word('Thank you. A moderator looks at your first topic before it shows. You’ll hear by the bell.'),
    failed: word('Couldn’t load the forum. Check your connection and try again.'),
    again: word('Try again'),
    archived: word('{name} (archived)'),
};

export const TOPIC_WORDS = {
    back: word('Back to the forum'),
    removedByWriter: word('Removed by its writer'),
    removedByModerator: word('Removed by a moderator'),
    removedTopic: word('A removed topic'),
    hidden: word('Hidden while moderators look'),
    edited: word('edited'),
    closed: word('This topic is closed, so it takes no new replies.'),
    writeReply: word('Write a reply…'),
    send: word('Send'),
    replyingTo: word('Replying to {name}: {words}'),
    quoteLine: word('{name}: {words}'),
    cancelQuote: word('Don’t quote'),
    moreReplies: word('Show more replies'),
    follow: word('Follow this topic'),
    following: word('Following: tap to stop'),
    mute: word('Mute this topic'),
    unmute: word('Unmute this topic'),
    close: word('Close this topic'),
    topicMenu: word('More for this topic'),
    postMenu: word('More for this post'),
    reply: word('Reply'),
    copy: word('Copy'),
    report: word('Report'),
    block: word('Block {name}'),
    remove: word('Remove'),
    blockSure: word('Block {name}? You won’t see their posts or messages. You can unblock them in Settings.'),
    goneBlocked: word('You blocked {name}, so their topic no longer shows for you.'),
    removeSure: word('Remove this post? Its words and photos go for everyone.'),
    reportTitle: word('Report this post'),
    reportNote: word('The community’s moderators see this post and your reason.'),
    cancel: word('Cancel'),
    failed: word('Couldn’t load this topic. Check your connection and try again.'),
    again: word('Try again'),
    tooLong: word('At most {n} characters.'),
    saveFailed: word('Couldn’t save this in the forum.'),
    member: word('A member'),
    photo: word('Photo {n}'),
};

export const NEW_TOPIC_WORDS = {
    heading: word('New topic'),
    section: word('Section'),
    title: word('Title'),
    words: word('What do you want to say?'),
    place: word('Place, in words (optional)'),
    placeHint: word('Like “near the town hall”. Never a map point.'),
    post: word('Post topic'),
    cancel: word('Cancel'),
    firstLook: word('Your first topic is looked at by a moderator before it shows.'),
    firstLookHours: wordn('Your first topic is looked at by a moderator before it shows. Usually within {n} hour.',
        'Your first topic is looked at by a moderator before it shows. Usually within {n} hours.'),
    count: word('{n} of {max}'),
};

export const FIRST_LOOK_WORDS = {
    heading: word('Waiting for a first look'),
    none: word('Nothing is waiting. Thank you for looking.'),
    ok: word('OK, put it up'),
    no: word('No'),
    why: word('Why not?'),
    send: word('Say no'),
    cancel: word('Cancel'),
    back: word('Back to the forum'),
    failed: word('Couldn’t load the first looks. Check your connection and try again.'),
    reasons: {
        spam: word('Spam or a scam'),
        offensive: word('Offensive content'),
        misleading: word('Misleading'),
        unsafe: word('Unsafe or illegal'),
        rules: word('Against this community’s rules'),
    },
};

export const TOLD_WORDS = {
    title: word('Anyone on the web can read this forum'),
    body: word('Anyone on the web can read this forum, with your name. Not your picture, your area or your profile.'),
    post: word('Post'),
    notNow: word('Not now'),
};
