import { Page, Locator } from '@playwright/test';

/**
 * 统计指定工具的调用卡片数量
 * @param page Playwright Page 实例
 * @param toolName 工具名称，如 "fileRead"、"dispatchSubagent"
 * @param isSubagent 可选，true=仅统计子智能体调用，false=仅统计主智能体调用，undefined=全部
 */
export async function countToolCards(
  page: Page,
  toolName: string,
  isSubagent?: boolean
): Promise<number> {
  // data-testid / data-tool-name / data-is-subagent 都在同一个根元素上，
  // 合成属性选择器直接匹配。
  let selector = `[data-testid="tool-call-card"][data-tool-name="${toolName}"]`;
  if (isSubagent !== undefined) {
    selector += `[data-is-subagent="${String(isSubagent)}"]`;
  }
  return await page.locator(selector).count();
}

/**
 * 获取所有工具卡片的 Locator
 */
export function getToolCards(page: Page): Locator {
  return page.locator('[data-testid="tool-call-card"]').or(page.locator('.ant-card'));
}

/**
 * 检查聊天区最终 assistant 消息（含工具卡片文本）是否包含所有关键词。
 *
 * 由于 MessageItem 组件目前没有稳定的 role/testid，改为在聊天滚动容器内
 * 抓取全部文本进行子串匹配。滚动容器由 ChatWindow.tsx 里的 useStickToBottom
 * hook 挂载 containerRef 到 <div style={{ flex:1, overflowY:'auto' }}>；
 * 我们通过它是"包含至少一个 tool-call-card 的最内层滚动容器"来定位。
 */
export async function checkAssistantMessageContains(
  page: Page,
  keywords: string[]
): Promise<boolean> {
  const text = await page.evaluate(() => {
    // 找到包含工具卡片的最近祖先滚动区（即消息滚动容器）
    const firstCard = document.querySelector('[data-testid="tool-call-card"]');
    if (!firstCard) return document.body.innerText;
    let el: HTMLElement | null = firstCard as HTMLElement;
    while (el && el !== document.body) {
      const overflow = getComputedStyle(el).overflowY;
      if (overflow === 'auto' || overflow === 'scroll') {
        return el.innerText;
      }
      el = el.parentElement;
    }
    return document.body.innerText;
  });

  return keywords.every(kw => text.includes(kw));
}
