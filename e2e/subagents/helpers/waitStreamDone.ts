import { Page } from '@playwright/test';

/**
 * 等待流式输出结束（发送按钮从 loading 状态恢复）
 * @param page Playwright Page 实例
 * @param timeout 超时时间（ms），默认 120s
 */
export async function waitStreamDone(page: Page, timeout = 120_000) {
  // 等待发送按钮不再 disabled 或不再 loading（Ant Design Button 的 loading 状态会设置 disabled）
  // 优先用 data-testid；若不存在则回退到按钮文本
  const sendButton = page.locator('[data-testid="send-button"]').or(page.locator('button:has-text("发送")'));

  await sendButton.waitFor({ state: 'visible', timeout: 5000 });

  // 等待按钮从 disabled 恢复到可点击（isStreaming 复位后按钮会解除 disabled）
  await sendButton.waitFor({ state: 'attached', timeout });
  await page.waitForFunction(
    (btn) => {
      const el = document.querySelector(btn);
      return el && !(el as HTMLButtonElement).disabled && !el.classList.contains('ant-btn-loading');
    },
    sendButton.first(),
    { timeout }
  );
}
