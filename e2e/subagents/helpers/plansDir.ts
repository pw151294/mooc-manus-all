import * as fs from 'fs/promises';
import * as path from 'path';

const PLANS_BASE = path.join(
  __dirname,
  '../../../mooc-manus/data/native-workspace/plans'
);

/**
 * 检查 plans/${conversationId}/ 是否存在
 */
export async function plansDirExists(conversationId: string): Promise<boolean> {
  try {
    const stats = await fs.stat(path.join(PLANS_BASE, conversationId));
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * 读取 Plan.md 内容
 */
export async function readPlanMd(conversationId: string): Promise<string | null> {
  try {
    return await fs.readFile(
      path.join(PLANS_BASE, conversationId, 'Plan.md'),
      'utf-8'
    );
  } catch {
    return null;
  }
}

/**
 * 读取 TODO.md 内容
 */
export async function readTodoMd(conversationId: string): Promise<string | null> {
  try {
    return await fs.readFile(
      path.join(PLANS_BASE, conversationId, 'TODO.md'),
      'utf-8'
    );
  } catch {
    return null;
  }
}

/**
 * 检查文件是否存在且非空，并包含所有关键词
 */
export function checkFileContent(
  content: string | null,
  keywords: string[]
): boolean {
  if (!content || content.length === 0) return false;
  return keywords.every(kw => content.includes(kw));
}
