# M2 用例管理模块规格文档

**父规格**：`docs/superpowers/specs/2026-07-17-eval-platform-frontend-design.md`
**模块编号**：M2
**依赖**：M1（types + api + store 基座）
**被依赖**：M3（弱依赖：需要用例数据才能创建任务）

---

## 1. 模块范围

实现 `/eval/cases` 用例管理页的完整 CRUD 交互：列表 + 搜索 + 分页、创建/编辑 Modal（含
`init_script` / `task_prompt` / `verify_script` 三段脚本，支持上传或直接输入）、只读详情
Drawer、删除确认（含 409 冲突提示）。

对应父规格 §7.1、§10.2 Phase 2。

### 1.1 交付物

- 页面：`src/pages/Eval/Cases/index.tsx`
  - 顶部工具栏（搜索、tags 过滤、"创建用例"按钮）
  - `CaseTable`、`CaseFormModal`、`CaseDetailDrawer` 三者的组装容器
  - `useEffect` 生命周期：mount 时 `fetchCases()`
- 表格：`src/pages/Eval/Cases/CaseTable.tsx`
  - 列：name、tags、description（截断）、created_at、操作
  - 操作列：查看、编辑、删除（Popconfirm）
  - antd Table 分页组件受控
- 表单 Modal：`src/pages/Eval/Cases/CaseFormModal.tsx`
  - name（必填）、description、tags（Select mode=tags）
  - 3 个脚本 Tabs：init / task_prompt / verify，每个 Tab 内嵌 `<ScriptInput>`
  - 提交调用 store `createCase` / `updateCase`
- 脚本输入组件：`src/pages/Eval/Cases/ScriptInput.tsx`
  - 双 Tab：上传文件 / 直接编辑
  - 上传成功后自动切到"直接编辑"Tab，TextArea 回填内容
  - `beforeUpload` 10MB 校验
- 只读详情：`src/pages/Eval/Cases/CaseDetailDrawer.tsx`
  - antd Descriptions 展示元信息 + tags
  - 3 个脚本 Tabs（只读 TextArea）

### 1.2 非目标

- 不引入 Monaco/CodeMirror（父规格 §2.2、§11.2），用 antd TextArea + monospace 字体
- 不在本模块做任务创建入口（属 M3）
- 不做用例分组/文件夹（父规格 §12 未来扩展）
- 不做 A11y 全面覆盖（父规格 §9.4 由 Phase 6 打磨，本模块只保证键盘可 Tab、必填有 aria-required）

---

## 2. 组件设计

### 2.1 `Cases/index.tsx` 页面容器

**详见父规格 §7.1.1**

关键结构：
```tsx
<>
  <Toolbar>
    <Search onSearch={applyNameLike} />
    <TagSelect onChange={applyTagFilter} />
    <Button type="primary" onClick={() => openFormModal('create')}>创建用例</Button>
  </Toolbar>
  <CaseTable ... />
  <CaseFormModal ... />
  <CaseDetailDrawer ... />
</>
```

### 2.2 `CaseTable.tsx`

**详见父规格 §7.1.2**（列定义、分页、行操作）

- 分页：`current` / `pageSize` / `total` 三个 prop 从 store 读，`onChange` 派发 store action
- 删除按钮：外套 `Popconfirm`，`onConfirm` 调 `store.deleteCase(id)`；catch 409 时不再重复
  toast（拦截器已处理）

### 2.3 `CaseFormModal.tsx`

**详见父规格 §7.1.3**

- `mode: 'create' | 'edit'` prop 决定初始值
- 编辑模式：只传变更字段（对齐父规格 §5.2.2 `updateCase` 语义）
- 校验：name 必填、长度 1-128；tags 无长度限制
- 关闭时 reset form

### 2.4 `ScriptInput.tsx`

**详见父规格 §7.1.4**

**Props**：
```typescript
interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}
```

**双 Tab 逻辑**：
- 上传 Tab：`<Upload beforeUpload={validate10MB} onChange={handleUploaded}>`；上传成功后
  调用 `onChange(text)` + 切换到「直接编辑」Tab
- 直接编辑 Tab：`<Input.TextArea value={value} onChange={e => onChange(e.target.value)} rows={20}
  style={{ fontFamily: 'monospace', fontSize: 13 }} />`

### 2.5 `CaseDetailDrawer.tsx`

**详见父规格 §7.1.5**

只读展示，无提交按钮。

---

## 3. 数据流

```
用户操作
  ↓
Cases/index.tsx → useEvalCaseStore.action(...)
  ↓
store/evalCase.ts → api.createCase / listCases / ...
  ↓
后端 /api/eval/cases/*
  ↓
Store 更新 state → 组件 re-render
```

**关键细节**：
- 搜索/过滤：debounce 300ms，`applyFiltersAndFetch` 内部把 page 重置为 1
- 文件上传：`api.uploadContent(file)` 返回 `{ content: string }`，`ScriptInput` 拿到后
  `onChange(content)` 回填
- 删除 409：`request.ts` 拦截器已 `message.error`，UI 只需 catch 时不重复 toast

---

## 4. 关键决策（继承父规格）

| 决策点 | 选择 | 依据（父规格章节） |
|---|---|---|
| 脚本编辑器 | antd TextArea + monospace | §2.2、§11.2 |
| 上传上限 | 前端 `beforeUpload` 10MB | §5.2.1、§9.2.5 |
| 部分更新 | `undefined` 字段不传 | §5.2.2 |
| tags 输入 | antd Select `mode="tags"` | §7.1.3 |
| 详情展示 | Drawer 720 宽，Descriptions + 3 Tab TextArea | §7.1.5 |
| 删除确认 | Popconfirm 内联，不再弹 Modal | §7.1.2 |

---

## 5. 验证边界

**功能验证**：见 `docs/harness/e2e/eval-modules/M2-case-management-e2e.md`
**技术验证**：组件 mount 无报错、API 联通、Store action 正确调用

---

## 6. 交付验收

- [ ] 上述 5 个交付物文件已创建，TS 编译零错误
- [ ] `Cases/index.tsx` 能列出、创建、编辑、删除、查看用例
- [ ] `ScriptInput` 上传 + 编辑双 Tab 均正常
- [ ] E2E 文档所有检查项通过（跨模块依赖项标 TODO 的除外）
- [ ] 依赖 M1；不阻塞 M3（M3 独立时可用后端已有用例数据）

---

**文档版本**：v1.0  |  **拆分自**：父规格 §7.1 / §10.2
