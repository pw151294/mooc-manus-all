# M2 用例管理模块验证文档

**对应规格**：`docs/harness/specs/eval-modules/M2-case-management-spec.md`  
**验证类型**：功能验证  
**前置**：M1 已交付；后端 eval case API 运行中；前端应用可访问 `/eval/cases`。

---

## 1. 创建用例

- [ ] **直接编辑脚本创建用例**
  - 打开 `/eval/cases`。
  - 点击「创建用例」。
  - 填写 `name = 用例-直接编辑`、`description = 直接编辑验证`、`tags = [基础]`。
  - 在 `Task Prompt` Tab 的「直接编辑」中输入 50 行以内文本。
  - 在 `Verify Script` Tab 的「直接编辑」中输入 `exit 0`。
  - 点击提交。
  - Expected: Modal 关闭，列表刷新，新用例出现在列表中，名称、描述、标签正确。

- [ ] **上传文件创建用例**
  - 点击「创建用例」。
  - 在 `Init Script` Tab 选择「上传文件」，拖入 `.sh` 或 `.txt` 文件。
  - Expected: 显示上传成功 toast，自动切到「直接编辑」Tab，TextArea 显示上传内容。
  - 填写必填字段并提交。
  - Expected: 新用例创建成功，详情中可看到上传后的脚本内容。

- [ ] **先上传后编辑脚本**
  - 上传一份约 100 行脚本。
  - 在上传回填后的 TextArea 末尾追加 20 行文本。
  - 提交创建。
  - Expected: 详情 Drawer 中展示的脚本包含上传内容和追加内容。

- [ ] **必填校验**
  - 打开创建 Modal，仅填写 `name`，不填 `task_prompt` 或 `verify_script`。
  - 点击提交。
  - Expected: 表单阻止提交，并在缺失字段附近显示必填提示；Network 面板无创建请求。

---

## 2. 查看与编辑用例

- [ ] **查看用例详情**
  - 在列表中点击用例名称或「查看」。
  - Expected: 右侧 Drawer 打开，展示名称、描述、标签、创建时间和三个脚本 Tab。

- [ ] **详情 Drawer 脚本只读**
  - 打开详情 Drawer，切换 Init Script / Task Prompt / Verify Script。
  - Expected: 三个 TextArea 均为只读或 disabled，长文本可滚动查看。

- [ ] **编辑基础字段**
  - 在列表或详情中点击「编辑」。
  - 将 name 从 `用例-直接编辑` 改为 `用例-直接编辑-已更新`。
  - 将 tags 从 `[基础]` 改为 `[基础, 回归]`。
  - 提交。
  - Expected: 列表和详情 Drawer 显示更新后的名称与标签。

- [ ] **编辑脚本字段**
  - 打开编辑 Modal。
  - 将 `verify_script` 从 `exit 0` 改为 `exit 1`。
  - 提交并重新打开详情。
  - Expected: Verify Script Tab 展示 `exit 1`。

---

## 3. 列表搜索、过滤与分页

- [ ] **按名称搜索**
  - 前置：至少存在名称含「搜索目标」和不含该词的用例。
  - 在搜索框输入 `搜索目标` 并提交。
  - Expected: 列表仅显示名称包含 `搜索目标` 的用例。

- [ ] **按标签过滤**
  - 前置：至少存在带 `基础` 标签和不带该标签的用例。
  - 在标签过滤中选择或输入 `基础`。
  - Expected: 列表仅显示 tags 包含 `基础` 的用例。

- [ ] **组合过滤**
  - 输入 name_like = `A`，tags = `[回归]`。
  - Expected: 列表显示两个条件的交集结果。

- [ ] **分页与 pageSize**
  - 前置：创建至少 25 个用例。
  - 设置 pageSize = 20。
  - Expected: 第一页最多显示 20 条。
  - 翻到第二页。
  - Expected: 显示第 21–25 条。
  - 将 pageSize 改为 50。
  - Expected: page 重置为 1，并显示全部 25 条或当前过滤条件下全部数据。

---

## 4. 删除与冲突

- [ ] **删除未被引用的用例**
  - 创建一个未被任何任务引用的用例。
  - 点击删除。
  - Expected: 出现确认对话框。
  - 确认删除。
  - Expected: 用例从列表消失，刷新页面后仍不存在。

- [ ] **取消删除不改变数据**
  - 点击删除后在确认对话框中取消。
  - Expected: 用例仍在列表中，无 DELETE 请求或请求未发出。

- [ ] **TODO：被活动任务引用时删除返回 409**
  - 需 M3 交付后测；M2 独立验收时跳过此项。
  - 前置：创建任务 T1 引用用例 C1，任务状态为 RUNNING。
  - 删除 C1。
  - Expected: 后端返回 409，前端显示错误 toast，用例未删除。

---

## 5. 边界与异常

- [ ] **上传文件过大**
  - 在 ScriptInput 上传一个大于 10MB 的文件。
  - Expected: 前端阻止上传，显示「文件大小不能超过 10MB」或等价错误提示，Network 面板无 upload-content 请求。

- [ ] **上传非 UTF-8 文件**
  - 上传二进制文件（如 `.jpg`）。
  - Expected: 后端返回 400 或等价错误，前端显示错误 toast，TextArea 不被错误内容覆盖。

- [ ] **网络失败**
  - 断开网络或让后端停止。
  - 触发列表刷新或创建用例。
  - Expected: loading 状态可见，随后显示错误 toast，页面不白屏。

- [ ] **快速搜索竞态**
  - 快速连续输入两个不同搜索词并触发搜索。
  - Expected: 最终列表对应最后一个搜索词，旧请求不覆盖新结果。

---

## 6. 空状态 / 加载态 / 可访问性

- [ ] **空列表状态**
  - 使用一个无匹配结果的搜索词。
  - Expected: 表格显示 antd Empty 或等价空状态。

- [ ] **加载态**
  - 在慢网络下刷新用例列表。
  - Expected: 表格或页面显示 loading，不出现旧数据误导操作。

- [ ] **Modal / Drawer 键盘操作**
  - 打开创建 Modal 后按 Tab / Enter / Esc。
  - Expected: 焦点在 Modal 内合理移动；Esc 可关闭；关闭后焦点回到触发按钮或合理位置。

---

## 7. 交付验收

- [ ] 上述所有非 TODO 检查项通过。
- [ ] `CaseTable.tsx`、`ScriptInput.tsx`、`CaseFormModal.tsx`、`CaseDetailDrawer.tsx`、`index.tsx` 均被至少一条检查项覆盖。
- [ ] 浏览器 devtools 无 error/warning。
- [ ] Network 面板无未处理 4xx/5xx。
- [ ] `git status` 干净（本模块代码已 commit）。

---

**文档版本**：v1.0  |  **拆分自**：父规格 §7.1、§9.2.1、§9.2.5、§10.2
