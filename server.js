const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();

const PORT = Number(process.env.PORT || 10000);
const MAX_UPLOAD = 250 * 1024 * 1024;
const TTL = 15 * 60 * 1000;

const tempRoot = "/tmp/spitz-x-media";
const jobs = new Map();

fs.mkdirSync(tempRoot, { recursive: true });

app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

/* --------------------------------------------------
   UPLOAD CONFIG
-------------------------------------------------- */

const upload = multer({
    dest: tempRoot,
    limits: {
        fileSize: MAX_UPLOAD,
        files: 1
    },
    fileFilter: (req, file, cb) => {
        if (/^video\//i.test(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error("Only video files are allowed."));
        }
    }
});

/* --------------------------------------------------
   YOUTUBE URL PARSER
-------------------------------------------------- */

function youtubeId(raw) {
    try {
        const u = new URL(raw);

        const host = u.hostname
            .replace(/^www\./, "")
            .toLowerCase();

        // youtube.com/watch?v=
        if (
            (host === "youtube.com" || host === "m.youtube.com") &&
            u.pathname === "/watch"
        ) {
            return u.searchParams.get("v");
        }

        // youtu.be/VIDEO_ID
        if (host === "youtu.be") {
            return u.pathname.slice(1).split("/")[0] || null;
        }

        // youtube.com/shorts/VIDEO_ID
        if (
            host === "youtube.com" &&
            u.pathname.startsWith("/shorts/")
        ) {
            return u.pathname.split("/")[2] || null;
        }

        // youtube.com/embed/VIDEO_ID
        if (
            host === "youtube.com" &&
            u.pathname.startsWith("/embed/")
        ) {
            return u.pathname.split("/")[2] || null;
        }

        return null;
    } catch {
        return null;
    }
}

/* --------------------------------------------------
   JOB CLEANUP
-------------------------------------------------- */

function cleanupJob(id) {
    const job = jobs.get(id);

    if (!job) return;

    jobs.delete(id);

    for (const file of [job.input, job.output]) {
        if (file) {
            fs.rm(file, { force: true }, () => {});
        }
    }

    if (job.directory) {
        fs.rm(job.directory, {
            recursive: true,
            force: true
        }).catch(() => {});
    }
}

/* --------------------------------------------------
   FFMPEG
-------------------------------------------------- */

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

        const process = spawn("ffmpeg", args, {
            stdio: ["ignore", "ignore", "pipe"]
        });

        let errorText = "";

        process.stderr.on("data", data => {
            errorText += data.toString();

            if (errorText.length > 8000) {
                errorText = errorText.slice(-8000);
            }
        });

        process.on("error", reject);

        process.on("close", code => {
            if (code === 0) {
                resolve();
            } else {
                reject(
                    new Error(
                        "FFmpeg failed:\n" + errorText
                    )
                );
            }
        });
    });
}

/* --------------------------------------------------
   ROOT
-------------------------------------------------- */

app.get("/", (req, res) => {
    res.json({
        name: "SPITz-X API",
        status: "online",
        version: "2.3.0",

        services: {
            analyze: "/analyze",
            process: "/process",
            convert: "/convert",
            playback: "/playback/:jobId",
            media: "/media/:jobId",
            download: "/download/:jobId",
            lookup: "/media/by-video/:videoId",
            health: "/health"
        }
    });
});

/* --------------------------------------------------
   HEALTH
-------------------------------------------------- */

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        service: "SPITz-X API",
        version: "2.3.0",
        processor: "ffmpeg",
        activeJobs: jobs.size,
        maxUploadMB: 250
    });
});

/* --------------------------------------------------
   YOUTUBE METADATA
--------------------------------------------------

   This ONLY retrieves public metadata.

   It does not attempt to bypass YouTube security
   or extract the YouTube stream.
-------------------------------------------------- */

app.get("/analyze", async (req, res) => {
    const url = String(req.query.url || "");
    const id = youtubeId(url);

    if (!id) {
        return res.status(400).json({
            error: "Invalid YouTube watch URL."
        });
    }

    try {
        const metadataUrl =
            "https://www.youtube.com/oembed?format=json&url=" +
            encodeURIComponent(
                "https://www.youtube.com/watch?v=" + id
            );

        const response = await fetch(metadataUrl);

        if (!response.ok) {
            return res.status(502).json({
                error: "YouTube metadata could not be retrieved."
            });
        }

        const data = await response.json();

        res.json({
            videoId: id,
            title: data.title || "YouTube Video",
            author_name: data.author_name || "Unknown",
            author_url: data.author_url || "",
            thumbnail_url:
                "https://i.ytimg.com/vi/" +
                id +
                "/hqdefault.jpg"
        });

    } catch (error) {
        console.error("Analyze error:", error);

        res.status(502).json({
            error: "Metadata request failed."
        });
    }
});

/* --------------------------------------------------
   PROCESS AUTHORIZED VIDEO
-------------------------------------------------- */

