# M2 用例管理规格

**父规格**：`docs/superpowers/specs/2026-07-17-eval-platform-frontend-design.md`（§7.1）
**依赖模块**：M1（类型、API、evalCase store、路由占位）
**下游模块**：M3（推荐但非强制，任务创建时的用例 Transfer 数据来自用例列表）

---

## 1. 目标

在 `/eval/cases` 页面实现评测用例的完整 CRUD 交互：创建、编辑、查看、删除、列表过滤、脚本文件上传。

**验收目标**：
- 5 个组件文件全部产出，页面组装可用
- 3 种脚本输入方式（上传/编辑/上传后编辑）均可提交
- 列表支持按 name / tags 过滤，支持分页
- 409 冲突（用例被活动任务引用）的错误 toast 正确显示

---

## 2. 范围

### 2.1 in-scope

| 文件 | 说明 |
|---|---|
| `src/pages/Eval/Cases/index.tsx` | 页面容器（组装 Filters + Table + Modals） |
| `src/pages/Eval/Cases/CaseTable.tsx` | 用例表格（分页、操作列） |
| `src/pages/Eval/Cases/CaseFormModal.tsx` | 创建/编辑 Modal（3 个 script 字段 Tabs） |
| `src/pages/Eval/Cases/CaseDetailDrawer.tsx` | 只读详情 Drawer |
| `src/pages/Eval/Cases/ScriptInput.tsx` | 脚本输入组件（上传/编辑双 Tab） |

### 2.2 out-of-scope

- 任务管理（M3）、任务详情（M4）
- 用例创建后自动创建任务的引导（不做，属未来扩展）

---

## 3. 详细设计

### 3.1 `Cases/index.tsx` — 页面容器

**布局**（详见父规格 §7.1.1）：
- 顶部操作栏：`Input.Search`（name_like）+ `Select mode="tags"`（tags 过滤）+ 「创建用例」按钮
- 中部：`CaseTable`
- 弹层：`CaseFormModal`（受控 open）+ `CaseDetailDrawer`（受控 caseId）

**生命周期**：
```typescript
useEffect(() => {
  evalCase.fetchCases();
}, []);
```

**关键交互**：
- 搜索 / tags 过滤 → 调 `evalCase.applyFiltersAndFetch({ nameLike, tags })`（内部会 reset page）
- 表格行点击名称 → 打开 `CaseDetailDrawer`
- 编辑按钮 → 复用 `CaseFormModal` 的 mode="edit" + 传入 initial data
- 删除按钮 → antd `Modal.confirm` → 调 `evalCase.deleteCase(id)`

---

### 3.2 `CaseTable.tsx` — 用例表格

**列定义**（详见父规格 §7.1.2）：

| 列 | 数据源 | 渲染 | 宽度 |
|---|---|---|---|
| 名称 | `name` | 纯文本，点击打开详情 Drawer | 200 |
| 描述 | `description` | 省略超长，Tooltip 悬停显示 | 300 |
| 标签 | `tags` | `tags.map(t => <Tag>{t}</Tag>)` | 200 |
| 创建时间 | `created_at` | `dayjs(...).format('YYYY-MM-DD HH:mm')` | 180 |
| 操作 | - | 查看/编辑/删除 3 个按钮 | 150 |

**分页**：`showSizeChanger` + pageSizeOptions=`['10','20','50']`，`onChange` 时同步 store。

**空状态**：`dataSource=[]` 时 antd 自动显示 Empty；也可自定义 description="暂无用例"。

---

### 3.3 `CaseFormModal.tsx` — 创建/编辑表单

**外层字段**（详见父规格 §7.1.3）：
- `name`：`Input`（必填，maxLength 建议 100）
- `description`：`TextArea` rows=3（可选）
- `tags`：`Select mode="tags"`（自由输入，可选）

**内层 Tabs**（3 个脚本字段各占一个 Tab）：
- Init Script（可选）
- Task Prompt（必填）
- Verify Script（必填）

每个 Tab 内部渲染 `<ScriptInput value={...} onChange={...} required={...} />`。

