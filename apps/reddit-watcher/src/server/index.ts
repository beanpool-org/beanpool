// The server Devvit runs for the app (devvit.json "server": dist/server/index.js, built by `npm run build`), as in
// Reddit's Devvit Web template (github.com/reddit/devvit-template-hello-world, src/server/index.ts).

import { createServer, getServerPort } from '@devvit/web/server';
import { onReq } from './server';

const server = createServer(onReq);
server.on('error', (err) => console.error(`[reddit-watcher] server error: ${err.message}`));
server.listen(getServerPort());
