# thumbnailer

A small NodeJS based Lambda that creates thumbnails from an image that is uploaded to S3.

You need to configure the S3 trigger yourself and add the following environment variables to your Lamda function.

### Environment variables

| Variable | Description | Example | 
| -------- | ------- | --- |
| DSTBUCKET | The bucket to send the result to | `testbucket` |
| DSTPATH | The path in the new bucket to place the files | `thumbnails` |
| SIZES | A comma seperated list of widths | `400,800,1200` |
| CLEANUPSOURCE | Should the source image be deleted? | `true/false` |