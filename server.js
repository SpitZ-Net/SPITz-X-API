const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const app = express();

const PORT = Number(process.env.PORT || 10000);
const MAX_UPLOAD = 250 * 1024 * 1024;

// ============================================================
// CONFIG
// ============================================================

// Your self-hosted converter API.
// Example:
// YOUTUBE_CONVERTER_BASE=http://your-converter-server:3000
const YOUTUBE_CONVERTER_BASE = String(
  process.env.YOUTUBE_CONVERTER_BASE || ''
).replace(/\/$/, '');

// ============================================================
// STORAGE
// ============================================================

const MEDIA_ROOT =
  process.env.MEDIA_ROOT || '/tmp/spitz-x-library';

const LIBRARY_FILE =
  path.join(MEDIA_ROOT, 'library.json');

fs.mkdirSync(MEDIA_ROOT, { recursive: true });
fs.mkdirSync(path.join(MEDIA_ROOT, '_uploads'), {
  recursive: true
});

const appData = {
  library: new Map()
};

// Load library
try {
  if (fs.existsSync(LIBRARY_FILE)) {
    const saved = JSON.parse(
      fs.readFileSync(LIBRARY_FILE, 'utf8')
    );

    for (const [id, item] of Object.entries(saved)) {
      appData.library.set(id, item);
    }
  }
} catch (err) {
  console.warn(
    'Could not load library.json:',
    err.message
  );
}

// ============================================================
// UPLOAD
// ============================================================

const upload = multer({
  dest: path.join(MEDIA_ROOT, '_uploads'),

  limits: {
    fileSize: MAX_UPLOAD,
    files: 1
  },

  fileFilter: (req, file, cb) => {
    cb(
      null,
      /^video\//i.test(file.mimetype)
    );
  }
});

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(
  cors({
    origin: true
  })
);

app.use(
  express.json({
    limit: '1mb'
  })
);

// ============================================================
// SAVE LIBRARY
// ============================================================

function saveLibrary() {
  const obj =
    Object.fromEntries(appData.library);

  return fsp.writeFile(
    LIBRARY_FILE,
    JSON.stringify(obj, null, 2),
    'utf8'
  );
}

// ============================================================
// YOUTUBE ID
// ============================================================

function youtubeId(raw) {
  try {
    const u = new URL(raw);

    const h =
      u.hostname
        .replace(/^www\./, '')
        .toLowerCase();

    if (
      (h === 'youtube.com' ||
       h === 'm.youtube.com') &&
      u.pathname === '/watch'
    ) {
      return u.searchParams.get('v');
    }

    if (h === 'youtu.be') {
      return (
        u.pathname.split('/')[1] ||
        null
      );
    }

    if (
      h === 'youtube.com' &&
      u.pathname.startsWith('/shorts/')
    ) {
      return (
        u.pathname.split('/')[2] ||
        null
      );
    }

    if (
      h === 'youtube.com' &&
      u.pathname.startsWith('/embed/')
    ) {
      return (
        u.pathname.split('/')[2] ||
        null
      );
    }

  } catch (_) {}

  return null;
}

// ============================================================
// CLEAN ID
// ============================================================

