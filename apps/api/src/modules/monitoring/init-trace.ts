/**
 * ⑨: Trace pipeline initialization
 *
 * Wire harness TraceCollector + TraceAnalyzer into the execution flow.
 * Previously these were only accessible via REST endpoint — never auto-analyzed.
 */

import { getTraceCollector } from '@dommaker/harness';
import { tracePipeline } from './trace-pipeline.service';

let initialized = false;

export async function initTracePipeline(): Promise<void> {
  if (initialized) return;

  try {
    // Dynamically import harness (TraceAnalyzer is a named export)
    const harness = await import('@dommaker/harness');

    const collector = getTraceCollector();
    const analyzer = new harness.TraceAnalyzer(collector);

    tracePipeline.setCollector(collector);
    tracePipeline.setAnalyzer(analyzer);

    initialized = true;
    console.log('[TracePipeline] Initialized — auto-analysis enabled');
  } catch (err) {
    console.warn('[TracePipeline] Init failed (non-blocking):', (err as Error).message);
  }
}
