const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const MAX_UPLOAD = 250 * 1024 * 1024;

// Use /tmp on Render Free for testing. For persistent storage, set
// MEDIA_ROOT to a persistent disk/object-storage mount supplied by your host.
const MEDIA_ROOT = process.env.MEDIA_ROOT || '/tmp/spitz-x-library';
const LIBRARY_FILE = path.join(MEDIA_ROOT, 'library.json');

fs.mkdirSync(MEDIA_ROOT, { recursive: true });
fs.mkdirSync(path.join(MEDIA_ROOT, '_uploads'), { recursive: true });

const appData = { library: new Map() };
try {
  if (fs.existsSync(LIBRARY_FILE)) {
    const saved = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
    for (const [id, item] of Object.entries(saved)) appData.library.set(id, item);
  }
} catch (err) {
  console.warn('Could not load library.json:', err.message);
}

const upload = multer({
  dest: path.join(MEDIA_ROOT, '_uploads'),
  limits: { fileSize: MAX_UPLOAD, files: 1 },
  fileFilter: (req, file, cb) => cb(null, /^video\//i.test(file.mimetype))
});

app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));

function saveLibrary() {
  const obj = Object.fromEntries(appData.library);
  return fsp.writeFile(LIBRARY_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

function youtubeId(raw) {
  try {
    const u = new URL(raw);
    const h = u.hostname.replace(/^www\./, '').toLowerCase();

    if ((h === 'youtube.com' || h === 'm.youtube.com') && u.pathname === '/watch') {
      return u.searchParams.get('v');
    }
    if (h === 'youtu.be') return u.pathname.split('/')[1] || null;
    if (h === 'youtube.com' && u.pathname.startsWith('/shorts/')) {
      return u.pathname.split('/')[2] || null;
    }
    if (h === 'youtube.com' && u.pathname.startsWith('/embed/')) {
      return u.pathname.split('/')[2] || null;
    }
  } catch (_) {}
  return null;
}

function cleanId(id) {
  return String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

function adminAuthorized(req) {
  const expected = process.env.ADMIN_TOKEN;
  if (!expected) return false;
  const supplied = req.get('x-spitz-admin-token') || '';
  return supplied === expected;
}

async function runFfmpeg(input, output) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      'ffmpeg',
      [
        '-y',
        '-i', input,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart',
        output
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );

    let err = '';
    p.stderr.on('data', b => {
      err += b.toString();
      if (err.length > 8000) err = err.slice(-8000);
    });

    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('FFmpeg failed: ' + err));
    });
  });
}

function libraryItem(id) {
  const item = appData.library.get(id);
  if (!item) return null;

  const absolute = path.join(MEDIA_ROOT, item.file);
  if (!fs.existsSync(absolute)) return null;

  return {
    videoId: id,
    title: item.title || 'SPITz-X Video',
    channel: item.channel || '',
    filename: path.basename(item.file),
    url: '/media/' + encodeURIComponent(id),
    downloadUrl: '/media/' + encodeURIComponent(id) + '/download'
  };
}

app.get('/', (req, res) => {
  res.json({
    name: 'SPITz-X API',
    status: 'online',
    version: '3.0.0',
    services: {
      analyze: '/analyze',
      library: '/library/:videoId',
      adminUpload: '/admin/upload',
      media: '/media/:videoId',
      download: '/media/:videoId/download',
      process: '/process',
      health: '/health'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'SPITz-X API',
    version: '3.0.0',
    processor: 'ffmpeg',
    libraryItems: appData.library.size,
    maxUploadMB: 250,
    storageRoot: MEDIA_ROOT
  });
});

app.get('/analyze', async (req, res) => {
  const url = String(req.query.url || '');
  const id = youtubeId(url);

  if (!id) {
    return res.status(400).json({ error: 'Invalid YouTube watch URL.' });
  }

  try {
    const o = await fetch(
      'https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=' + id)
    );

    if (!o.ok) {
      return res.status(502).json({ error: 'YouTube metadata could not be retrieved.' });
    }

    const data = await o.json();
    const copy = libraryItem(id);

    res.json({
      videoId: id,
      ...data,
      libraryAvailable: Boolean(copy),
      library: copy
    });
  } catch (_) {
    res.status(502).json({ error: 'Metadata request failed.' });
  }
});

app.get('/library/:videoId', (req, res) => {
  const id = cleanId(req.params.videoId);
  const item = libraryItem(id);

  if (!item) {
    return res.status(404).json({
      available: false,
      error: 'No authorized MP4 copy is registered for this video.'
    });
  }

  res.json({ available: true, ...item });
});

