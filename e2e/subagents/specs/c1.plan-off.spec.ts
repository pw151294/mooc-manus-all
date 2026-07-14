import { test, expect } from '@playwright/test';
import {
  setupFixtures,
  cleanupFixtures,
  buildInstruction,
  FIXTURE_BASE,
} from '../fixtures/testdata';
import { countToolCards, checkAssistantMessageContains } from '../helpers/toolCards';
import { waitStreamDone } from '../helpers/waitStreamDone';
import { snapshotPlansDir, findNewConversationDirs } from '../helpers/plansDir';
import { openAgentPageAndSelectModel, setPlanMode, sendMessage } from '../helpers/setupPage';

const MODEL_NAME = 'zai-org/GLM-5.2';

test.describe('C1: PlanMode=off + Subagent=off', () => {
  let plansSnapshot: Set<string> = new Set();

  test.beforeEach(async () => {
    await setupFixtures();
    plansSnapshot = await snapshotPlansDir();
  });

  test.afterEach(async () => {
    await cleanupFixtures();
  });

  test('主 Agent 直接调 fileRead，无 dispatchSubagent，无 plans 目录', async ({ page }) => {
    await openAgentPageAndSelectModel(page, MODEL_NAME);
    await setPlanMode(page, false);
    await sendMessage(page, buildInstruction(FIXTURE_BASE));
    await waitStreamDone(page);

    // === 断言 ===

    const fileReadCount = await countToolCards(page, 'fileRead');
    expect(fileReadCount, 'fileRead 卡片数应 ≥3').toBeGreaterThanOrEqual(3);
    expect(fileReadCount, 'fileRead 卡片数应 ≤4').toBeLessThanOrEqual(4);

    const dispatchCount = await countToolCards(page, 'dispatchSubagent');
    expect(dispatchCount, 'PlanMode=off 时不应有 dispatchSubagent').toBe(0);

    const subagentFileReadCount = await countToolCards(page, 'fileRead', true);
    expect(subagentFileReadCount, '不应有子智能体标记的 fileRead').toBe(0);

    const hasKeywords = await checkAssistantMessageContains(page, ['dir_a', 'dir_b', 'dir_c']);
    expect(hasKeywords, '最终消息应包含三个目录关键词').toBe(true);

    // 后端：本轮不应产生新的 plans/${cid} 目录
    const newDirs = await findNewConversationDirs(plansSnapshot);
    expect(newDirs, `不应新增 plans 目录，实际新增: ${newDirs.join(', ')}`).toHaveLength(0);
  });
});
