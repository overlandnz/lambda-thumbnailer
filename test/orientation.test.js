const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { processEvent } = require('../index');
const { makeOrientedImage, readCorners, fakeS3, s3Event, RED, BLUE, GREEN } = require('./helpers');

const FORMATS = ['jpeg', 'png', 'webp', 'tiff'];
const ORIENTATIONS = [1, 2, 3, 4, 5, 6, 7, 8];
const env = { DSTBUCKET: 'dst', SIZES: '20,40' };

describe('EXIF orientation is applied to thumbnails', () => {
    for (const format of FORMATS) {
        for (const orientation of ORIENTATIONS) {
            test(`${format} with orientation ${orientation} comes out upright`, async () => {
                const source = await makeOrientedImage(format, orientation);

                // Sanity check the fixture: stored pixels really carry the tag.
                const meta = await sharp(source).metadata();
                assert.equal(meta.orientation, orientation);

                const s3 = fakeS3({ 'src/photo.img': { Body: source, ContentType: `image/${format}` } });
                await processEvent(s3Event('src', 'photo.img'), { s3Client: s3, env });

                for (const size of [20, 40]) {
                    const out = s3.store[`dst/photo.img_${size}`];
                    assert.ok(out, `thumbnail ${size} was uploaded`);

                    const corners = await readCorners(out.Body);
                    assert.equal(corners.width, size, 'width matches requested size');
                    assert.equal(corners.height, size / 2, 'upright image is 2:1 landscape');
                    assert.equal(corners.topLeft, GREEN, 'marker is top-left');
                    assert.equal(corners.topRight, BLUE);
                    assert.equal(corners.bottomLeft, RED);
                    assert.equal(corners.bottomRight, BLUE);

                    // The tag must not survive, or viewers would rotate the pixels a second time.
                    const outMeta = await sharp(out.Body).metadata();
                    assert.ok(outMeta.orientation === undefined || outMeta.orientation === 1,
                        `orientation tag removed (got ${outMeta.orientation})`);
                    assert.equal(outMeta.format, format === 'jpeg' ? 'jpeg' : format, 'output keeps the input format');
                }
            });
        }
    }
});

test('portrait source stays portrait after orientation', async () => {
    // A 20x40 portrait stored sideways (40x20 pixels + orientation 6).
    const source = await sharp({ create: { width: 40, height: 20, channels: 3, background: 'white' } })
        .jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const s3 = fakeS3({ 'src/p.jpg': { Body: source, ContentType: 'image/jpeg' } });
    await processEvent(s3Event('src', 'p.jpg'), { s3Client: s3, env: { DSTBUCKET: 'dst', SIZES: '10' } });
    const meta = await sharp(s3.store['dst/p.jpg_10'].Body).metadata();
    assert.deepEqual({ w: meta.width, h: meta.height }, { w: 10, h: 20 });
});
