import { Page } from '@playwright/test';

/**
 * 等待流式输出结束。
 *
 * 前端信号：
 *  - 流式中：ChatWindow 显示 "停止" 按钮（ChatWindow.tsx:139），发送按钮带 ant-btn-loading class
 *  - 流式结束："停止" 按钮消失，发送按钮的 loading 状态被清除
 *
 * 注意：不能靠 button.disabled 判断，因为 input 为空时按钮永远 disabled（!input.trim()）
 */
export async function waitStreamDone(page: Page, timeout = 120_000) {
  // 先等待"停止"按钮出现（进入流式状态的强信号）
  const stopButton = page.getByRole('button', { name: /停\s*止/ }).first();

  await stopButton
    .waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => {
      // 若 30s 内未出现，可能后端很快返回或未真正开始流；后续继续检测消失
    });

  // 等待"停止"按钮消失（流式结束的强信号）
  await stopButton.waitFor({ state: 'hidden', timeout });

  // 再多等 500ms 让 SSE 尾部事件（tool_call_complete、message_end）都渲染完毕
  await page.waitForTimeout(500);
}
