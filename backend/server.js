
'use strict';

const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const multer = require('multer');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ALLOWED_ORIGIN = 'https://vctr-edu.github.io';
const REDIRECT_URI = 'https://broken-reflection-api.onrender.com/tiktok/callback';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const MAX_VIDEO_BYTES = 128 * 1024 * 1024;
const CHUNK_SIZE = 10 * 1024 * 1024;
const DASHBOARD_SESSION_MS = 2 * 60 * 60 * 1000;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not configured.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// CORS
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '1mb' }));

function getEncryptionKey() {
  const value = process.env.TOKEN_ENCRYPTION_KEY;

  if (!value || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('Token encryption key is missing or invalid.');
  }

  return Buffer.from(value, 'hex');
}

function encryptToken(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    getEncryptionKey(),
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final()
  ]);

  return [
    iv.toString('hex'),
    cipher.getAuthTag().toString('hex'),
    encrypted.toString('hex')
  ].join(':');
}

function decryptToken(value) {
  if (typeof value !== 'string') {
    throw new Error('Encrypted token is missing.');
  }

  const parts = value.split(':');

  if (parts.length !== 3) {
    throw new Error('Encrypted token has invalid format.');
  }

  const [ivHex, tagHex, encryptedHex] = parts;

  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getEncryptionKey(),
    Buffer.from(ivHex, 'hex')
  );

  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));

  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final()
  ]).toString('utf8');
}

function createDashboardToken() {
  const secret = process.env.DASHBOARD_SESSION_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error('Dashboard session configuration is missing.');
  }

  const payload = Buffer.from(
    JSON.stringify({
      exp: Date.now() + DASHBOARD_SESSION_MS
    })
  ).toString('base64url');

  const signature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('base64url');

  return `${payload}.${signature}`;
}

function requireDashboard(req, res, next) {
  try {
    const secret = process.env.DASHBOARD_SESSION_SECRET;
    const token = (req.get('Authorization') || '')
      .replace(/^Bearer\s+/i, '');

    const [payload, signature] = token.split('.');

    if (!secret || !payload || !signature) {
      return res.status(401).json({
        error: 'Sign in to continue.'
      });
    }

    const expected = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest();

    const actual = Buffer.from(signature, 'base64url');

    if (
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)
    ) {
      return res.status(401).json({
        error: 'Invalid session.'
      });
    }

    const session = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    );

    if (!Number.isFinite(session.exp) || session.exp < Date.now()) {
      return res.status(401).json({
        error: 'Session expired. Sign in again.'
      });
    }

    return next();
  } catch {
    return res.status(401).json({
      error: 'Invalid session.'
    });
  }
}

function getSandboxCredentials() {
  if (process.env.TIKTOK_ENV !== 'sandbox') {
    throw new Error('TikTok environment is not set to sandbox.');
  }

  const clientKey = process.env.TIKTOK_CLIENT_KEY_SANDBOX;
  const clientSecret = process.env.TIKTOK_CLIENT_SECRET_SANDBOX;

  if (!clientKey || !clientSecret) {
    throw new Error('TikTok Sandbox credentials are missing.');
  }

  return { clientKey, clientSecret };
}

function readCookies(header = '') {
  const cookies = {};

  for (const item of header.split(';')) {
    const index = item.indexOf('=');

    if (index <= 0) continue;

    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();

    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      // Ignore malformed cookies.
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
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cache-Control': 'no-cache'
    },
    body
  });

  const data = await response.json();

  if (!response.ok || data.error || !data.access_token) {
    throw new Error('TikTok token request failed.');
  }

  return data;
}

