# Performance scripts (manual use only)

This directory is **not** wired into any npm script or the vitest workspace —
nothing here runs in CI. The files are standalone baselines/stress harnesses
(`performance-baseline.ts`, `stress-test.ts`) meant to be executed by hand
against a running environment, e.g. `npx tsx tests/performance/stress-test.ts`.
Treat their numbers as ad-hoc measurements, not regression gates.
