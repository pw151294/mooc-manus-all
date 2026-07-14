import { test, expect } from '@playwright/test';
import { setupFixtures, cleanupFixtures, buildInstruction, FIXTURE_BASE } from '../fixtures/testdata';
import { countToolCards, checkAssistantMessageContains } from '../helpers/toolCards';
import { waitStreamDone } from '../helpers/waitStreamDone';
import { plansDirExists } from '../helpers/plansDir';

test.describe('C1: PlanMode=off + Subagent=off', () => {
  let conversationId: string | null = null;

  test.beforeEach(async () => {
    await setupFixtures();
  });

  test.afterEach(async ({ page }, testInfo) => {
    // 失败时截屏已由 playwright.config.ts 处理
    // 清理 fixture 目录
    await cleanupFixtures();

    // 如果拿到了 conversationId，记录到产物
    if (conversationId && testInfo.status === 'failed') {
      const plansExist = await plansDirExists(conversationId);
      console.log(`[DIAGNOSTIC] conversationId=${conversationId}, plans目录存在=${plansExist}`);
    }
  });

  test('主 Agent 直接调 fileRead，无 dispatchSubagent，无 plans 目录', async ({ page }) => {
    // 1. 打开页面
    await page.goto('/agent');

    // 2. 等待模型下拉框出现并选择 zai-org/GLM-5.2
    await page.waitForLoadState('networkidle');

    // 尝试找 Ant Design Select 组件（可能是 .ant-select 或原生 select）
    const modelSelector = page.locator('.ant-select').first().or(page.locator('select').first());
    await modelSelector.waitFor({ state: 'visible', timeout: 10_000 });
    await modelSelector.click();

    // 点击下拉项
    const modelOption = page.locator('.ant-select-item:has-text("zai-org/GLM-5.2")').or(page.locator('text=zai-org/GLM-5.2'));
    await modelOption.click();

    // 3. 确认 PlanMode 开关为关闭状态（默认）
    const planModeSwitch = page.locator('[data-testid="plan-mode-switch"]').or(page.locator('.ant-switch').first());
    const isChecked = await planModeSwitch.getAttribute('aria-checked');
    expect(isChecked).toBe('false');

    // 4. 输入指令
    const instruction = buildInstruction(FIXTURE_BASE);
    const inputBox = page.locator('[data-testid="chat-input"]').or(page.locator('textarea').first());
    await inputBox.fill(instruction);

    // 5. 点击发送
    const sendButton = page.locator('[data-testid="send-button"]').or(page.locator('button:has-text("发送")'));
    await sendButton.click();

    // 6. 等待流式结束
    await waitStreamDone(page);

    // 7. 从 store 读取 conversationId（用于后续清理与诊断）
    conversationId = await page.evaluate(() => {
      return (window as any).useAgentStore?.getState?.().conversationId || null;
    });

    // === 断言 ===

    // UI 层：fileRead 卡片恰好 3 张（允许 ≥3 以应对 LLM 拆更细）
    const fileReadCount = await countToolCards(page, 'fileRead');
    expect(fileReadCount).toBeGreaterThanOrEqual(3);
    expect(fileReadCount).toBeLessThanOrEqual(4); // 软上限，避免过度派发

    // UI 层：无 dispatchSubagent 卡片
    const dispatchCount = await countToolCards(page, 'dispatchSubagent');
    expect(dispatchCount).toBe(0);

    // UI 层：无子智能体标签（data-is-subagent="true"）
    const subagentFileReadCount = await countToolCards(page, 'fileRead', true);
    expect(subagentFileReadCount).toBe(0);

    // UI 层：最终 assistant 消息包含三关键词
    const hasKeywords = await checkAssistantMessageContains(page, ['dir_a', 'dir_b', 'dir_c']);
    expect(hasKeywords).toBe(true);

    // 后端层：plans 目录不存在（或存在但不含 Plan.md/TODO.md）
    if (conversationId) {
      const plansExist = await plansDirExists(conversationId);
      expect(plansExist).toBe(false);
    }
  });
});
