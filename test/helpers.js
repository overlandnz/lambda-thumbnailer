const sharp = require('sharp');
const { CopyObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

// A 40x20 test image: left half red, right half blue, with a green 4x4 marker in
// the top-left corner. After correct orientation the marker must always end up
// top-left, so the corner colours tell us whether rotation was applied properly.
const makeBaseImage = () =>
    sharp({ create: { width: 40, height: 20, channels: 3, background: { r: 255, g: 0, b: 0 } } })
        .composite([
            { input: { create: { width: 20, height: 20, channels: 3, background: { r: 0, g: 0, b: 255 } } }, left: 20, top: 0 },
            { input: { create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 255, b: 0 } } }, left: 0, top: 0 }
        ])
        .png()
        .toBuffer();

// Produces the "as a camera would store it" version: pixels rotated so that applying
// the EXIF orientation tag `orientation` brings the image back upright.
const makeOrientedImage = async (format, orientation) => {
    const upright = await makeBaseImage();
    // Each orientation's inverse, as a list of passes. Passes run as separate
    // pipelines because sharp applies flip/flop before rotate inside one pipeline,
    // which would turn "rotate then mirror" (transpose/transverse) into the wrong op.
    const inverse = {
        1: [],
        2: [(img) => img.flop()],
        3: [(img) => img.rotate(180)],
        4: [(img) => img.flip()],
        5: [(img) => img.rotate(90), (img) => img.flop()],   // transpose (self-inverse)
        6: [(img) => img.rotate(270)],
        7: [(img) => img.rotate(270), (img) => img.flop()],  // transverse (self-inverse)
        8: [(img) => img.rotate(90)]
    }[orientation];

    let storedPixels = upright;
    for (const pass of inverse) {
        storedPixels = await pass(sharp(storedPixels)).png().toBuffer();
    }
    return sharp(storedPixels)[format]().withMetadata({ orientation }).toBuffer();
};

const RED = 'red', BLUE = 'blue', GREEN = 'green';
const classify = (r, g, b) => (g > 128 ? GREEN : r > 128 ? RED : BLUE);

const readCorners = async (buffer) => {
    const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
    const px = (x, y) => {
        const i = (y * info.width + x) * info.channels;
        return classify(data[i], data[i + 1], data[i + 2]);
    };
    return {
        width: info.width,
        height: info.height,
        topLeft: px(1, 1),
        topRight: px(info.width - 2, 1),
        bottomLeft: px(1, info.height - 2),
        bottomRight: px(info.width - 2, info.height - 2)
    };
};

// Minimal in-memory stand-in for S3Client. Records every command it receives.
const fakeS3 = (objects = {}) => {
    const calls = [];
    const store = { ...objects };
    return {
        calls,
        store,
        commands: (Type) => calls.filter(c => c instanceof Type).map(c => c.input),
        async send(command) {
            calls.push(command);
            if (command instanceof GetObjectCommand) {
                const obj = store[`${command.input.Bucket}/${command.input.Key}`];
                if (!obj) {
                    const err = new Error('The specified key does not exist.');
                    err.name = 'NoSuchKey';
                    throw err;
                }
                return {
                    ContentType: obj.ContentType,
                    Body: { transformToByteArray: async () => new Uint8Array(obj.Body) }
                };
            }
            if (command instanceof PutObjectCommand) {
                store[`${command.input.Bucket}/${command.input.Key}`] = { Body: command.input.Body, ContentType: command.input.ContentType };
                return {};
            }
            if (command instanceof CopyObjectCommand) {
                return {};
            }
            if (command instanceof DeleteObjectCommand) {
                delete store[`${command.input.Bucket}/${command.input.Key}`];
                return {};
            }
            throw new Error(`Unexpected command ${command.constructor.name}`);
        }
    };
};

const s3Event = (bucket, key) => ({ Records: [{ s3: { bucket: { name: bucket }, object: { key } } }] });

module.exports = { makeBaseImage, makeOrientedImage, readCorners, fakeS3, s3Event, RED, BLUE, GREEN };
