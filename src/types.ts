export interface PrRef {
  /** 项目名 */
  project: string;
  /** 仓库 GUID（REST API 用） */
  repoId: string;
  /** 仓库名（mirror 目录、配置路由用） */
  repoName: string;
  pullRequestId: number;
  /** git 远程地址 */
  remoteUrl: string;
}

/** 唯一标识一个 PR：project/repoName/prId */
export function prKey(pr: PrRef): string {
  return `${pr.project}/${pr.repoName}/${pr.pullRequestId}`;
}

/** 标识一个仓库：project/repoName */
export function repoKey(pr: PrRef): string {
  return `${pr.project}/${pr.repoName}`;
}

export type Severity = 'must-fix' | 'suggestion' | 'nit';

export interface Finding {
  file: string;
  line: number;
  endLine?: number;
  severity: Severity;
  title: string;
  detail: string;
  /** 质疑 pass 复核结果：confirmed=有代码依据证实；uncertain=无法证实也无法否定 */
  verification?: 'confirmed' | 'uncertain';
  /** 复核给出的代码依据（confirmed 时展示） */
  verificationNote?: string;
  /** 多模型交叉：独立发现此问题的模型数（>1 时评论中标注） */
  agreedBy?: number;
}

export interface ReviewOutput {
  summary: string;
  walkthrough?: string;
  riskLevel?: string;
  /** 给人类 reviewer 的导读：最需要人工把关的位置与可略过的部分 */
  reviewerGuide?: string;
  /** 本次 review 发现的、值得长期记住的仓库事实（代码里不明显的约定/坑/决策/术语） */
  repoMemories?: Array<{ type?: string; text: string }>;
  findings: Finding[];
  /** 增量 review：模型判定已被新提交修复的旧 finding 线程 id */
  resolvedThreadIds: number[];
  /** JSON 解析失败时为 true，summary 为模型原文 */
  degraded: boolean;
}

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug?(obj: unknown, msg?: string): void;
}

export const consoleLogger: Logger = {
  info: (o, m) => console.log(m ?? '', typeof o === 'string' ? o : JSON.stringify(o)),
  warn: (o, m) => console.warn(m ?? '', typeof o === 'string' ? o : JSON.stringify(o)),
  error: (o, m) => console.error(m ?? '', typeof o === 'string' ? o : JSON.stringify(o)),
};
