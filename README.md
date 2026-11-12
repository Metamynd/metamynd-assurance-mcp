# @metamynd/assurance-mcp

MetaMynd **Agent Readiness Reports** as MCP tools. Ask Claude, Cursor or any MCP app whether your agent is ready to
deploy, what is blocking it, and how to fix it, and check that a report someone gave you is authentic and still current.

A readiness report says whether an agent can be deployed for a target (for example autonomous production payments),
from a Controlled Testing run in MetaMynd. It has two separate outputs: a **deployment status**, decided by mandatory
gates and evidence, and a **risk grade**, an ordinal and uncalibrated risk index. A report is an assessment, not a
certification.

## Tools

| Tool | What it does | Token scope |
|---|---|---|
| `list_programmes` | Your Controlled Testing programmes | `readiness:read` |
| `list_reports` | A programme's issued reports, each with its status, grade and validity now | `readiness:read` |
| `get_report` | One report: status and grade, gates, findings, fixes, validity (Lite or Full) | `readiness:read` |
| `check_report_status` | Is this report authentic and still current? Optionally check a copy's hash | none (public) |
| `get_fix_draft` | The draft for one fix: the owner request, a rule dry run, code snippets, steps (Full) | `readiness:read` |
| `issue_report` | Issue a new signed report for a programme's latest run | `readiness:issue` |
| `ask_report` | Ask MetaMynd's assistant about one report; answers cite the report | `readiness:ask` |

The connector never changes an agent. Fix drafts are for reading: you apply a change from the MetaMynd dashboard.

## Set up

1. In the MetaMynd dashboard, open **Settings > API tokens** and create a token with the scopes you want (start with
   `readiness:read`). Copy it: it is shown once.
2. Add the connector to your MCP app. For Claude Desktop (`claude_desktop_config.json`) or Cursor (`mcp.json`):

```json
{
  "mcpServers": {
    "metamynd-assurance": {
      "command": "npx",
      "args": ["-y", "@metamynd/assurance-mcp@0.1.0"],
      "env": { "METAMYND_TOKEN": "mm_pat_..." }
    }
  }
}
```

For Claude Code:

```bash
claude mcp add metamynd-assurance --env METAMYND_TOKEN=mm_pat_... -- npx -y @metamynd/assurance-mcp@0.1.0
```

Without `METAMYND_TOKEN`, only `check_report_status` works. `METAMYND_API` points the connector at another MetaMynd API
(default `https://metamynd.ai/api/v1`).

## Security

- The token is read from the environment only, sent only in the `Authorization` header, only over HTTPS (or to
  localhost), and never included in a tool result or error.
- A MetaMynd API token can only do what its scopes allow, reaches only your own programmes, never acts as an
  administrator, and can be revoked at any time in Settings. Changing your password revokes all of them.
- Ids and arguments are checked before any request is sent.
- Pin the version (`@0.1.0`) in your app's config: the connector runs with your token.

Report a vulnerability privately: see [SECURITY.md](SECURITY.md).

## Develop

```bash
npm ci
npm run check   # typecheck + tests
```

MIT licensed.
