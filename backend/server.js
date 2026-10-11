
const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGIN = "https://vctr-edu.github.io";
const REDIRECT_URI =
  "https://broken-reflection-api.onrender.com/tiktok/callback";
const TOKEN_URL = "https://open.tiktokapis.com/v2/oauth/token/";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use((req, res, next) => {
  if (req.headers.origin === ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
    );
  }

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());


const multer = require("multer");

const MAX_VIDEO_BYTES = 128 * 1024 * 1024;
const CHUNK_SIZE = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const allowed = new Set([
      "video/mp4",
      "video/quicktime",
      "video/webm"
    ]);

    if (!allowed.has(file.mimetype)) {
      return cb(new Error("Unsupported video type."));
    }

    cb(null, true);
  }
});

function createDashboardToken() {
  const secret = process.env.DASHBOARD_SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("Dashboard session configuration is missing.");
  }

  const payload = Buffer.from(JSON.stringify({
    exp: Date.now() + 2 * 60 * 60 * 1000
  })).toString("base64url");

  const signature = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

function requireDashboard(req, res, next) {
  try {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    const token = (req.get("Authorization") || "").replace(/^Bearer /, "");
    const [payload, signature] = token.split(".");

    if (!secret || !payload || !signature) {
      return res.status(401).json({ error: "Sign in to continue." });
    }

    const expected = crypto
      .createHmac("sha256", secret)
      .update(payload)
      .digest();

    const actual = Buffer.from(signature, "base64url");

    if (
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)
    ) {
      return res.status(401).json({ error: "Invalid session." });
    }

    const session = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    if (!Number.isFinite(session.exp) || session.exp < Date.now()) {
      return res.status(401).json({ error: "Session expired. Sign in again." });
    }

    next();
  } catch {
    return res.status(401).json({ error: "Invalid session." });
  }
}

async function getStoredTikTokAccount() {
  const result = await pool.query(
    `SELECT open_id, access_token_enc
     FROM tiktok_tokens
     ORDER BY updated_at DESC
     LIMIT 1`
  );

  if (!result.rowCount) {
    throw new Error("Connect a TikTok Sandbox account first.");
  }

  return {
    openId: result.rows[0].open_id,
    accessToken: decryptToken(result.rows[0].access_token_enc)
  };
}

async function tiktokJson(path, accessToken, body) {
  const response = await fetch(`https://open.tiktokapis.com${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8"
    },
    body: JSON.stringify(body)
  });

  const data = await response.json();

  if (!response.ok || data.error?.code !== "ok") {
    // Do not expose tokens, upload URLs, or raw provider responses.
    throw new Error(`TikTok API request failed (${data.error?.code || response.status}).`);
  }

  return data.data;
}

// Dashboard sign-in. Do not log the submitted password.
app.post("/api/dashboard/login", (req, res) => {
  const configuredPassword = process.env.DASHBOARD_PASSWORD;
  const suppliedPassword = req.body?.password;

  if (!configuredPassword || typeof suppliedPassword !== "string") {
    return res.status(401).json({ error: "Invalid credentials." });
  }

  const a = Buffer.from(suppliedPassword);
  const b = Buffer.from(configuredPassword);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: "Invalid credentials." });
  }

  try {
    res.setHeader("Cache-Control", "no-store");
    return res.json({ token: createDashboardToken(), expiresIn: 7200 });
  } catch {
    return res.status(500).json({ error: "Dashboard authentication is not configured." });
  }
});

// Always query the latest creator settings before composing a Direct Post.
app.get("/api/tiktok/creator-info", requireDashboard, async (req, res) => {
  try {
    const { accessToken } = await getStoredTikTokAccount();
    const data = await tiktokJson(
      "/v2/post/publish/creator_info/query/",
      accessToken,
      {}
    );

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      username: data.creator_username || "",
      nickname: data.creator_nickname || "",
      privacyOptions: data.privacy_level_options || [],
      commentDisabled: Boolean(data.comment_disabled),
      duetDisabled: Boolean(data.duet_disabled),
      stitchDisabled: Boolean(data.stitch_disabled),
      maxVideoDurationSec: data.max_video_post_duration_sec || null
    });
  } catch {
    return res.status(502).json({
      error: "Could not retrieve creator settings. Reconnect TikTok if necessary."
    });
  }
});


const multer = require("multer");

const MAX_VIDEO_BYTES = 128 * 1024 * 1024;
const CHUNK_SIZE = 10 * 1024 * 1024;

const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_BYTES, files: 1 },
  fileFilter: (req, file, callback) => {
    const allowedTypes = new Set([
      "video/mp4",
      "video/quicktime",
      "video/webm"
    ]);

    if (!allowedTypes.has(file.mimetype)) {
      return callback(new Error("Unsupported video type."));
    }

    callback(null, true);
  }
});

async function getStoredTikTokAccount() {
  const result = await pool.query(
    `SELECT open_id, access_token_enc
     FROM tiktok_tokens
     ORDER BY updated_at DESC
     LIMIT 1`
  );

  if (!result.rowCount) {
    throw new Error("Connect a TikTok account first.");
  }

  return {
    openId: result.rows[0].open_id,
    accessToken: decryptToken(result.rows[0].access_token_enc)
  };
}

async function tiktokJson(path, accessToken, body) {
  const response = await fetch(
    `https://open.tiktokapis.com${path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8"
      },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();

  if (!response.ok || data.error?.code !== "ok") {
    throw new Error(
      `TikTok API error: ${data.error?.code || response.status}`
    );
  }

  return data.data;
}

