# M2 用例管理 E2E 验证

**对应规格**：`../specs/eval-modules/M2-case-management-spec.md`
**依赖 E2E 已通过**：M1-infrastructure-e2e

---

## 1. 前置条件

- M1 基础设施已交付验证
- 后端 mooc-manus 服务已启动，数据库中至少无脏数据（或允许创建/删除测试用例）
- 前端 `mooc-manus-web` dev server 已启动
- 浏览器打开开发者工具（Network / Console）

---

## 2. 验证清单

### 2.1 创建用例（3 种脚本输入方式）

- [ ] **方式 A：上传 txt 文件**：
  - 打开 `/eval/cases` → 点「创建用例」
  - 填写 name="测试用例 A"、description="上传方式"、tags=["基础"]
  - 切到 Init Script Tab → 「上传文件」子 Tab → 拖拽或选择 200 行的 shell 脚本 .txt 文件（<10MB）
  - 上传成功 → toast "上传成功"、内部自动切到「直接编辑」子 Tab、内容已回填
  - 类似方式填 Task Prompt / Verify Script
  - 点「提交」→ Modal 关闭、列表刷新、"测试用例 A" 出现在表格第一行
- [ ] **方式 B：直接在 TextArea 输入短文本**：
  - 「创建用例」→ 3 个脚本 Tab 都直接进入「直接编辑」子 Tab
  - 粘贴 50 行左右的 shell 代码
  - 提交 → 成功
- [ ] **方式 C：先上传后编辑（追加修改）**：
  - 上传 100 行脚本 → 内容回填「直接编辑」Tab
  - 手动在 TextArea 底部追加 20 行
  - 提交 → 保存的内容为 120 行（可通过 Drawer 查看验证）

### 2.2 上传边界

- [ ] **10MB 上限**：
  - 选择 15MB 文件上传 → beforeUpload 拦截、toast "文件大小不能超过 10MB"
  - Network 面板无 upload-content 请求发出（前置校验生效）
- [ ] **非 UTF-8 文件**（如 .jpg）：
  - 上传二进制文件 → 后端返回 400 + `ErrUploadNotUTF8`
  - 前端 toast 错误信息

### 2.3 编辑用例

- [ ] 点表格中某用例的「编辑」按钮 → CaseFormModal 打开（mode=edit）
- [ ] 修改 name："测试用例 A" → "用例 A - 已更新"
- [ ] 追加 tags：原 `["基础"]` → `["基础", "回归"]`
- [ ] 替换 verify_script：从 `exit 0` 改为 `exit 1`
- [ ] 提交 → Modal 关闭、列表刷新，行内容显示最新
- [ ] 再打开该用例的 Drawer → 3 个脚本内容为最新
- [ ] **只改一个字段的部分更新**：
  - 编辑时只改 name → 提交
  - Network 面板检查 PUT 请求 body，只包含 `{ name: '...' }`，无 undefined/其他字段

### 2.4 删除用例

- [ ] **空闲用例删除成功**：
  - 创建一个未被任务引用的用例
  - 点「删除」→ Modal.confirm 弹出「确认删除？」
  - 点「确定」→ 列表刷新、用例消失、toast 成功
- [ ] **被活动任务引用时 409**：
  - 前置：创建任务 T1 引用用例 C1，任务状态 RUNNING（可用 M3 或后端 API 造）
  - 尝试删除 C1 → 后端返回 409 + 错误消息
  - 前端 message.error 显示"用例正被 X 个运行中任务引用"或类似文案
  - 用例仍在列表中

### 2.5 列表过滤与搜索

- [ ] **按 name_like 搜索**：
  - 顶部搜索框输入"测试"关键词 → 回车/触发 onSearch
  - 列表只显示名称包含"测试"的用例
  - Network 面板检查请求 query 含 `name_like=测试`
- [ ] **按 tags 过滤**：
  - Select 选择 tag ["基础"] → 列表只显示含该 tag 的用例
- [ ] **组合过滤**：
  - name_like="A" + tags=["回归"] → 结果为两个条件的交集
- [ ] **清空过滤**：
  - 清空搜索框、清空 tags → 列表恢复全部

### 2.6 分页

- [ ] **翻页**：
  - 前置：至少造 25 条用例
  - pageSize=20（默认）→ 第一页显示 1-20 条
  - 翻到第 2 页 → 显示 21-25 条
- [ ] **切换 pageSize**：
  - 从 20 改为 50 → page 重置为 1 → 显示全部 25 条
- [ ] **过滤后翻页 + 重置**：
  - 过滤后翻到第 2 页 → 修改过滤条件 → page 应自动回到 1

### 2.7 查看详情 Drawer

- [ ] 点表格行的名称文本 → Drawer 从右侧滑出
- [ ] 顶部 Descriptions 显示：名称、创建时间、描述、标签（Tag 组件）
- [ ] 3 个脚本 Tab 切换 → 每个 Tab 的 TextArea 显示对应内容（disabled，monospace 字体）
- [ ] 长脚本内容可滚动查看
- [ ] 点底部「编辑」→ Drawer 关闭 + CaseFormModal 打开（mode=edit）

### 2.8 空状态

- [ ] 后端清空所有用例，或用不匹配的过滤条件
- [ ] 列表显示 antd Empty 组件（"暂无数据"或自定义"暂无用例"）

### 2.9 网络异常

- [ ] 断开网络 → 触发 `evalCase.fetchCases()`（切过滤或翻页）
- [ ] Loading 状态正确显示
- [ ] 恢复网络后手动触发 → 数据正常加载
- [ ] Console 无未捕获异常

---

## 3. 通过标准

- 2.1 ~ 2.9 全部勾选
- 所有 CRUD 操作后表格自动刷新
- 错误 toast 文案清晰、Modal 未误关

---

## 4. 已知限制

- 用例引用统计（"被 X 个任务引用"）依赖后端返回错误消息文案
- Monaco/CodeMirror 高级编辑体验不做（TextArea 已够用）

---

**E2E 版本**：v1.0
