# @agent-studio/audit

Audit CLI for agent-studio.

## Commands

| Command | Usage |
|---------|-------|
| `log` | View audit logs `--company=<id> [--action=<type>] [--limit=<n>]` |
| `export` | Export logs `--company=<id> --from=<date> --to=<date>` |
| `search` | Search logs `--company=<id> --query=<text>` |

## Usage

```bash
npx @agent-studio/audit log --company=1 --action=create --limit=10
npx @agent-studio/audit export --company=1 --from=2026-01-01 --to=2026-03-31 --format=csv
npx @agent-studio/audit search --company=1 --query="role"
```