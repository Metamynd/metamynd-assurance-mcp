#!/usr/bin/env node
// assurance-mcp: the MetaMynd readiness connector as a stdio MCP server.
//
//   METAMYND_TOKEN=mm_pat_…  npx -y @metamynd/assurance-mcp
//
// METAMYND_TOKEN is an owner API token (MetaMynd dashboard: Settings > API tokens); without it only
// check_report_status works. METAMYND_API overrides the API base (default https://metamynd.ai/api/v1).

import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createApi, DEFAULT_API } from './api.mjs';
import { createAssuranceServer } from './server.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const arg = process.argv[2];

if (arg === '--version' || arg === '-v') {
  console.log(pkg.version);
} else if (arg === '--help' || arg === '-h') {
  console.log(`${pkg.name} ${pkg.version}: MetaMynd Agent Readiness Reports as MCP tools (stdio).

  Environment
    METAMYND_TOKEN   owner API token (Settings > API tokens) with readiness:read,
                     plus readiness:issue / readiness:ask for those tools
    METAMYND_API     API base, default ${DEFAULT_API}

  Tools: list_programmes, list_reports, get_report, check_report_status,
         get_fix_draft, issue_report, ask_report`);
} else {
  let api;
  try {
    api = createApi({ base: process.env.METAMYND_API || DEFAULT_API, token: process.env.METAMYND_TOKEN || null });
  } catch (e) {
    // stdout is the MCP channel: diagnostics go to stderr only.
    console.error(`[assurance-mcp] ${/** @type {Error} */ (e).message}`);
    process.exit(2);
  }
  if (!api.hasToken) console.error('[assurance-mcp] METAMYND_TOKEN is not set: only check_report_status will work.');
  const server = createAssuranceServer({ api, serverInfo: { name: 'metamynd-assurance', version: pkg.version } });
  await server.connect(new StdioServerTransport());
}
