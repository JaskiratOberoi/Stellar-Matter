'use strict';

// Storage for purchase-order documents (the proforma invoice PDF). Mirrors
// inventoryPhotos.js: files land under <out>/inventory-docs on the same
// bind-mounted volume as run artefacts and photos, and are served read-only
// at /inventory-docs/<file> by server.js. Kept separate from photos so the
// PDF allow-list and the larger size cap never loosen the image uploader.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const URL_PREFIX = '/inventory-docs';
const MAX_BYTES = 15 * 1024 * 1024; // 15 MB per document

function resolveOutDir() {
    const raw = process.env.LIS_OUT_DIR || path.join(__dirname, '..', 'scripts', 'lis-nav-bot', 'out');
    return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

const DOCS_DIR = path.join(resolveOutDir(), 'inventory-docs');

function ensureDocsDir() {
    fs.mkdirSync(DOCS_DIR, { recursive: true });
    return DOCS_DIR;
}

const storage = multer.diskStorage({
    destination(_req, _file, cb) {
        try {
            cb(null, ensureDocsDir());
        } catch (err) {
            cb(err);
        }
    },
    filename(_req, _file, cb) {
        cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.pdf`);
    }
});

function fileFilter(_req, file, cb) {
    const isPdf =
        file.mimetype === 'application/pdf' ||
        (file.mimetype === 'application/octet-stream' && /\.pdf$/i.test(file.originalname || ''));
    if (!isPdf) {
        const err = new Error('Only PDF files are allowed for order documents');
        err.status = 400;
        return cb(err);
    }
    cb(null, true);
}

const uploadDocument = multer({ storage, fileFilter, limits: { fileSize: MAX_BYTES, files: 1 } });

function urlFor(filename) {
    return `${URL_PREFIX}/${filename}`;
}

module.exports = { DOCS_DIR, URL_PREFIX, ensureDocsDir, uploadDocument, urlFor, MAX_BYTES };