async function saveTokens(data) {
  if (!data.open_id || !data.access_token || !data.refresh_token) {
    throw new Error('TikTok returned an incomplete token response.');
  }

  await pool.query(
    `INSERT INTO tiktok_tokens (
      open_id,
      access_token_enc,
      refresh_token_enc,
      access_expires_at,
      refresh_expires_at,
      scopes,
      updated_at
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
      data.scope || ''
    ]
  );
}

async function getStoredTikTokAccount() {
  const result = await pool.query(
    `SELECT open_id, access_token_enc
     FROM tiktok_tokens
     ORDER BY updated_at DESC
     LIMIT 1`
  );

  if (!result.rowCount) {
    throw new Error('Connect a TikTok Sandbox account first.');
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
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8'
      },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json().catch(() => ({}));

  if (!response.ok || data.error?.code !== 'ok') {
    throw new Error(
      `TikTok API request failed (${data.error?.code || response.status}).`
    );
  }

  return data.data;
}

const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_VIDEO_BYTES,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    const allowed = new Set([
      'video/mp4',
      'video/quicktime',
      'video/webm'
    ]);

    if (!allowed.has(file.mimetype)) {
      return cb(new Error('Unsupported video type.'));
    }

    return cb(null, true);
  }
});



app.get('/', (req, res) => {
  res.json({
    name: 'Broken Reflection Content Pipeline API',
    status: 'running'
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Backend is working'
  });
});

app.post('/api/dashboard/login', (req, res) => {
  const configuredPassword = process.env.DASHBOARD_PASSWORD;
  const suppliedPassword = req.body?.password;

  if (!configuredPassword || typeof suppliedPassword !== 'string') {
    return res.status(401).json({
      error: 'Invalid credentials.'
    });
  }

  const a = Buffer.from(suppliedPassword);
  const b = Buffer.from(configuredPassword);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({
      error: 'Invalid credentials.'
    });
  }

  try {
    res.setHeader('Cache-Control', 'no-store');

    return res.json({
      token: createDashboardToken(),
      expiresIn: DASHBOARD_SESSION_MS / 1000
    });
  } catch {
    return res.status(500).json({
      error: 'Dashboard authentication is not configured.'
    });
  }
});

app.get('/api/tiktok/creator-info', requireDashboard, async (req, res) => {
  try {
    const { accessToken } = await getStoredTikTokAccount();

    const data = await tiktokJson(
      '/v2/post/publish/creator_info/query/',
      accessToken,
      {}
    );

    res.setHeader('Cache-Control', 'no-store');

    return res.json({
      username: data.creator_username || '',
      nickname: data.creator_nickname || '',
      privacyOptions: data.privacy_level_options || [],
      commentDisabled: Boolean(data.comment_disabled),
      duetDisabled: Boolean(data.duet_disabled),
      stitchDisabled: Boolean(data.stitch_disabled),
      maxVideoDurationSec: data.max_video_post_duration_sec || null
    });
  } catch (error) {
    console.error('Creator settings request failed:', error.message);

    return res.status(502).json({
      error: 'Could not retrieve creator settings. Reconnect TikTok if necessary.'
    });
  }
});

// Direct Post upload.
// Sandbox requests are restricted to SELF_ONLY visibility.
app.post(
  '/api/tiktok/publish',
  requireDashboard,
  (req, res, next) => {
    videoUpload.single('video')(req, res, error => {
      if (error) {
        return res.status(400).json({
          error: error.code === 'LIMIT_FILE_SIZE'
            ? 'Video exceeds the 128 MB application limit.'
            : 'Choose a valid MP4, MOV, or WebM video.'
        });
      }

      return next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: 'Select a video first.'
        });
      }

      if (req.file.size < 5 * 1024 * 1024) {
        return res.status(400).json({
          error: 'Video must be at least 5 MB for this upload configuration.'
        });
      }

      const { caption, privacy, consent } = req.body;

      if (typeof caption !== 'string' || caption.length > 2200) {
        return res.status(400).json({
          error: 'Caption is required and must be no longer than 2,200 characters.'
        });
      }

      if (consent !== 'true') {
        return res.status(400).json({
          error: 'Confirm consent before publishing.'
        });
      }

      const { accessToken } = await getStoredTikTokAccount();

      const creator = await tiktokJson(
        '/v2/post/publish/creator_info/query/',
        accessToken,
        {}
      );

      if (!(creator.privacy_level_options || []).includes(privacy)) {
        return res.status(400).json({
          error: 'That privacy setting is not currently allowed by TikTok.'
        });
      }

      if (
        process.env.TIKTOK_ENV === 'sandbox' &&
        privacy !== 'SELF_ONLY'
      ) {
        return res.status(400).json({
          error: 'Sandbox testing is restricted to SELF_ONLY visibility.'
        });
      }

      const size = req.file.size;
      const chunkSize = Math.min(CHUNK_SIZE, size);
      const totalChunks = Math.ceil(size / chunkSize);

      const init = await tiktokJson(
        '/v2/post/publish/video/init/',
        accessToken,
        {
          post_info: {
            title: caption,
            privacy_level: privacy,
            disable_comment: req.body.disableComment === 'true',
            disable_duet: req.body.disableDuet === 'true',
            disable_stitch: req.body.disableStitch === 'true'
          },
          source_info: {
            source: 'FILE_UPLOAD',
            video_size: size,
            chunk_size: chunkSize,
            total_chunk_count: totalChunks
          }
        }
      );

      if (!init.publish_id || !init.upload_url) {
        throw new Error('TikTok did not return upload details.');
      }

      for (let index = 0; index < totalChunks; index++) {
        const start = index * chunkSize;
        const endExclusive = Math.min(start + chunkSize, size);
        const chunk = req.file.buffer.subarray(start, endExclusive);

        const uploadResponse = await fetch(init.upload_url, {
          method: 'PUT',
          headers: {
            'Content-Type': req.file.mimetype,
            'Content-Length': String(chunk.length),
            'Content-Range': `bytes ${start}-${endExclusive - 1}/${size}`
          },
          body: chunk
        });

        if (!uploadResponse.ok) {
          throw new Error(
            `TikTok video upload failed (${uploadResponse.status}).`
          );
        }
      }

      res.setHeader('Cache-Control', 'no-store');

      return res.json({
        publishId: init.publish_id,
        status: 'PROCESSING_UPLOAD',
        message: 'Video uploaded. Check TikTok processing status.'
      });
    } catch (error) {
      console.error('TikTok publishing failed:', error.message);

      const message =
        error.message === 'Connect a TikTok Sandbox account first.'
          ? error.message
          : 'Publishing failed. Check Render logs for details.';

      return res.status(502).json({ error: message });
    }
  }
);

app.post('/api/tiktok/publish-status', requireDashboard, async (req, res) => {
  try {
    const publishId = req.body?.publishId;

    if (
      typeof publishId !== 'string' ||
      publishId.length < 1 ||
      publishId.length > 128
    ) {
      return res.status(400).json({
        error: 'Invalid publish ID.'
      });
    }

    const { accessToken } = await getStoredTikTokAccount();

    const data = await tiktokJson(
      '/v2/post/publish/status/fetch/',
      accessToken,
      { publish_id: publishId }
    );

    res.setHeader('Cache-Control', 'no-store');

    return res.json({
      status: data.status,
      failReason: data.fail_reason || null,
      uploadedBytes: data.uploaded_bytes ?? null
    });
  } catch (error) {
    console.error('TikTok status check failed:', error.message);

    return res.status(502).json({
      error: 'Could not retrieve publishing status.'
    });
  }
});



app.get('/tiktok/authorize', (req, res) => {
  try {
    const { clientKey } = getSandboxCredentials();
    getEncryptionKey();

    const state = crypto.randomBytes(32).toString('hex');

    res.cookie('tiktok_oauth_state', state, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 10 * 60 * 1000
    });

    const params = new URLSearchParams({
      client_key: clientKey,
      response_type: 'code',
      scope: 'user.info.basic,video.publish,video.upload',
      redirect_uri: REDIRECT_URI,
      state
    });

    return res.redirect(
      `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`
    );
  } catch {
    return res.status(500).send(
      'TikTok Sandbox configuration is incomplete.'
    );
  }
});

app.get('/tiktok/callback', async (req, res) => {
  const expectedState =
    readCookies(req.headers.cookie).tiktok_oauth_state;

  const receivedState = req.query.state;

  res.clearCookie('tiktok_oauth_state', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/'
  });

  if (req.query.error) {
    return res.status(400).send(
      'TikTok authorization was cancelled or rejected. Return to the app and try again.'
    );
  }

  if (
    typeof expectedState !== 'string' ||
    typeof receivedState !== 'string' ||
    expectedState.length !== receivedState.length ||
    !crypto.timingSafeEqual(
      Buffer.from(expectedState),
      Buffer.from(receivedState)
    )
  ) {
    return res.status(400).send(
      'Authorization state validation failed. Return to the app and try again.'
    );
  }

  if (typeof req.query.code !== 'string' || !req.query.code) {
    return res.status(400).send(
      'TikTok did not return an authorization code.'
    );
  }

  try {
    const data = await exchangeToken({
      code: req.query.code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI
    });

    await saveTokens(data);

    return res.status(200).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Broken Reflection — Connected</title>
</head>
<body style="font-family:Arial,sans-serif;max-width:640px;margin:60px auto;padding:24px;line-height:1.6">
  <h1>TikTok connected successfully</h1>
  <p>Your authorization tokens were received and encrypted in the database.</p>
  <p>Return to the dashboard to sign in and test private Sandbox publishing.</p>
  <a href="https://vctr-edu.github.io/tiktok-pipeline/">Return to Broken Reflection</a>
</body>
</html>`);
  } catch (error) {
    console.error('TikTok callback failed:', error.message);

    return res.status(500).send(
      'TikTok token exchange or secure storage failed. Check Render service logs and database configuration.'
    );
  }
});

