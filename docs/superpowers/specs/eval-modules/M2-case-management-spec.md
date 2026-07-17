# M2 用例管理模块规格文档

**父规格**：`docs/superpowers/specs/2026-07-17-eval-platform-frontend-design.md`
**模块编号**：M2
**依赖**：M1（types + api/modules/eval.ts + store/evalCase.ts + 路由占位）
**被依赖**：M3（任务创建 Modal 需要用例列表，但独立调 API 不走 store）

---

## 1. 模块范围

实现评测用例的 CRUD 全流程，替换 M1 的 `/eval/cases` 路由占位。

### 1.1 交付物

5 个组件（`src/pages/Eval/Cases/`）：
- `index.tsx` — 页面容器（过滤器 + 组装）
- `CaseTable.tsx` — 用例表格（分页、操作列）
- `CaseFormModal.tsx` — 创建/编辑 Modal（顶部字段 + 3 个脚本 Tabs）
- `CaseDetailDrawer.tsx` — 只读详情 Drawer
- `ScriptInput.tsx` — 脚本输入组件（上传/编辑双 Tab）

修改 1 处：
- `router/index.tsx` — 将 `/eval/cases` 占位替换为 `<EvalCasesPage />`

### 1.2 非目标

- 不涉及任务/实例（属 M3、M4）
- 不涉及 Trace 跳转（属 M5）
- 不做用例 tag 的中央管理（tag 用 antd `Select mode="tags"` 自由输入）

---

## 2. 组件设计

### 2.1 `ScriptInput.tsx`（脚本输入组件）

**Props**：
```typescript
interface ScriptInputProps {
  value: string;
  onChange: (val: string) => void;
  label?: string;
  required?: boolean;
  readOnly?: boolean;  // 详情 Drawer 用
}
```

**内层双 Tab 结构**：
- Tab 1「上传文件」：`Upload.Dragger` + `beforeUpload` 校验 10MB 上限 + `customRequest` 调 `uploadContent` API + 成功后 `onChange(content)` + 自动切到编辑 Tab
- Tab 2「直接编辑」：`Input.TextArea` `rows={20}` + `fontFamily: monospace`

**详见父规格 §7.1.4**

### 2.2 `CaseTable.tsx`（用例表格）

**Props**：
```typescript
interface CaseTableProps {
  onView: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}
```

**列定义**：详见父规格 §7.1.2 表格
- 名称 / 描述 / 标签 / 创建时间 / 操作（查看/编辑/删除）

**数据源**：`useEvalCaseStore()`（从 M1 引入）

### 2.3 `CaseFormModal.tsx`（创建/编辑 Modal）

**Props**：
```typescript
interface CaseFormModalProps {
  open: boolean;
  mode: 'create' | 'edit';
  caseId?: string;  // edit 模式需要
  onClose: () => void;
}
```

**结构**：
- 顶部：`name` / `description` / `tags` 表单项
- 下方：3 个 Tabs（Init/Task/Verify），每个 Tab 内嵌 `<ScriptInput>`
- 底部：取消 / 提交按钮

**逻辑**：
- create 模式：提交调 `evalCase.createCase(req)`
- edit 模式：`useEffect` 拉取 `getCase(caseId)` 回填，提交调 `evalCase.updateCase(id, req)`
- 提交成功后 `onClose()` + store 自动刷新列表

**详见父规格 §7.1.3**

### 2.4 `CaseDetailDrawer.tsx`（只读详情）

**Props**：
```typescript
interface CaseDetailDrawerProps {
  caseId: string | null;
  open: boolean;
  onClose: () => void;
  onEdit: (id: string) => void;  // 点「编辑」触发
}
```

**结构**：
- 顶部：`Descriptions` 显示元信息（name / desc / tags / 时间）
- 中部：3 个 Tabs，每个是只读 TextArea（`disabled` + `fontFamily: monospace`）
- 底部：关闭 / 编辑按钮

**详见父规格 §7.1.5**

### 2.5 `index.tsx`（页面容器）

