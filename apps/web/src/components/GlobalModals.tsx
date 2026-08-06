/**
 * 全局弹窗组件
 * - ProjectDetailModal
 */
import { ProjectDetail } from './ProjectDetail';

interface GlobalModalsProps {
  selectedProject: any;
  onCloseProject: () => void;
}

export function GlobalModals({
  selectedProject,
  onCloseProject,
}: GlobalModalsProps) {
  return (
    <>
      {selectedProject && (
        <ProjectDetail project={selectedProject} onClose={onCloseProject} />
      )}
    </>
  );
}
