---
id: ARC-015
type: architecture
title: Deep Analysis Detection Hooks
maturity: verified
layer: tech
created: '2026-05-22T13:17:56.529Z'
lastReferenced: ''
contributors: []
projects: []
tags:
  - deep-analysis-detection
  - design-doc
applicablePhases: []
sourceReferences:
  - workflow: design:claude:deep-analysis-detection
    timestamp: '2026-05-22T13:17:56.545Z'
referencedBy: []
---

# Deep Analysis Detection Hooks

## Problem
Claude Code performs deep analysis (pipeline audit, architecture review) but no knowledge is captured. KnowledgeSync only auto-captures when Analyst agent completes — Claude Code analysis has no bridge to KnowledgeSync.

## Solution
Two PostToolUse + Stop hooks detect deep analysis by behavioral patterns (not hard thresholds):

| Signal | Meaning | Detection |
|--------|---------|-----------|
| EnterPlanMode called | Explicit plan declaration | PostToolUse(EnterPlanMode) |
| Agent(Explore) spawned | Delegated codebase exploration | PostToolUse(Agent, subagent_type=Explore) |
| Read across 10+ unique dirs | Structural evidence of broad analysis | PostToolUse(Read) → count unique dirs |

Any signal hits AND no Write to `.harness/knowledge-docs/` → Stop hook warns.

## Files
- harness/bin/harness-knowledge-track.js — PostToolUse hook, writes state to /tmp/claude-knowledge-capture-state.json
- harness/bin/harness-knowledge-check.js — Stop hook, reads state, outputs systemMessage if needed, cleans up
- ~/.claude/settings.json — hook registration (PostToolUse matcher: EnterPlanMode|Agent|Read|Write, Stop)

## Design Principles
- Zero LLM cost (pure file I/O)
- <5ms per PostToolUse trigger
- Zero false positives (EnterPlanMode and Agent(Explore) are explicit user intent)
- State file auto-cleaned on Stop
- No dependency on Studio API (works when API is down)