app.post('/admin/upload', upload.single('video'), async (req, res) => {
  if (!adminAuthorized(req)) {
    if (req.file?.path) await fsp.rm(req.file.path, { force: true });
    return res.status(401).json({ error: 'Admin authorization required.' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'Upload a video in the video field.' });
  }

  const suppliedUrl = String(req.body.videoUrl || '');
  const id = cleanId(youtubeId(suppliedUrl) || req.body.videoId);

  if (!id) {
    await fsp.rm(req.file.path, { force: true });
    return res.status(400).json({
      error: 'Provide a valid YouTube watch URL or video ID.'
    });
  }

  const title = String(req.body.title || 'SPITz-X Video').slice(0, 200);
  const channel = String(req.body.channel || '').slice(0, 200);
  const filename = id + '.mp4';
  const finalPath = path.join(MEDIA_ROOT, filename);
  const tempPath = req.file.path;

  try {
    await runFfmpeg(tempPath, finalPath);
    await fsp.rm(tempPath, { force: true });

    appData.library.set(id, {
      title,
      channel,
      file: filename,
      updatedAt: new Date().toISOString()
    });

    await saveLibrary();

    res.json({
      ok: true,
      videoId: id,
      title,
      channel,
      url: '/media/' + encodeURIComponent(id),
      downloadUrl: '/media/' + encodeURIComponent(id) + '/download'
    });
  } catch (err) {
    await fsp.rm(tempPath, { force: true });
    await fsp.rm(finalPath, { force: true });
    res.status(500).json({ error: err.message || 'Video processing failed.' });
  }
});

// Student/user upload endpoint for an authorized source file.
// It can associate the processed copy with the pasted watch URL.
app.post('/process', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Upload a video in the video field.' });
  }

  const suppliedUrl = String(req.body.videoUrl || '');
  const id = cleanId(youtubeId(suppliedUrl) || req.body.videoId);

  if (!id) {
    await fsp.rm(req.file.path, { force: true });
    return res.status(400).json({
      error: 'Provide the YouTube watch URL or video ID so the copy can be linked.'
    });
  }

  const title = String(req.body.title || 'SPITz-X Video').slice(0, 200);
  const filename = id + '.mp4';
  const finalPath = path.join(MEDIA_ROOT, filename);

  try {
    await runFfmpeg(req.file.path, finalPath);
    await fsp.rm(req.file.path, { force: true });

    appData.library.set(id, {
      title,
      channel: '',
      file: filename,
      updatedAt: new Date().toISOString()
    });

    await saveLibrary();

    res.json({
      ok: true,
      videoId: id,
      title,
      url: '/media/' + encodeURIComponent(id),
      downloadUrl: '/media/' + encodeURIComponent(id) + '/download'
    });
  } catch (err) {
    await fsp.rm(req.file.path, { force: true });
    await fsp.rm(finalPath, { force: true });
    res.status(500).json({ error: err.message || 'Video processing failed.' });
  }
});

app.post('/convert', upload.single('video'), async (req, res) => {
  // Compatibility route: same authorized-source processing as /process.
  if (!req.file) {
    return res.status(400).json({ error: 'Upload a video in the video field.' });
  }

  const suppliedUrl = String(req.body.videoUrl || '');
  const id = cleanId(youtubeId(suppliedUrl) || req.body.videoId);

  if (!id) {
    await fsp.rm(req.file.path, { force: true });
    return res.status(400).json({
      error: 'Provide the YouTube watch URL or video ID so the copy can be linked.'
    });
  }

  const title = String(req.body.title || 'SPITz-X Video').slice(0, 200);
  const filename = id + '.mp4';
  const finalPath = path.join(MEDIA_ROOT, filename);

  try {
    await runFfmpeg(req.file.path, finalPath);
    await fsp.rm(req.file.path, { force: true });

    appData.library.set(id, {
      title,
      channel: '',
      file: filename,
      updatedAt: new Date().toISOString()
    });

    await saveLibrary();

    res.json({
      ok: true,
      videoId: id,
      title,
      url: '/media/' + encodeURIComponent(id),
      downloadUrl: '/media/' + encodeURIComponent(id) + '/download'
    });
  } catch (err) {
    await fsp.rm(req.file.path, { force: true });
    await fsp.rm(finalPath, { force: true });
    res.status(500).json({ error: err.message || 'Video processing failed.' });
  }
});

function sendVideo(req, res, download) {
  const id = cleanId(req.params.videoId);
  const item = appData.library.get(id);

  if (!item) {
    return res.status(404).json({ error: 'Media not found.' });
  }

  const absolute = path.join(MEDIA_ROOT, item.file);

  if (!fs.existsSync(absolute)) {
    return res.status(404).json({ error: 'Media file is unavailable.' });
  }

  res.type('mp4');
  res.setHeader(
    'Content-Disposition',
    (download ? 'attachment' : 'inline') +
    '; filename="' + (id + '.mp4') + '"'
  );

  // Express sendFile supports browser range requests, which allows
  // native HTML5 video seeking/streaming.
  res.sendFile(absolute);
}

app.get('/media/:videoId/download', (req, res) => {
  sendVideo(req, res, true);
});

app.get('/media/:videoId', (req, res) => {
  sendVideo(req, res, false);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`SPITz-X API listening on 0.0.0.0:${PORT}`);
});
