const { S3Client, CopyObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');

// Lambda reuses the container between invocations. libvips' operation cache would
// otherwise keep decoded images from earlier invocations alive in memory.
sharp.cache(false);

const s3Client = new S3Client({});

const readConfig = (env) => {
    if (!env.DSTBUCKET) {
        throw new Error('Destination bucket is not set');
    }

    const sizes = (env.SIZES || '')
        .split(',')
        .map(size => parseInt(size.trim(), 10))
        .filter(size => Number.isInteger(size) && size > 0);

    if (sizes.length === 0) {
        throw new Error('SIZES must contain at least one width');
    }

    return {
        destinationBucket: env.DSTBUCKET,
        destinationPath: env.DSTPATH || '',
        sizes,
        copyOriginal: env.COPYORIGINAL === 'true',
        cleanUpSource: env.CLEANUPSOURCE === 'true',
        acl: env.ACL || undefined
    };
};

// S3 event notifications URL-encode the object key (and use "+" for spaces).
const decodeKey = (key) => decodeURIComponent(key.replace(/\+/g, ' '));

// CopySource must be URL-encoded, but "/" separators must stay as-is.
const encodeCopySource = (bucket, key) => `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

const processRecord = async (record, { s3Client, config }) => {
    const srcBucket = record.s3.bucket.name;
    const srcKey = decodeKey(record.s3.object.key);
    const destinationKey = config.destinationPath ? `${config.destinationPath}/${srcKey}` : srcKey;

    const copyOriginal = config.copyOriginal
        ? s3Client.send(new CopyObjectCommand({
            Bucket: config.destinationBucket,
            CopySource: encodeCopySource(srcBucket, srcKey),
            Key: destinationKey,
            ACL: config.acl
        }))
        : Promise.resolve();

    // Download the source once, regardless of how many sizes are requested.
    const source = await s3Client.send(new GetObjectCommand({ Bucket: srcBucket, Key: srcKey }));
    const imageBuffer = Buffer.from(await source.Body.transformToByteArray());

    // autoOrient() applies the EXIF Orientation tag to the pixels and drops the tag,
    // so every thumbnail is stored upright. It must come before resize().
    const image = sharp(imageBuffer).autoOrient();

    // Never upscale: a source narrower than the requested width is stored at its own width.
    const uploads = config.sizes.map(async (size) => {
        const resized = await image.clone().resize({ width: size, withoutEnlargement: true }).toBuffer();
        await s3Client.send(new PutObjectCommand({
            Bucket: config.destinationBucket,
            Key: `${destinationKey}_${size}`,
            Body: resized,
            ContentType: source.ContentType,
            ACL: config.acl
        }));
    });

    await Promise.all([copyOriginal, ...uploads]);

    if (config.cleanUpSource) {
        await s3Client.send(new DeleteObjectCommand({ Bucket: srcBucket, Key: srcKey }));
    }

    return `${srcBucket}/${srcKey}`;
};

const processEvent = async (event, deps) => {
    const config = readConfig(deps.env || process.env);
    const results = [];
    for (const record of event.Records) {
        results.push(await processRecord(record, { s3Client: deps.s3Client, config }));
    }
    return `Successfully resized ${results.join(', ')}`;
};

exports.handler = (event) => processEvent(event, { s3Client, env: process.env });

// Exported for tests
exports.processEvent = processEvent;
exports.readConfig = readConfig;
exports.decodeKey = decodeKey;