// Public profile endpoint retained for frontend compatibility.
// Protect this endpoint before using the app in production.
app.get('/api/tiktok/profile', requireDashboard, async (req, res) => {
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
        profileAvailable: false,
        message: 'No TikTok account is connected.'
      });
    }

    const { open_id, access_token_enc } = result.rows[0];
    const accessToken = decryptToken(access_token_enc);

    const response = await fetch(
      'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url',
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    const data = await response.json().catch(() => ({}));

    if (
      !response.ok ||
      data.error?.code !== 'ok' ||
      !data.data?.user
    ) {
      return res.status(502).json({
        connected: true,
        profileAvailable: false,
        message: 'TikTok authorization is saved, but profile retrieval failed.'
      });
    }

    const user = data.data.user;

    if (user.open_id !== open_id) {
      return res.status(502).json({
        connected: true,
        profileAvailable: false,
        message: 'TikTok returned an unexpected account.'
      });
    }

    res.setHeader('Cache-Control', 'no-store');

    return res.json({
      connected: true,
      profileAvailable: true,
      profile: {
        displayName: user.display_name || 'TikTok user',
        avatarUrl: user.avatar_url || null
      }
    });
  } catch {
    return res.status(500).json({
      connected: false,
      profileAvailable: false,
      message: 'Unable to retrieve the TikTok profile.'
    });
  }
});

