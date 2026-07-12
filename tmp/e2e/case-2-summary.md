[用例 2] pass — fileRead 同 path 失败 3 次后 LLM 停止重试，日志命中熔断，done 事件到达

观察到的结果：
- 3 次 fileRead 调用，path 均为 /tmp/mooc-manus-e2e-nonexist-ukhrwgsg.txt
- 全部失败（文件不存在）
- 后端日志显示：检测到工具调用死循环，注入干预提示，tools: ["fileRead"]
- LLM 最终回复明确提到"经过 3 次重试"、"系统已强制阻止我对该路径继续重试"
- 对话正常结束（done），无 error 事件
- console 无 error 级日志

符合预期：熔断机制成功阻止了重复调用同一路径的 fileRead
