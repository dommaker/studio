/**
 * B59-001: OKR metrics API endpoints
 *
 * AC-1: GET /okr/metrics — returns all metric actuals
 * AC-2: GET /okr/data-health — returns data source health
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROUTES_PATH = path.resolve(__dirname, '../routes.ts');
const routesSource = fs.readFileSync(ROUTES_PATH, 'utf-8');

describe('GET /okr/metrics endpoint (AC-1)', () => {
  it('route handler exists', () => {
    expect(routesSource).toContain("router.get('/okr/metrics'");
  });

  it('calls okrService.getMetricBaseline for each registered metricType', () => {
    // Extract the handler body between the route definition and the next router.get/route.post
    const handlerMatch = routesSource.match(
      /router\.get\('\/okr\/metrics'[\s\S]*?(?=\nrouter\.|\nexport)/,
    );
    expect(handlerMatch).toBeTruthy();
    const body = handlerMatch![0];
    expect(body).toContain('getMetricBaseline');
  });

  it('returns data keyed by metricType with value/status/description', () => {
    const handlerMatch = routesSource.match(
      /router\.get\('\/okr\/metrics'[\s\S]*?(?=\nrouter\.|\nexport)/,
    );
    expect(handlerMatch).toBeTruthy();
    const body = handlerMatch![0];
    // Must return an object with metrics data
    expect(body).toContain('res.json');
    // Must include METRIC_REGISTRY iteration
    expect(body).toContain('METRIC_REGISTRY');
  });

  it('supports ?days= query parameter', () => {
    const handlerMatch = routesSource.match(
      /router\.get\('\/okr\/metrics'[\s\S]*?(?=\nrouter\.|\nexport)/,
    );
    expect(handlerMatch).toBeTruthy();
    const body = handlerMatch![0];
    expect(body).toContain('days');
  });
});

describe('GET /okr/data-health endpoint (AC-2)', () => {
  it('route handler exists', () => {
    expect(routesSource).toContain("router.get('/okr/data-health'");
  });

  it('calls okrService.checkDataSourceHealth', () => {
    const handlerMatch = routesSource.match(
      /router\.get\('\/okr\/data-health'[\s\S]*?(?=\nrouter\.|\nexport)/,
    );
    expect(handlerMatch).toBeTruthy();
    const body = handlerMatch![0];
    expect(body).toContain('checkDataSourceHealth');
  });

  it('returns data source health + registry coverage summary', () => {
    const handlerMatch = routesSource.match(
      /router\.get\('\/okr\/data-health'[\s\S]*?(?=\nrouter\.|\nexport)/,
    );
    expect(handlerMatch).toBeTruthy();
    const body = handlerMatch![0];
    expect(body).toContain('res.json');
    // Must include METRIC_REGISTRY for coverage summary
    expect(body).toContain('METRIC_REGISTRY');
  });
});
