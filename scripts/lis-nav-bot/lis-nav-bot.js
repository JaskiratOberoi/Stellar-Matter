#!/usr/bin/env node
'use strict';

// Phase 11 (cli-rename): This file used to be the canonical CLI entry-point.
// The CLI now lives at top-level `cli/stellar-matter-cli.js`.
//
// We keep this shim around for one release so that any wrapper scripts,
// scheduled tasks, or muscle-memory invocations of
//
//     node scripts/lis-nav-bot/lis-nav-bot.js …
//
// continue to work — but they'll print a loud deprecation warning so we
// notice anything still pointing at the old path before deletion.
//
// Migration:
//   - Library code moved from scripts/lis-nav-bot/lib/ to cli/lib/
//   - CLI entry-point moved from scripts/lis-nav-bot/lis-nav-bot.js
//     to cli/stellar-matter-cli.js
//   - Run via: `npm run cli -- …` or `node cli/stellar-matter-cli.js …`
//
// This shim will be removed in a future release.

const path = require('path');

const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

process.stderr.write(
    `${YELLOW}[deprecated]${RESET} ${RED}scripts/lis-nav-bot/lis-nav-bot.js${RESET} is a removal-notice shim.\n` +
    `             Use ${YELLOW}node cli/stellar-matter-cli.js${RESET} (or ${YELLOW}npm run cli --${RESET}) instead.\n` +
    `             This shim will be removed in a future release.\n\n`
);

require(path.join(__dirname, '..', '..', 'cli', 'stellar-matter-cli.js'));