async function processUpload(req, res) {
    if (!req.file) {
        return res.status(400).json({
            error: "Upload a video in the 'video' field."
        });
    }

    const jobId = crypto.randomUUID();

    const directory = path.join(
        tempRoot,
        jobId
    );

    const input = path.join(
        directory,
        "source"
    );

    const output = path.join(
        directory,
        "spitz-x-video.mp4"
    );

    try {
        await fsp.mkdir(directory, {
            recursive: true
        });

        await fsp.rename(
            req.file.path,
            input
        );

        await runFfmpeg(
            input,
            output
        );

        const submittedVideoId =
            String(req.body.videoId || "").trim();

        const submittedVideoUrl =
            String(req.body.videoUrl || "").trim();

        const videoId =
            youtubeId(submittedVideoUrl) ||
            submittedVideoId ||
            null;

        jobs.set(jobId, {
            input,
            output,
            directory,
            videoId,
            created: Date.now()
        });

        setTimeout(() => {
            cleanupJob(jobId);
        }, TTL);

        res.json({
            ok: true,

            jobId,

            videoId,

            playbackUrl:
                "/playback/" + jobId,

            mediaUrl:
                "/media/" + jobId,

            downloadUrl:
                "/download/" + jobId,

            expiresInMinutes: 15
        });

    } catch (error) {
        console.error("Processing error:", error);

        await fsp.rm(
            directory,
            {
                recursive: true,
                force: true
            }
        ).catch(() => {});

        res.status(500).json({
            error:
                error.message ||
                "Video processing failed."
        });
    }
}

/* --------------------------------------------------
   PROCESS / CONVERT
-------------------------------------------------- */

app.post(
    "/process",
    upload.single("video"),
    processUpload
);

app.post(
    "/convert",
    upload.single("video"),
    processUpload
);

/* --------------------------------------------------
   MEDIA LOOKUP BY YOUTUBE VIDEO ID
-------------------------------------------------- */

app.get(
    "/media/by-video/:videoId",
    (req, res) => {
        const videoId =
            String(req.params.videoId || "").trim();

        if (!videoId) {
            return res.status(400).json({
                error: "Missing video ID."
            });
        }

        const matching = [
            ...jobs.entries()
        ]
            .reverse()
            .find(
                ([, job]) =>
                    job.videoId === videoId &&
                    fs.existsSync(job.output)
            );

        if (!matching) {
            return res.status(404).json({
                error:
                    "No authorized MP4 copy is currently registered for this video."
            });
        }

        const [jobId, job] = matching;

        res.json({
            ok: true,

            videoId,

            jobId,

            playbackUrl:
                "/playback/" + jobId,

            mediaUrl:
                "/media/" + jobId,

            downloadUrl:
                "/download/" + jobId,

            expiresInMinutes: Math.max(
                0,
                Math.ceil(
                    (
                        TTL -
                        (Date.now() - job.created)
                    ) /
                    60000
                )
            )
        });
    }
);

/* --------------------------------------------------
   MEDIA SERVING
-------------------------------------------------- */

function getJob(req, res) {
    const job =
        jobs.get(req.params.jobId);

    if (
        !job ||
        !fs.existsSync(job.output)
    ) {
        res.status(404).json({
            error:
                "Media expired or was not found."
        });

        return null;
    }

    return job;
}

/* --------------------------------------------------
   INLINE PLAYBACK
-------------------------------------------------- */

app.get(
    "/playback/:jobId",
    (req, res) => {
        const job = getJob(req, res);

        if (!job) return;

        res.setHeader(
            "Content-Type",
            "video/mp4"
        );

        res.setHeader(
            "Content-Disposition",
            'inline; filename="spitz-x-video.mp4"'
        );

        res.sendFile(job.output);
    }
);

/* --------------------------------------------------
   NORMAL MEDIA URL
-------------------------------------------------- */

app.get(
    "/media/:jobId",
    (req, res) => {
        const job = getJob(req, res);

        if (!job) return;

        res.setHeader(
            "Content-Type",
            "video/mp4"
        );

        res.setHeader(
            "Content-Disposition",
            'inline; filename="spitz-x-video.mp4"'
        );

        res.sendFile(job.output);
    }
);

/* --------------------------------------------------
   DOWNLOAD MP4
-------------------------------------------------- */

app.get(
    "/download/:jobId",
    (req, res) => {
        const job = getJob(req, res);

        if (!job) return;

        res.download(
            job.output,
            "spitz-x-video.mp4"
        );
    }
);

/* --------------------------------------------------
   ERROR HANDLER
-------------------------------------------------- */

app.use((error, req, res, next) => {
    console.error(error);

    if (
        error.code === "LIMIT_FILE_SIZE"
    ) {
        return res.status(413).json({
            error:
                "Video is too large. Maximum size is 250 MB."
        });
    }

    res.status(500).json({
        error:
            error.message ||
            "Server error."
    });
});

/* --------------------------------------------------
   PERIODIC CLEANUP
-------------------------------------------------- */

setInterval(() => {
    const now = Date.now();

    for (const [id, job] of jobs.entries()) {
        if (
            now - job.created >= TTL
        ) {
            cleanupJob(id);
        }
    }
}, 60 * 1000);

/* --------------------------------------------------
   START SERVER
-------------------------------------------------- */

app.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log(
            `SPITz-X API listening on port ${PORT}`
        );
    }
);
