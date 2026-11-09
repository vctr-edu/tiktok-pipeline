
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
const TOKEN_REFRESH_EARLY_MS = 10 * 60 * 1000;
const TIKTOK_ACCOUNTS = Object.freeze({
  tsr_music: 'TSR Music',
  broken_reflection: 'Broken Reflection'
});

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

function getTikTokCredentials() {
  const isSandbox = process.env.TIKTOK_ENV === 'sandbox';
  const clientKey = isSandbox
    ? process.env.TIKTOK_CLIENT_KEY_SANDBOX
    : process.env.TIKTOK_CLIENT_KEY;
  const clientSecret = isSandbox
    ? process.env.TIKTOK_CLIENT_SECRET_SANDBOX
    : process.env.TIKTOK_CLIENT_SECRET;

  if (!clientKey || !clientSecret) {
    throw new Error(isSandbox
      ? 'TikTok Sandbox credentials are missing.'
      : 'TikTok production credentials are missing.');
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
  const { clientKey, clientSecret } = getTikTokCredentials();

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
    const code = data.error || response.status;
    const detail = data.error_description ? `: ${data.error_description}` : '';
    throw new Error(`TikTok token request failed (${code})${detail}.`);
  }

  return data;
}

function accountKeyFrom(value) {
  return typeof value === 'string' && Object.hasOwn(TIKTOK_ACCOUNTS, value)
    ? value
    : null;
}

async function saveTokens(data, accountKey) {
  if (!accountKeyFrom(accountKey)) {
    throw new Error('Choose which TikTok account you are connecting.');
  }
  if (!data.open_id || !data.access_token || !data.refresh_token) {
    throw new Error('TikTok returned an incomplete token response.');
  }
  if (!(data.scope || '').split(',').includes('video.publish')) {
    throw new Error('TikTok authorization did not grant the video.publish scope.');
  }

  const accountForOpenId = await pool.query(
    'SELECT account_key FROM tiktok_tokens WHERE open_id = $1',
    [data.open_id]
  );
  if (accountForOpenId.rowCount && accountForOpenId.rows[0].account_key !== accountKey) {
    throw new Error('This TikTok profile is already assigned to the other account slot. Authorize a different TikTok profile.');
  }

  await pool.query(
    `INSERT INTO tiktok_tokens (
      account_key,
      open_id,
      access_token_enc,
      refresh_token_enc,
      access_expires_at,
      refresh_expires_at,
      scopes,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    ON CONFLICT (account_key) DO UPDATE SET
      open_id = EXCLUDED.open_id,
      access_token_enc = EXCLUDED.access_token_enc,
      refresh_token_enc = EXCLUDED.refresh_token_enc,
      access_expires_at = EXCLUDED.access_expires_at,
      refresh_expires_at = EXCLUDED.refresh_expires_at,
      scopes = EXCLUDED.scopes,
      updated_at = NOW()`,
    [
      accountKey,
      data.open_id,
      encryptToken(data.access_token),
      encryptToken(data.refresh_token),
      new Date(Date.now() + Number(data.expires_in || 0) * 1000),
      new Date(Date.now() + Number(data.refresh_expires_in || 0) * 1000),
      data.scope || ''
    ]
  );
}

