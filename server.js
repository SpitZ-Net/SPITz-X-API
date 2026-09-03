const express = require("express");
const cors = require("cors");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { execFile } = require("child_process");

const app = express();

const PORT = process.env.PORT || 10000;

const API_VERSION = "2.0.0";

const MAX_FILE_SIZE = "500M";
const MAX_CONCURRENT_JOBS = 1;
const FILE_LIFETIME_MS = 15 * 60 * 1000;

const MEDIA_ROOT = path.join(
    os.tmpdir(),
    "spitz-x-media"
);

const jobs = new Map();

let activeJobs = 0;


/* =========================================================
   BASIC SERVER CONFIG
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

    await fsp.mkdir(
        MEDIA_ROOT,
        {
            recursive: true
        }
    );

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
   ROOT
========================================================= */

app.get("/", (req, res) => {

    res.json({

        name: "SPITz-X API",

        status: "online",

        version: API_VERSION,

        services: {

            analyze: "/analyze",

            playback: "/playback",

            convert: "/convert",

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

        processor:
            ytDlpPath(),

        activeJobs:
            activeJobs,

        maxConcurrentJobs:
            MAX_CONCURRENT_JOBS

    });

});


/* =========================================================
   HELPERS
========================================================= */

function ytDlpPath() {

    return path.join(
        process.cwd(),
        "yt-dlp"
    );

}


function isYouTubeURL(value) {

    try {

        const url =
            new URL(value);

        const hostname =
            url.hostname
                .toLowerCase()
                .replace(/^www\./, "");

        const allowedHosts = [

            "youtube.com",

            "m.youtube.com",

            "youtu.be"

        ];

        if (
            !allowedHosts.includes(
                hostname
            )
        ) {

            return false;

        }

        if (
            hostname === "youtu.be"
        ) {

            return (
                url.pathname
                    .split("/")
                    .filter(Boolean)
                    .length === 1
            );

        }

        if (
            url.pathname === "/watch"
        ) {

            return Boolean(
                url.searchParams.get("v")
            );

        }

        if (
            url.pathname.startsWith(
                "/shorts/"
            )
        ) {

            return (
                url.pathname
                    .split("/")
                    .filter(Boolean)
                    .length === 2
            );

        }

        if (
            url.pathname.startsWith(
                "/embed/"
            )
        ) {

            return (
                url.pathname
                    .split("/")
                    .filter(Boolean)
                    .length === 2
            );

        }

        return false;

    } catch {

        return false;

    }

}


function validateURL(value) {

    if (
        typeof value !== "string" ||
        !value.trim()
    ) {

        return {
            valid: false,
            error: "Missing URL."
        };

    }

    const url =
        value.trim();

    if (
        url.length > 2048
    ) {

        return {
            valid: false,
            error: "URL is too long."
        };

    }

    if (
        !isYouTubeURL(url)
    ) {

        return {

            valid: false,

            error:
                "Only supported YouTube video URLs are currently accepted."

        };

    }

    return {

        valid: true,

        url: url

    };

}


function runYTDLP(
    args,
    timeout
) {

    return new Promise(
        (resolve, reject) => {

            execFile(

                ytDlpPath(),

                args,

                {

                    timeout:
                        timeout,

                    maxBuffer:
                        8 * 1024 * 1024,

                    windowsHide:
                        true

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

                        stdout:
                            stdout,

                        stderr:
                            stderr

                    });

                }

            );

        }
    );

}


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

        createdAt:
            Date.now(),

        file: null,

        title: null

    };

}


