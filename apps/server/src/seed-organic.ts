import { db } from './db/db.js';
import crypto from 'crypto';
import { beans } from '@beanpool/core';

const MOCK_OFFERS = [
  {
    title: 'Free Range Eggs',
    description: '1 Dozen farm-fresh eggs from happy hens. Pick up by the community garden gate.',
    type: 'offer',
    category: 'organic-produce',
    price_c: 350, // 3.50 Beans: whole hundredths, as posts.price_c holds every price
    status: 'active'
  },
  {
    title: 'Organic Compost',
    description: '2 bags of nitrogen-rich local compost available.',
    type: 'offer',
    category: 'organic-produce',
    price_c: 200,
    status: 'active'
  },
  {
    title: 'Heirloom Tomato Starters',
    description: 'Need a good home for 5 heirloom cherry tomato saplings. Grew too many!',
    type: 'offer',
    category: 'plants-seeds',
    price_c: 500,
    status: 'active'
  },
  {
    title: 'Community Garden Labor Swap',
    description: 'I will help weed your garden bed for 2 hours on Sunday in exchange for produce.',
    type: 'offer',
    category: 'community-labor',
    price_c: 400,
    status: 'active'
  },
  {
    title: 'Tool Library - Post Hole Digger',
    description: 'Heavy-duty post hole digger available to borrow for the weekend. Pick up only.',
    type: 'offer',
    category: 'tools-hardware',
    price_c: 100,
    status: 'active'
  }
];

function seed() {
  console.log('🌱 Starting Organic Seed Process...');

  // Create a mock user
  const newId = crypto.randomUUID();
  const pubkey = 'community_garden_mock_pubkey';
  
  db.prepare(`
        INSERT OR IGNORE INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
        VALUES (?, ?, ?, ?, ?, ?)
  `).run(pubkey, 'Community_Garden', new Date().toISOString(), 'genesis', 'legacy', 'active');
  
  db.prepare(`
        INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch)
        VALUES (?, ?, ?)
  `).run(pubkey, beans(100), 0); // 100 Beans, in whole hundredths

  console.log('✅ Synchronized mock user: Community_Garden');

  const insertPost = db.prepare(`
        INSERT OR IGNORE INTO posts (
            id, type, category, title, description, price_c, author_pubkey, created_at,
            active, status, repeatable, lat, lng
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const offer of MOCK_OFFERS) {
    const postId = crypto.randomUUID();
    insertPost.run(
      postId,
      offer.type,
      offer.category,
      offer.title,
      offer.description,
      offer.price_c,
      pubkey,
      new Date().toISOString(),
      1,
      offer.status,
      0,
      -28.55,
      153.50
    );
    console.log(`✅ Seeded: ${offer.title}`);
  }

  console.log('🎉 Seeding Complete. Exiting.');
  process.exit(0);
}

seed();
