const { S3Client, CopyObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');

const s3Client = new S3Client({});

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

    if (process.env.COPYORIGINAL === 'true') {
        let copyObjectParams = {
            Bucket: destinationBucket,
            CopySource: `${srcBucket}/${srcKey}`,
            Key: destinationKey
        };

        if (process.env.ACL) {
            copyObjectParams.ACL = process.env.ACL;
        }

        await s3Client.send(new CopyObjectCommand(copyObjectParams));
    }

    const sizes = process.env.SIZES.split(',').map(size => parseInt(size));
    for (let i = 0; i < sizes.length; i++) {
        await resizeImage(sizes[i], srcBucket, srcKey, destinationBucket, destinationKey);
    }

    const cleanUpSource = process.env.CLEANUPSOURCE === 'true';
    if (cleanUpSource) {
        await s3Client.send(new DeleteObjectCommand({ Bucket: srcBucket, Key: srcKey }));
    }

    callback(null, `Successfully resized ${srcBucket}/${srcKey}`);
}

const resizeImage = async (size, srcBucket, srcKey, dstBucket, dstKey) => {
    const getObjectResponse = await s3Client.send(new GetObjectCommand({ Bucket: srcBucket, Key: srcKey }));
    
    // Convert stream to buffer for sharp
    const chunks = [];
    for await (const chunk of getObjectResponse.Body) {
        chunks.push(chunk);
    }
    const imageBuffer = Buffer.concat(chunks);
    
    const resizedImage = await sharp(imageBuffer).autoOrient().resize(size).toBuffer();

    let uploadParams = {
        Bucket: dstBucket,
        Key: `${dstKey}_${size}`,
        Body: resizedImage,
        ContentType: getObjectResponse.ContentType
    };

    if (process.env.ACL) {
        uploadParams.ACL = process.env.ACL;
    }

    await s3Client.send(new PutObjectCommand(uploadParams));
}