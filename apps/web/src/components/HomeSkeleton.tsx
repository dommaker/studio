// HomeSkeleton - 首页骨架屏
export function HomeSkeleton() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-6">
      {/* 顶部统计卡片骨架 */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        {[1, 2, 3].map((i) => (
          <div key={i} className="animate-pulse bg-white dark:bg-gray-800 rounded-lg p-4">
            <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/2 mb-2"></div>
            <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-3/4"></div>
          </div>
        ))}
      </div>
      
      {/* 空间卡片网格骨架 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="animate-pulse bg-white dark:bg-gray-800 rounded-lg p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-gray-200 dark:bg-gray-700 rounded-lg"></div>
              <div className="flex-1">
                <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/2 mb-2"></div>
                <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-3/4"></div>
              </div>
            </div>
            <div className="flex gap-2">
              <div className="h-6 bg-gray-200 dark:bg-gray-700 rounded w-16"></div>
              <div className="h-6 bg-gray-200 dark:bg-gray-700 rounded w-16"></div>
            </div>
          </div>
        ))}
      </div>
      
      {/* 底部输入框骨架 */}
      <div className="mt-6 animate-pulse">
        <div className="h-20 bg-gray-200 dark:bg-gray-700 rounded-lg"></div>
      </div>
    </div>
  );
}
