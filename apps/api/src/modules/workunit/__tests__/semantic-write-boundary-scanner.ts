import * as ts from 'typescript';

export interface SemanticWriteViolation {
  kind: 'updateMetadata' | 'repository.mutate';
  line: number;
}

type WriteKind = SemanticWriteViolation['kind'];

const SEMANTIC_COMMAND_FILES = [
  'modules/workunit/execution-journal.ts',
  'modules/workunit/derivation-ledger.ts',
  'modules/workunit/trace-link.ts',
  'modules/workunit/waiting-gate.ts',
];

const SEMANTIC_SERVICE_RECEIVERS = new Set([
  'svc',
  'service',
  'wuService',
  'workUnitService',
  'getWorkUnitService()',
  'getService()',
  'this.workUnitService',
]);

function calledName(call: ts.CallExpression): string | null {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
  return null;
}

function methodReference(expression: ts.Expression): { name: string; receiver: ts.Expression } | null {
  if (ts.isPropertyAccessExpression(expression)) {
    return { name: expression.name.text, receiver: expression.expression };
  }
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)) {
    return { name: expression.argumentExpression.text, receiver: expression.expression };
  }
  return null;
}

function isSemanticServiceExpression(
  expression: ts.Expression,
  sourceFile: ts.SourceFile,
  serviceAliases: ReadonlySet<string>,
): boolean {
  const receiver = expression.getText(sourceFile).replace(/\s+/g, '');
  return SEMANTIC_SERVICE_RECEIVERS.has(receiver) || serviceAliases.has(receiver);
}

/** 扫描物理 metadata mutator 与窄 repository 的越域直接使用；语义 patch 调用不算违规。 */
export function findSemanticWriteViolations(source: string, fileName: string): SemanticWriteViolation[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const normalizedFile = fileName.replaceAll('\\', '/');
  const commandFile = SEMANTIC_COMMAND_FILES.some(suffix => normalizedFile.endsWith(suffix));
  const violations: SemanticWriteViolation[] = [];
  const physicalBindings = new Map<string, WriteKind>();
  const serviceUpdateBindings = new Set<string>();
  const serviceAliases = new Set<string>();

  const bindMethod = (localName: string, importedName: string, initializer: ts.Expression): void => {
    if (importedName !== 'updateMetadata' && importedName !== 'mutate') return;
    const kind: WriteKind = importedName === 'mutate' ? 'repository.mutate' : 'updateMetadata';
    if (importedName === 'updateMetadata' && isSemanticServiceExpression(initializer, sourceFile, serviceAliases)) {
      physicalBindings.delete(localName);
      serviceUpdateBindings.add(localName);
    } else {
      serviceUpdateBindings.delete(localName);
      physicalBindings.set(localName, kind);
    }
  };

  const bindValue = (localName: string, initializer: ts.Expression): void => {
    if (isSemanticServiceExpression(initializer, sourceFile, serviceAliases)) {
      serviceAliases.add(localName);
    }
    const method = methodReference(initializer);
    if (method) bindMethod(localName, method.name, method.receiver);
  };

  const collectBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        bindValue(node.name.text, node.initializer);
      } else if (ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (!ts.isIdentifier(element.name)) continue;
          const importedName = element.propertyName && ts.isIdentifier(element.propertyName)
            ? element.propertyName.text
            : element.name.text;
          bindMethod(element.name.text, importedName, node.initializer);
        }
      }
    } else if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)) {
      bindValue(node.left.text, node.right);
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(sourceFile);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calledName(node);
      const boundKind = name ? physicalBindings.get(name) : undefined;
      const kind = name === 'mutate'
        ? 'repository.mutate'
        : name === 'updateMetadata' ? 'updateMetadata' : boundKind;
      if (kind === 'repository.mutate' && !commandFile) {
        violations.push({
          kind,
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        });
      } else if (kind === 'updateMetadata' && node.arguments.length >= 2) {
        const patch = node.arguments[1];
        const functionMutator = ts.isArrowFunction(patch) || ts.isFunctionExpression(patch);
        const expression = node.expression;
        const semanticService = (name ? serviceUpdateBindings.has(name) : false)
          || ((ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
            && isSemanticServiceExpression(expression.expression, sourceFile, serviceAliases));
        if (functionMutator || (!ts.isObjectLiteralExpression(patch) && !semanticService)) {
          violations.push({
            kind,
            line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return violations;
}
