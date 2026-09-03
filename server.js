const express = require("express");
const cors = require("cors");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");
const multer = require("multer");

const app = express();

const PORT = process.env.PORT || 10000;
const API_VERSION = "2.1.0";

const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;
const MAX_CONCURRENT_JOBS = 1;
const FILE_LIFETIME_MS = 15 * 60 * 1000;

const MEDIA_ROOT = path.join(
  os.tmpdir(),
  "spitz-x-media"
);

const jobs = new Map();

let activeJobs = 0;


/* =========================================================
   BASIC CONFIG
========================================================= */

app.disable("x-powered-by");

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);

app.use(
  express.json({
    limit: "32kb"
  })
);


/* =========================================================
   STARTUP
========================================================= */

async function initialize() {
  await fsp.mkdir(MEDIA_ROOT, {
    recursive: true
  });

  console.log(
    "SPITz-X media directory:",
    MEDIA_ROOT
  );
}

initialize().catch(error => {
  console.error(
    "Startup error:",
    error
  );
});


/* =========================================================
   MULTER UPLOAD CONFIG
========================================================= */

const upload = multer({
  dest: path.join(
    MEDIA_ROOT,
    "uploads"
  ),

  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1
  },

  fileFilter: (req, file, callback) => {

    const allowedMimeTypes = [
      "video/mp4",
      "video/webm",
      "video/quicktime",
      "video/x-matroska",
      "video/x-msvideo",
      "video/mpeg"
    ];

    if (
      allowedMimeTypes.includes(
        file.mimetype
      )
    ) {
      callback(null, true);
      return;
    }

    callback(
      new Error(
        "Unsupported video format."
      )
    );
  }
});


/* =========================================================
   ROOT
========================================================= */

app.get("/", (req, res) => {

  res.json({
    name: "SPITz-X API",
    status: "online",
    version: API_VERSION,

    services: {
      analyze: "/analyze",
      process: "/process",
      playback: "/playback",
      convert: "/convert",
      media: "/media/:jobId",
      health: "/health"
    }
  });

});


/* =========================================================
   HEALTH
========================================================= */

app.get("/health", (req, res) => {

  res.json({
    status: "ok",
    service: "SPITz-X API",
    version: API_VERSION,

    processor: "ffmpeg",

    activeJobs: activeJobs,

    maxConcurrentJobs:
      MAX_CONCURRENT_JOBS,

    maxUploadMB:
      MAX_UPLOAD_BYTES /
      1024 /
      1024
  });

});


/* =========================================================
   YOUTUBE HELPERS
========================================================= */

function getYouTubeVideoId(value) {

  try {

    const url =
      new URL(value);

    const hostname =
      url.hostname
        .toLowerCase()
        .replace(/^www\./, "");

    if (
      hostname === "youtu.be"
    ) {

      const id =
        url.pathname
          .split("/")
          .filter(Boolean)[0];

      return id || null;
    }

    if (
      hostname !== "youtube.com" &&
      hostname !== "m.youtube.com"
    ) {
      return null;
    }

    if (
      url.pathname === "/watch"
    ) {

      return (
        url.searchParams.get("v") ||
        null
      );
    }

    if (
      url.pathname.startsWith("/shorts/")
    ) {

      return (
        url.pathname
          .split("/")
          .filter(Boolean)[1] ||
        null
      );
    }

    if (
      url.pathname.startsWith("/embed/")
    ) {

      return (
        url.pathname
          .split("/")
          .filter(Boolean)[1] ||
        null
      );
    }

    return null;

  } catch {

    return null;

  }

}


function isYouTubeURL(value) {

  return Boolean(
    getYouTubeVideoId(value)
  );

}


/* =========================================================
   GENERAL HELPERS
========================================================= */

function createJob() {

  const id =
    crypto.randomUUID();

  const directory =
    path.join(
      MEDIA_ROOT,
      id
    );

  return {
    id,
    directory,
    createdAt: Date.now(),
    file: null,
    filename: null
  };

}


async function cleanupJob(jobId) {

  const job =
    jobs.get(jobId);

  if (!job) {
    return;
  }

  try {

    await fsp.rm(
      job.directory,
      {
        recursive: true,
        force: true
      }
    );

  } catch (error) {

    console.error(
      "Cleanup error:",
      error.message
    );

  }

  jobs.delete(jobId);

}


function scheduleCleanup(jobId) {

  setTimeout(
    () => {
      cleanupJob(jobId);
    },
    FILE_LIFETIME_MS
  );

}


