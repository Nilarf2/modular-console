import { lookup } from 'node:dns';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { NewApiData } from '../../shared/types.js';

export interface NewApiConfig {
  baseUrl: string;
  token: string;
  userId: number;
  quotaPerUnit: number;
  currency: string;
}

const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;

function blockedAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(host) === 4) return host.startsWith('169.254.') || host === '0.0.0.0';
  if (isIP(host) === 6) {
    // URL parsing also normalizes IPv4-mapped IPv6 to hexadecimal groups.
    const normalized = new URL(`http://[${host}]/`).hostname.slice(1, -1);
    if (normalized === '::' || /^fe[89ab][0-9a-f]:/.test(normalized)) return true;
    if (normalized.startsWith('::ffff:')) {
      const groups = normalized.slice(7).split(':');
      if (groups.length === 2) {
        const high = Number.parseInt(groups[0]!, 16);
        const low = Number.parseInt(groups[1]!, 16);
        return blockedAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
      }
    }
  }
  return false;
}

/** Validates the configured service base; private networks and localhost are supported. */
export function validateNewApiUrl(value: string): string {
  let url: URL;
  try {
    if (typeof value !== 'string' || value.length > 2048 || !/^https?:\/\//i.test(value) || /[\s\\]/.test(value)) throw new Error();
    url = new URL(value);
  } catch {
    throw new Error('Invalid NewAPI base URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      value.slice(value.indexOf('//') + 2).split('/')[0]!.includes('@') ||
      url.search || url.hash || value.includes('?') || value.includes('#') ||
      blockedAddress(url.hostname)) {
    throw new Error('Invalid NewAPI base URL');
  }
  return url.toString().replace(/\/+$/, '');
}

// Resolve inside the connection attempt, so a hostname cannot bypass the IP restriction.
const safeLookup: NonNullable<RequestOptions['lookup']> = (hostname, options, callback) => {
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error || addresses.length === 0 || addresses.some(({ address }) => blockedAddress(address))) {
      callback(new Error('NewAPI host unavailable'), '', 4);
      return;
    }
    if (options.all) {
      callback(null, addresses);
      return;
    }
    const address = addresses.find((entry) => !options.family || entry.family === options.family);
    if (!address) callback(new Error('NewAPI host unavailable'), '', 4);
    else callback(null, address.address, address.family);
  });
};

function readNewApi(url: URL, config: NewApiConfig): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = transport(url, {
      method: 'GET',
      lookup: safeLookup,
      // No pooled connection can outlive a DNS validation for this request.
      agent: false,
      headers: {
        Authorization: `Bearer ${config.token}`,
        'New-Api-User': String(config.userId),
        Accept: 'application/json',
        'Accept-Encoding': 'identity',
      },
    });
    const timer = setTimeout(() => req.destroy(new Error('NewAPI request timed out')), REQUEST_TIMEOUT_MS);
    timer.unref();
    req.once('error', () => reject(new Error('NewAPI request failed')));
    req.once('close', () => clearTimeout(timer));
    req.once('response', (response) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        response.destroy();
        reject(new Error(status >= 300 && status < 400 ? 'NewAPI redirects are not allowed' : `NewAPI HTTP ${status}`));
        return;
      }
      const declaredLength = Number(response.headers['content-length']);
      if (declaredLength > MAX_RESPONSE_BYTES) {
        response.destroy();
        reject(new Error('NewAPI response is too large'));
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          response.destroy();
          reject(new Error('NewAPI response is too large'));
        } else chunks.push(chunk);
      });
      response.once('error', () => reject(new Error('NewAPI response failed')));
      response.once('end', () => {
        try {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
          const envelope = body as Record<string, unknown>;
          if (envelope.success !== true || !envelope.data ||
              typeof envelope.data !== 'object' || Array.isArray(envelope.data)) throw new Error();
          resolve(envelope.data as Record<string, unknown>);
        } catch {
          reject(new Error('NewAPI returned an invalid or unsuccessful response'));
        }
      });
    });
    req.end();
  });
}

function metric(value: unknown, allowNegative = false): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && (allowNegative || value >= 0) ? value : null;
}

/** Reads account totals and optional daily quota. Never sends a modifying request. */
export async function fetchNewApi(config: NewApiConfig): Promise<NewApiData> {
  const baseUrl = validateNewApiUrl(config.baseUrl);
  if (!Number.isSafeInteger(config.userId) || config.userId <= 0) throw new Error('Invalid NewAPI user ID');
  if (typeof config.token !== 'string' || !config.token || config.token.length > 8192 || /\s|[^\x21-\x7e]/.test(config.token)) {
    throw new Error('Invalid NewAPI access token');
  }
  if (!Number.isFinite(config.quotaPerUnit) || config.quotaPerUnit <= 0 || config.quotaPerUnit > Number.MAX_SAFE_INTEGER) {
    throw new Error('Invalid NewAPI quota conversion');
  }
  if (typeof config.currency !== 'string' || !config.currency.trim() || config.currency.length > 16 || /[\x00-\x1f\x7f]/.test(config.currency)) {
    throw new Error('Invalid NewAPI currency');
  }
  const account = await readNewApi(new URL(`${baseUrl}/api/user/self`), config);
  if (typeof account.username !== 'string' || !account.username.trim() || account.username.length > 256) {
    throw new Error('NewAPI returned an invalid account');
  }
  const data: NewApiData = {
    username: account.username,
    quota: metric(account.quota, true),
    usedQuota: metric(account.used_quota),
    requestCount: metric(account.request_count),
    todayQuota: null,
    todayTokens: null,
    todayRequests: null,
    quotaPerUnit: config.quotaPerUnit,
    currency: config.currency.trim(),
  };
  // Asia/Shanghai has a fixed UTC+8 offset; use its midnight regardless of server TZ.
  const end = Math.floor(Date.now() / 1000);
  const start = Math.floor((end + 8 * 3600) / 86400) * 86400 - 8 * 3600;
  const statsUrl = new URL(`${baseUrl}/api/log/self/stat`);
  statsUrl.search = new URLSearchParams({ type: '2', start_timestamp: String(start), end_timestamp: String(end) }).toString();
  try {
    const stats = await readNewApi(statsUrl, config);
    data.todayQuota = metric(stats.quota);
    // rpm/tpm are the last minute's rates, not daily request/token totals.
  } catch {
    // Older servers and narrowly scoped access tokens may not expose log statistics.
  }
  return data;
}
