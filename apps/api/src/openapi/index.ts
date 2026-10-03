/**
 * openapi/index.ts — /api/docs 挂载（Phase 0 删掉的死链原址复活）。
 *
 * GET /api/docs     → OpenAPI 3.0.3 JSON（contract zod schema 派生，启动后首次请求时构建并缓存）
 * GET /api/docs/ui  → Swagger UI（CDN 静态页，不引重依赖；helmet CSP 已关，CDN 可用）
 *
 * 端点源 = route-registry 路由表 + defineRoute meta（discover.ts），schema 源 = contract。
 */

import type { Express } from 'express';
import type { RouteEntry } from '../route-registry.js';
import { discoverRoutes } from './discover.js';
import { buildOpenApiDocument } from './build.js';

const SWAGGER_UI_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>Studio API Docs</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.onload = () => {
      window.ui = SwaggerUIBundle({ url: '/api/docs', dom_id: '#swagger-ui' });
    };
  </script>
</body>
</html>
`;

export function mountApiDocs(app: Express, table: RouteEntry[]): void {
  let cachedJson: string | null = null;
  app.get('/api/docs', (_req, res) => {
    if (!cachedJson) {
      const { routes, skipped } = discoverRoutes(table);
      cachedJson = JSON.stringify(buildOpenApiDocument(routes, skipped));
    }
    res.type('application/json').send(cachedJson);
  });
  app.get('/api/docs/ui', (_req, res) => {
    res.type('html').send(SWAGGER_UI_HTML);
  });
}
