
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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

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
