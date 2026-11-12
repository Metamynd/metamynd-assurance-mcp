// The MetaMynd readiness API, as the connector uses it. An owner API token (Settings > API tokens) authenticates every
// call except the public status check; it is sent only in the Authorization header, only over HTTPS (or to localhost),
// and never appears in an error message.

export const DEFAULT_API = 'https://metamynd.ai/api/v1';

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {number | null} status
   * @param {string | null} code
   */
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** @param {string} base */
export function checkBase(base) {
  const trimmed = base.replace(/\/+$/, '');
  // A token sent over plain HTTP to a remote host would be readable on the way.
  if (!/^https:\/\//.test(trimmed) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(trimmed)) {
    throw new ApiError(`METAMYND_API must be an https:// URL (or http://localhost): ${trimmed}`, null, 'INSECURE_API');
  }
  return trimmed;
}

const HINTS = /** @type {Record<number, string>} */ ({
  401: 'Check METAMYND_TOKEN: it must be an owner API token that is unexpired, not revoked, and has the scope this tool needs.',
  402: 'This needs the Full report (a paid assessment).',
  404: 'Not found, or not one of your programmes.',
  429: 'Too many requests; wait a minute and try again.',
});

/**
 * @param {{ base?: string, token?: string | null, fetchImpl?: typeof fetch }} [opts]
 */
export function createApi({ base = DEFAULT_API, token = null, fetchImpl = fetch } = {}) {
  const root = checkBase(base);

  /**
   * @param {string} path
   * @param {{ method?: string, body?: unknown, auth?: boolean, scope?: string }} [opts]
   */
  async function call(path, { method = 'GET', body, auth = true, scope } = {}) {
    if (auth && !token) {
      throw new ApiError(`Set METAMYND_TOKEN to an owner API token${scope ? ` with ${scope}` : ''} (MetaMynd dashboard: Settings > API tokens).`, null, 'NO_TOKEN');
    }
    /** @type {Record<string, string>} */
    const headers = { accept: 'application/json' };
    if (auth && token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res;
    try {
      res = await fetchImpl(`${root}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    } catch {
      throw new ApiError(`Could not reach ${new URL(root).host}.`, null, 'UNREACHABLE');
    }
    /** @type {any} */
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const code = json?.data?.code ?? null;
      const hint = HINTS[res.status] ? ` ${HINTS[res.status]}` : '';
      const message = String(json?.message ?? `Request failed (${res.status})`).trim();
      throw new ApiError(`${/[.!?]$/.test(message) ? message : `${message}.`}${hint}`, res.status, code);
    }
    return json?.data;
  }

  const id = (/** @type {string} */ v) => encodeURIComponent(v);
  return {
    hasToken: Boolean(token),
    listProgrammes: () => call('/sandbox/programmes', { scope: 'readiness:read' }),
    /** @param {string} programmeId */
    listReports: (programmeId) => call(`/sandbox/programmes/${id(programmeId)}/readiness-reports`, { scope: 'readiness:read' }),
    /** @param {string} reportId @param {'lite' | 'full'} edition */
    getReport: (reportId, edition) => call(`/sandbox/readiness-reports/${id(reportId)}?edition=${edition}`, { scope: 'readiness:read' }),
    /** @param {string} reportId @param {string} fixId */
    getFixDraft: (reportId, fixId) => call(`/sandbox/readiness-reports/${id(reportId)}/fixes/${id(fixId)}`, { scope: 'readiness:read' }),
    /** @param {string} programmeId @param {string | undefined} target */
    issueReport: (programmeId, target) =>
      call(`/sandbox/programmes/${id(programmeId)}/readiness-reports`, { method: 'POST', body: target ? { target } : {}, scope: 'readiness:issue' }),
    /** @param {string} reportId @param {string} question @param {Array<{ question: string, answer: string }>} history */
    ask: (reportId, question, history) =>
      call(`/sandbox/readiness-reports/${id(reportId)}/questions`, { method: 'POST', body: { question, history }, scope: 'readiness:ask' }),
    /** Public: no token is sent. @param {string} reportId @param {string | undefined} hash */
    status: (reportId, hash) =>
      call(`/sandbox/readiness-reports/${id(reportId)}/status${hash ? `?hash=${encodeURIComponent(hash)}` : ''}`, { auth: false }),
  };
}

/** @typedef {ReturnType<typeof createApi>} ReadinessApi */
