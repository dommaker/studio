// 404 页面 - 路由表兜底（未匹配路径）
// 批次 F-4：🔍 emoji → ui/icons SVG（#474 图标策略，empty-icon 装饰容器）
import { Link } from 'react-router-dom';
import { IconSearch } from '../components/ui/icons';

export function NotFoundPage() {
  return (
    <div className="h-full flex flex-col items-center justify-center u-page-bg">
      <div className="empty-icon"><IconSearch size={48} /></div>
      <h1 className="page-title">404</h1>
      <p className="page-subtitle mb-6">页面不存在或已被移除</p>
      <Link to="/" className="btn btn-primary">返回首页</Link>
    </div>
  );
}

export default NotFoundPage;