async function getStoredTikTokAccount({
  accountKey = 'tsr_music',
  forceRefresh = false,
  rejectedAccessToken = null
} = {}) {
  if (!accountKeyFrom(accountKey)) {
    throw new Error('Choose a valid TikTok account.');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT account_key, open_id, access_token_enc, refresh_token_enc,
              access_expires_at, refresh_expires_at, scopes
       FROM tiktok_tokens
       WHERE account_key = $1
       FOR UPDATE`,
      [accountKey]
    );

    if (!result.rowCount) {
      throw new Error(`Connect the ${TIKTOK_ACCOUNTS[accountKey]} TikTok account first.`);
    }

    const account = result.rows[0];
    const storedAccessToken = decryptToken(account.access_token_enc);
    const accessExpiresAt = account.access_expires_at
      ? new Date(account.access_expires_at).getTime()
      : 0;
    const shouldRefresh = (forceRefresh && storedAccessToken === rejectedAccessToken) ||
      !Number.isFinite(accessExpiresAt) ||
      accessExpiresAt <= Date.now() + TOKEN_REFRESH_EARLY_MS;

    if (shouldRefresh) {
      if (!account.refresh_token_enc) {
        throw new Error('TikTok connection needs authorization again to enable automatic renewal.');
      }

      const refreshExpiresAt = account.refresh_expires_at
        ? new Date(account.refresh_expires_at).getTime()
        : 0;
      if (refreshExpiresAt && refreshExpiresAt <= Date.now()) {
        throw new Error('TikTok refresh authorization expired. Reconnect the account.');
      }

      const refreshed = await exchangeToken({
        grant_type: 'refresh_token',
        refresh_token: decryptToken(account.refresh_token_enc)
      });
      if (refreshed.open_id !== account.open_id || !refreshed.refresh_token) {
        throw new Error('TikTok returned incomplete or mismatched refresh credentials. Reconnect the account.');
      }

      const scopes = refreshed.scope || account.scopes || '';
      if (!scopes.split(',').includes('video.publish')) {
        throw new Error('Renewed TikTok authorization does not include video.publish. Reconnect the account.');
      }

      const expiresIn = Number(refreshed.expires_in);
      const refreshExpiresIn = Number(refreshed.refresh_expires_in);
      if (!Number.isFinite(expiresIn) || expiresIn <= 0 || !Number.isFinite(refreshExpiresIn) || refreshExpiresIn <= 0) {
        throw new Error('TikTok returned invalid token expiry information. Reconnect the account.');
      }

      await client.query(
        `UPDATE tiktok_tokens
         SET access_token_enc = $2,
             refresh_token_enc = $3,
             access_expires_at = $4,
             refresh_expires_at = $5,
             scopes = $6,
             updated_at = NOW()
         WHERE account_key = $1`,
        [
          account.account_key,
          encryptToken(refreshed.access_token),
          encryptToken(refreshed.refresh_token),
          new Date(Date.now() + expiresIn * 1000),
          new Date(Date.now() + refreshExpiresIn * 1000),
          scopes
        ]
      );

      await client.query('COMMIT');
      return { accountKey: account.account_key, openId: account.open_id, accessToken: refreshed.access_token };
    }

    await client.query('COMMIT');
    return {
      accountKey: account.account_key,
      openId: account.open_id,
      accessToken: storedAccessToken
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function tiktokJson(path, accessToken, body, accountKey = 'tsr_music') {
  const request = token => fetch(`https://open.tiktokapis.com${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8'
      },
      body: JSON.stringify(body)
  });

  let response = await request(accessToken);
  let data = await response.json().catch(() => ({}));

  const tokenError = /(?:invalid|expired|revoked).*access.?token|access.?token.*(?:invalid|expired|revoked)/i
    .test(String(data.error?.code || ''));
  if (response.status === 401 || tokenError) {
    const refreshed = await getStoredTikTokAccount({
      accountKey,
      forceRefresh: true,
      rejectedAccessToken: accessToken
    });
    if (refreshed.accessToken !== accessToken) {
      response = await request(refreshed.accessToken);
      data = await response.json().catch(() => ({}));
    }
  }

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

app.get('/api/tiktok/accounts', requireDashboard, async (req, res) => {
  try {
    const result = await pool.query('SELECT account_key FROM tiktok_tokens');
    const connected = new Set(result.rows.map(row => row.account_key));
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      accounts: Object.entries(TIKTOK_ACCOUNTS).map(([key, name]) => ({
        key,
        name,
        connected: connected.has(key)
      }))
    });
  } catch (error) {
    console.error('TikTok account list failed:', error.message);
    return res.status(500).json({ error: 'Could not load TikTok accounts.' });
  }
});

