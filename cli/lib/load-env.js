'use strict';

const fs = require('fs');
const path = require('path');

/** Same CBC / Listec Autobots `.env` path documented in `internal/lis-navigation-reference.md`. */
const LISTEC_AUTOMATION_ENV = path.join('X:', 'Listec Automation', '.env');

/**
 * Walk up from startDir looking for a stellar-matter (or stellar-matter-monorepo)
 * package.json. Used to resolve the repo-root `.env` no matter where the caller
 * lives — Phase 11 moved the CLI from scripts/lis-nav-bot/ to cli/, which broke
 * the old `path.join(packageDir, '..', '..')` shortcut.
 */
function findRepoRoot(startDir) {
    let dir = path.resolve(startDir);
    for (let i = 0; i < 8; i++) {
        const pkgPath = path.join(dir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                if (pkg && (pkg.name === 'stellar-matter' || pkg.name === 'stellar-matter-monorepo')) {
                    return dir;
                }
            } catch {
                // fall through and keep walking
            }
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/**
 * Load env: package `.env`, repo root `.env`, then Listec Autobots / CBC bot `.env`,
 * then optional `LIS_AUTOBOTS_ENV` (full path to a `.env` file).
 * Later files only set keys that are still unset (dotenv default).
 *
 * @param {string} packageDir - absolute path to the caller's directory
 *   (e.g. `cli/` for the CLI, `scripts/lis-nav-bot/` for the legacy server).
 */
function loadLisNavBotEnv(packageDir) {
    const dotenvConfig = (p) => {
        if (p && fs.existsSync(p)) require('dotenv').config({ path: p });
    };

    const local = path.join(packageDir, '.env');
    const repoRoot = findRepoRoot(packageDir);
    const rootEnv = repoRoot ? path.join(repoRoot, '.env') : null;

    dotenvConfig(local);
    dotenvConfig(rootEnv);

    if (process.platform === 'win32') {
        dotenvConfig(LISTEC_AUTOMATION_ENV);
    }

    const extra = (process.env.LIS_AUTOBOTS_ENV || '').trim();
    if (extra) {
        dotenvConfig(path.isAbsolute(extra) ? extra : path.resolve(process.cwd(), extra));
    }
}

module.exports = {
    loadLisNavBotEnv,
    findRepoRoot
};