app.post(
  "/api/tiktok/publish",
  requireDashboard,
  (req, res, next) => {
    videoUpload.single("video")(req, res, error => {
      if (error) {
        return res.status(400).json({
          error: error.code === "LIMIT_FILE_SIZE"
            ? "Video exceeds the 128 MB limit."
            : "Choose a valid MP4, MOV, or WebM video."
        });
      }

      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: "Select a video first."
        });
      }

      if (req.file.size < 5 * 1024 * 1024) {
        return res.status(400).json({
          error: "Video must be at least 5 MB for this upload configuration."
        });
      }

      const { caption, privacy, consent } = req.body;

      if (typeof caption !== "string" || caption.length > 2200) {
        return res.status(400).json({
          error: "Caption must not exceed 2,200 characters."
        });
      }

      if (consent !== "true") {
        return res.status(400).json({
          error: "Confirm consent before publishing."
        });
      }

      const { accessToken } = await getStoredTikTokAccount();

      const creator = await tiktokJson(
        "/v2/post/publish/creator_info/query/",
        accessToken,
        {}
      );

      if (!(creator.privacy_level_options || []).includes(privacy)) {
        return res.status(400).json({
          error: "TikTok does not allow this privacy setting."
        });
      }

      if (
        process.env.TIKTOK_ENV === "sandbox" &&
        privacy !== "SELF_ONLY"
      ) {
        return res.status(400).json({
          error: "Sandbox testing must use SELF_ONLY visibility."
        });
      }

      const size = req.file.size;
      const chunkSize = Math.min(CHUNK_SIZE, size);
      const totalChunks = Math.ceil(size / chunkSize);

      const init = await tiktokJson(
        "/v2/post/publish/video/init/",
        accessToken,
        {
          post_info: {
            title: caption,
            privacy_level: privacy,
            disable_comment: req.body.disableComment === "true",
            disable_duet: req.body.disableDuet === "true",
            disable_stitch: req.body.disableStitch === "true"
          },
          source_info: {
            source: "FILE_UPLOAD",
            video_size: size,
            chunk_size: chunkSize,
            total_chunk_count: totalChunks
          }
        }
      );

      if (!init.publish_id || !init.upload_url) {
        throw new Error("TikTok did not return upload details.");
      }

      for (let index = 0; index < totalChunks; index++) {
        const start = index * chunkSize;
        const endExclusive = Math.min(start + chunkSize, size);
        const chunk = req.file.buffer.subarray(start, endExclusive);

        const uploadResponse = await fetch(init.upload_url, {
          method: "PUT",
          headers: {
            "Content-Type": req.file.mimetype,
            "Content-Length": String(chunk.length),
            "Content-Range":
              `bytes ${start}-${endExclusive - 1}/${size}`
          },
          body: chunk
        });

        if (!uploadResponse.ok) {
          throw new Error("TikTok video upload failed.");
        }
      }

      res.setHeader("Cache-Control", "no-store");

      return res.json({
        publishId: init.publish_id,
        status: "PROCESSING_UPLOAD",
        message: "Video uploaded. Check TikTok processing status."
      });
    } catch (error) {
      console.error("TikTok publishing error:", error.message);

      return res.status(502).json({
        error: "Publishing failed. Check Render logs for details."
      });
    }
  }
);


