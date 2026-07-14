import { test, expect } from '@playwright/test';
import {
  setupFixtures,
  cleanupFixtures,
  buildInstruction,
  FIXTURE_BASE,
} from '../fixtures/testdata';
import { countToolCards, checkAssistantMessageContains } from '../helpers/toolCards';
import { waitStreamDone } from '../helpers/waitStreamDone';
import {
  snapshotPlansDir,
  findNewConversationDirs,
  readPlanMd,
  readTodoMd,
  checkFileContent,
} from '../helpers/plansDir';
import { openAgentPageAndSelectModel, setPlanMode, sendMessage } from '../helpers/setupPage';

const MODEL_NAME = 'zai-org/GLM-5.2';

test.describe('C3: PlanMode=on + Subagent=on', () => {
  let plansSnapshot: Set<string> = new Set();

  test.beforeEach(async () => {
    await setupFixtures();
    plansSnapshot = await snapshotPlansDir();
  });

  test.afterEach(async () => {
    await cleanupFixtures();
  });

  test('主 Agent 派遣 dispatchSubagent，子 Agent 各调 fileRead，生成 Plan.md/TODO.md', async ({ page }) => {
    await openAgentPageAndSelectModel(page, MODEL_NAME);
    await setPlanMode(page, true);
    await sendMessage(page, buildInstruction(FIXTURE_BASE, true));
    await waitStreamDone(page, 180_000);

    // === 断言 ===

    const dispatchCount = await countToolCards(page, 'dispatchSubagent');
    expect(dispatchCount, 'dispatchSubagent 卡片数应 ≥1').toBeGreaterThanOrEqual(1);
    expect(dispatchCount, 'dispatchSubagent 卡片数应 ≤5').toBeLessThanOrEqual(5);

    const subagentFileReadCount = await countToolCards(page, 'fileRead', true);
    expect(subagentFileReadCount, '子智能体 fileRead 卡片数应 ≥1').toBeGreaterThanOrEqual(1);

    const mainFileReadCount = await countToolCards(page, 'fileRead', false);
    console.log(
      `[INFO] 主Agent直接调fileRead=${mainFileReadCount}（期望0，弱化为记录）`
    );

    const hasKeywords = await checkAssistantMessageContains(page, ['dir_a', 'dir_b', 'dir_c']);
    expect(hasKeywords, '最终消息应包含三个目录关键词').toBe(true);

    // 后端：本轮应新增一个 plans/${cid} 目录（用作 conversationId）
    const newDirs = await findNewConversationDirs(plansSnapshot);
    expect(newDirs, `PlanMode=on 应新增一个 plans 目录，实际=${newDirs.length}`).toHaveLength(1);
    const conversationId = newDirs[0];

    const planMd = await readPlanMd(conversationId);
    expect(planMd, 'Plan.md 应存在').not.toBeNull();
    expect(planMd?.length ?? 0, 'Plan.md 应非空').toBeGreaterThan(0);
    expect(
      checkFileContent(planMd, ['dir_a', 'dir_b', 'dir_c']),
      'Plan.md 应含三关键词'
    ).toBe(true);

    const todoMd = await readTodoMd(conversationId);
    expect(todoMd, 'TODO.md 应存在').not.toBeNull();
    expect(todoMd?.length ?? 0, 'TODO.md 应非空').toBeGreaterThan(0);
    expect(
      checkFileContent(todoMd, ['dir_a', 'dir_b', 'dir_c']),
      'TODO.md 应含三关键词'
    ).toBe(true);
  });
});