**Modal 配置**：
- `width={800}`
- `bodyStyle={{ maxHeight: '70vh', overflow: 'auto' }}`
- 底部「取消」/「提交」按钮

**提交逻辑**：
- mode="create" → `evalCase.createCase(formData)` → 成功后 `fetchCases()` + 关闭 Modal
- mode="edit" → `evalCase.updateCase(id, dirtyFields)` → 只传变更字段（利用 Axios undefined 过滤）

---

### 3.4 `ScriptInput.tsx` — 脚本输入组件（关键组件）

**双 Tab 结构**（详见父规格 §7.1.4）：

**Tab 1「上传文件」**：
- `Upload.Dragger`
- `accept=".txt,.sh,.py,.md"`
- `beforeUpload`：> 10MB → `message.error('文件大小不能超过 10MB')` + 返回 `Upload.LIST_IGNORE`
- `customRequest`：调 `uploadContent(file)` → `onChange(content)` 回填内容 → 自动切到「直接编辑」Tab
- 拖拽区显示 `InboxOutlined` icon + 提示文案

**Tab 2「直接编辑」**：
- `Input.TextArea rows={20}`
- `style={{ fontFamily: 'monospace', fontSize: 13 }}`
- placeholder：`在此输入或粘贴脚本内容...`

**Props**：
```typescript
interface ScriptInputProps {
  value: string;
  onChange: (val: string) => void;
  label: string;
  required?: boolean;
}
```

**关键行为**：
- 上传成功 → 自动切到「直接编辑」Tab，用户可在此追加/修改
- required=true 时，label 上加红色 `*`

---

### 3.5 `CaseDetailDrawer.tsx` — 只读详情

**布局**（详见父规格 §7.1.5）：
- 顶部：`Descriptions` 展示名称/创建时间/描述/标签
- 中部：Tabs 展示 3 个脚本字段（`TextArea disabled` + monospace 字体）
- 底部：「关闭」+「编辑」按钮

**数据加载**：
```typescript
useEffect(() => {
  if (!caseId || !open) return;
  getCase(caseId).then(setCaseData);
}, [caseId, open]);
```

`Drawer width={720}`。

---

## 4. 交互流程串接

### 4.1 创建用例
1. 点顶部「创建用例」→ CaseFormModal 打开（mode="create"）
2. 填 name / description / tags → Tabs 内每个脚本可选上传或直接编辑
3. 点「提交」→ `createCase` → 成功后 `fetchCases()` + 关闭 Modal + `message.success`

### 4.2 编辑用例
1. 点表格行「编辑」→ CaseFormModal 打开（mode="edit"，initial data 从行 record 或 `getCase` 拉取）
2. 修改任意字段 → 点「提交」→ `updateCase(id, dirtyFields)`

### 4.3 删除用例
1. 点表格行「删除」→ `Modal.confirm({ title: '确认删除？' })`
2. 确认 → `deleteCase(id)`
3. 若 409：`request.ts` 拦截器已 toast，UI 无需额外逻辑；列表不刷新（用例仍存在）
4. 若 204：`fetchCases()` 刷新列表

### 4.4 查看详情
1. 点表格行名称 → CaseDetailDrawer 打开
2. 内部拉取 `getCase(id)` 显示最新数据
3. 底部「编辑」→ 关闭 Drawer + 打开 CaseFormModal(mode="edit")

---

## 5. 与父规格的对齐

- 组件粒度、Props、Tab 结构完全对齐父规格 §7.1
- 无新依赖（TextArea 不换 Monaco）
- 与 Trace 模块表格/Modal 模式一致

---

## 6. 验收标准

见 `M2-case-management-e2e.md`。核心场景：
- 3 种脚本输入方式均能提交成功
- 列表过滤、分页、pageSize 切换正常
- 409 冲突场景（被活动任务引用时）正确显示错误 toast
- 10MB 文件上传前置拦截

---

**规格版本**：v1.0
**依赖**：M1
**预估工作量**：4 ~ 5 天