// Upload one video as a Direct Post. Requires explicit consent in the request.
app.post(
  "/api/tiktok/publish",
  requireDashboard,
  (req, res, next) => {
    upload.single("video")(req, res, (err) => {
      if (err) {
        return res.status(400).json({
          error: err.code === "LIMIT_FILE_SIZE"
            ? "Video exceeds the 128 MB limit."
            : "Choose a valid MP4, MOV, or WebM video."
        });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "Select a video first." });
      }

      if (req.file.size < 5 * 1024 * 1024) {
        return res.status(400).json({
          error: "Video must be at least 5 MB for this upload configuration."
        });
      }

      const caption = req.body.caption;
      const privacy = req.body.privacy;
      const consent = req.body.consent === "true";

      if (typeof caption !== "string" || caption.length > 2200) {
        return res.status(400).json({
          error: "Caption is required and must be no longer than 2,200 characters."
        });
      }

      if (!consent) {
        return res.status(400).json({
          error: "Confirm that you want to send this video to TikTok."
        });
      }

      const { accessToken } = await getStoredTikTokAccount();

      // The privacy selection must come from the latest creator-info response.
      const creator = await tiktokJson(
        "/v2/post/publish/creator_info/query/",
        accessToken,
        {}
      );

      const privacyOptions = creator.privacy_level_options || [];

      if (!privacyOptions.includes(privacy)) {
        return res.status(400).json({
          error: "That privacy setting is not currently allowed by TikTok."
        });
      }

      // Conservative default for a Sandbox / unaudited client.
      if (process.env.TIKTOK_ENV === "sandbox" && privacy !== "SELF_ONLY") {
        return res.status(400).json({
          error: "Sandbox testing is restricted to SELF_ONLY visibility."
        });
      }

      const size = req.file.size;
      const chunkSize = Math.min(CHUNK_SIZE, size);
      const totalChunks = Math.ceil(size / chunkSize);

      const init = await tiktokJson(
        "/v2/post/publish/video/init/",
        accessToken,
        {
          post_info: {
            title: caption,
            privacy_level: privacy,
            disable_comment: req.body.disableComment === "true",
            disable_duet: req.body.disableDuet === "true",
            disable_stitch: req.body.disableStitch === "true"
          },
          source_info: {
            source: "FILE_UPLOAD",
            video_size: size,
            chunk_size: chunkSize,
            total_chunk_count: totalChunks
          }
        }
      );

      if (!init.publish_id || !init.upload_url) {
        throw new Error("TikTok did not return upload details.");
      }

      // Use TikTok's returned upload URL exactly as provided.
      for (let index = 0; index < totalChunks; index++) {
        const start = index * chunkSize;
        const endExclusive = Math.min(start + chunkSize, size);
        const chunk = req.file.buffer.subarray(start, endExclusive);
        const endInclusive = endExclusive - 1;

        const mimeType = {
          "video/mp4": "video/mp4",
          "video/quicktime": "video/quicktime",
          "video/webm": "video/webm"
        }[req.file.mimetype];

        const response = await fetch(init.upload_url, {
          method: "PUT",
          headers: {
            "Content-Type": mimeType,
            "Content-Length": String(chunk.length),
            "Content-Range": `bytes ${start}-${endInclusive}/${size}`
          },
          body: chunk
        });

        if (!response.ok) {
          throw new Error("TikTok video upload failed.");
        }
      }

      res.setHeader("Cache-Control", "no-store");
      return res.json({
        publishId: init.publish_id,
        status: "PROCESSING_UPLOAD",
        message: "Video uploaded to TikTok. Check status for the result."
      });
    } catch (error) {
      // Return only a generic message; never expose credentials or upload URLs.
      const message = error.message === "Connect a TikTok Sandbox account first."
        ? error.message
        : "Publishing failed. Check the connection and try again.";

      return res.status(502).json({ error: message });
    }
  }
);

