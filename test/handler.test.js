const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { CopyObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { processEvent, readConfig, decodeKey } = require('../index');
const { makeBaseImage, fakeS3, s3Event } = require('./helpers');

const baseEnv = { DSTBUCKET: 'dst', SIZES: '20,10' };

const seeded = async (key = 'photo.png') => {
    const s3 = fakeS3({ [`src/${key}`]: { Body: await makeBaseImage(), ContentType: 'image/png' } });
    return s3;
};

describe('configuration', () => {
    test('throws when DSTBUCKET is missing', () => {
        assert.throws(() => readConfig({ SIZES: '10' }), /Destination bucket is not set/);
    });
    test('throws when SIZES is empty or invalid', () => {
        assert.throws(() => readConfig({ DSTBUCKET: 'dst' }), /SIZES/);
        assert.throws(() => readConfig({ DSTBUCKET: 'dst', SIZES: 'abc' }), /SIZES/);
    });
    test('tolerates whitespace in SIZES', () => {
        assert.deepEqual(readConfig({ DSTBUCKET: 'dst', SIZES: ' 400, 800 ,1200' }).sizes, [400, 800, 1200]);
    });
});

describe('S3 keys', () => {
    test('decodes URL-encoded keys from the event', () => {
        assert.equal(decodeKey('my+photos/caf%C3%A9+%281%29.jpg'), 'my photos/café (1).jpg');
    });

    test('fetches the decoded key and writes thumbnails under the decoded name', async () => {
        const s3 = await seeded('my photos/café (1).png');
        await processEvent(s3Event('src', 'my+photos/caf%C3%A9+%281%29.png'), { s3Client: s3, env: baseEnv });
        assert.deepEqual(s3.commands(GetObjectCommand), [{ Bucket: 'src', Key: 'my photos/café (1).png' }]);
        assert.deepEqual(s3.commands(PutObjectCommand).map(p => p.Key).sort(), [
            'my photos/café (1).png_10',
            'my photos/café (1).png_20'
        ]);
    });

    test('prefixes DSTPATH', async () => {
        const s3 = await seeded();
        await processEvent(s3Event('src', 'photo.png'), { s3Client: s3, env: { ...baseEnv, DSTPATH: 'thumbs' } });
        assert.deepEqual(s3.commands(PutObjectCommand).map(p => p.Key).sort(), ['thumbs/photo.png_10', 'thumbs/photo.png_20']);
    });
});

describe('uploads', () => {
    test('downloads the source only once however many sizes are requested', async () => {
        const s3 = await seeded();
        await processEvent(s3Event('src', 'photo.png'), { s3Client: s3, env: { ...baseEnv, SIZES: '5,10,15,20' } });
        assert.equal(s3.commands(GetObjectCommand).length, 1);
        assert.equal(s3.commands(PutObjectCommand).length, 4);
    });

    test('passes ContentType through and applies ACL when set', async () => {
        const s3 = await seeded();
        await processEvent(s3Event('src', 'photo.png'), { s3Client: s3, env: { ...baseEnv, ACL: 'public-read' } });
        for (const put of s3.commands(PutObjectCommand)) {
            assert.equal(put.Bucket, 'dst');
            assert.equal(put.ContentType, 'image/png');
            assert.equal(put.ACL, 'public-read');
            assert.ok(Buffer.isBuffer(put.Body) && put.Body.length > 0);
        }
    });

    test('omits ACL when not configured', async () => {
        const s3 = await seeded();
        await processEvent(s3Event('src', 'photo.png'), { s3Client: s3, env: baseEnv });
        for (const put of s3.commands(PutObjectCommand)) {
            assert.equal(put.ACL, undefined);
        }
    });

    test('does not enlarge a source narrower than the requested size', async () => {
        // Base image is 40x20; request one size below and one above its width.
        const s3 = await seeded();
        await processEvent(s3Event('src', 'photo.png'), { s3Client: s3, env: { ...baseEnv, SIZES: '20,400' } });
        const small = await sharp(s3.store['dst/photo.png_20'].Body).metadata();
        const large = await sharp(s3.store['dst/photo.png_400'].Body).metadata();
        assert.deepEqual({ w: small.width, h: small.height }, { w: 20, h: 10 });
        assert.deepEqual({ w: large.width, h: large.height }, { w: 40, h: 20 }, 'kept at source size, still uploaded under _400');
    });

    test('returns a success message naming the source', async () => {
        const s3 = await seeded();
        const result = await processEvent(s3Event('src', 'photo.png'), { s3Client: s3, env: baseEnv });
        assert.equal(result, 'Successfully resized src/photo.png');
    });
});

describe('COPYORIGINAL', () => {
    test('copies the original with a URL-encoded CopySource', async () => {
        const s3 = await seeded('a b/c.png');
        await processEvent(s3Event('src', 'a+b/c.png'), { s3Client: s3, env: { ...baseEnv, COPYORIGINAL: 'true', DSTPATH: 'out', ACL: 'public-read' } });
        assert.deepEqual(s3.commands(CopyObjectCommand), [{
            Bucket: 'dst',
            CopySource: 'src/a%20b/c.png',
            Key: 'out/a b/c.png',
            ACL: 'public-read'
        }]);
    });

    test('does not copy by default', async () => {
        const s3 = await seeded();
        await processEvent(s3Event('src', 'photo.png'), { s3Client: s3, env: baseEnv });
        assert.equal(s3.commands(CopyObjectCommand).length, 0);
    });
});

describe('CLEANUPSOURCE', () => {
    test('deletes the source only after every thumbnail is uploaded', async () => {
        const s3 = await seeded();
        await processEvent(s3Event('src', 'photo.png'), { s3Client: s3, env: { ...baseEnv, CLEANUPSOURCE: 'true' } });
        const types = s3.calls.map(c => c.constructor.name);
        assert.equal(types.at(-1), 'DeleteObjectCommand');
        assert.deepEqual(s3.commands(DeleteObjectCommand), [{ Bucket: 'src', Key: 'photo.png' }]);
        assert.equal(types.filter(t => t === 'DeleteObjectCommand').length, 1);
    });

    test('keeps the source when a resize fails', async () => {
        const s3 = fakeS3({ 'src/bad.png': { Body: Buffer.from('not an image'), ContentType: 'image/png' } });
        await assert.rejects(processEvent(s3Event('src', 'bad.png'), { s3Client: s3, env: { ...baseEnv, CLEANUPSOURCE: 'true' } }));
        assert.equal(s3.commands(DeleteObjectCommand).length, 0);
        assert.ok(s3.store['src/bad.png']);
    });

    test('keeps the source by default', async () => {
        const s3 = await seeded();
        await processEvent(s3Event('src', 'photo.png'), { s3Client: s3, env: baseEnv });
        assert.equal(s3.commands(DeleteObjectCommand).length, 0);
    });
});

test('processes every record in the event', async () => {
    const image = await makeBaseImage();
    const s3 = fakeS3({ 'src/a.png': { Body: image, ContentType: 'image/png' }, 'src/b.png': { Body: image, ContentType: 'image/png' } });
    const event = { Records: [...s3Event('src', 'a.png').Records, ...s3Event('src', 'b.png').Records] };
    const result = await processEvent(event, { s3Client: s3, env: { ...baseEnv, SIZES: '10' } });
    assert.deepEqual(s3.commands(PutObjectCommand).map(p => p.Key).sort(), ['a.png_10', 'b.png_10']);
    assert.equal(result, 'Successfully resized src/a.png, src/b.png');
});