**结构**：
- 顶部操作栏：`Input.Search`（name 搜索）+ `Select mode="tags"`（标签过滤）+ 「创建用例」按钮
- 主体：`<CaseTable>`
- 弹层：`<CaseFormModal>` + `<CaseDetailDrawer>`

**生命周期**：`useEffect(() => { evalCase.fetchCases(); }, [])`

**详见父规格 §7.1.1**

---

## 3. 数据流

**创建用例**：
```
用户填表 → CaseFormModal.handleSubmit
  → evalCase.createCase(req) [store]
  → api.createCase [API 层]
  → 后端 POST /api/eval/cases
  → 成功后 store 内部 fetchCases() 刷新
  → onClose 关闭 Modal
```

**编辑用例**：
```
点表格「编辑」→ 传 id 到 CaseFormModal（mode='edit', caseId=id）
  → Modal useEffect 调 getCase(id) 回填
  → 用户改动 → 提交调 evalCase.updateCase(id, req)
  → 同上刷新逻辑
```

**删除用例**：
```
点「删除」→ Popconfirm 二次确认
  → evalCase.deleteCase(id)
  → 409（被引用）由 request.ts 拦截器 toast，不 rethrow
  → 200 成功后 store 刷新列表
```

---

## 4. 关键实现细节

### 4.1 上传文件校验

`ScriptInput.tsx` 的 `Upload.Dragger.beforeUpload`：
```typescript
beforeUpload: (file) => {
  if (file.size > 10 * 1024 * 1024) {
    message.error('文件大小不能超过 10MB');
    return Upload.LIST_IGNORE;  // 阻止上传
  }
  return true;
}
```

### 4.2 上传成功回填

`customRequest` 调 `uploadContent` API 后：
```typescript
onChange(content);  // 回填内容到父组件 state
setActiveKey('edit');  // 切到「直接编辑」Tab
```

### 4.3 编辑模式的字段回填

`CaseFormModal` 里 `useEffect`：
```typescript
useEffect(() => {
  if (mode === 'edit' && caseId && open) {
    getCase(caseId).then(setFormData);
  } else if (mode === 'create' && open) {
    setFormData(initialFormData);  // 重置
  }
}, [mode, caseId, open]);
```

### 4.4 部分更新的 diff 逻辑

`CaseFormModal.handleSubmit` 提交时构造 `CaseUpdateRequest`（只包含变更字段）：
```typescript
// edit 模式：对比 originalData 与 formData，仅传变更
const diff: CaseUpdateRequest = {};
if (formData.name !== originalData.name) diff.name = formData.name;
// ... 其他字段同理
evalCase.updateCase(caseId, diff);
```

---

## 5. 验证边界

**功能验证**（本模块独立可测）：见 `M2-case-management-e2e.md`
- CRUD 全流程
- 上传/编辑双 Tab 交互
- 过滤与分页
- 409 冲突处理（依赖 M3 创建任务后可测，本模块基础版只测空闲删除）

**技术验证**：
- TS 编译通过
- 组件 render 无警告
- store 与 API 联通

---

## 6. 关键决策（继承父规格）

| 决策点 | 选择 | 依据 |
|---|---|---|
| 脚本输入 | 上传/编辑双 Tab | 父规格 §7.1.4 |
| 字段布局 | 顶部元信息 + 下方 3 Tab 脚本 | 父规格 §7.1.3 |
| 详情形态 | Drawer 只读 + Tab 切换 | 父规格 §7.1.5 |
| 长文本 | antd TextArea + monospace | 父规格 §2.2 |
| 编辑接口 | 部分更新（axios 过滤 undefined） | 父规格 §5.2.2 |

---

## 7. 交付验收

- [ ] 5 个组件文件已创建
- [ ] `router/index.tsx` 已替换占位
- [ ] E2E 文档所有检查项通过
- [ ] 依赖 M1 且不阻塞 M3

---

**文档版本**：v1.0  |  **拆分自**：父规格 §7.1
