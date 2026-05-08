'use strict';

/**
 * Phase-2 scaffold shim — defers to the still-canonical legacy entrypoint
 * at scripts/lis-nav-bot/server.js. The next iteration splits the legacy
 * file into server/routes/{run,tiles,lookups,auth,admin}Api.js and this
 * shim becomes a thin wire-up of those routers + middleware.
 *
 * CommonJS (no "type": "module" on this workspace) so the CJS auth/admin
 * modules under server/ resolve naturally without .cjs renames.
 */

const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const legacyEntry = path.join(repoRoot, 'scripts', 'lis-nav-bot', 'server.js');

require(legacyEntry);
