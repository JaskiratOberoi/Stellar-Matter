#!/usr/bin/env node
'use strict';

const path = require('path');
const { Command } = require('commander');
const { loadLisNavBotEnv } = require('./lib/load-env');
loadLisNavBotEnv(__dirname);

const { runLisNavBot } = require('./lib/run');

async function main() {
    const program = new Command();
    program
        .name('lis-nav-bot')
        .description('Read-only LIS Sample Worksheet navigation (no worksheet writes)')
        .option('--bu <name>', 'Business unit label')
        .option('--status <label>', 'Worksheet status label')
        .option('--test-code <code>', 'Test code filter')
        .option('--from-date <DD/MM/YYYY>', 'From date')
        .option('--to-date <DD/MM/YYYY>', 'To date')
        .option('--from-hour <0-23>', 'From hour', (v) => Number(v))
        .option('--to-hour <0-23>', 'To hour', (v) => Number(v))
        .option('--client-code <code>', 'Client code')
        .option('--sid <sid>', 'SID search field')
        .option('--vail-id <id>', 'Vail / valid id')
        .option('--pid <pid>', 'PID')
        .option('--dept-no <no>', 'Department (numeric code or name substring)')
        .option('--open-sid <sid>', 'After search, open this SID worksheet modal (read-only)')
        .option('--headless', 'Run headless Chromium', false)
        .option('--dry-run', 'Login + filters only; do not click Search', false)
        .option('--out-dir <dir>', 'Output directory', process.env.LIS_OUT_DIR || './out')
        .option('--no-screenshots', 'Skip PNG screenshots', false)
        .option('--skip-regional-badge', 'Skip gvSample rows with regional mcc badge (QUGEN pattern)', false)
        .option('--scrape-packages', 'Paginate gvSample and extract bracket package labels mapped to SIDs', false)
        .parse(process.argv);

    const opts = program.opts();

    console.log('READ-ONLY MODE — no LIS writes will be performed.');

    try {
        const { exitCode } = await runLisNavBot(opts);
        process.exit(exitCode);
    } catch (e) {
        console.error(e && e.message ? e.message : e);
        process.exit(1);
    }
}

main();
