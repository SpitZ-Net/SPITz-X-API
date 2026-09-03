const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// IMPORTANT:
// Put the real password in Render Environment Variables.
// Do NOT put the real password in this file.
const MEDIA_PASSWORD = process.env.MEDIA_PASSWORD;

const sessions = new Map();

const SESSION_LENGTH = 30 * 60 * 1000; // 30 minutes


function createSession() {
    const token = crypto.randomBytes(32).toString("hex");

    sessions.set(token, {
        created: Date.now()
    });

    return token;
}


function checkSession(token) {

    if (!token) {
        return false;
    }

    const session = sessions.get(token);

    if (!session) {
        return false;
    }

    if (Date.now() - session.created > SESSION_LENGTH) {
        sessions.delete(token);
        return false;
    }

    return true;
}


/*
========================================
HEALTH
========================================
*/

app.get("/health", (req, res) => {

    res.json({
        status: "online",
        service: "SPITz-X API"
    });

});


/*
========================================
MEDIA LOGIN
========================================
*/

app.post("/media-login", (req, res) => {

    const password = req.body?.password;

    if (!MEDIA_PASSWORD) {

        return res.status(500).json({
            error: "MEDIA_PASSWORD is not configured on the server."
        });

    }

    if (
        typeof password !== "string" ||
        password !== MEDIA_PASSWORD
    ) {

        return res.status(401).json({
            error: "Incorrect password."
        });

    }

    const token = createSession();

    res.json({
        authenticated: true,
        token,
        expiresIn: SESSION_LENGTH / 1000
    });

});


/*
========================================
CHECK LOGIN
========================================
*/

app.get("/media-auth", (req, res) => {

    const header = req.headers.authorization || "";

    const token = header.replace(/^Bearer\s+/i, "");

    res.json({
        authenticated: checkSession(token)
    });

});


/*
========================================
LOCKED MEDIA AREA
========================================
*/

app.get("/media-access", (req, res) => {

    const header = req.headers.authorization || "";

    const token = header.replace(/^Bearer\s+/i, "");

    if (!checkSession(token)) {

        return res.status(401).json({
            error: "Authentication required."
        });

    }

    res.json({
        authorized: true,
        message: "SPITz-X media area unlocked."
    });

});


/*
========================================
LOGOUT
========================================
*/

app.post("/media-logout", (req, res) => {

    const header = req.headers.authorization || "";

    const token = header.replace(/^Bearer\s+/i, "");

    if (token) {
        sessions.delete(token);
    }

    res.json({
        authenticated: false
    });

});


/*
========================================
START SERVER
========================================
*/

app.listen(PORT, () => {

    console.log(
        `SPITz-X API running on port ${PORT}`
    );

});