// Internal endpoint for token refresh.
// Never call this endpoint from the public frontend.
app.post('/internal/tiktok/refresh', async (req, res) => {
  const expected = process.env.INTERNAL_API_SECRET;
  const supplied = req.get('Authorization');

  if (!expected || supplied !== `Bearer ${expected}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const openId = req.body?.open_id;

  if (typeof openId !== 'string' || !openId) {
    return res.status(400).json({
      error: 'open_id is required'
    });
  }

  try {
    const result = await pool.query(
      'SELECT refresh_token_enc FROM tiktok_tokens WHERE open_id = $1',
      [openId]
    );

    if (!result.rowCount) {
      return res.status(404).json({
        error: 'No stored connection found'
      });
    }

    const refreshToken = decryptToken(
      result.rows[0].refresh_token_enc
    );

    const data = await exchangeToken({
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    });

    await saveTokens({
      ...data,
      open_id: data.open_id || openId
    });

    return res.json({ status: 'refreshed' });
  } catch (error) {
    console.error('Token refresh failed:', error.message);

    return res.status(500).json({
      error: 'Token refresh failed. Reauthorization may be required.'
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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`API running on port ${PORT}`);
  });
}

start().catch(error => {
  console.error(
    'Backend startup failed. Check database and environment configuration.',
    error.message
  );
  process.exit(1);
});