// Check status using the publish ID returned by the upload endpoint.
app.post("/api/tiktok/publish-status", requireDashboard, async (req, res) => {
  try {
    const publishId = req.body?.publishId;

    if (
      typeof publishId !== "string" ||
      publishId.length < 1 ||
      publishId.length > 64
    ) {
      return res.status(400).json({ error: "Invalid publish ID." });
    }

    const { accessToken } = await getStoredTikTokAccount();
    const data = await tiktokJson(
      "/v2/post/publish/status/fetch/",
      accessToken,
      { publish_id: publishId }
    );

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      status: data.status,
      failReason: data.fail_reason || null,
      uploadedBytes: data.uploaded_bytes ?? null
    });
  } catch {
    return res.status(502).json({
      error: "Could not retrieve publishing status."
    });
  }
});


function getEncryptionKey() {
  const value = process.env.TOKEN_ENCRYPTION_KEY;

  if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("Token encryption key is missing or invalid.");
  }

  return Buffer.from(value, "hex");
}

function encryptToken(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final()
  ]);

  return [
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    encrypted.toString("hex")
  ].join(":");
}

function decryptToken(value) {
  const [ivHex, tagHex, encryptedHex] = value.split(":");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(ivHex, "hex")
  );

  decipher.setAuthTag(Buffer.from(tagHex, "hex"));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final()
  ]).toString("utf8");
}

function getSandboxCredentials() {
  if (process.env.TIKTOK_ENV !== "sandbox") {
    throw new Error("TikTok environment is not set to sandbox.");
  }

  const clientKey = process.env.TIKTOK_CLIENT_KEY_SANDBOX;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET_SANDBOX;

  if (!clientKey || !clientSecret) {
    throw new Error("TikTok sandbox credentials are missing.");
  }

  return { clientKey, clientSecret };
}

function readCookies(header = "") {
  const cookies = {};

  for (const item of header.split(";")) {
    const index = item.indexOf("=");

    if (index > 0) {
      const key = item.slice(0, index).trim();
      const value = item.slice(index + 1).trim();

      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        // Ignore malformed cookies.
      }
    }
  }

  return cookies;
}

async function exchangeToken(fields) {
  const { clientKey, clientSecret } = getSandboxCredentials();

  const body = new URLSearchParams({
    client_key: clientKey,
    client_secret: clientSecret,
    ...fields
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache"
    },
    body
  });

  const data = await response.json();

  if (!response.ok || data.error || !data.access_token) {
    // Never log or return the token response or credentials.
    throw new Error("TikTok token request failed.");
  }

  return data;
}

async function saveTokens(data) {
  if (!data.open_id || !data.access_token || !data.refresh_token) {
    throw new Error("TikTok returned an incomplete token response.");
  }

  await pool.query(
    `INSERT INTO tiktok_tokens (
       open_id, access_token_enc, refresh_token_enc,
       access_expires_at, refresh_expires_at, scopes, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (open_id) DO UPDATE SET
       access_token_enc = EXCLUDED.access_token_enc,
       refresh_token_enc = EXCLUDED.refresh_token_enc,
       access_expires_at = EXCLUDED.access_expires_at,
       refresh_expires_at = EXCLUDED.refresh_expires_at,
       scopes = EXCLUDED.scopes,
       updated_at = NOW()`,
    [
      data.open_id,
      encryptToken(data.access_token),
      encryptToken(data.refresh_token),
      new Date(Date.now() + Number(data.expires_in || 0) * 1000),
      new Date(
        Date.now() + Number(data.refresh_expires_in || 0) * 1000
      ),
      data.scope || ""
    ]
  );
}

app.get("/", (req, res) => {
  res.json({
    name: "Broken Reflection Content Pipeline API",
    status: "running"
  });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "Backend is working" });
});

app.get("/tiktok/authorize", (req, res) => {
  try {
    const { clientKey } = getSandboxCredentials();
    getEncryptionKey();

    const state = crypto.randomBytes(32).toString("hex");

    res.cookie("tiktok_oauth_state", state, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 10 * 60 * 1000
    });

    const params = new URLSearchParams({
      client_key: clientKey,
      response_type: "code",
      scope: "user.info.basic,video.publish,video.upload",
      redirect_uri: REDIRECT_URI,
      state
    });

    res.redirect(
      `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`
    );
  } catch {
    res.status(500).send("TikTok Sandbox configuration is incomplete.");
  }
});

