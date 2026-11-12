// The connector as an MCP server: tools over the MetaMynd readiness API, so an AI app can list an owner's programmes,
// read and issue Agent Readiness Reports, check one is still valid, read fix drafts and ask about a report.
//
// It never changes an agent: fix drafts are returned to read, and applying one stays a signed-in dashboard action
// (an API token cannot change a mandate). Every answer keeps the deployment status and the risk grade apart.

import { Server } from '@modelcontextprotocol/server';
import { ApiError } from './api.mjs';

/** @typedef {import('./api.mjs').ReadinessApi} ReadinessApi */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TARGETS = ['autonomous-payments', 'supervised-payments', 'non-financial'];
const READ = { readOnlyHint: true, openWorldHint: false };

/** @type {Array<{ name: string, description: string, inputSchema: any, annotations: Record<string, boolean> }>} */
export const TOOLS = [
  {
    name: 'list_programmes',
    description: "List your Controlled Testing programmes (one agent tested against one plan). Needs readiness:read.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ,
  },
  {
    name: 'list_reports',
    description:
      "List a programme's issued Agent Readiness Reports, newest first, each with its deployment status, risk grade and validity now (current, superseded, reassessment required, revoked, expired). Needs readiness:read.",
    inputSchema: {
      type: 'object',
      properties: { programme_id: { type: 'string', description: 'The programme id (a UUID).' } },
      required: ['programme_id'],
      additionalProperties: false,
    },
    annotations: READ,
  },
  {
    name: 'get_report',
    description:
      'Read one issued Agent Readiness Report: deployment status and risk grade (reported separately), gates, assurances, findings, fixes and validity. The Full edition needs a paid assessment. Needs readiness:read.',
    inputSchema: {
      type: 'object',
      properties: {
        report_id: { type: 'string', description: 'The report id (a UUID).' },
        edition: { type: 'string', enum: ['lite', 'full'], description: 'Default lite.' },
      },
      required: ['report_id'],
      additionalProperties: false,
    },
    annotations: READ,
  },
  {
    name: 'check_report_status',
    description:
      'Check that a readiness report is authentic and still current, without a token: what a customer or regulator does before relying on one. Optionally confirm a copy by its hash.',
    inputSchema: {
      type: 'object',
      properties: {
        report_id: { type: 'string', description: 'The report id (a UUID).' },
        hash: { type: 'string', description: 'Optional sha256:… hash of the copy you were given.' },
      },
      required: ['report_id'],
      additionalProperties: false,
    },
    annotations: READ,
  },
  {
    name: 'get_fix_draft',
    description:
      "Read the draft for one fix in a report (Full edition): the exact owner request, a rule dry run, code snippets and steps. Read only: apply a change from the MetaMynd dashboard. Needs readiness:read.",
    inputSchema: {
      type: 'object',
      properties: {
        report_id: { type: 'string', description: 'The report id (a UUID).' },
        fix_id: { type: 'string', description: 'The fix id from the report, e.g. gate-G3.' },
      },
      required: ['report_id', 'fix_id'],
      additionalProperties: false,
    },
    annotations: READ,
  },
  {
    name: 'issue_report',
    description:
      "Issue a new signed Agent Readiness Report for a programme's latest completed run. It is recorded and supersedes the previous report for the same target. Needs readiness:issue.",
    inputSchema: {
      type: 'object',
      properties: {
        programme_id: { type: 'string', description: 'The programme id (a UUID).' },
        target: { type: 'string', enum: TARGETS, description: "Default: from the agent's mandate." },
      },
      required: ['programme_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'ask_report',
    description:
      "Ask MetaMynd's report assistant a question about ONE report. Answers come from that report only, cite its sections, and label projections as projections; they are guidance, not attested. Needs readiness:ask.",
    inputSchema: {
      type: 'object',
      properties: {
        report_id: { type: 'string', description: 'The report id (a UUID).' },
        question: { type: 'string', description: 'Up to 2000 characters.' },
        history: {
          type: 'array',
          description: 'Earlier turns of this conversation about the same report, oldest first (at most 10).',
          items: {
            type: 'object',
            properties: { question: { type: 'string' }, answer: { type: 'string' } },
            required: ['question', 'answer'],
            additionalProperties: false,
          },
        },
      },
      required: ['report_id', 'question'],
      additionalProperties: false,
    },
    annotations: READ,
  },
];

class InputError extends Error {}

/** @param {Record<string, unknown>} args @param {string} key */
function uuidArg(args, key) {
  const v = args[key];
  if (typeof v !== 'string' || !UUID.test(v)) throw new InputError(`${key} must be a UUID.`);
  return v;
}

/** @param {any} r */
function reportSummary(r) {
  const gates = (r.gates ?? []).map((/** @type {any} */ g) => `${g.id} ${g.result}`).join(', ');
  const lines = [
    `Deployment status for ${r.targetLabel}: ${r.status?.status}. ${(r.status?.reasons ?? []).join(' ')}`.trim(),
    `Risk grade (separate from the status; an ordinal, ${r.risk?.calibration ?? 'uncalibrated'} index): ${r.risk?.grade}, index ${r.risk?.index}, band ${r.risk?.band?.low}-${r.risk?.band?.high}.`,
    `Gates: ${gates || 'none'}.`,
  ];
  if (r.validity) lines.push(`Validity now: ${r.validity.status}${r.validity.triggers?.length ? ` (${r.validity.triggers.join(', ')})` : ''}.`);
  lines.push(`Edition: ${r.edition}. This is an assessment, not a certification.`);
  return lines.join('\n');
}

/** @param {string} summary @param {unknown} data */
const ok = (summary, data) => ({ content: [{ type: 'text', text: summary }, { type: 'text', text: JSON.stringify(data, null, 2) }] });
/** @param {string} text */
const fail = (text) => ({ content: [{ type: 'text', text }], isError: true });

/**
 * @param {ReadinessApi} api
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
export async function callTool(api, name, args) {
  try {
    switch (name) {
      case 'list_programmes': {
        const rows = /** @type {any[]} */ ((await api.listProgrammes()) ?? []);
        return ok(`${rows.length} programme(s).`, rows.map((p) => ({ programmeId: p.programmeId, agentDid: p.agentDid, planId: p.planId, status: p.status, createdAt: p.createdAt })));
      }
      case 'list_reports': {
        const rows = /** @type {any[]} */ ((await api.listReports(uuidArg(args, 'programme_id'))) ?? []);
        const lines = rows.map((r) => `${r.reportId}: ${r.status} (grade ${r.grade}), ${r.validity?.status}, issued ${String(r.issuedAt).slice(0, 10)}`);
        return ok(rows.length ? lines.join('\n') : 'No issued reports for this programme.', rows);
      }
      case 'get_report': {
        const edition = args.edition === 'full' ? 'full' : 'lite';
        const r = await api.getReport(uuidArg(args, 'report_id'), edition);
        return ok(reportSummary(r), r);
      }
      case 'check_report_status': {
        const hash = typeof args.hash === 'string' && args.hash ? args.hash : undefined;
        const s = await api.status(uuidArg(args, 'report_id'), hash);
        const reasons = (s.reasons ?? []).map((/** @type {any} */ x) => x.description ?? x.code).join(' ');
        return ok(
          `Authentic: ${s.authentic ? 'yes' : 'NO'}${s.hashMatches === false ? ' (your copy does not match the issued report)' : ''}. Validity: ${s.status}${reasons ? ` - ${reasons}` : ''}. Reassess by ${s.reassessBy}.`,
          s,
        );
      }
      case 'get_fix_draft': {
        const fixId = args.fix_id;
        if (typeof fixId !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(fixId)) throw new InputError('fix_id must be a fix id from the report, e.g. gate-G3.');
        const d = await api.getFixDraft(uuidArg(args, 'report_id'), fixId);
        return ok(`Draft for "${d.title}" (${d.kind}). ${d.notice} Apply changes from the MetaMynd dashboard.`, d);
      }
      case 'issue_report': {
        const target = args.target;
        if (target !== undefined && (typeof target !== 'string' || !TARGETS.includes(target))) throw new InputError(`target must be one of ${TARGETS.join(', ')}.`);
        const r = await api.issueReport(uuidArg(args, 'programme_id'), /** @type {string | undefined} */ (target));
        return ok(`Issued report ${r.reportId}: ${r.status}, grade ${r.grade}. Check it any time with check_report_status.`, r);
      }
      case 'ask_report': {
        const question = args.question;
        if (typeof question !== 'string' || !question.trim() || question.length > 2000) throw new InputError('question must be 1 to 2000 characters.');
        const raw = Array.isArray(args.history) ? args.history : [];
        const history = raw
          .slice(-10)
          .filter((/** @type {any} */ t) => t && typeof t.question === 'string' && typeof t.answer === 'string')
          .map((/** @type {any} */ t) => ({ question: t.question.slice(0, 2000), answer: t.answer.slice(0, 8000) }));
        const a = await api.ask(uuidArg(args, 'report_id'), question.trim(), history);
        const left = a.remaining === null || a.remaining === undefined ? '' : ` (${a.remaining} question(s) left on the Lite edition)`;
        return ok(`${a.answer}\n\n${a.notice}${left}`, a);
      }
      default:
        return fail(`No tool named "${name}".`);
    }
  } catch (e) {
    if (e instanceof InputError || e instanceof ApiError) return fail(e.message);
    return fail('The MetaMynd API could not be used just now.');
  }
}

/**
 * @param {{ api: ReadinessApi, serverInfo?: { name: string, version: string } }} deps
 */
export function createAssuranceServer({ api, serverInfo = { name: 'metamynd-assurance', version: '0.0.0' } }) {
  const server = new Server(serverInfo, {
    capabilities: { tools: {} },
    instructions:
      "MetaMynd Agent Readiness Reports. Keep a report's deployment status and its risk grade separate: gates and evidence decide the status; the grade is an ordinal, uncalibrated index. A report is an assessment, not a certification. Before relying on a report, use check_report_status.",
  });
  server.setRequestHandler('tools/list', async () => /** @type {any} */ ({ tools: TOOLS }));
  server.setRequestHandler('tools/call', async (request) =>
    /** @type {any} */ (await callTool(api, request.params.name, /** @type {Record<string, unknown>} */ (request.params.arguments ?? {}))),
  );
  return server;
}
