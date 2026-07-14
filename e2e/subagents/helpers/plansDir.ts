import * as fs from 'fs/promises';
import * as path from 'path';

const PLANS_BASE = path.join(
  __dirname,
  '../../../mooc-manus/data/native-workspace/plans'
);

/**
 * 快照 plans 目录当前存在的所有 conversationId
 */
export async function snapshotPlansDir(): Promise<Set<string>> {
  try {
    const entries = await fs.readdir(PLANS_BASE, { withFileTypes: true });
    return new Set(
      entries.filter(e => e.isDirectory()).map(e => e.name)
    );
  } catch {
    return new Set();
  }
}

/**
 * 找出快照之后新增的目录（用于失败诊断与断言）
 */
export async function findNewConversationDirs(
  before: Set<string>
): Promise<string[]> {
  try {
    const entries = await fs.readdir(PLANS_BASE, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && !before.has(e.name))
      .map(e => e.name);
  } catch {
    return [];
  }
}

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
