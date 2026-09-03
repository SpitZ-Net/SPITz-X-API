# SPITz-X API 3.0

## Render settings

Build Command:
`npm install`

Start Command:
`npm start`

Environment:
- `NODE_VERSION=24.14.1`
- `ADMIN_TOKEN=choose-a-long-random-admin-token`
- Optional: `MEDIA_ROOT=/var/data/spitz-x-library` if your hosting plan provides a persistent disk at that path.

## Endpoints

- `GET /`
- `GET /health`
- `GET /analyze?url=YOUTUBE_WATCH_URL`
- `GET /library/:videoId`
- `POST /process`
- `POST /admin/upload`
- `GET /media/:videoId`
- `GET /media/:videoId/download`

## Admin upload

`POST /admin/upload` requires:
`x-spitz-admin-token: YOUR_ADMIN_TOKEN`

Multipart fields:
- `video` = authorized source video
- `videoId` or `videoUrl`
- `title`
- `channel`

The API converts the source to MP4 with FFmpeg and registers it against the YouTube video ID.

## Storage warning

Render Free's normal filesystem is temporary. This version is ideal for testing. For a permanent school-wide library, put `MEDIA_ROOT` on persistent/object storage supplied by your hosting provider.

## Authorization

Only upload/process videos your group owns or is authorized to distribute. This API intentionally does not download arbitrary YouTube watch URLs or bypass YouTube access controls.
