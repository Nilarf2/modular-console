import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { fetchNewApi, validateNewApiUrl, type NewApiConfig } from '../src/plugins/newapi/connector.js';

const secret = 'private-test-access-token';
const account = { username: 'operator', quota: 1234, used_quota: 567, request_count: 89 };

async function mockNewApi(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  const config: NewApiConfig = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: secret, userId: 42, quotaPerUnit: 500_000, currency: 'USD',
  };
  return {
    config,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function json(res: ServerResponse, data: unknown) {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ success: true, data }));
}

test('reads only fixed account/stat routes with access-token and user headers', async () => {
  const requests: string[] = [];
  const mock = await mockNewApi((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    assert.equal(req.headers['new-api-user'], '42');
    requests.push(req.url!);
    const url = new URL(req.url!, 'http://localhost');
    if (url.pathname === '/prefix/api/user/self') json(res, account);
    else {
      assert.equal(url.pathname, '/prefix/api/log/self/stat');
      assert.equal(url.searchParams.get('type'), '2');
      const start = Number(url.searchParams.get('start_timestamp'));
      const end = Number(url.searchParams.get('end_timestamp'));
      assert.equal((start + 8 * 3600) % 86400, 0);
      assert(end >= start && end - start < 86400);
      json(res, { quota: 320, rpm: 7, tpm: 900 });
    }
  });
  try {
    const result = await fetchNewApi({ ...mock.config, baseUrl: `${mock.config.baseUrl}/prefix/` });
    assert.deepEqual(result, {
      username: 'operator', quota: 1234, usedQuota: 567, requestCount: 89,
      todayQuota: 320, todayRequests: null, todayTokens: null,
      quotaPerUnit: 500_000, currency: 'USD',
    });
    assert.equal(requests.length, 2);
  } finally { await mock.close(); }
});

test('preserves zero and negative account balance, leaves missing/invalid metrics null', async () => {
  let zeros = false;
  const mock = await mockNewApi((req, res) => {
    if (req.url === '/api/user/self') json(res, zeros ? { username: 'zero', quota: 0, used_quota: 0, request_count: 0 } : {
      username: 'empty', quota: -3, used_quota: '12', request_count: Number.MAX_SAFE_INTEGER + 1,
    });
    else json(res, zeros ? { quota: 0 } : { rpm: 0, tpm: 0 });
  });
  try {
    const missing = await fetchNewApi(mock.config);
    assert.equal(missing.quota, -3);
    for (const key of ['usedQuota', 'requestCount', 'todayQuota', 'todayTokens', 'todayRequests'] as const) assert.equal(missing[key], null);
    zeros = true;
    const result = await fetchNewApi(mock.config);
    for (const key of ['quota', 'usedQuota', 'requestCount', 'todayQuota'] as const) assert.equal(result[key], 0);
  } finally { await mock.close(); }
});

test('optional statistics failure leaves account available without invented daily totals', async () => {
  const mock = await mockNewApi((req, res) => {
    if (req.url === '/api/user/self') json(res, account);
    else { res.statusCode = 403; res.end(secret); }
  });
  try {
    const result = await fetchNewApi(mock.config);
    assert.equal(result.quota, 1234);
    assert.equal(result.todayQuota, null);
    assert.equal(result.todayTokens, null);
    assert.equal(result.todayRequests, null);
  } finally { await mock.close(); }
});

test('rejects redirects without sending credentials to the target', async () => {
  let targetCalls = 0;
  const target = await mockNewApi((_req, res) => { targetCalls++; json(res, account); });
  const mock = await mockNewApi((_req, res) => {
    res.writeHead(302, { Location: `${target.config.baseUrl}/capture?secret=${secret}` });
    res.end(secret);
  });
  try {
    await assert.rejects(fetchNewApi(mock.config), { message: 'NewAPI redirects are not allowed' });
    assert.equal(targetCalls, 0);
  } finally { await mock.close(); await target.close(); }
});

test('bounds responses by declared size and actual streamed bytes', async () => {
  for (const declared of [false, true]) {
    const mock = await mockNewApi((_req, res) => {
      if (declared) res.setHeader('Content-Length', 300_000);
      res.write('x'.repeat(150_000));
      res.end('x'.repeat(150_000));
    });
    try { await assert.rejects(fetchNewApi(mock.config), { message: 'NewAPI response is too large' }); }
    finally { await mock.close(); }
  }
});

test('enforces the request deadline even if upstream never answers', async () => {
  const mock = await mockNewApi(() => { /* Deliberately leave the response open. */ });
  try {
    await assert.rejects(fetchNewApi(mock.config), { message: 'NewAPI request failed' });
  } finally { await mock.close(); }
});

test('sanitizes HTTP, API-envelope, JSON, and interrupted-response errors', async () => {
  for (const failure of ['http', 'envelope', 'json', 'interrupted', 'username']) {
    const mock = await mockNewApi((_req, res) => {
      if (failure === 'http') { res.writeHead(401); res.end(secret); }
      else if (failure === 'envelope') res.end(JSON.stringify({ success: false, message: secret }));
      else if (failure === 'json') res.end(secret);
      else if (failure === 'username') json(res, { quota: 5 });
      else { res.writeHead(200, { 'Content-Length': 100 }); res.write('{'); res.socket?.destroy(); }
    });
    try {
      await assert.rejects(fetchNewApi(mock.config), (error: Error) => {
        assert(error.message.startsWith('NewAPI '));
        assert(!error.message.includes(secret));
        assert.equal(error.cause, undefined);
        return true;
      });
    } finally { await mock.close(); }
  }
});

test('validates URL and credential config before making requests', async () => {
  let calls = 0;
  const mock = await mockNewApi((_req, res) => { calls++; json(res, account); });
  try {
    for (const userId of [0, -1, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '42' as unknown as number]) {
      await assert.rejects(fetchNewApi({ ...mock.config, userId }), { message: 'Invalid NewAPI user ID' });
    }
    for (const token of ['', `${secret}\r\nOther: injected`, ` ${secret}`]) {
      await assert.rejects(fetchNewApi({ ...mock.config, token }), { message: 'Invalid NewAPI access token' });
    }
    for (const quotaPerUnit of [0, -1, NaN, Infinity]) await assert.rejects(fetchNewApi({ ...mock.config, quotaPerUnit }));
    assert.equal(calls, 0);
  } finally { await mock.close(); }
});

test('allows self-hosted/private/Tailscale hosts but rejects unsafe URL forms and link-local addresses', () => {
  for (const url of ['http://localhost:3000/', 'http://127.0.0.1', 'http://10.1.2.3/newapi', 'https://100.90.80.70', 'http://[::1]:3000']) {
    assert.equal(validateNewApiUrl(url), url.replace(/\/$/, ''));
  }
  for (const url of [
    'file:///etc/passwd', 'ftp://example.com', 'https://user:pass@example.com',
    'http://@example.com', 'http:example.com',
    'https://example.com?token=secret', 'https://example.com#secret',
    'https://example.com?', 'https://example.com#', 'http://169.254.169.254',
    'http://0xa9fea9fe', 'http://[::ffff:169.254.169.254]', 'http://[fe80::1]',
    'http://0.0.0.0', 'http://[::]', 'http://example.com\\@169.254.169.254', 'not-a-url',
  ]) assert.throws(() => validateNewApiUrl(url), { message: 'Invalid NewAPI base URL' });
});
