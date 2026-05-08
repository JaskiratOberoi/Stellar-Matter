/**
 * Phase-2 scaffold shim — defers to the still-canonical legacy entrypoint
 * at scripts/lis-nav-bot/server.js. The next todo (`react-vite-port`)
 * splits the legacy file into server/routes/{run,tiles,lookups,auth,admin}Api.js
 * and this shim becomes a thin wire-up of those routers + middleware.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const legacyEntry = path.join(repoRoot, 'scripts', 'lis-nav-bot', 'server.js');

// CommonJS legacy file — load via createRequire so we don't need to rewrite it yet.
const require = createRequire(import.meta.url);
require(legacyEntry);
