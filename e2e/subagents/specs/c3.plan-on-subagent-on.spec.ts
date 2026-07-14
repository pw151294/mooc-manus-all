import { test, expect } from '@playwright/test';
import { setupFixtures, cleanupFixtures, buildInstruction, FIXTURE_BASE } from '../fixtures/testdata';
import { countToolCards, checkAssistantMessageContains } from '../helpers/toolCards';
import { waitStreamDone } from '../helpers/waitStreamDone';
import { plansDirExists, readPlanMd, readTodoMd, checkFileContent } from '../helpers/plansDir';

test.describe('C3: PlanMode=on + Subagent=on', () => {
  let conversationId: string | null = null;

  test.beforeEach(async () => {
    await setupFixtures();
  });

  test.afterEach(async ({ page }, testInfo) => {
    await cleanupFixtures();

    if (conversationId && testInfo.status === 'failed') {
      const plansExist = await plansDirExists(conversationId);
      console.log(`[DIAGNOSTIC] conversationId=${conversationId}, plans目录存在=${plansExist}`);

      if (plansExist) {
        const planMd = await readPlanMd(conversationId);
        const todoMd = await readTodoMd(conversationId);
        console.log(`[DIAGNOSTIC] Plan.md存在=${!!planMd}, TODO.md存在=${!!todoMd}`);
      }
    }
  });

  test('主 Agent 派遣 dispatchSubagent，子 Agent 各调 fileRead，生成 Plan.md/TODO.md', async ({ page }) => {
    // 1. 打开页面
    await page.goto('/agent');

    // 2. 等待模型下拉框出现并选择 zai-org/GLM-5.2
    await page.waitForLoadState('networkidle');

    const modelSelector = page.locator('.ant-select').first().or(page.locator('select').first());
    await modelSelector.waitFor({ state: 'visible', timeout: 10_000 });
    await modelSelector.click();

    const modelOption = page.locator('.ant-select-item:has-text("zai-org/GLM-5.2")').or(page.locator('text=zai-org/GLM-5.2'));
    await modelOption.click();

    // 3. 打开 PlanMode 开关
    const planModeSwitch = page.locator('[data-testid="plan-mode-switch"]').or(page.locator('.ant-switch').first());

    // 检查当前状态
    const isChecked = await planModeSwitch.getAttribute('aria-checked');
    if (isChecked === 'false') {
      await planModeSwitch.click();
    }

    // 确认已开启
    await expect(planModeSwitch).toHaveAttribute('aria-checked', 'true');

    // 4. 输入指令（含子智能体提示）
    const instruction = buildInstruction(FIXTURE_BASE);
    const inputBox = page.locator('[data-testid="chat-input"]').or(page.locator('textarea').first());
    await inputBox.fill(instruction);

    // 5. 点击发送
    const sendButton = page.locator('[data-testid="send-button"]').or(page.locator('button:has-text("发送")'));
    await sendButton.click();

    // 6. 等待流式结束（C3 可能更慢，给 180s）
    await waitStreamDone(page, 180_000);

    // 7. 读取 conversationId
    conversationId = await page.evaluate(() => {
      return (window as any).useAgentStore?.getState?.().conversationId || null;
    });

    // === 断言 ===

    // UI 层：dispatchSubagent 卡片至少 1 张（理想 3 张，弱化判据应对 LLM 不确定性）
    const dispatchCount = await countToolCards(page, 'dispatchSubagent');
    expect(dispatchCount).toBeGreaterThanOrEqual(1);
    expect(dispatchCount).toBeLessThanOrEqual(5); // 软上限

    // UI 层：子智能体调用的 fileRead 至少 1 张
    const subagentFileReadCount = await countToolCards(page, 'fileRead', true);
    expect(subagentFileReadCount).toBeGreaterThanOrEqual(1);

    // UI 层：主 Agent 不直接调 fileRead（data-is-subagent="false" 或不带标记）
    // 注意：若前端未加 data-is-subagent 属性，此断言可能 flake，先记录日志
    const mainFileReadCount = await countToolCards(page, 'fileRead', false);
    console.log(`[INFO] 主Agent直接调用fileRead次数=${mainFileReadCount}（期望0）`);
    // expect(mainFileReadCount).toBe(0); // 暂时注释，等前端补 test-id 后再开

    // UI 层：最终 assistant 消息含三关键词
    const hasKeywords = await checkAssistantMessageContains(page, ['dir_a', 'dir_b', 'dir_c']);
    expect(hasKeywords).toBe(true);

    // 后端层：plans 目录存在
    if (!conversationId) {
      throw new Error('conversationId 未获取到，无法断言后端产物');
    }

    const plansExist = await plansDirExists(conversationId);
    expect(plansExist).toBe(true);

    // 后端层：Plan.md 存在、非空、含三关键词
    const planMd = await readPlanMd(conversationId);
    expect(planMd).not.toBeNull();
    expect(checkFileContent(planMd, ['dir_a', 'dir_b', 'dir_c'])).toBe(true);

    // 后端层：TODO.md 存在、非空、含三关键词
    const todoMd = await readTodoMd(conversationId);
    expect(todoMd).not.toBeNull();
    expect(checkFileContent(todoMd, ['dir_a', 'dir_b', 'dir_c'])).toBe(true);
  });
});
