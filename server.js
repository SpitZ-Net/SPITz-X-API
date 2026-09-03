const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const MEDIA_ROOT =
  process.env.MEDIA_ROOT || path.join("/tmp", "spitz-x-library");

const UPLOAD_ROOT = path.join(MEDIA_ROOT, "_uploads");
const LIBRARY_FILE = path.join(MEDIA_ROOT, "library.json");

fs.mkdirSync(MEDIA_ROOT, { recursive: true });
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

function loadLibrary() {
  try {
    if (!fs.existsSync(LIBRARY_FILE)) return {};
    return JSON.parse(fs.readFileSync(LIBRARY_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveLibrary(library) {
  fs.writeFileSync(
    LIBRARY_FILE,
    JSON.stringify(library, null, 2),
    "utf8"
  );
}

function cleanId(id) {
  return String(id || "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 120);
}

function youtubeId(raw) {
  try {
    const url = new URL(raw);

    if (url.hostname === "youtu.be") {
      return cleanId(url.pathname.slice(1).split("/")[0]);
    }

    if (
      url.hostname.includes("youtube.com") ||
      url.hostname.includes("youtube-nocookie.com")
    ) {
      if (url.searchParams.get("v")) {
        return cleanId(url.searchParams.get("v"));
      }

      const parts = url.pathname.split("/").filter(Boolean);

      if (
        ["shorts", "embed", "live"].includes(parts[0]) &&
        parts[1]
      ) {
        return cleanId(parts[1]);
      }
    }
  } catch {}

  return null;
}

function baseUrl(req) {
  return (
    process.env.PUBLIC_BASE_URL ||
    `${req.protocol}://${req.get("host")}`
  ).replace(/\/+$/, "");
}

function adminAuthorized(req) {
  const expected = process.env.ADMIN_TOKEN;

  if (!expected) return false;

  return req.get("x-spitz-admin-token") === expected;
}

function itemFor(req, item) {
  const base = baseUrl(req);

  return {
    ...item,
    playbackUrl: `${base}/media/${encodeURIComponent(item.videoId)}`,
    downloadUrl: `${base}/media/${encodeURIComponent(
      item.videoId
    )}/download`,
  };
}

function runFfmpeg(input, output) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i",
      input,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      output,
    ];

    const ffmpeg = spawn("ffmpeg", args);

    let stderr = "";

    ffmpeg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    ffmpeg.on("error", reject);

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `FFmpeg exited with code ${code}: ${stderr.slice(-4000)}`
          )
        );
      }
    });
  });
}

const upload = multer({
  dest: UPLOAD_ROOT,
  limits: {
    fileSize: 1024 * 1024 * 1024,
  },
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "SPITz-X API",
    version: "5.0.0",
  });
});

app.get("/analyze", async (req, res) => {
  const url = String(req.query.url || "").trim();

  if (!url) {
    return res.status(400).json({
      error: "Missing url",
    });
  }

  const id = youtubeId(url);

  if (!id) {
    return res.status(400).json({
      error: "Unsupported or invalid YouTube URL",
    });
  }

  try {
    const response = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        url
      )}&format=json`
    );

    if (!response.ok) {
      throw new Error("YouTube metadata request failed");
    }

    const data = await response.json();

    const library = loadLibrary();

    const existing = library[id];

    return res.json({
      videoId: id,
      title: data.title || "Unknown title",
      author: data.author_name || "Unknown channel",
      thumbnailUrl:
        `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`,
      library: existing
        ? itemFor(req, existing)
        : null,
    });
  } catch (error) {
    return res.status(502).json({
      error: error.message || "Unable to analyze video",
    });
  }
});

app.get("/library/:videoId", (req, res) => {
  const videoId = cleanId(req.params.videoId);
  const library = loadLibrary();
  const item = library[videoId];

  if (!item) {
    return res.status(404).json({
      error: "Video not found in library",
    });
  }

  const fullPath = path.join(MEDIA_ROOT, item.filename);

  if (!fs.existsSync(fullPath)) {
    delete library[videoId];
    saveLibrary(library);

    return res.status(404).json({
      error: "Video file is no longer available",
    });
  }

  return res.json(itemFor(req, item));
});

async function processUpload(req, res, isAdmin) {
  if (!req.file) {
    return res.status(400).json({
      error: "No video file uploaded",
    });
  }

  const videoId = cleanId(
    req.body.videoId ||
      `spitz-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`
  );

  const title =
    String(req.body.title || req.file.originalname || "SPITz-X Video");

  const outputName = `${videoId}.mp4`;
  const outputPath = path.join(MEDIA_ROOT, outputName);

  try {
    await runFfmpeg(req.file.path, outputPath);

    const library = loadLibrary();

    const item = {
      videoId,
      title,
      channel: String(req.body.channel || ""),
      sourceUrl: String(req.body.sourceUrl || ""),
      filename: outputName,
      size: fs.statSync(outputPath).size,
      createdAt: new Date().toISOString(),
      adminUploaded: Boolean(isAdmin),
    };

    library[videoId] = item;
    saveLibrary(library);

    return res.json(itemFor(req, item));
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Video processing failed",
    });
  } finally {
    try {
      fs.unlinkSync(req.file.path);
    } catch {}
  }
}

app.post("/process", upload.single("video"), async (req, res) => {
  return processUpload(req, res, false);
});

app.post("/convert", upload.single("video"), async (req, res) => {
  return processUpload(req, res, false);
});

app.post(
  "/admin/upload",
  upload.single("video"),
  async (req, res) => {
    if (!adminAuthorized(req)) {
      if (req.file) {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
      }

      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    return processUpload(req, res, true);
  }
);

app.get("/media/:videoId", (req, res) => {
  const videoId = cleanId(req.params.videoId);
  const library = loadLibrary();
  const item = library[videoId];

  if (!item) {
    return res.status(404).send("Video not found");
  }

  const filePath = path.join(MEDIA_ROOT, item.filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Video file not found");
  }

  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("Accept-Ranges", "bytes");

  return res.sendFile(path.resolve(filePath));
});

app.get("/media/:videoId/download", (req, res) => {
  const videoId = cleanId(req.params.videoId);
  const library = loadLibrary();
  const item = library[videoId];

  if (!item) {
    return res.status(404).send("Video not found");
  }

  const filePath = path.join(MEDIA_ROOT, item.filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Video file not found");
  }

  return res.download(
    path.resolve(filePath),
    `${item.videoId}.mp4`
  );
});

// No endpoint here extracts hidden/protected YouTube stream URLs.
// Playback URLs point to media hosted by SPITz-X itself.

app.listen(PORT, () => {
  console.log(`SPITz-X API listening on port ${PORT}`);
});