function safeFilename(value) {

  return String(value)

    .replace(
      /[<>:"/\\|?*\x00-\x1F]/g,
      "_"
    )

    .replace(
      /\s+/g,
      " "
    )

    .trim()

    .slice(
      0,
      180
    ) ||

    "spitz-x-video.mp4";

}


function publicMediaURL(req, jobId) {

  return (
    `${req.protocol}://${req.get("host")}` +
    `/media/${encodeURIComponent(jobId)}`
  );

}


function runFFmpeg(
  input,
  output
) {

  return new Promise(
    (resolve, reject) => {

      const args = [

        "-y",

        "-i",
        input,

        "-c:v",
        "libx264",

        "-preset",
        "veryfast",

        "-crf",
        "23",

        "-c:a",
        "aac",

        "-b:a",
        "128k",

        "-movflags",
        "+faststart",

        output

      ];

      execFile(
        "ffmpeg",
        args,

        {
          timeout:
            10 * 60 * 1000,

          maxBuffer:
            8 * 1024 * 1024
        },

        (
          error,
          stdout,
          stderr
        ) => {

          if (error) {

            error.stdout =
              stdout;

            error.stderr =
              stderr;

            reject(error);

            return;

          }

          resolve({
            stdout,
            stderr
          });

        }
      );

    }
  );

}


function friendlyError(error) {

  const output =
    (
      error?.stderr ||
      error?.stdout ||
      error?.message ||
      ""
    )
    .toString()
    .trim();

  if (
    output.length > 1200
  ) {

    return output.slice(
      -1200
    );

  }

  return (
    output ||
    "Media processing failed."
  );

}


/* =========================================================
   YOUTUBE ANALYZE
========================================================= */

/*
   This does NOT download the YouTube video.

   It asks YouTube's public oEmbed endpoint
   for basic metadata.
*/

app.post(
  "/analyze",
  async (req, res) => {

    const input =
      req.body?.url;

    if (
      typeof input !== "string" ||
      !input.trim()
    ) {

      return res
        .status(400)
        .json({
          success: false,
          error: "Missing YouTube URL."
        });

    }

    const url =
      input.trim();

    if (
      !isYouTubeURL(url)
    ) {

      return res
        .status(400)
        .json({
          success: false,
          error:
            "Please enter a valid YouTube video URL."
        });

    }

    const videoId =
      getYouTubeVideoId(url);

    try {

      const endpoint =
        "https://www.youtube.com/oembed" +
        "?url=" +
        encodeURIComponent(url) +
        "&format=json";

      const response =
        await fetch(endpoint);

      if (!response.ok) {

        throw new Error(
          `YouTube returned HTTP ${response.status}`
        );

      }

      const data =
        await response.json();

      return res.json({

        success: true,

        type: "YouTube",

        id: videoId,

        title:
          data.title ||
          null,

        uploader:
          data.author_name ||
          null,

        channel:
          data.author_name ||
          null,

        thumbnail:
          data.thumbnail_url ||
          `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,

        thumbnailWidth:
          data.thumbnail_width ||
          null,

        thumbnailHeight:
          data.thumbnail_height ||
          null,

        webpageUrl:
          url,

        playerUrl:
          `https://www.youtube.com/watch?v=${videoId}`,

        note:
          "Metadata only. No server-side YouTube download is performed."

      });

    } catch (error) {

      console.error(
        "YouTube analyze error:",
        friendlyError(error)
      );

      return res
        .status(502)
        .json({

          success: false,

          error:
            "YouTube metadata could not be retrieved.",

          details:
            friendlyError(error)

        });

    }

  }
);


/* =========================================================
   VIDEO PROCESSING
========================================================= */

async function processUploadedVideo(
  req,
  res,
  mode
) {

  if (
    !req.file
  ) {

    return res
      .status(400)
      .json({

        success: false,

        error:
          "No video file was uploaded."

      });

  }


  if (
    activeJobs >=
    MAX_CONCURRENT_JOBS
  ) {

    try {
      await fsp.rm(
        req.file.path,
        {
          force: true
        }
      );
    } catch {}

    return res
      .status(429)
      .json({

        success: false,

        error:
          "The media processor is busy. Please try again shortly."

      });

  }


  activeJobs++;


  const job =
    createJob();

  jobs.set(
    job.id,
    job
  );


  try {

    await fsp.mkdir(
      job.directory,
      {
        recursive: true
      }
    );


    const inputExtension =
      path.extname(
        req.file.originalname
      )
      .toLowerCase() ||
      ".video";


    const inputPath =
      path.join(
        job.directory,
        `input${inputExtension}`
      );


    const outputPath =
      path.join(
        job.directory,
        "spitz-x-output.mp4"
      );


    await fsp.rename(
      req.file.path,
      inputPath
    );


    console.log(
      `Starting ${mode} job ${job.id}`
    );


    await runFFmpeg(
      inputPath,
      outputPath
    );


    const stats =
      await fsp.stat(
        outputPath
      );


    if (
      stats.size <= 0
    ) {

      throw new Error(
        "FFmpeg produced an empty file."
      );

    }


    job.file =
      outputPath;

    job.filename =
      safeFilename(
        path.parse(
          req.file.originalname
        ).name +
        ".mp4"
      );


    scheduleCleanup(
      job.id
    );


    const mediaURL =
      publicMediaURL(
        req,
        job.id
      );


    activeJobs--;


    return res.json({

      success: true,

      jobId:
        job.id,

      mode:
        mode,

      filename:
        job.filename,

      size:
        stats.size,

      playbackUrl:
        mediaURL,

      downloadUrl:
        mediaURL +
        "?download=1",

      expiresIn:
        FILE_LIFETIME_MS / 1000

    });


  } catch (error) {

    activeJobs--;

    await cleanupJob(
      job.id
    );


    console.error(
      `${mode} error:`,
      friendlyError(error)
    );


    return res
      .status(500)
      .json({

        success: false,

        error:
          "Video processing failed.",

        details:
          friendlyError(error)

      });

  }

}


/* =========================================================
   PROCESS
========================================================= */

app.post(
  "/process",
  upload.single("video"),
  async (req, res) => {

    return processUploadedVideo(
      req,
      res,
      "process"
    );

  }
);


/* =========================================================
   PLAYBACK
========================================================= */

app.post(
  "/playback",
  upload.single("video"),
  async (req, res) => {

    return processUploadedVideo(
      req,
      res,
      "playback"
    );

  }
);


/* =========================================================
   MP4 CONVERSION
========================================================= */

app.post(
  "/convert",
  upload.single("video"),
  async (req, res) => {

    if (
      req.body?.format &&
      req.body.format !== "mp4"
    ) {

      return res
        .status(400)
        .json({

          success: false,

          error:
            "Only MP4 output is supported."

        });

    }


    return processUploadedVideo(
      req,
      res,
      "mp4"
    );

  }
);


/* =========================================================
   MEDIA FILE
========================================================= */

app.get(
  "/media/:jobId",
  async (req, res) => {

    const jobId =
      req.params.jobId;


    if (
      !/^[a-f0-9-]{36}$/i.test(
        jobId
      )
    ) {

      return res
        .status(400)
        .json({

          error:
            "Invalid media ID."

        });

    }


    const job =
      jobs.get(
        jobId
      );


    if (
      !job ||
      !job.file
    ) {

      return res
        .status(404)
        .json({

          error:
            "Media has expired or does not exist."

        });

    }


    try {

      await fsp.access(
        job.file,
        fs.constants.R_OK
      );


      const download =
        req.query.download === "1";


      res.setHeader(
        "Cache-Control",
        "no-store"
      );


      res.setHeader(
        "Accept-Ranges",
        "bytes"
      );


      res.setHeader(
        "Content-Type",
        "video/mp4"
      );


      if (download) {

        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${safeFilename(
            job.filename ||
            "spitz-x-video.mp4"
          )}"`
        );

      } else {

        res.setHeader(
          "Content-Disposition",
          "inline"
        );

      }


      return res.sendFile(
        job.file
      );


    } catch (error) {

      console.error(
        "Media serve error:",
        error.message
      );

      return res
        .status(404)
        .json({

          error:
            "Media file is no longer available."

        });

    }

  }
);


/* =========================================================
   MULTER ERROR HANDLER
========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    if (
      error instanceof multer.MulterError
    ) {

      if (
        error.code ===
        "LIMIT_FILE_SIZE"
      ) {

        return res
          .status(413)
          .json({

            success: false,

            error:
              "Video is too large. Maximum upload size is 250 MB."

          });

      }

      return res
        .status(400)
        .json({

          success: false,

          error:
            error.message

        });

    }


    if (
      error
    ) {

      return res
        .status(400)
        .json({

          success: false,

          error:
            error.message ||
            "Request failed."

        });

    }


    next();

  }
);


/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {

    res
      .status(404)
      .json({

        success: false,

        error:
          "SPITz-X API endpoint not found."

      });

  }
);


/* =========================================================
   SERVER
========================================================= */

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `SPITz-X API v${API_VERSION} running on port ${PORT}`
    );

    console.log(
      "FFmpeg processor enabled"
    );

  }
);
