[用例 3] pass — 2 次不同 path 的 fileRead 失败未触发熔断，fileWrite→fileRead 正常完成

观察到的结果：
- fileRead /tmp/mooc-manus-e2e-noexist-a-92mswm9m.txt 失败（文件不存在）
- fileRead /tmp/mooc-manus-e2e-noexist-b-6olpu9s7.txt 失败（文件不存在）
- 两次失败的 path 不同，不属于"同源"调用
- 后续 fileWrite 成功创建文件
- 最终 fileRead 成功读回文件内容 "ok"
- 后端日志无新增熔断记录（用例 2 到用例 3 期间，grep 熔断日志仍只有 1 条）
- 对话正常结束（done），无 error 事件
- console 无 error 级日志

符合预期：2 次不同 key 的工具调用失败不触发熔断，后续工作流正常执行
