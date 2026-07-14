import { Page, expect } from '@playwright/test';

/**
 * 打开 /agent 页面，选择指定模型并点击"应用"按钮激活配置。
 *
 * 流程：
 *   1. goto /agent
 *   2. 等模型 Select 出现（placeholder="请选择模型配置"）
 *   3. 点击展开下拉框
 *   4. 严格匹配选项 title=modelName（Ant Design option 外层 div 会带 title 属性）
 *   5. 点击"应用"按钮
 */
export async function openAgentPageAndSelectModel(
  page: Page,
  modelName: string
) {
  await page.goto('/agent');
  await page.waitForLoadState('networkidle');

  // 模型 Select 是"能力装配"面板中第一个 combobox
  // 用 Ant Design combobox role 定位 + 通过 placeholder 属性精准匹配
  const modelSelect = page
    .getByRole('combobox')
    .and(page.locator('[aria-controls*="_list"]'))
    .first();

  // 若上面策略失败（antd 版本差异），回退：找包含"请选择模型配置"文本的第一个 .ant-select
  const modelSelectFallback = page
    .locator('.ant-select')
    .filter({ hasText: '请选择模型配置' })
    .or(page.locator('.ant-select-selector').filter({ hasText: '请选择模型配置' }))
    .first();

  // 优先用 combobox role，若失败切换到 fallback
  const target = modelSelect.or(modelSelectFallback).first();
  await target.waitFor({ state: 'visible', timeout: 10_000 });
  await target.click();

  // 下拉打开后，Ant Design 会把 popup 挂到 body 下的 .ant-select-dropdown
  // option 外层是 .ant-select-item-option[title="${modelName}"]
  const option = page
    .locator('.ant-select-item-option')
    .filter({ has: page.locator(`[title="${modelName}"]`) })
    .or(page.locator(`.ant-select-item-option[title="${modelName}"]`))
    .first();

  await option.waitFor({ state: 'visible', timeout: 5_000 });
  await option.click();

  // 等待下拉关闭
  await page.waitForTimeout(300);

  // 点击"应用"按钮（Ant Design 会自动在两个汉字之间插空格 → 实际文本为"应 用"）
  const applyButton = page
    .getByRole('button', { name: /^应\s*用$/ })
    .first();
  await applyButton.click({ timeout: 10_000 });

  // 验证：出现成功提示（Ant Design message）或按钮不再 disabled
  // 这里给个短等待让 store 刷新
  await page.waitForTimeout(500);
}

/**
 * 打开或关闭 PlanMode 开关，最终把状态设置为 desired
 */
export async function setPlanMode(page: Page, desired: boolean) {
  const planModeSwitch = page
    .locator('[data-testid="plan-mode-switch"]')
    .or(
      page.locator('.ant-switch').filter({
        has: page.locator('..').filter({ hasText: '规划模式' }),
      })
    )
    .first();

  await planModeSwitch.waitFor({ state: 'visible', timeout: 5_000 });

  const isChecked = (await planModeSwitch.getAttribute('aria-checked')) === 'true';
  if (isChecked !== desired) {
    await planModeSwitch.click();
    await page.waitForTimeout(200);
  }

  await expect(planModeSwitch).toHaveAttribute('aria-checked', String(desired));
}

/**
 * 发送消息：填充输入框 → 点发送
 */
export async function sendMessage(page: Page, text: string) {
  // 用 placeholder 精准定位聊天输入框（避开"系统提示词"输入框）
  const inputBox = page
    .locator('textarea[placeholder*="请输入消息"]')
    .first();

  await inputBox.waitFor({ state: 'visible' });
  await inputBox.click();
  await inputBox.fill(text);

  // 发送按钮：Ant Design 的 Button 也可能带汉字空格 → 用 accessible name "send 发送" 或严格文本
  const sendButton = page
    .locator('[data-testid="send-button"]')
    .or(page.getByRole('button', { name: /发\s*送/ }))
    .first();

  // 等待按钮从 disabled 恢复（输入非空后应立即启用）
  await sendButton.waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => {
      const btn = document.querySelector(
        '[data-testid="send-button"]'
      ) as HTMLButtonElement | null;
      return btn ? !btn.disabled : false;
    },
    undefined,
    { timeout: 5_000 }
  );

  await sendButton.click();
}