function cleanId(id) {
  return String(id || '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 64);
}

// ============================================================
// ADMIN AUTH
// ============================================================

function adminAuthorized(req) {
  const expected =
    process.env.ADMIN_TOKEN;

  if (!expected) {
    return false;
  }

  const supplied =
    req.get('x-spitz-admin-token') || '';

  return supplied === expected;
}

// ============================================================
// FFMPEG
// ============================================================

async function runFfmpeg(input, output) {
  return new Promise(
    (resolve, reject) => {

      const p = spawn(
        'ffmpeg',
        [
          '-y',
          '-i',
          input,

          '-c:v',
          'libx264',

          '-preset',
          'veryfast',

          '-crf',
          '23',

          '-c:a',
          'aac',

          '-b:a',
          '128k',

          '-movflags',
          '+faststart',

          output
        ],
        {
          stdio: [
            'ignore',
            'ignore',
            'pipe'
          ]
        }
      );

      let errorText = '';

      p.stderr.on(
        'data',
        data => {
          errorText += data.toString();

          if (errorText.length > 8000) {
            errorText =
              errorText.slice(-8000);
          }
        }
      );

      p.on('error', reject);

      p.on(
        'close',
        code => {

          if (code === 0) {
            resolve();
          } else {
            reject(
              new Error(
                'FFmpeg failed: ' +
                errorText
              )
            );
          }

        }
      );

    }
  );
}

// ============================================================
// LIBRARY ITEM
// ============================================================

function libraryItem(id) {

  const item =
    appData.library.get(id);

  if (!item) {
    return null;
  }

  // External MP4
  if (item.externalUrl) {

    return {
      videoId: id,

      title:
        item.title ||
        'SPITz-X Video',

      channel:
        item.channel ||
        '',

      filename:
        item.filename ||
        `${id}.mp4`,

      url:
        item.externalUrl,

      downloadUrl:
        item.externalUrl,

      source:
        'self-hosted-converter'
    };
  }

  // Local MP4
  const absolute =
    path.join(
      MEDIA_ROOT,
      item.file || ''
    );

  if (
    !item.file ||
    !fs.existsSync(absolute)
  ) {
    return null;
  }

  return {
    videoId: id,

    title:
      item.title ||
      'SPITz-X Video',

    channel:
      item.channel ||
      '',

    filename:
      path.basename(item.file),

    url:
      '/media/' +
      encodeURIComponent(id),

    downloadUrl:
      '/media/' +
      encodeURIComponent(id) +
      '/download',

    source:
      'spitz-x-local-library'
  };
}

// ============================================================
// ROOT
// ============================================================

app.get('/', (req, res) => {

  res.json({
    name: 'SPITz-X API',

    status: 'online',

    version: '4.1.0',

    services: {
      analyze: '/analyze',
      library: '/library/:videoId',
      youtubeConvert:
        '/admin/youtube-convert',
      adminUpload:
        '/admin/upload',
      process: '/process',
      convert: '/convert',
      media: '/media/:videoId',
      download:
        '/media/:videoId/download',
      health: '/health'
    }
  });

});

// ============================================================
// HEALTH
// ============================================================

app.get('/health', (req, res) => {

  res.json({

    status: 'ok',

    service:
      'SPITz-X API',

    version:
      '4.1.0',

    processor:
      'ffmpeg',

    converterConfigured:
      Boolean(
        YOUTUBE_CONVERTER_BASE
      ),

    libraryItems:
      appData.library.size,

    maxUploadMB:
      250,

    storageRoot:
      MEDIA_ROOT

  });

});

// ============================================================
// ANALYZE YOUTUBE URL
// ============================================================

app.get('/analyze', async (req, res) => {

  const url =
    String(req.query.url || '');

  const id =
    youtubeId(url);

  if (!id) {

    return res
      .status(400)
      .json({
        error:
          'Invalid YouTube watch URL.'
      });

  }

  try {

    const response =
      await fetch(
        'https://www.youtube.com/oembed?format=json&url=' +
        encodeURIComponent(
          'https://www.youtube.com/watch?v=' +
          id
        )
      );

    if (!response.ok) {

      return res
        .status(502)
        .json({
          error:
            'YouTube metadata could not be retrieved.'
        });

    }

    const data =
      await response.json();

    const copy =
      libraryItem(id);

    res.json({

      videoId:
        id,

      ...data,

      libraryAvailable:
        Boolean(copy),

      library:
        copy

    });

  } catch (err) {

    res
      .status(502)
      .json({
        error:
          'Metadata request failed.'
      });

  }

});

// ============================================================
// LIBRARY LOOKUP
// ============================================================

app.get(
  '/library/:videoId',
  (req, res) => {

    const id =
      cleanId(
        req.params.videoId
      );

    const item =
      libraryItem(id);

    if (!item) {

      return res
        .status(404)
        .json({

          available:
            false,

          error:
            'No MP4 copy is registered for this video.'

        });

    }

    res.json({
      available: true,
      ...item
    });

  }
);

// ============================================================
// ADMIN YOUTUBE → MP4
// ============================================================
//
// The converter itself must be separately self-hosted/configured.
// SPITz-X only sends the URL to that service and registers the
// returned MP4 URL.
//
// ============================================================

app.post(
  '/admin/youtube-convert',
  async (req, res) => {

    // Admin check
    if (!adminAuthorized(req)) {

      return res
        .status(401)
        .json({
          error:
            'Admin authorization required.'
        });

    }

    // Converter configuration
    if (!YOUTUBE_CONVERTER_BASE) {

      return res
        .status(503)
        .json({

          error:
            'Self-hosted YouTube converter is not configured. Set YOUTUBE_CONVERTER_BASE on the SPITz-X API server.'

        });

    }

    // YouTube URL
    const suppliedUrl =
      String(
        req.body.videoUrl || ''
      );

    const id =
      cleanId(
        youtubeId(
          suppliedUrl
        )
      );

    if (!id) {

      return res
        .status(400)
        .json({
          error:
            'Provide a valid YouTube watch URL.'
        });

    }

    try {

      // --------------------------------------------------------
      // Send the URL to the configured converter.
      //
      // This expects the converter service to expose an endpoint
      // that accepts a YouTube URL and returns an MP4 URL.
      // --------------------------------------------------------

      const converterUrl =
        new URL(
          '/convert',
          YOUTUBE_CONVERTER_BASE
        );

      const converterResponse =
        await fetch(
          converterUrl,
          {
            method: 'POST',

            headers: {
              'content-type':
                'application/json'
            },

            body: JSON.stringify({
              url:
                suppliedUrl,

              format:
                'mp4'
            })
          }
        );

      const text =
        await converterResponse.text();

      let data;

      try {
        data =
          JSON.parse(text);
      } catch (_) {

        return res
          .status(502)
          .json({

            error:
              'Converter returned an invalid response.'

          });

      }

      if (
        !converterResponse.ok
      ) {

        return res
          .status(502)
          .json({

            error:
              data.error ||
              'Converter rejected the request.'

          });

      }

      // Accept common response field names
      const mp4Url =
        data.file ||
        data.url ||
        data.downloadUrl ||
        data.download_url;

      if (!mp4Url) {

        return res
          .status(502)
          .json({

            error:
              'Converter did not return an MP4 URL.'

          });

      }

      const title =
        String(
          data.title ||
          'SPITz-X Video'
        ).slice(0, 200);

      // Save it to SPITz-X library
      appData.library.set(
        id,
        {

          title,

          channel:
            String(
              data.channel ||
              ''
            ).slice(0, 200),

          filename:
            id + '.mp4',

          externalUrl:
            mp4Url,

          source:
            'self-hosted-converter',

          updatedAt:
            new Date()
              .toISOString()

        }
      );

      await saveLibrary();

      res.json({

        ok:
          true,

        videoId:
          id,

        title,

        url:
          mp4Url,

        downloadUrl:
          mp4Url,

        source:
          'self-hosted-converter'

      });

    } catch (err) {

      console.error(
        'Converter error:',
        err
      );

      res
        .status(502)
        .json({

          error:
            err.message ||
            'Could not connect to the self-hosted converter.'

        });

    }

  }
);

// ============================================================
// ADMIN DIRECT UPLOAD
// ============================================================

app.post(
  '/admin/upload',
  upload.single('video'),
  async (req, res) => {

    if (!adminAuthorized(req)) {

      if (req.file?.path) {

        await fsp.rm(
          req.file.path,
          {
            force: true
          }
        );

      }

      return res
        .status(401)
        .json({
          error:
            'Admin authorization required.'
        });

    }

    if (!req.file) {

      return res
        .status(400)
        .json({
          error:
            'Upload a video in the video field.'
        });

    }

    const suppliedUrl =
      String(
        req.body.videoUrl || ''
      );

    const id =
      cleanId(
        youtubeId(
          suppliedUrl
        ) ||
        req.body.videoId
      );

    if (!id) {

      await fsp.rm(
        req.file.path,
        {
          force: true
        }
      );

      return res
        .status(400)
        .json({
          error:
            'Provide a YouTube URL or video ID.'
        });

    }

    const title =
      String(
        req.body.title ||
        'SPITz-X Video'
      ).slice(0, 200);

    const channel =
      String(
        req.body.channel ||
        ''
      ).slice(0, 200);

    const filename =
      id + '.mp4';

    const finalPath =
      path.join(
        MEDIA_ROOT,
        filename
      );

    try {

      await runFfmpeg(
        req.file.path,
        finalPath
      );

      await fsp.rm(
        req.file.path,
        {
          force: true
        }
      );

      appData.library.set(
        id,
        {

          title,

          channel,

          file:
            filename,

          updatedAt:
            new Date()
              .toISOString()

        }
      );

      await saveLibrary();

      res.json({

        ok: true,

        videoId:
          id,

        title,

        channel,

        url:
          '/media/' +
          encodeURIComponent(id),

        downloadUrl:
          '/media/' +
          encodeURIComponent(id) +
          '/download'

      });

    } catch (err) {

      await fsp.rm(
        req.file.path,
        {
          force: true
        }
      );

      await fsp.rm(
        finalPath,
        {
          force: true
        }
      );

      res
        .status(500)
        .json({

          error:
            err.message ||
            'Video processing failed.'

        });

    }

  }
);

// ============================================================
// AUTHORIZED SOURCE PROCESSING
// ============================================================

app.post(
  '/process',
  upload.single('video'),
  async (req, res) => {

    if (!req.file) {

      return res
        .status(400)
        .json({
          error:
            'Upload a video in the video field.'
        });

    }

    const id =
      cleanId(
        youtubeId(
          String(
            req.body.videoUrl || ''
          )
        ) ||
        req.body.videoId
      );

    if (!id) {

      await fsp.rm(
        req.file.path,
        {
          force: true
        }
      );

      return res
        .status(400)
        .json({
          error:
            'Provide a YouTube URL or video ID.'
        });

    }

    const title =
      String(
        req.body.title ||
        'SPITz-X Video'
      ).slice(0, 200);

    const filename =
      id + '.mp4';

    const finalPath =
      path.join(
        MEDIA_ROOT,
        filename
      );

    try {

      await runFfmpeg(
        req.file.path,
        finalPath
      );

      await fsp.rm(
        req.file.path,
        {
          force: true
        }
      );

      appData.library.set(
        id,
        {
          title,

          channel: '',

          file:
            filename,

          updatedAt:
            new Date()
              .toISOString()
        }
      );

      await saveLibrary();

      res.json({

        ok: true,

        videoId:
          id,

        title,

        url:
          '/media/' +
          encodeURIComponent(id),

        downloadUrl:
          '/media/' +
          encodeURIComponent(id) +
          '/download'

      });

    } catch (err) {

      await fsp.rm(
        req.file.path,
        {
          force: true
        }
      );

      await fsp.rm(
        finalPath,
        {
          force: true
        }
      );

      res
        .status(500)
        .json({

          error:
            err.message ||
            'Video processing failed.'

        });

    }

  }
);

// ============================================================
// COMPATIBILITY CONVERT ROUTE
// ============================================================

app.post(
  '/convert',
  upload.single('video'),
  async (req, res) => {

    if (!req.file) {

      return res
        .status(400)
        .json({
          error:
            'Upload a video in the video field.'
        });

    }

    const id =
      cleanId(
        youtubeId(
          String(
            req.body.videoUrl || ''
          )
        ) ||
        req.body.videoId
      );

    if (!id) {

      await fsp.rm(
        req.file.path,
        {
          force: true
        }
      );

      return res
        .status(400)
        .json({
          error:
            'Provide a YouTube URL or video ID.'
        });

    }

    const filename =
      id + '.mp4';

    const finalPath =
      path.join(
        MEDIA_ROOT,
        filename
      );

    try {

      await runFfmpeg(
        req.file.path,
        finalPath
      );

      await fsp.rm(
        req.file.path,
        {
          force: true
        }
      );

      appData.library.set(
        id,
        {

          title:
            String(
              req.body.title ||
              'SPITz-X Video'
            ).slice(0, 200),

          channel: '',

          file:
            filename,

          updatedAt:
            new Date()
              .toISOString()

        }
      );

      await saveLibrary();

      res.json({

        ok: true,

        videoId:
          id,

        url:
          '/media/' +
          encodeURIComponent(id),

        downloadUrl:
          '/media/' +
          encodeURIComponent(id) +
          '/download'

      });

    } catch (err) {

      await fsp.rm(
        req.file.path,
        {
          force: true
        }
      );

      await fsp.rm(
        finalPath,
        {
          force: true
        }
      );

      res
        .status(500)
        .json({

          error:
            err.message ||
            'Video conversion failed.'

        });

    }

  }
);

// ============================================================
// MEDIA SERVING
// ============================================================

function sendVideo(
  req,
  res,
  download
) {

  const id =
    cleanId(
      req.params.videoId
    );

  const item =
    appData.library.get(id);

  if (!item) {

    return res
      .status(404)
      .json({
        error:
          'Media not found.'
      });

  }

  // External MP4
  if (item.externalUrl) {

    return res.redirect(
      item.externalUrl
    );

  }

  const absolute =
    path.join(
      MEDIA_ROOT,
      item.file
    );

  if (!fs.existsSync(absolute)) {

    return res
      .status(404)
      .json({
        error:
          'Media file is unavailable.'
      });

  }

  res.type('mp4');

  res.setHeader(
    'Content-Disposition',

    (
      download
        ? 'attachment'
        : 'inline'
    ) +
    '; filename="' +
    id +
    '.mp4"'
  );

  res.sendFile(
    absolute
  );

}

// ============================================================
// MEDIA PLAYER
// ============================================================

app.get(
  '/media/:videoId',
  (req, res) => {

    sendVideo(
      req,
      res,
      false
    );

  }
);

// ============================================================
// DOWNLOAD
// ============================================================

app.get(
  '/media/:videoId/download',
  (req, res) => {

    sendVideo(
      req,
      res,
      true
    );

  }
);

// ============================================================
// START
// ============================================================

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      `SPITz-X API listening on port ${PORT}`
    );

    console.log(
      'Converter:',
      YOUTUBE_CONVERTER_BASE ||
      'NOT CONFIGURED'
    );

  }
);
