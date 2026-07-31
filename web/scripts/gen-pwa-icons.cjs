'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const src = path.join(__dirname, '..', 'public', 'favicon.svg');
const out = path.join(__dirname, '..', 'public');

async function main() {
    if (!fs.existsSync(src)) {
        throw new Error(`Source icon missing: ${src}`);
    }
    fs.mkdirSync(out, { recursive: true });
    const buf = fs.readFileSync(src);

    await sharp(buf).resize(192, 192).png().toFile(path.join(out, 'pwa-192x192.png'));
    await sharp(buf).resize(512, 512).png().toFile(path.join(out, 'pwa-512x512.png'));
    await sharp(buf).resize(180, 180).png().toFile(path.join(out, 'apple-touch-icon.png'));

    // Maskable: inset art ~62% so OS masks do not clip the grid mark.
    const mask = await sharp({
        create: { width: 512, height: 512, channels: 3, background: { r: 10, g: 10, b: 10 } }
    })
        .png()
        .toBuffer();
    const inset = await sharp(buf).resize(320, 320).png().toBuffer();
    await sharp(mask)
        .composite([{ input: inset, gravity: 'centre' }])
        .png()
        .toFile(path.join(out, 'pwa-512x512-maskable.png'));

    console.log('Wrote PWA icons to', out);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
