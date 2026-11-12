// The connector end to end over MCP (in-memory transport) against a fake MetaMynd API: the tools it offers, what it
// sends, what it refuses before sending, and that the token never leaves the Authorization header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { ApiError, checkBase, createApi } from '../src/api.mjs';
import { TOOLS, createAssuranceServer } from '../src/server.mjs';

const TOKEN = 'mm_pat_' + 'x'.repeat(43);
const PROG = '6f1c2b3a-1111-4111-8111-111111111111';
const REPORT = '11111111-2222-4333-8444-555555555555';

const REPORT_VIEW = {
  edition: 'lite',
  reportId: REPORT,
  targetLabel: 'autonomous production payments',
  status: { status: 'not-ready', reasons: ['Gate G3 failed.'] },
  risk: { grade: 'C', index: 30, band: { low: 25, high: 35 }, calibration: 'uncalibrated' },
  gates: [{ id: 'G3', result: 'fail' }],
  validity: { status: 'current', triggers: [] },
};

/** A fake API: records calls, answers by path. */
function fakeApi(overrides = /** @type {Record<string, (url: URL, init: any) => any>} */ ({})) {
  const calls = /** @type {Array<{ url: string, method: string, auth: string | null, body: any }>} */ ([]);
  /** @type {typeof fetch} */
  const fetchImpl = /** @type {any} */ (
    async (/** @type {string} */ url, /** @type {any} */ init) => {
      calls.push({ url, method: init?.method ?? 'GET', auth: init?.headers?.authorization ?? null, body: init?.body ? JSON.parse(init.body) : null });
      const u = new URL(url);
      for (const [pattern, handler] of Object.entries(overrides)) {
        if (u.pathname.endsWith(pattern)) return handler(u, init);
      }
      const ok = (/** @type {any} */ data) => ({ ok: true, status: 200, json: async () => ({ success: true, data }) });
      if (u.pathname.endsWith('/sandbox/programmes')) return ok([{ programmeId: PROG, agentDid: 'did:x', planId: 'p', status: 'open', createdAt: '2026-11-01', planDocument: { big: true } }]);
      if (u.pathname.endsWith('/readiness-reports') && init?.method === 'POST') return ok({ reportId: REPORT, status: 'not-ready', grade: 'C' });
      if (u.pathname.endsWith('/readiness-reports')) return ok([{ reportId: REPORT, status: 'not-ready', grade: 'C', issuedAt: '2026-11-12T00:00:00Z', validity: { status: 'current' } }]);
      if (u.pathname.endsWith('/status')) return ok({ reportId: REPORT, authentic: true, status: 'current', reasons: [], reassessBy: '2027-02-10' });
      if (u.pathname.endsWith('/questions')) return ok({ answer: 'Not ready: G3 failed [S:gate-G3].', notice: 'Answers are guidance.', remaining: 4 });
      if (u.pathname.includes('/fixes/')) return ok({ title: 'Set issuer-held limits', kind: 'mandate-change', notice: 'A draft.', requests: [] });
      if (u.pathname.includes('/readiness-reports/')) return ok(REPORT_VIEW);
      return { ok: false, status: 404, json: async () => ({ message: 'Not found' }) };
    }
  );
  return { fetchImpl, calls };
}

async function connect(api) {
  const server = createAssuranceServer({ api });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'ai-app', version: '0' });
  await client.connect(b);
  return client;
}

const text = (/** @type {any} */ r) => r.content.map((/** @type {any} */ c) => c.text).join('\n');

