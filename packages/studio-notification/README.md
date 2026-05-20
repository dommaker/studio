# @agent-studio/notification

Notification CLI for agent-studio.

## Commands

| Command | Usage |
|---------|-------|
| `send` | Send notification `--to=<userId> --type=<info/warning/alert> --message=<text>` |
| `list` | List notifications `--user=<id> --unread` |
| `mark` | Mark as read `--notification=<id> [--all]` |

## Usage

```bash
npx @agent-studio/notification send --to=1 --type=info --message="Hello"
npx @agent-studio/notification list --user=1 --unread
npx @agent-studio/notification mark --notification=1
```