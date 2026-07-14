import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export const FIXTURE_BASE = path.join(os.homedir(), 'mooc-manus-e2e-fixtures');

export async function setupFixtures() {
  const dirs = ['dir_a', 'dir_b', 'dir_c'];

  for (const dir of dirs) {
    await fs.mkdir(path.join(FIXTURE_BASE, dir), { recursive: true });
  }

  await fs.writeFile(
    path.join(FIXTURE_BASE, 'dir_a', 'a1.txt'),
    'content of dir_a file 1\n'
  );
  await fs.writeFile(
    path.join(FIXTURE_BASE, 'dir_a', 'a2.txt'),
    'content of dir_a file 2\n'
  );
  await fs.writeFile(
    path.join(FIXTURE_BASE, 'dir_b', 'b1.txt'),
    'content of dir_b file 1\n'
  );
  await fs.writeFile(
    path.join(FIXTURE_BASE, 'dir_c', 'c1.txt'),
    'content of dir_c file 1\n'
  );

  return FIXTURE_BASE;
}

export async function cleanupFixtures() {
  try {
    await fs.rm(FIXTURE_BASE, { recursive: true, force: true });
  } catch (err) {
    // 目录不存在时静默忽略
  }
}

/**
 * 构造用户指令。
 *
 * withPlanMode=true 时强制要求先落盘 Plan.md/TODO.md 再执行任务，
 * 覆盖 LLM 因任务简单而跳过规划文件的行为（PlanMode 提示词是软约束）。
 */
export function buildInstruction(fixturePath: string, withPlanMode = false): string {
  const base = `同时读取 ${fixturePath}/dir_a、${fixturePath}/dir_b、${fixturePath}/dir_c 三个目录下所有文件并在会话展示全部内容。（请严格分别对每个目录调用 fileRead 工具，不要合并`;

  if (withPlanMode) {
    return (
      base +
      `；请**必须**先通过 fileEdit(persistent=true) 分别创建 Plan.md 与 TODO.md 两个规划文件（内容必须提及 dir_a、dir_b、dir_c 三个目录），再派遣独立子智能体分别处理三个目录，每完成一个子任务同步更新 TODO.md 的完成状态）`
    );
  }

  return base + `）`;
}
