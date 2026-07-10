import fs from 'node:fs';
import path from 'node:path';

/**
 * 每次调用都重新读文件：改提示词无需重启服务。
 */
export function loadPrompt(promptsDir: string, name: string): string {
  return fs.readFileSync(path.join(promptsDir, name), 'utf8');
}

/** {{key}} 插值；未提供的变量替换为空串 */
export function renderTemplate(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key: string) => vars[key] ?? '');
}
