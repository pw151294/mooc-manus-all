# M3 任务管理 E2E 验证

**对应规格**：`../specs/eval-modules/M3-task-management-spec.md`
**依赖 E2E 已通过**：M1-infrastructure-e2e；(M2 推荐已通过)

---

## 1. 前置条件

- M1 已交付、后端联通
- 数据库中至少 2 个用例（可用 M2 创建，或直接调 API 造）
- 后端至少配置 3 个 Agent Config
- 前端 dev server 已启动
- 浏览器 Network / Console 已打开

---

## 2. 验证清单

### 2.1 任务列表基础

- [ ] 访问 `/eval/tasks` → 页面渲染任务表格
- [ ] 列表列显示正确：名称 / 状态 Tag / 进度 / 3 个时间 / 操作
- [ ] 空状态：清空任务后显示 antd Empty
- [ ] 分页控件正常，`showSizeChanger` 可切换 pageSize

### 2.2 创建任务（TaskCreateModal）

- [ ] 点「创建任务」→ Modal 打开
- [ ] Modal 打开时后台立即调 `listCases({page:1,size:100})` + `listAgentConfigs()`（Network 面板确认）
- [ ] 双 Transfer 正确渲染：
  - 左侧列出全部用例（title 为 case.name）
  - 右侧列出全部 Agent（title 格式 `${provider} - ${model_name}`）
- [ ] Transfer 支持搜索（输入关键词过滤）
- [ ] 选择 2 个用例 + 3 个 Agent → 底部 Alert 显示"将创建 2 × 3 = 6 个实例"
- [ ] 修改选择 → Alert 数量实时更新
- [ ] **提交按钮 disabled 逻辑**：
  - taskName 为空 → disabled
  - 未选任何用例 → disabled
  - 未选任何 Agent → disabled
  - 三者齐备 → enabled
- [ ] 点「创建」→ Modal 关闭、任务列表刷新、新任务出现（status=PENDING）
- [ ] 新任务状态短暂 PENDING → RUNNING（后端处理速度依赖）

### 2.3 智能轮询（5 秒）

- [ ] **有 RUNNING 任务时轮询启动**：
  - 存在 RUNNING 任务 → Network 面板每 5s 一次 `GET /api/eval/tasks`（可能带 status 查询）
- [ ] **状态动态更新**：
  - 观察 RUNNING 任务的进度数字（succeeded_count / total_count）在轮询后动态变化
  - 状态最终变为 SUCCEEDED / FAILED
- [ ] **全终态自动停止**：
  - 所有任务终态后 → 下一次轮询后自动停止
  - Network 面板 30s 内无新 `GET /api/eval/tasks` 请求
- [ ] **离开页面停止**：
  - 有 RUNNING 任务时点侧边栏「用例管理」→ 跳转 `/eval/cases`
  - Network 面板 30s 内无新任务请求
  - 返回 `/eval/tasks` → 轮询重启

### 2.4 状态过滤器

- [ ] Radio.Group 显示：全部 / 待执行 / 运行中 / 已完成 / 失败（5 个按钮）
- [ ] 选「运行中」→ 只显示 RUNNING 任务
- [ ] 选「已完成」→ 只显示 SUCCEEDED 任务
- [ ] 选「失败」→ 只显示 FAILED 任务
- [ ] 选「全部」→ 显示所有状态
- [ ] 切换过滤时 page 应重置为 1

### 2.5 任务表格 UI

- [ ] **状态 Tag 颜色**：
  - PENDING → blue
  - RUNNING → processing（动画点）
  - SUCCEEDED → success（绿）
  - FAILED → error（红）
- [ ] **进度列**：显示"成功 X / 失败 Y / 运行中 Z / 总计 N"
- [ ] **时间列**：格式化为 `YYYY-MM-DD HH:mm`，空值显示 `--`
- [ ] **行点击**：点表格行任意区域（除操作按钮）→ 跳转 `/eval/tasks/:id`
- [ ] **A11y**：行 focus 状态可见，Enter 键可触发跳转

### 2.6 删除任务

- [ ] 点某任务的「删除」按钮 → antd Modal.confirm 弹出
- [ ] 点「确定」→ 列表刷新、任务消失、toast 成功
- [ ] 点「取消」→ 任务保留
- [ ] **RUNNING 任务删除**：
  - 尝试删除 RUNNING 任务 → 后端可能返回 409（若不允许）
  - 前端 toast 错误消息，任务保留

### 2.7 重试任务

- [ ] FAILED 任务点「重试」→ 调 `retryTask` → 返回 `{retried_count: N}`
- [ ] 前端 toast 显示"已重试 N 个实例"或类似文案
- [ ] 任务列表刷新，状态可能重新变为 RUNNING、开始新一轮轮询

### 2.8 分页

- [ ] 造 25+ 任务 → 分页控件工作正常
- [ ] 切换 pageSize=50 → page 重置为 1
- [ ] 过滤后翻页 → 修改过滤 → page 回 1

### 2.9 网络异常

- [ ] 断开网络 → loading 显示、恢复后自动恢复
- [ ] Console 无未捕获异常

---

## 3. 通过标准

- 2.1 ~ 2.9 全部勾选
- 智能轮询启停行为准确可观察
- Transfer 支持搜索、M×N 预览实时更新

---

## 4. 已知限制

- 用例数量 >100 时 `listCases({page:1,size:100})` 只加载前 100 条（父规格 §11.3 未来扩展）
- 无任务编辑功能（后端无 API）

---

**E2E 版本**：v1.0
