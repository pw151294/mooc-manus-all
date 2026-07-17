# M2 用例管理模块验证文档

**对应规格**：`docs/harness/specs/eval-modules/M2-case-management-spec.md`
**验证类型**：功能验证（用户操作流）
**前置**：
- M1 已交付（types / api / store / 路由 / 菜单）
- 后端服务运行中；数据库可写
- 浏览器打开 `/eval/cases`

---

## 1. 创建用例

- [ ] **上传文件（.txt shell 脚本，200 行）**
  - 点「创建用例」→ Modal 弹出
  - 填 name = `test-case-upload`、tags 输入 `["基础"]`
  - 切到「Init Script」Tab → 点「上传文件」→ 拖入 200 行 shell 脚本（约 5KB）
  - Expected: 上传成功 toast，自动切到「直接编辑」Tab，TextArea 显示脚本内容（monospace 字体）
  - Task Prompt / Verify Script 分别填入短文本
  - 点「提交」
  - Expected: Modal 关闭，列表刷新，新用例出现在第一行

- [ ] **直接编辑短文本（50 行）**
  - 点「创建用例」→ name = `test-case-inline`
  - 每个脚本 Tab 直接在 TextArea 输入 50 行内容
  - 提交
  - Expected: 提交成功，列表更新

- [ ] **先上传后编辑（追加 20 行）**
  - 上传 100 行脚本 → 切「直接编辑」→ 手动追加 20 行
  - 提交
  - 打开详情 Drawer 的 Init Tab
  - Expected: 显示 120 行内容

---

## 2. 编辑用例

- [ ] **修改 name**
  - 找到 `test-case-upload` 行 → 点「编辑」
  - name 从 `test-case-upload` 改为 `test-case-upload-v2`
  - 提交
  - Expected: 列表中该行 name 更新

- [ ] **追加 tags**
  - 编辑同一用例 → tags 从 `["基础"]` 追加为 `["基础", "回归"]`
  - 提交
  - Expected: 列表 tags 列显示两个 Tag

- [ ] **替换 verify_script**
  - 编辑 → Verify Tab → 清空 → 输入 `exit 1`
  - 提交
  - Expected: 打开详情 Drawer 的 Verify Tab 显示 `exit 1`

- [ ] **只改一个字段其他字段不动**（对齐 §5.2.2 部分更新）
  - 编辑用例，只改 description → 提交
  - 打开 devtools Network → 找到 `PUT /api/eval/cases/:id` 请求体
  - Expected: 请求体只含 `description` 字段，未修改的 name/tags/scripts 均不出现

---

## 3. 查看详情

- [ ] **打开详情 Drawer**
  - 点某行「查看」按钮
  - Expected: 右侧 720 宽 Drawer 滑出，顶部 Descriptions 显示 name/created_at/description/tags
  - 3 个脚本 Tab 均为只读 TextArea（disabled），可切换查看

- [ ] **关闭 Drawer**
  - 点右上角关闭 / 点 Drawer 外
  - Expected: Drawer 关闭，列表状态不丢失

---

## 4. 删除用例

- [ ] **空闲用例删除成功**
  - 创建一个未被任何任务引用的用例 `test-case-orphan`
  - 点「删除」→ Popconfirm 弹出「确认删除」→ 点确认
  - Expected: 列表中该用例消失，无错误 toast

- [ ] **被活动任务引用时返回 409**（需 M3 交付后完整验证）
  - 前置：M3 已交付，且已用 `test-case-inline` 创建了 RUNNING 状态的任务 T1
  - 尝试删除 `test-case-inline`
  - Expected: 后端返回 409，前端显示 error toast「用例正被 N 个运行中任务引用」；用例未删除
  - **本模块独立验收时**：跳过；需 M3 后测

---

## 5. 列表过滤 / 搜索 / 分页

- [ ] **按 name 搜索**
  - 顶部搜索框输入 `test-case-inline` → 回车
  - Expected: 只显示 name 含该关键词的用例；清空搜索 → 恢复全量

- [ ] **按 tags 过滤**
  - 顶部 tags 下拉选 `["基础"]`
  - Expected: 只显示含该 tag 的用例

- [ ] **组合过滤**
  - 搜索 `A` + tags 选 `["回归"]`
  - Expected: 两个条件的交集

- [ ] **分页**
  - 前置：批量创建 25 个用例（可后端 seed 或手动）
  - pageSize = 20 → 第一页显示 20 条，第二页显示 5 条
  - 改 pageSize 为 50 → page 自动重置为 1，一次显示全部 25 条

---

## 6. 表单校验 / 边界输入

- [ ] **name 必填**
  - 打开创建 Modal → 不填 name → 点提交
  - Expected: name 输入框下方红字提示「请输入名称」，Modal 不关闭

- [ ] **name 过长（>128 字）**
  - 粘贴 200 字的 name
  - Expected: 前端校验或后端 400，友好提示

- [ ] **上传文件过大（>10MB）**
  - 选择 15MB 文件上传
  - Expected: 前端 `beforeUpload` 阻止上传，显示 toast「文件大小不能超过 10MB」
  - Network 面板无请求发出

- [ ] **上传非 UTF-8 文件**
  - 上传二进制文件（.jpg 或含 NULL 字节）
  - Expected: 前端过了 → 后端返回 400 `ErrUploadNotUTF8` → 前端 error toast

---

## 7. 空状态 / 加载态

- [ ] **无用例**
  - 前置：清空所有用例（数据库或删完）
  - 访问 `/eval/cases`
  - Expected: 表格区域显示 antd Empty 组件

- [ ] **加载中**
  - Chrome Devtools → Network → Throttle: Slow 3G
  - 刷新页面
  - Expected: 表格显示 Skeleton 或 loading spinner，加载完成后消失

- [ ] **详情 Drawer 加载态**
  - 慢网络下点「查看」
  - Expected: Drawer 内部先显示 loading，数据到达后填充

---

## 8. 边界与异常

- [ ] **网络失败**
  - 断网 → 点「查看」按钮
  - Expected: loading 结束，错误 toast「网络连接失败」；界面保持稳定不白屏

- [ ] **快速连击创建**
  - 快速点两次「提交」
  - Expected: 只发一次请求；第二次被禁用或被 store 竞态处理

- [ ] **搜索防抖**
  - 快速在搜索框输入 5 个字符
  - Expected: Network 面板只发一次请求（debounce 300ms 生效）

---

## 9. 交付验收

- [ ] 上述所有检查项通过（跨模块 TODO 项除外）
- [ ] `git status` 干净（本模块代码已 commit）
- [ ] 浏览器 devtools Console 无 error
- [ ] Network 面板无 4xx/5xx 未处理错误
- [ ] 键盘可用 Tab 键遍历表单，必填字段 aria-required 存在

---

**文档版本**：v1.0  |  **拆分自**：父规格 §7.1 / §9.2.1 / §9.2.5
