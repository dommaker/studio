/**
 * API 层验证器
 * 
 * 检查项：
 * - endpoint.path 格式（以 / 开头）
 * - endpoint.method 有效（GET/POST/PUT/DELETE）
 * - schema 定义完整
 */

import type {
  SpecContent,
  ApiValidationResult,
  CheckResult,
} from '../types/validation.types.js';

// 有效 HTTP 方法
const VALID_HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

export class ApiValidator {
  /**
   * 验证 Spec API 层
   */
  async validate(spec: SpecContent): Promise<ApiValidationResult> {
    const checks: CheckResult[] = [];
    const invalidEndpoints: string[] = [];
    const missingSchemas: string[] = [];

    if (!spec.api?.endpoints) {
      // 无 API 定义，视为通过
      return {
        valid: true,
        checks: [{
          checkId: 'api-no-endpoints',
          description: '无 API endpoint 定义',
          passed: true,
          message: 'Spec 未定义 API endpoints',
        }],
        invalidEndpoints: [],
        missingSchemas: [],
      };
    }

    // 收集已定义的 schemas
    const definedSchemas = spec.api.schemas ? Object.keys(spec.api.schemas) : [];

    // 检查每个 endpoint
    for (const endpoint of spec.api.endpoints) {
      // 检查 path 格式
      const pathValid = endpoint.path.startsWith('/');
      checks.push({
        checkId: `api-path-${endpoint.path}`,
        description: `检查 endpoint path 格式`,
        passed: pathValid,
        message: pathValid ? undefined : `endpoint path 应以 / 开头: ${endpoint.path}`,
        location: pathValid ? undefined : `api.endpoints.${endpoint.path}.path`,
      });

      if (!pathValid) {
        invalidEndpoints.push(endpoint.path);
      }

      // 检查 method 有效
      const methodValid = VALID_HTTP_METHODS.includes(endpoint.method.toUpperCase());
      checks.push({
        checkId: `api-method-${endpoint.path}`,
        description: `检查 endpoint method 有效`,
        passed: methodValid,
        message: methodValid ? undefined : `无效 HTTP method: ${endpoint.method}`,
        location: methodValid ? undefined : `api.endpoints.${endpoint.path}.method`,
      });

      if (!methodValid) {
        invalidEndpoints.push(endpoint.path);
      }

      // 检查 request schema 存在
      if (endpoint.request) {
        const requestSchemaExists = definedSchemas.includes(endpoint.request);
        checks.push({
          checkId: `api-request-${endpoint.request}`,
          description: `检查 request schema 存在`,
          passed: requestSchemaExists,
          message: requestSchemaExists ? undefined : `缺失 request schema: ${endpoint.request}`,
          location: requestSchemaExists ? undefined : `api.endpoints.${endpoint.path}.request`,
        });

        if (!requestSchemaExists) {
          missingSchemas.push(endpoint.request);
        }
      }

      // 检查 response schema 存在
      if (endpoint.response) {
        const responseSchemaExists = definedSchemas.includes(endpoint.response);
        checks.push({
          checkId: `api-response-${endpoint.response}`,
          description: `检查 response schema 存在`,
          passed: responseSchemaExists,
          message: responseSchemaExists ? undefined : `缺失 response schema: ${endpoint.response}`,
          location: responseSchemaExists ? undefined : `api.endpoints.${endpoint.path}.response`,
        });

        if (!responseSchemaExists) {
          missingSchemas.push(endpoint.response);
        }
      }
    }

    const valid = invalidEndpoints.length === 0 && missingSchemas.length === 0;

    return {
      valid,
      checks,
      invalidEndpoints,
      missingSchemas,
    };
  }
}