app.get('/api/tiktok/creator-info', requireDashboard, async (req, res) => {
  const accountKey = req.query.accountKey == null
    ? 'tsr_music'
    : accountKeyFrom(req.query.accountKey);
  if (!accountKey) return res.status(400).json({ error: 'Choose a valid TikTok account.' });

  try {
    const { accessToken } = await getStoredTikTokAccount({ accountKey });

    const data = await tiktokJson(
      '/v2/post/publish/creator_info/query/',
      accessToken,
      {},
      accountKey
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

    const reason = String(error.message || '');
    if (reason.startsWith('Connect the ') && reason.endsWith(' TikTok account first.')) {
      return res.status(404).json({ error: reason });
    }
    if (reason.includes('invalid_grant') || reason.includes('refresh authorization expired')) {
      return res.status(401).json({
        error: 'TikTok authorization has expired. Reconnect the account once to restore automatic renewal.'
      });
    }
    if (reason.includes('spam_risk_too_many_posts')) {
      return res.status(429).json({
        error: 'TikTok temporarily paused posting for this account. Please try again later.'
      });
    }
    if (reason.includes('spam_risk_user_banned_from_posting')) {
      return res.status(403).json({
        error: 'TikTok currently does not allow this account to publish. Check the account in TikTok.'
      });
    }
    if (reason.includes('reached_active_user_cap')) {
      return res.status(429).json({
        error: 'The current TikTok publishing capacity has been reached. Please try again later.'
      });
    }

    return res.status(502).json({
      error: 'Could not retrieve creator settings. Reconnect TikTok if necessary.'
    });
  }
});

// Direct Post upload.
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

      const { caption, privacy, consent } = req.body;

      if (caption !== undefined && (typeof caption !== 'string' || caption.length > 2200)) {
        return res.status(400).json({
          error: 'Caption must be no longer than 2,200 characters.'
        });
      }

      if (consent !== 'true') {
        return res.status(400).json({
          error: 'Confirm consent before publishing.'
        });
      }

      const accountKey = req.body.accountKey == null
        ? 'tsr_music'
        : accountKeyFrom(req.body.accountKey);
      if (!accountKey) {
        return res.status(400).json({ error: 'Choose a valid TikTok account.' });
      }
      const { accessToken } = await getStoredTikTokAccount({ accountKey });

      const creator = await tiktokJson(
        '/v2/post/publish/creator_info/query/',
        accessToken,
        {},
        accountKey
      );

      if (!(creator.privacy_level_options || []).includes(privacy)) {
        return res.status(400).json({
          error: 'That privacy setting is not currently allowed by TikTok.'
        });
      }

      const maxDuration = Number(creator.max_video_post_duration_sec || 0);
      const durationSeconds = Number(req.body.durationSeconds || 0);
      if (maxDuration > 0 && (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > maxDuration)) {
        return res.status(400).json({
          error: durationSeconds > maxDuration
            ? `This TikTok account can post videos up to ${maxDuration} seconds.`
            : 'Could not read the video duration. Choose another video and try again.'
        });
      }

      const brandOrganic = req.body.brandOrganic === 'true';
      const brandContent = req.body.brandContent === 'true';
      if ((brandOrganic || brandContent) && brandContent && privacy === 'SELF_ONLY') {
        return res.status(400).json({
          error: 'Branded content cannot be posted with the Only you privacy setting.'
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
      const postInfo = {
        privacy_level: privacy,
        disable_comment: Boolean(creator.comment_disabled) || req.body.allowComments !== 'true',
        disable_duet: Boolean(creator.duet_disabled) || req.body.allowDuet !== 'true',
        disable_stitch: Boolean(creator.stitch_disabled) || req.body.allowStitch !== 'true',
        brand_organic_toggle: brandOrganic,
        brand_content_toggle: brandContent
      };
      if (typeof caption === 'string' && caption.trim()) {
        postInfo.title = caption;
      }

      const init = await tiktokJson(
        '/v2/post/publish/video/init/',
        accessToken,
        {
          post_info: postInfo,
          source_info: {
            source: 'FILE_UPLOAD',
            video_size: size,
            chunk_size: chunkSize,
            total_chunk_count: totalChunks
          }
        },
        accountKey
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
        error.message.startsWith('Connect the ') && error.message.endsWith(' TikTok account first.')
          ? error.message
          : error.message.includes('invalid_grant') || error.message.includes('refresh authorization expired')
            ? 'TikTok authorization has expired. Reconnect the account once to restore automatic renewal.'
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

    const accountKey = req.body?.accountKey == null
      ? 'tsr_music'
      : accountKeyFrom(req.body.accountKey);
    if (!accountKey) return res.status(400).json({ error: 'Choose a valid TikTok account.' });
    const { accessToken } = await getStoredTikTokAccount({ accountKey });

    const data = await tiktokJson(
      '/v2/post/publish/status/fetch/',
      accessToken,
      { publish_id: publishId },
      accountKey
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
    const { clientKey } = getTikTokCredentials();
    getEncryptionKey();
    const accountKey = req.query.account == null
      ? 'tsr_music'
      : accountKeyFrom(req.query.account);
    if (!accountKey) {
      return res.status(400).send('Choose TSR Music or Broken Reflection before connecting TikTok.');
    }

    const state = crypto.randomBytes(32).toString('hex');

    res.cookie('tiktok_oauth_state', state, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 10 * 60 * 1000
    });
    res.cookie('tiktok_account_slot', accountKey, {
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
    console.error('TikTok authorization configuration failed.');
    return res.status(500).send(
      'TikTok authorization configuration is incomplete. Check the Render environment variables.'
    );
  }
});

app.get('/tiktok/callback', async (req, res) => {
  const cookies = readCookies(req.headers.cookie);
  const expectedState = cookies.tiktok_oauth_state;
  const accountKey = accountKeyFrom(cookies.tiktok_account_slot);

  const receivedState = req.query.state;

  res.clearCookie('tiktok_oauth_state', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/'
  });
  res.clearCookie('tiktok_account_slot', {
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
  if (!accountKey) {
    return res.status(400).send('TikTok account selection expired. Return to the app and connect the account again.');
  }

  try {
    const data = await exchangeToken({
      code: req.query.code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI
    });

    await saveTokens(data, accountKey);
    return res.redirect(
    `https://vctr-edu.github.io/tiktok-pipeline/?tiktok=connected&account=${encodeURIComponent(accountKey)}`
    );} 
    catch (error) {
    console.error('TikTok callback failed:', error.message);

    return res.status(500).send(
      'TikTok token exchange or secure storage failed. Check Render service logs and database configuration.'
    );
  }
});

// Public profile endpoint retained for frontend compatibility.
// Protect this endpoint before using the app in production.
app.get('/api/tiktok/profile', requireDashboard, async (req, res) => {
  const accountKey = req.query.accountKey == null
    ? 'tsr_music'
    : accountKeyFrom(req.query.accountKey);
  if (!accountKey) return res.status(400).json({ error: 'Choose a valid TikTok account.' });

  try {
    const { openId, accessToken } = await getStoredTikTokAccount({ accountKey });

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

    if (user.open_id !== openId) {
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
  } catch (error) {
    if (String(error.message || '').startsWith('Connect the ')) {
      return res.status(404).json({
        connected: false,
        profileAvailable: false,
        message: error.message
      });
    }
    return res.status(500).json({
      connected: false,
      profileAvailable: false,
      message: 'Unable to retrieve the TikTok profile.'
    });
  }
});

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tiktok_tokens (
      account_key TEXT NOT NULL DEFAULT 'tsr_music',
      open_id TEXT PRIMARY KEY,
      access_token_enc TEXT NOT NULL,
      refresh_token_enc TEXT,
      access_expires_at TIMESTAMPTZ,
      refresh_expires_at TIMESTAMPTZ,
      scopes TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE tiktok_tokens
      ADD COLUMN IF NOT EXISTS account_key TEXT NOT NULL DEFAULT 'tsr_music',
      ADD COLUMN IF NOT EXISTS refresh_token_enc TEXT,
      ADD COLUMN IF NOT EXISTS refresh_expires_at TIMESTAMPTZ
  `);

  // If the old single-selector version saved several profiles, keep the most
  // recently used one in the TSR slot and place the next in the second slot.
  await pool.query(`
    WITH ranked AS (
      SELECT open_id, ROW_NUMBER() OVER (ORDER BY updated_at DESC, open_id) AS slot_rank
      FROM tiktok_tokens
      WHERE account_key = 'tsr_music'
    )
    UPDATE tiktok_tokens AS token
    SET account_key = CASE
      WHEN ranked.slot_rank = 2 THEN 'broken_reflection'
      WHEN ranked.slot_rank > 2 THEN 'legacy_' || token.open_id
      ELSE 'tsr_music'
    END
    FROM ranked
    WHERE token.open_id = ranked.open_id
      AND ranked.slot_rank > 1
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS tiktok_tokens_account_key_unique
    ON tiktok_tokens (account_key)
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
