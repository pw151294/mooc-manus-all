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
  let selector = '[data-testid="tool-call-card"]';

  // 若有 data-tool-name 属性，用它过滤
  const allCards = page.locator(selector);
  const count = await allCards.count();

  if (count === 0) {
    // 可能前端没加 test-id，回退到 class 选择器（Ant Design Card）
    // 尝试通过工具名称文本匹配
    const fallbackCards = page.locator('.ant-card').filter({ hasText: toolName });
    return await fallbackCards.count();
  }

  // 有 test-id 时精准过滤
  let filtered = allCards;

  // 按 data-tool-name 过滤
  filtered = filtered.filter({ has: page.locator(`[data-tool-name="${toolName}"]`) });

  // 按 data-is-subagent 过滤（若指定）
  if (isSubagent !== undefined) {
    const expectedValue = String(isSubagent);
    filtered = filtered.filter({ has: page.locator(`[data-is-subagent="${expectedValue}"]`) });
  }

  return await filtered.count();
}

/**
 * 获取所有工具卡片的 Locator
 */
export function getToolCards(page: Page): Locator {
  return page.locator('[data-testid="tool-call-card"]').or(page.locator('.ant-card'));
}

/**
 * 检查最终 assistant 消息是否包含所有关键词
 */
export async function checkAssistantMessageContains(
  page: Page,
  keywords: string[]
): Promise<boolean> {
  // 获取最后一条 assistant 消息
  // 优先用 data-testid，回退到 class 选择器
  const lastMessage = page
    .locator('[data-testid="message-assistant"]')
    .or(page.locator('.ant-message-content'))
    .last();

  const text = await lastMessage.innerText();

  return keywords.every(kw => text.includes(kw));
}
