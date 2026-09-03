const express = require("express");
const cors = require("cors");

const app = express();

const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

/*
    SPITz-X API
*/

app.get("/", (req, res) => {
    res.json({
        name: "SPITz-X API",
        status: "online",
        version: "1.0.0"
    });
});


/*
    Health check
*/

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        service: "SPITz-X API"
    });
});


/*
    Analyze media URL

    This intentionally does not download or process
    anything by itself yet.
*/

app.post("/analyze", async (req, res) => {

    const { url } = req.body;

    if (!url) {
        return res.status(400).json({
            error: "Missing URL"
        });
    }

    try {

        const parsed = new URL(url);

        res.json({
            success: true,
            type: detectType(parsed),
            url: url
        });

    } catch {

        res.status(400).json({
            error: "Invalid URL"
        });

    }

});


/*
    Playback endpoint

    Your actual authorized media-processing code
    can be connected here later.
*/

app.post("/playback", async (req, res) => {

    const { url } = req.body;

    if (!url) {
        return res.status(400).json({
            error: "Missing URL"
        });
    }

    res.status(501).json({
        error: "Playback processor is not configured yet."
    });

});


/*
    MP4 endpoint

    Your actual authorized conversion processor
    can be connected here later.
*/

app.post("/convert", async (req, res) => {

    const { url, format } = req.body;

    if (!url) {
        return res.status(400).json({
            error: "Missing URL"
        });
    }

    if (format !== "mp4") {
        return res.status(400).json({
            error: "Unsupported format"
        });
    }

    res.status(501).json({
        error: "MP4 processor is not configured yet."
    });

});


function detectType(url) {

    const hostname =
        url.hostname.toLowerCase();

    if (
        hostname === "youtube.com" ||
        hostname === "www.youtube.com"
    ) {
        return "YouTube";
    }

    if (
        hostname === "youtu.be"
    ) {
        return "YouTube";
    }

    return "Direct URL";
}


/*
    Render requires the server to listen on
    the provided port and 0.0.0.0.
*/

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `SPITz-X API running on port ${PORT}`
        );

    }
);
