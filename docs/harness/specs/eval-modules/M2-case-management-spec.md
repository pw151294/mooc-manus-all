# M2 用例管理模块规格文档

**父规格**：`docs/superpowers/specs/2026-07-17-eval-platform-frontend-design.md`  
**模块编号**：M2  
**依赖**：M1（types + api + `store/evalCase.ts` + 路由/菜单基座）  
**被依赖**：M3（弱依赖：创建任务时需要可选用例数据）

---

## 1. 模块范围

本模块交付评测用例的创建、查看、编辑、删除、搜索、标签过滤、分页与脚本上传/编辑能力，让用户可以维护后续评测任务所需的 Case 数据。

### 1.1 交付物

- 页面容器：`mooc-manus-web/src/pages/Eval/Cases/index.tsx`
- 表格组件：`mooc-manus-web/src/pages/Eval/Cases/CaseTable.tsx`
- 表单组件：`mooc-manus-web/src/pages/Eval/Cases/CaseFormModal.tsx`
- 脚本输入组件：`mooc-manus-web/src/pages/Eval/Cases/ScriptInput.tsx`
- 详情组件：`mooc-manus-web/src/pages/Eval/Cases/CaseDetailDrawer.tsx`
- 复用 M1：`store/evalCase.ts`、`api/modules/eval.ts`、`types/eval.ts`

### 1.2 非目标

- 不实现任务创建时的用例选择 Transfer（属 M3）。
- 不验证用例被运行中任务引用时的完整业务链路；该项需 M3 后补测。
- 不实现任务详情中 case_id 到用例名的增强映射（属 M4 或后续优化）。
- 不新增脚本编辑器依赖，不引入 Monaco/CodeMirror。

---

## 2. 页面与组件设计

### 2.1 `Cases/index.tsx`

负责组装顶部操作栏、用例表格、创建/编辑 Modal、详情 Drawer。

关键交互：

- 首次进入页面调用 `evalCase.fetchCases()`。
- 顶部搜索框按 `nameLike` 过滤。
- 标签选择使用 `Select mode="tags"`。
- 点击「创建用例」打开 `CaseFormModal`。
- 点击表格名称或「查看」打开 `CaseDetailDrawer`。
- 编辑/删除后刷新列表。

**详见父规格 §7.1.1。**

### 2.2 `CaseTable.tsx`

展示用例列表、标签、创建时间和操作列。

列要求：

- 名称：点击打开详情 Drawer。
- 描述：超长省略，Tooltip 悬停显示。
- 标签：用 `Tag` 展示。
- 创建时间：用 dayjs 格式化。
- 操作：查看 / 编辑 / 删除。

分页要求：

- `current`、`pageSize`、`total` 来自 `evalCase` store。
- 支持 `10 / 20 / 50` pageSize。
- 页码或 pageSize 改变后触发 store 更新并重新拉取。

**详见父规格 §7.1.2。**

### 2.3 `CaseFormModal.tsx`

承载创建与编辑用例表单。

字段：

- `name`：必填。
- `description`：可选。
- `tags`：`Select mode="tags"`，可自由输入。
- `init_script`：可选脚本。
- `task_prompt`：必填脚本。
- `verify_script`：必填脚本。

脚本字段通过三组 Tab 展示，内部复用 `ScriptInput`。

**详见父规格 §7.1.3。**

### 2.4 `ScriptInput.tsx`

提供「上传文件」与「直接编辑」双 Tab。

关键要求：

- `accept=".txt,.sh,.py,.md"`。
- 上传前检查文件大小不超过 10MB。
- `customRequest` 调用 `uploadContent(file)`。
- 上传成功后将返回 `content` 回填，并自动切到「直接编辑」Tab。
- TextArea 使用 monospace 字体，支持继续修改。

**详见父规格 §7.1.4、§5.2.1。**

### 2.5 `CaseDetailDrawer.tsx`

展示只读用例详情。

内容：

- 顶部 `Descriptions` 展示名称、描述、标签、创建时间。
- 三个只读脚本 Tab：Init Script / Task Prompt / Verify Script。
- 底部操作：关闭、编辑。

**详见父规格 §7.1.5。**

---

## 3. 数据流 / 关键实现细节

```text
用户搜索/过滤/翻页 → Cases/index.tsx → evalCase store → listCases()
创建/编辑用例 → CaseFormModal → evalCase create/update → list 刷新
上传脚本 → ScriptInput → uploadContent(file) → content 回填
查看详情 → CaseTable → CaseDetailDrawer → getCase(id) 或列表数据
删除用例 → CaseTable 操作列 → deleteCase(id) → list 刷新
```

关键边界：

- 表单提交时只调用 M1 已封装的 API/store action，不在组件内拼接 URL。
- 编辑模式下，`CaseFormModal` 应用已有用例数据初始化表单。
- 删除前使用确认交互，避免误删。
- 409 冲突错误交由 request 拦截器提示；本模块不吞错。
- 上传文件过大在前端阻止，避免无意义后端请求。

---

## 4. 关键决策（继承父规格）

| 决策点 | 选择 | 依据（父规格章节） |
|---|---|---|
| 用例页面形态 | 列表页 + Modal + Drawer | §3.3、§7.1 |
| 脚本输入 | 上传/编辑双 Tab | §7.1.4、§13.2 |
| 长文本展示 | antd TextArea，不加新依赖 | §2.2、§7.1.4 |
| 文件大小限制 | 前端 10MB beforeUpload 校验 | §5.2.1、§9.2.5 |
| 搜索过滤 | 名称搜索 + tags 过滤 | §4.1.1、§9.2.1 |
| 数据字段 | 使用 snake_case DTO | §6.1 |

---

## 5. 验证边界

**功能验证**：见 `../../e2e/eval-modules/M2-case-management-e2e.md`。  
**依赖前置**：M1 已交付；后端 eval case API 可用。

---

## 6. 交付验收

- [ ] 5 个 `Cases/` 组件文件已创建。
- [ ] 用例创建、编辑、查看、删除、搜索、标签过滤、分页可用。
- [ ] 脚本上传、上传后编辑、直接编辑三种输入方式可用。
- [ ] 文件过大、必填缺失、空列表、加载态均有可观察反馈。
- [ ] M2 e2e 文档所有非 TODO 检查项通过。
- [ ] 不阻塞 M3 基于已有用例创建任务。

---

**文档版本**：v1.0  |  **拆分自**：父规格 §4.1.1、§5.2.1、§7.1、§9.2.1、§10.2
