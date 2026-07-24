import { AwsClient } from 'aws4fetch';

const COVER_ROUTE = /^\/(movie|book|music|game|celebrity)\/(\d+)\.jpg$/i;
const DEFAULT_DOUBAN_HOST = 'frodo.douban.com';
const DEFAULT_DOUBAN_API_KEY = '0ac44ae016490db2204ce0a042db2916';
const MAX_COVER_BYTES = 15 * 1024 * 1024;
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: {
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function assertConfiguration(env) {
  const required = [
    'OSCA_ENDPOINT',
    'OSCA_BUCKET',
    'OSCA_ACCESS_KEY_ID',
    'OSCA_SECRET_ACCESS_KEY',
  ];
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new HttpError(503, `Missing Cloudflare configuration: ${missing.join(', ')}`);
  }

  const endpoint = new URL(env.OSCA_ENDPOINT);
  if (endpoint.protocol !== 'https:') {
    throw new HttpError(503, 'OSCA_ENDPOINT must use HTTPS');
  }
}

function buildObjectKey(env, type, id) {
  const prefix = (env.OSCA_PREFIX || 'dover').replace(/^\/+|\/+$/g, '');
  return [prefix, type.toLowerCase(), `${id}.jpg`].filter(Boolean).join('/');
}

function buildObjectUrl(env, key) {
  const endpoint = env.OSCA_ENDPOINT.replace(/\/+$/g, '');
  const bucket = encodeURIComponent(env.OSCA_BUCKET);
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return `${endpoint}/${bucket}/${encodedKey}`;
}

function createOscaClient(env) {
  return new AwsClient({
    accessKeyId: env.OSCA_ACCESS_KEY_ID,
    secretAccessKey: env.OSCA_SECRET_ACCESS_KEY,
    service: 's3',
    region: env.OSCA_REGION || 'us-east-1',
    retries: 2,
  });
}

function bytesToHex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value) {
  return bytesToHex(await crypto.subtle.digest('SHA-256', value));
}

async function getStoredCover(client, env, key) {
  const response = await client.fetch(buildObjectUrl(env, key), {
    method: 'GET',
    headers: { 'x-amz-content-sha256': EMPTY_SHA256 },
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`OSCA GET failed with status ${response.status}`);
  }
  return response;
}

async function putStoredCover(client, env, key, body, contentType) {
  const response = await client.fetch(buildObjectUrl(env, key), {
    method: 'PUT',
    headers: {
      'content-type': contentType,
      'content-length': String(body.byteLength),
      'x-amz-content-sha256': await sha256Hex(body),
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`OSCA PUT failed with status ${response.status}`);
  }
}

function doubanHeaders(env) {
  const headers = new Headers({
    'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.16 NetType/WIFI Language/zh_CN',
    referer: 'https://servicewechat.com/wx2f9b06c1de1ccfca/84/page-frame.html',
  });
  if (env.AUTH_TOKEN) headers.set('authorization', `Bearer ${env.AUTH_TOKEN}`);
  return headers;
}

async function fetchCover(env, type, id) {
  const host = env.DOUBAN_API_HOST || DEFAULT_DOUBAN_HOST;
  const apiKey = env.DOUBAN_API_KEY || DEFAULT_DOUBAN_API_KEY;
  const subjectUrl = new URL(`https://${host}/api/v2/${type}/${id}`);
  subjectUrl.searchParams.set('apiKey', apiKey);

  const subjectResponse = await fetch(subjectUrl, { headers: doubanHeaders(env) });
  if (!subjectResponse.ok) {
    throw new HttpError(subjectResponse.status === 404 ? 404 : 502, `Douban API returned ${subjectResponse.status}`);
  }

  const subject = await subjectResponse.json();
  const coverUrl = type === 'celebrity' ? subject?.cover_img?.url : subject?.cover_url;
  if (typeof coverUrl !== 'string' || !coverUrl.startsWith('https://')) {
    throw new HttpError(404, 'Cover URL was not found');
  }

  const coverResponse = await fetch(coverUrl, { headers: doubanHeaders(env) });
  if (!coverResponse.ok) {
    throw new HttpError(502, `Cover origin returned ${coverResponse.status}`);
  }

  const declaredLength = Number(coverResponse.headers.get('content-length') || 0);
  if (declaredLength > MAX_COVER_BYTES) {
    throw new HttpError(413, 'Cover image is too large');
  }

  const body = await coverResponse.arrayBuffer();
  if (body.byteLength > MAX_COVER_BYTES) {
    throw new HttpError(413, 'Cover image is too large');
  }

  return {
    body,
    contentType: coverResponse.headers.get('content-type') || 'image/jpeg',
  };
}

function imageHeaders(contentType, cacheStatus, sourceHeaders) {
  const headers = new Headers({
    'content-type': contentType || 'image/jpeg',
    'cache-control': 'public, max-age=86400, s-maxage=604800, immutable',
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
    'x-dover-cache': cacheStatus,
  });

  for (const name of ['content-length', 'etag', 'last-modified']) {
    const value = sourceHeaders?.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

async function handleCoverRequest(request, env, ctx, type, id) {
  assertConfiguration(env);
  const client = createOscaClient(env);
  const key = buildObjectKey(env, type, id);

  try {
    const cached = await getStoredCover(client, env, key);
    if (cached) {
      return new Response(cached.body, {
        status: 200,
        headers: imageHeaders(cached.headers.get('content-type'), 'HIT', cached.headers),
      });
    }
  } catch (error) {
    console.error(JSON.stringify({
      message: 'OSCA cache read failed; falling back to Douban',
      path: new URL(request.url).pathname,
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  const cover = await fetchCover(env, type, id);
  ctx.waitUntil(
    putStoredCover(client, env, key, cover.body, cover.contentType).catch((error) => {
      console.error(JSON.stringify({
        message: 'OSCA cache write failed',
        key,
        error: error instanceof Error ? error.message : String(error),
      }));
    }),
  );

  return new Response(cover.body, {
    status: 200,
    headers: imageHeaders(cover.contentType, 'MISS'),
  });
}

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method !== 'GET') {
        return jsonResponse({ error: 'Method not allowed' }, 405, { allow: 'GET' });
      }

      const url = new URL(request.url);
      if (url.pathname === '/') {
        return new Response('Operational', {
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'access-control-allow-origin': '*',
            'x-content-type-options': 'nosniff',
          },
        });
      }

      const match = url.pathname.match(COVER_ROUTE);
      if (!match) return jsonResponse({ error: 'Not found' }, 404);

      return await handleCoverRequest(request, env, ctx, match[1].toLowerCase(), match[2]);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : 'Internal server error';
      console.error(JSON.stringify({
        message: 'Request failed',
        path: new URL(request.url).pathname,
        status,
        error: error instanceof Error ? error.message : String(error),
      }));
      return jsonResponse({ error: message }, status);
    }
  },
};