async function cleanupJob(
    jobId
) {

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


function scheduleCleanup(
    jobId
) {

    setTimeout(
        () => {

            cleanupJob(
                jobId
            );

        },
        FILE_LIFETIME_MS
    );

}


function formatDuration(
    seconds
) {

    if (
        !Number.isFinite(
            seconds
        )
    ) {

        return null;

    }

    seconds =
        Math.max(
            0,
            Math.floor(seconds)
        );

    const hours =
        Math.floor(
            seconds / 3600
        );

    const minutes =
        Math.floor(
            (seconds % 3600) / 60
        );

    const secs =
        seconds % 60;

    if (hours > 0) {

        return (
            String(hours).padStart(2, "0") +
            ":" +
            String(minutes).padStart(2, "0") +
            ":" +
            String(secs).padStart(2, "0")
        );

    }

    return (
        String(minutes).padStart(2, "0") +
        ":" +
        String(secs).padStart(2, "0")
    );

}


function getOutputFile(
    directory
) {

    const possibleExtensions = [

        ".mp4",
        ".webm",
        ".mkv",
        ".mov",
        ".avi",
        ".flv"

    ];

    return fsp
        .readdir(
            directory
        )
        .then(files => {

            const match =
                files.find(
                    file => {

                        const extension =
                            path.extname(
                                file
                            )
                            .toLowerCase();

                        return possibleExtensions.includes(
                            extension
                        );

                    }
                );

            if (!match) {

                throw new Error(
                    "The media processor did not produce a video file."
                );

            }

            return path.join(
                directory,
                match
            );

        });

}


function publicMediaURL(
    req,
    jobId
) {

    return (
        `${req.protocol}://${req.get("host")}` +
        `/media/${encodeURIComponent(jobId)}`
    );

}


function friendlyError(
    error
) {

    const output =
        (
            error.stderr ||
            error.stdout ||
            error.message ||
            ""
        )
        .toString()
        .trim();

    if (
        output.length > 1000
    ) {

        return output.slice(
            -1000
        );

    }

    return output ||
        "Media processing failed.";

}


/* =========================================================
   ANALYZE
========================================================= */

app.post(
    "/analyze",
    async (req, res) => {

        const validation =
            validateURL(
                req.body?.url
            );

        if (!validation.valid) {

            return res
                .status(400)
                .json({

                    success: false,

                    error:
                        validation.error

                });

        }

        try {

            const result =
                await runYTDLP(

                    [

                        "--dump-single-json",

                        "--skip-download",

                        "--no-playlist",

                        "--no-warnings",

                        "--js-runtimes",
                        "node",

                        "--remote-components",
                        "ejs:github",

                        validation.url

                    ],

                    60000

                );


            const data =
                JSON.parse(
                    result.stdout
                );


            return res.json({

                success: true,

                type:
                    data.extractor_key ||
                    "YouTube",

                id:
                    data.id ||
                    null,

                title:
                    data.title ||
                    null,

                uploader:
                    data.uploader ||
                    data.channel ||
                    null,

                channel:
                    data.channel ||
                    null,

                duration:
                    data.duration ||
                    null,

                durationFormatted:
                    formatDuration(
                        data.duration
                    ),

                thumbnail:
                    data.thumbnail ||
                    null,

                width:
                    data.width ||
                    null,

                height:
                    data.height ||
                    null,

                resolution:
                    data.resolution ||
                    (
                        data.width &&
                        data.height
                            ? `${data.width}x${data.height}`
                            : null
                    ),

                webpageUrl:
                    data.webpage_url ||
                    validation.url,

                live:
                    Boolean(
                        data.is_live
                    )

            });

        } catch (error) {

            console.error(
                "Analyze error:",
                friendlyError(
                    error
                )
            );

            return res
                .status(500)
                .json({

                    success: false,

                    error:
                        "Unable to analyze this video.",

                    details:
                        friendlyError(
                            error
                        )

                });

        }

    }
);


/* =========================================================
   PROCESS MEDIA
========================================================= */

async function processMedia(
    req,
    res,
    mode
) {

    const validation =
        validateURL(
            req.body?.url
        );

    if (!validation.valid) {

        return res
            .status(400)
            .json({

                success: false,

                error:
                    validation.error

            });

    }


    if (
        activeJobs >=
        MAX_CONCURRENT_JOBS
    ) {

        return res
            .status(429)
            .json({

                success: false,

                error:
                    "The media processor is busy. Please try again in a moment."

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


        /*
            We keep processing capped at 720p to make
            the small/free Render instance more practical.
        */

        const outputTemplate =
            path.join(
                job.directory,
                "video.%(ext)s"
            );


        const args = [

            "--no-playlist",

            "--no-warnings",

            "--restrict-filenames",

            "--max-filesize",
            MAX_FILE_SIZE,

            "--js-runtimes",
            "node",

            "--remote-components",
            "ejs:github",

            "-f",

            "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/b[height<=720]",

            "--recode-video",
            "mp4",

            "-o",
            outputTemplate,

            validation.url

        ];


        console.log(
            `Starting ${mode} job ${job.id}`
        );


        await runYTDLP(
            args,
            8 * 60 * 1000
        );


        const file =
            await getOutputFile(
                job.directory
            );


        const stats =
            await fsp.stat(
                file
            );


        if (
            stats.size <= 0
        ) {

            throw new Error(
                "The generated video file is empty."
            );

        }


        job.file =
            file;


        job.title =
            path.basename(
                file
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
                path.basename(
                    file
                ),

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
            friendlyError(
                error
            )
        );


        return res
            .status(500)
            .json({

                success: false,

                error:
                    `Unable to process media for ${mode}.`,

                details:
                    friendlyError(
                        error
                    )

            });

    }

}


/* =========================================================
   PLAYBACK
========================================================= */

app.post(
    "/playback",
    async (req, res) => {

        return processMedia(
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


        return processMedia(
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
                        job.title ||
                        "spitz-x-video.mp4"
                    )}"`
                );

            } else {

                res.setHeader(
                    "Content-Disposition",
                    "inline"
                );

            }


            res.sendFile(
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
   SAFE FILENAME
========================================================= */

function safeFilename(
    value
) {

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
        ) || "spitz-x-video.mp4";

}


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
   ERROR HANDLER
========================================================= */

app.use(
    (
        error,
        req,
        res,
        next
    ) => {

        console.error(
            "Unhandled API error:",
            error
        );

        res
            .status(500)
            .json({

                success: false,

                error:
                    "Internal SPITz-X API error."

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
            `yt-dlp expected at: ${ytDlpPath()}`
        );

    }
);
