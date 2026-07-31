'use strict';

// Storage for inventory proof-of-goods photos (one per receive/dispatch line).
// Files land under <out>/inventory-photos and are served read-only at
// /inventory-photos/<file> by server.js. The out dir is the same bind-mounted
// volume the run artefacts use, so photos survive container rebuilds. We mirror
// server.js's resolveOutDir() so both agree on the path whether we run from the
// repo root, inside Docker (LIS_OUT_DIR=/app/out), or scripts/lis-nav-bot.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const URL_PREFIX = '/inventory-photos';
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB per photo

const ALLOWED_EXT = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/heic': '.heic',
    'image/heif': '.heif'
};

function resolveOutDir() {
    const raw = process.env.LIS_OUT_DIR || path.join(__dirname, '..', 'scripts', 'lis-nav-bot', 'out');
    return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

const PHOTOS_DIR = path.join(resolveOutDir(), 'inventory-photos');

function ensurePhotosDir() {
    fs.mkdirSync(PHOTOS_DIR, { recursive: true });
    return PHOTOS_DIR;
}

const storage = multer.diskStorage({
    destination(_req, _file, cb) {
        try {
            cb(null, ensurePhotosDir());
        } catch (err) {
            cb(err);
        }
    },
    filename(_req, file, cb) {
        const ext = ALLOWED_EXT[file.mimetype] || path.extname(file.originalname || '').toLowerCase() || '.bin';
        cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
    }
});

function fileFilter(_req, file, cb) {
    if (!ALLOWED_EXT[file.mimetype]) {
        const err = new Error('Only image files are allowed (jpeg, png, webp, gif, heic)');
        err.status = 400;
        return cb(err);
    }
    cb(null, true);
}

const uploadPhoto = multer({ storage, fileFilter, limits: { fileSize: MAX_BYTES, files: 1 } });

// Map a stored filename to the public URL path recorded on the movement row.
function urlFor(filename) {
    return `${URL_PREFIX}/${filename}`;
}

module.exports = { PHOTOS_DIR, URL_PREFIX, ensurePhotosDir, uploadPhoto, urlFor, MAX_BYTES };
