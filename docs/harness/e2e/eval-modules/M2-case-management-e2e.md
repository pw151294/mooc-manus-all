# M2 用例管理模块验证文档

**对应规格**：`docs/superpowers/specs/eval-modules/M2-case-management-spec.md`
**前置**：M1 已交付；后端服务运行中

---

## 1. 创建用例（3 种输入方式）

- [ ] **方式 A：上传 txt 文件**
  - 点「创建用例」按钮 → Modal 弹出
  - 填 name = "M2-上传测试"、tags 加 `["基础"]`
  - 切到 Init Script Tab → 「上传文件」子 Tab → 拖入 200 行 shell 脚本
  - Expected: 上传成功 toast，自动切到「直接编辑」Tab，TextArea 显示脚本内容
  - Task Prompt / Verify Script 同上或直接编辑
  - 点「提交」→ Modal 关闭，列表刷新，新用例出现在第一行

- [ ] **方式 B：直接输入短文本**
  - 点「创建用例」→ 填 name = "M2-手输测试"
  - 三个脚本 Tab 都选「直接编辑」，粘 50 行内容
  - 提交 → 列表出现新用例

- [ ] **方式 C：先上传后编辑**
  - 点「创建用例」→ 上传 100 行 verify_script
  - 切到「直接编辑」Tab（自动切）→ 手动追加 20 行
  - 提交 → 打开详情 Drawer 验证 verify_script 是 120 行

---

## 2. 编辑用例

- [ ] **修改 name**
  - 点用例行「编辑」→ Modal 打开，字段回填
  - 改 name 为「M2-上传测试 - 已更新」→ 提交
  - Expected: 列表 name 列已更新

- [ ] **追加 tags**
  - 编辑上一个用例 → tags 追加 `"回归"`（原有 `["基础"]`）
  - 提交 → 详情 Drawer 显示 `["基础","回归"]` 两个 Tag

- [ ] **替换 verify_script**
  - 编辑 → verify Tab → 「直接编辑」→ 全选删除 → 粘 `exit 1`
  - 提交 → 详情 Drawer 的 verify_script 为 `exit 1`

- [ ] **仅传变更字段（技术验证）**
  - Chrome Network 观察 PUT 请求 body
  - Expected: 仅含实际变更字段（如仅改 name 时，body 只有 `{"name":"..."}`）

---

## 3. 删除用例

- [ ] **空闲用例删除成功**
  - 创建一个未被任务引用的用例 C1
  - 点「删除」→ Popconfirm 二次确认「确定删除？」→ 确定
  - Expected: 列表刷新，C1 消失，成功 toast

- [ ] **被活动任务引用返回 409**（需 M3 后测；本模块暂标记 TODO）
  - 依赖 M3 创建任务功能，M2 独立验收时跳过此项

- [ ] **取消删除**
  - 点「删除」→ Popconfirm 弹出 → 点「取消」
  - Expected: 用例保留，无 API 请求

---

## 4. 列表过滤

- [ ] **name_like 搜索**
  - 顶部搜索框输入「测试」→ 回车或按搜索图标
  - Expected: 只显示 name 含「测试」的用例

- [ ] **tags 过滤**
  - Select 里选择 `["基础"]`
  - Expected: 只显示含「基础」tag 的用例

- [ ] **组合过滤**
  - name_like = "M2" + tags = ["回归"]
  - Expected: 交集结果

- [ ] **重置过滤**
  - 清空搜索框 + 清空 tags Select
  - Expected: 列表恢复全量显示

---

## 5. 分页

- [ ] **翻页**
  - 前置：至少创建 25 个用例（可写脚本批量）
  - pageSize = 20 时，第一页显示 20 条
  - 点「下一页」→ 第二页显示 5 条
  - Expected: URL 无变化（分页走 store，不入 URL），列表内容切换

- [ ] **改 pageSize**
  - 底部选择 pageSize = 50
  - Expected: page 重置为 1，显示全部 25 条

- [ ] **showTotal**
  - Expected: 底部显示「共 25 条」

---

## 6. 详情 Drawer

- [ ] **打开详情**
  - 点用例行的名称（或「查看」按钮）
  - Expected: 右侧滑出 Drawer，宽 720px
  - Expected: 顶部 Descriptions 显示 name / desc / tags / 时间
  - Expected: 3 个 Tab 展示只读脚本（TextArea disabled + monospace 字体）

- [ ] **从详情跳编辑**
  - Drawer 底部点「编辑」→ Drawer 关闭 + CaseFormModal 打开（edit 模式）
  - Expected: Modal 内字段已回填

- [ ] **关闭**
  - Drawer 右上 X 或底部「关闭」→ Drawer 消失，Drawer 内 state 清空

---

## 7. 上传边界

- [ ] **文件过大（>10MB）**
  - 准备 15MB 的 txt 文件
  - Upload.Dragger 拖入
  - Expected: 阻止上传，toast「文件大小不能超过 10MB」，TextArea 内容不变

- [ ] **非 UTF-8 文件**
  - 上传二进制文件（如 .png）
  - Expected: 后端返回 400 + `ErrUploadNotUTF8`，前端显示错误 toast

- [ ] **必填校验**
  - 不填 task_prompt / verify_script 就提交
  - Expected: 前端阻止提交（form validation）或后端返回 400（binding required 失败）

---

## 8. 空状态

- [ ] **无用例**
  - 删光所有用例
  - Expected: 表格显示 antd Empty「暂无数据」

---

## 9. 交付验收

- [ ] 上述所有 § 1-8 检查项通过
- [ ] `git status` 干净
- [ ] 浏览器 devtools 无 error/warning
- [ ] Network 面板无 4xx/5xx 未处理错误

---

**文档版本**：v1.0  |  **拆分自**：父规格 §9.2.1、§9.2.5
