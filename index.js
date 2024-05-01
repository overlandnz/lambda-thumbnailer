const AWS = require('aws-sdk');
const sharp = require('sharp');

const s3 = new AWS.S3();

exports.handler = async (event, context, callback) => {
    const srcBucket = event.Records[0].s3.bucket.name;
    const srcKey = event.Records[0].s3.object.key;

    let destinationBucket = process.env.DSTBUCKET;
    if (!destinationBucket) {
        throw new Error('Destination bucket is not set');
    }

    let destinationPath = process.env.DSTPATH;
    let destinationKey = ''

    if (!destinationPath) {
        destinationKey = srcKey;
    } else {
        destinationKey = `${destinationPath}/${srcKey}`;
    }

    const sizes = process.env.SIZES.split(',').map(size => parseInt(size));
    for (let i = 0; i < sizes.length; i++) {
        await resizeImage(sizes[i], srcBucket, srcKey, destinationBucket, destinationKey);
    }

    const cleanUpSource = process.env.CLEANUPSOURCE === 'true';
    if (cleanUpSource) {
        await s3.deleteObject({ Bucket: srcBucket, Key: srcKey }).promise();
    }

    callback(null, `Successfully resized ${srcBucket}/${srcKey}`);
}

const resizeImage = async (size, srcBucket, srcKey, dstBucket, dstKey) => {
    const image = await s3.getObject({ Bucket: srcBucket, Key: srcKey }).promise();
    const resizedImage = await sharp(image.Body).resize(size).toBuffer();
    
    await s3.putObject({
        Bucket: dstBucket,
        Key: `${dstKey}_${size}`,
        Body: resizedImage,
        ContentType: image.ContentType
    }).promise();
}