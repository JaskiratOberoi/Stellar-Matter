'use strict';

const fs = require('fs');
const path = require('path');

/** Same CBC / Listec Autobots `.env` path documented in `internal/lis-navigation-reference.md`. */
const LISTEC_AUTOMATION_ENV = path.join('X:', 'Listec Automation', '.env');

/**
 * Load env: package `.env`, repo root `.env`, then Listec Autobots / CBC bot `.env`,
 * then optional `LIS_AUTOBOTS_ENV` (full path to a `.env` file).
 * Later files only set keys that are still unset (dotenv default).
 *
 * @param {string} packageDir - absolute path to `scripts/lis-nav-bot`
 */
function loadLisNavBotEnv(packageDir) {
    const dotenvConfig = (p) => {
        if (fs.existsSync(p)) require('dotenv').config({ path: p });
    };

    const local = path.join(packageDir, '.env');
    const root = path.join(packageDir, '..', '..', '.env');

    dotenvConfig(local);
    dotenvConfig(root);

    if (process.platform === 'win32') {
        dotenvConfig(LISTEC_AUTOMATION_ENV);
    }

    const extra = (process.env.LIS_AUTOBOTS_ENV || '').trim();
    if (extra) {
        dotenvConfig(path.isAbsolute(extra) ? extra : path.resolve(process.cwd(), extra));
    }
}

module.exports = {
    loadLisNavBotEnv
};
