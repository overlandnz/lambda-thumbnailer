# thumbnailer

A small NodeJS based Lambda that creates thumbnails from an image that is uploaded to S3.

You need to configure the S3 trigger yourself and add the following environment variables to your Lamda function.

### Environment variables

| Variable | Description | Example | 
| -------- | ------- | --- |
| DSTBUCKET | The bucket to send the result to | `testbucket` |
| DSTPATH | The path in the new bucket to place the files | `thumbnails` |
| SIZES | A comma seperated list of widths. Sources narrower than a width are not enlarged | `400,800,1200` |
| CLEANUPSOURCE | Should the source image be deleted? | `true/false` |
| ACL | Any custom ACL to apply | `public-read` |
| COPYORIGINAL | Copy the original to the destination bucket | `true/false` |
### Notes

- Thumbnails are auto-oriented: the EXIF `Orientation` tag is applied to the pixels and then dropped, so every thumbnail is stored upright. Originals copied with `COPYORIGINAL` keep their tag untouched.
- HEIC/HEIF photos (the iPhone default) are not supported by the bundled image library and will fail. Convert to JPEG before upload, or use AVIF.

### Tests

```
npm test
```

Runs the `node:test` suite under `test/`. It generates images tagged with each of the 8 EXIF orientations in JPEG, PNG, WebP and TIFF and checks the thumbnails come out upright, plus the S3 key handling, copy/cleanup behaviour and configuration parsing. No AWS credentials are needed; S3 is replaced with an in-memory fake.

### Releases

Every push to `main` builds and tests the Lambda. If `package.json` carries a version that has not been tagged yet, the workflow also creates a GitHub release `v<version>` with `lambda.zip` attached, ready to upload to the function. Bump the version to cut a new release.
