/**
 * The real MessagesPage in App's own layout (e2e/chat-pending-lines-harness.tsx), plus the two things e2e/chat-about-shots.mjs
 * needs to reach from the page: the chip store (the one Message on a listing writes to) and the chip builder. Nothing here
 * talks to a node (the driver answers /api), and the key is a test's: a fixed seed, never a member's.
 */
import { aboutOfPost, chatAboutDrafts } from '@beanpool/core';
import './chat-pending-lines-harness';

(window as unknown as Record<string, unknown>).__chatAboutDrafts = chatAboutDrafts;
(window as unknown as Record<string, unknown>).__aboutOfPost = aboutOfPost;