test('offers the seven tools, read-only except issue_report', async () => {
  const client = await connect(createApi({ token: TOKEN, fetchImpl: fakeApi().fetchImpl }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS.map((t) => t.name).sort());
  for (const t of tools) assert.equal(t.annotations?.readOnlyHint, t.name !== 'issue_report', t.name);
  assert.equal(tools.find((t) => t.name === 'issue_report')?.annotations?.destructiveHint, false);
});

test('reads a report, keeping status and grade apart, with the token only in the Authorization header', async () => {
  const { fetchImpl, calls } = fakeApi();
  const client = await connect(createApi({ token: TOKEN, fetchImpl }));
  const r = await client.callTool({ name: 'get_report', arguments: { report_id: REPORT } });
  assert.match(text(r), /Deployment status for autonomous production payments: not-ready/);
  assert.match(text(r), /Risk grade \(separate from the status/);
  assert.equal(calls[0].auth, `Bearer ${TOKEN}`);
  assert.ok(!calls[0].url.includes(TOKEN));
  assert.match(calls[0].url, /edition=lite$/);
});

test('issues a report with the chosen target', async () => {
  const { fetchImpl, calls } = fakeApi();
  const client = await connect(createApi({ token: TOKEN, fetchImpl }));
  const r = await client.callTool({ name: 'issue_report', arguments: { programme_id: PROG, target: 'supervised-payments' } });
  assert.match(text(r), /Issued report/);
  assert.deepEqual(calls[0].body, { target: 'supervised-payments' });
  assert.equal(calls[0].method, 'POST');
});

test('checks a report status with no token at all', async () => {
  const { fetchImpl, calls } = fakeApi();
  const client = await connect(createApi({ token: null, fetchImpl }));
  const r = await client.callTool({ name: 'check_report_status', arguments: { report_id: REPORT } });
  assert.match(text(r), /Authentic: yes\. Validity: current/);
  assert.equal(calls[0].auth, null);
});

test('without a token, the other tools say how to get one and send nothing', async () => {
  const { fetchImpl, calls } = fakeApi();
  const client = await connect(createApi({ token: null, fetchImpl }));
  const r = await client.callTool({ name: 'list_programmes', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(text(r), /Set METAMYND_TOKEN/);
  assert.equal(calls.length, 0);
});

test('refuses malformed ids and targets before calling the API', async () => {
  const { fetchImpl, calls } = fakeApi();
  const client = await connect(createApi({ token: TOKEN, fetchImpl }));
  for (const [name, args] of /** @type {Array<[string, any]>} */ ([
    ['get_report', { report_id: '../../admin' }],
    ['issue_report', { programme_id: PROG, target: 'everything' }],
    ['get_fix_draft', { report_id: REPORT, fix_id: '../x' }],
    ['ask_report', { report_id: REPORT, question: '' }],
  ])) {
    const r = await client.callTool({ name, arguments: args });
    assert.equal(r.isError, true, name);
  }
  assert.equal(calls.length, 0);
});

test('passes the API message on, with a hint, and never the token', async () => {
  const { fetchImpl } = fakeApi({
    '/questions': () => ({ ok: false, status: 401, json: async () => ({ message: 'Unauthorized' }) }),
  });
  const client = await connect(createApi({ token: TOKEN, fetchImpl }));
  const r = await client.callTool({ name: 'ask_report', arguments: { report_id: REPORT, question: 'Why?' } });
  assert.equal(r.isError, true);
  assert.match(text(r), /Unauthorized\. Check METAMYND_TOKEN/);
  assert.ok(!text(r).includes(TOKEN));
});

test('asks about a report, trimming history to what the API accepts', async () => {
  const { fetchImpl, calls } = fakeApi();
  const client = await connect(createApi({ token: TOKEN, fetchImpl }));
  const history = Array.from({ length: 15 }, (_, i) => ({ question: `q${i}`, answer: 'a'.repeat(9000) }));
  const r = await client.callTool({ name: 'ask_report', arguments: { report_id: REPORT, question: 'Why not ready?', history } });
  assert.match(text(r), /4 question\(s\) left/);
  assert.equal(calls[0].body.history.length, 10);
  assert.equal(calls[0].body.history[0].answer.length, 8000);
});

test('lists programmes without their bulky plan documents', async () => {
  const client = await connect(createApi({ token: TOKEN, fetchImpl: fakeApi().fetchImpl }));
  const r = await client.callTool({ name: 'list_programmes', arguments: {} });
  assert.ok(!text(r).includes('planDocument'));
  assert.match(text(r), /1 programme/);
});

test('only talks to https (or localhost)', () => {
  assert.throws(() => checkBase('http://metamynd.ai/api/v1'), ApiError);
  assert.throws(() => checkBase('http://localhost.evil.test/api/v1'), ApiError);
  assert.equal(checkBase('https://metamynd.ai/api/v1/'), 'https://metamynd.ai/api/v1');
  assert.equal(checkBase('http://localhost:9926/api/v1'), 'http://localhost:9926/api/v1');
});
