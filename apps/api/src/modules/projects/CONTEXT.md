# apps/api/src/modules/projects

### 职责

Project Discovery（AC-D1 + AC-D3）：发现已注册的工程（repo）信息并对外提供查询 API，供频道默认工程、WorkUnit 工程绑定等流程使用。

### 核心导出

- `project-discovery.service.ts` — Project Discovery Service（AC-D1+D3；#266 排除清单分层来源 + PMO 绑定排序）
- `project-exclude-config.ts` — #266（决策 #258）归属候选排除清单读写（`projects-exclude.json`，load 失败降级空清单）
- `project.routes.ts` — Project Discovery API（AC-D3；#266 GET/PUT `/exclude` 排除清单 CRUD）

### 依赖关系

- 上游：workspaces 模块的工程注册数据（FileStore）
- 下游：apps/api 路由挂载；UI/频道派发流程查询工程列表

### 注意事项

- 只读发现层，不负责工程注册（注册在 workspaces 模块）
- **工程即叶子（2026-07-29）**：命中标记（CLAUDE.md / package.json / .git）的目录不再递归内部 —— monorepo 只列根目录，子包不重复出现；非工程中间目录（分组目录、无标记 packages/）仍继续下钻
- **D6 排除清单（第一层，2026-07-27）**：env `STUDIO_PROJECTS_EXCLUDE`（冒号分隔）或构造参数 `exclude` —— 规则命中目录名（精确）或绝对路径（目录边界前缀，不误伤同名前缀目录）即跳过且不递归
- **#266 排除清单分层来源（决策 #258，2026-08-20）**：优先级 `options.exclude` > env `STUDIO_PROJECTS_EXCLUDE`（部署级覆盖）> `~/.studio/projects-exclude.json`（设置页「工程候选管理」管理，GET/PUT `/api/v1/projects/exclude`，PUT 后主动 `invalidateCache` 即时生效）；配置文件每次 `discover` 缓存刷新时重读，损坏降级空清单不炸
- **#266 候选兜底排序**：`discover()` 结果稳定排序——已绑定 PMO（`~/.studio/projects/*.json` 的 gitRepo + deliveries[].gitRepo，缺省来源可经 `options.boundPaths` 注入）的工程排前，纯扫描发现的排后
- **鉴权（2026-07-29 放宽）**：/api/v1/projects 挂载层为 requireAuth（登录即可；PMO 新建表单的工程下拉依赖 GET /discover）。曾收 requireAuth+requireAdmin（2026-07-24，顾虑：扫描服务器目录、回显绝对路径），但非 admin 部署下 PMO 新建不可用，故放宽。
