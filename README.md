# @dommaker/studio

**Multi-Agent AI Pipeline Platform** — Goals in, deliverables out. Humans approve, agents execute.

```
Analyst → Executor → Reviewer → Deploy
                          ↓
                   Knowledge Agent
```

---

## Quick Start

```bash
git clone https://github.com/dommaker/studio.git
cd studio
pnpm install && studio up
```

**Ports**: API `http://localhost:3001` | SSE `/api/v1/events/stream` | CLI `studio`

---

## Key Features

| Feature | Description |
|---------|-------------|
| **8-Agent Pipeline** | Analyst → Planner → Executor → Reviewer → Deploy → Knowledge → Monitor → Auditor, full lifecycle autonomy |
| **PMO / OKR** | Goal-driven execution, OKR tracking, progress dashboards, auto-summaries |
| **Harness Constraints** | 10 Iron Laws enforced via `@dommaker/harness`, no-bypass guardrails for all agent operations |
| **MCP Tools** | 32 JSON-RPC 2.0 tools, HTTP + REST, exposed as Model Context Protocol server |
| **Discord Integration** | Slash commands, real-time notifications, tmux bridge, channel-based interaction |
| **Knowledge Engine** | Automated knowledge extraction (KK), 3-tier evolution, gap coverage (G-001~005) |
| **CLI** | 25 commands via `studio` — service mgmt, pipeline, db, approval, project management |
| **Auditor** | Daily audit, auto-recommendations, EvalCase flywheel for continuous improvement |

### Stack

**Runtime**: Node.js, SQLite (Prisma), EventEmitter, SSE push
**Agent isolation**: git worktree + async spawn + `.progress.json`
**Testing**: vitest

---

## Architecture

See [CLAUDE.md](CLAUDE.md) for pipeline flow, agent topology, state machine, and API design.

### Packages

| Package | Purpose |
|---------|---------|
| studio-shared | Logger, LLM client, EventBus, harness wrapper |
| studio-prisma | Prisma schema + client (SQLite) |
| studio-agent | AgentExecutor — spawn session loop |
| studio-task | TaskQueue + TaskWorker |
| studio-spec | GateChecker + change analysis + Spec validation |
| studio-audit | Audit log service |
| studio-monitor | Health monitoring |
| studio-notification | Notification service |
| studio-capability | Capability/skill pool management |

---

## License

MIT © dommaker
