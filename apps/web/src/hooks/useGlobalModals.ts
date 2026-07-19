/**
 * 全局弹窗状态 hook
 * - showResult, selectedProject
 * - handleViewDetails
 */
import { useState } from 'react';
import type { ExecutionState } from '../types';

export function useGlobalModals() {
  const [showResult, setShowResult] = useState(false);
  const [selectedProject, setSelectedProject] = useState<any>(null);

  const handleViewDetails = (execution: ExecutionState) => {
    let projectDir = null;
    let projectName = null;

    if (execution.input) {
      const trimmedInput = execution.input.trim();
      if (trimmedInput.startsWith('{') || trimmedInput.startsWith('[')) {
        try {
          const inputObj = typeof execution.input === 'string'
            ? JSON.parse(execution.input)
            : execution.input;
          projectDir = inputObj.project_dir || inputObj.projectDir || inputObj.project_path;
          projectName = inputObj.project_name || inputObj.projectName;
        } catch {
          // not JSON, treat as plain text
        }
      }
    }

    if (projectDir) {
      setSelectedProject({
        id: execution.id,
        name: projectName || projectDir.split('/').pop() || '未命名项目',
        path: projectDir,
        createdAt: execution.startedAt || new Date().toISOString(),
        updatedAt: execution.completedAt || new Date().toISOString(),
      });
      return;
    }

    setSelectedProject({
      id: execution.id,
      name: `执行 ${execution.id.slice(0, 8)}`,
      path: `/tmp/executions/${execution.id}`,
      createdAt: execution.startedAt || new Date().toISOString(),
      updatedAt: execution.completedAt || new Date().toISOString(),
    });
  };

  return {
    showResult,
    setShowResult,
    selectedProject,
    setSelectedProject,
    handleViewDetails,
  };
}
