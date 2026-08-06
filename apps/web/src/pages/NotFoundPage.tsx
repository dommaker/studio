// 404 页面 - 路由表兜底（未匹配路径）
import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <div className="h-full flex flex-col items-center justify-center" style={{ background: 'var(--bg-primary)' }}>
      <div className="text-6xl mb-4">🔍</div>
      <h1 className="page-title">404</h1>
      <p className="page-subtitle mb-6">页面不存在或已被移除</p>
      <Link to="/" className="btn btn-primary">返回首页</Link>
    </div>
  );
}

export default NotFoundPage;