app.get("/tiktok/callback", async (req, res) => {
  const expectedState = readCookies(req.headers.cookie).tiktok_oauth_state;
  const receivedState = req.query.state;

  res.clearCookie("tiktok_oauth_state", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/"
  });

  if (req.query.error) {
    return res.status(400).send(
      "TikTok authorization was cancelled or rejected. Return to the app and try again."
    );
  }

  if (
    typeof expectedState !== "string" ||
    typeof receivedState !== "string" ||
    expectedState.length !== receivedState.length ||
    !crypto.timingSafeEqual(
      Buffer.from(expectedState),
      Buffer.from(receivedState)
    )
  ) {
    return res.status(400).send(
      "Authorization state validation failed. Return to the app and try again."
    );
  }

  if (typeof req.query.code !== "string" || !req.query.code) {
    return res.status(400).send("TikTok did not return an authorization code.");
  }

  try {
    const data = await exchangeToken({
      code: req.query.code,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI
    });

    await saveTokens(data);

    res.send(`
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Broken Reflection — Connected</title>
        </head>
        <body style="font-family:Arial,sans-serif;max-width:640px;margin:60px auto;padding:24px;line-height:1.6">
          <h1>TikTok connected successfully</h1>
          <p>Your authorization tokens were received and encrypted in the database.</p>
          <p>Video publishing is not implemented yet.</p>
          <a href="https://vctr-edu.github.io/tiktok-pipeline/">Return to Broken Reflection</a>
        </body>
      </html>
    `);
  } catch {
    res.status(500).send(
      "TikTok token exchange or secure storage failed. Check the Render service status and database configuration, then try connecting again."
    );
  }
});



app.get("/api/tiktok/profile", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT open_id, access_token_enc
       FROM tiktok_tokens
       ORDER BY updated_at DESC
       LIMIT 1`
    );

    if (!result.rowCount) {
      return res.status(404).json({
        connected: false,
        message: "No TikTok account is connected."
      });
    }

    const { open_id, access_token_enc } = result.rows[0];
    const accessToken = decryptToken(access_token_enc);

    const response = await fetch(
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    const data = await response.json();

    if (
      !response.ok ||
      data.error?.code !== "ok" ||
      !data.data?.user
    ) {
      return res.status(502).json({
        connected: true,
        profileAvailable: false,
        message:
          "TikTok authorization is saved, but profile retrieval failed. The token may have expired or the Sandbox may restrict this API."
      });
    }

    const user = data.data.user;

    // Ensure the returned profile belongs to the stored connection.
    if (user.open_id !== open_id) {
      return res.status(502).json({
        connected: true,
        profileAvailable: false,
        message: "TikTok returned an unexpected account."
      });
    }

    return res.json({
      connected: true,
      profileAvailable: true,
      profile: {
        displayName: user.display_name || "TikTok user",
        avatarUrl: user.avatar_url || null
      }
    });
  } catch {
    return res.status(500).json({
      connected: false,
      message: "Unable to retrieve the TikTok profile."
    });
  }
});

// Backend-only refresh endpoint. Do not call this from the public frontend.
app.post("/internal/tiktok/refresh", async (req, res) => {
  // Require a separate secret before enabling this endpoint.
  const expected = process.env.INTERNAL_API_SECRET;
  const supplied = req.get("Authorization");

  if (!expected || supplied !== `Bearer ${expected}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const openId = req.body?.open_id;

  if (typeof openId !== "string" || !openId) {
    return res.status(400).json({ error: "open_id is required" });
  }

  try {
    const result = await pool.query(
      `SELECT refresh_token_enc FROM tiktok_tokens WHERE open_id = $1`,
      [openId]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: "No stored connection found" });
    }

    const refreshToken = decryptToken(result.rows[0].refresh_token_enc);
    const data = await exchangeToken({
      grant_type: "refresh_token",
      refresh_token: refreshToken
    });

    await saveTokens({ ...data, open_id: data.open_id || openId });

    return res.json({ status: "refreshed" });
  } catch {
    return res.status(500).json({
      error: "Token refresh failed. Reauthorization may be required."
    });
  }
});

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tiktok_tokens (
      open_id TEXT PRIMARY KEY,
      access_token_enc TEXT NOT NULL,
      refresh_token_enc TEXT NOT NULL,
      access_expires_at TIMESTAMPTZ,
      refresh_expires_at TIMESTAMPTZ,
      scopes TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`API running on port ${PORT}`);
  });
}

start().catch(() => {
  console.error("Backend startup failed. Check database and environment configuration.");
  process.exit(1);
});
