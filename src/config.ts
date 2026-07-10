import fs from 'node:fs';
import path from 'node:path';
import type { Severity } from './types';

export interface NotifyConfig {
  rocketchatWebhookUrl?: string;
  /** 企业微信群机器人 key（或完整 webhook URL） */
  wecomWebhookKey?: string;
  /** 推送哪些事件，默认全部 */
  events: Array<'review_completed' | 'must_fix_found' | 'job_failed' | 'weekly_report'>;
}

/** 单仓库覆盖项（bot 侧配置文件，优先级低于仓库内 .ai-review.yml） */
export interface RepoOverrides {
  autoReview?: boolean;
  maxInlineComments?: number;
  minSeverity?: Severity;
  ignorePaths?: string[];
  focus?: string;
  challenge?: boolean;
  allowFix?: boolean;
  knowledgeBase?: boolean;
  notify?: Partial<NotifyConfig>;
}

export interface Config {
  host: string;
  port: number;

  /** collection URL，如 https://ado.corp.local/DefaultCollection */
  adoUrl: string;
  adoPat: string;
  /** Service Hook 订阅里配置的密钥（basic auth 密码或 x-webhook-secret 头） */
  webhookSecret: string;

  /** bot 服务账号的 identity GUID（过滤自触发 + mention 匹配）；留空则启动时经 connectionData 自动获取 */
  botAccountId: string;
  /** bot 显示名（纯文本 @ 匹配），如 ai-review-bot */
  botDisplayName: string;

  debounceMs: number;
  reviewConcurrency: number;
  qaConcurrency: number;

  /** mirror / worktree / sqlite 的根目录 */
  dataDir: string;

  codexBin: string;
  codexTimeoutMs: number;
  codexSandbox: string;
  codexExtraArgs: string[];
  /** 非超时失败的自动重试次数 */
  codexRetries: number;

  maxInlineComments: number;
  maxChangedFiles: number;
  promptsDir: string;

  /** review 后追加一轮「质疑 pass」复核 findings，过滤假阳性 */
  challengeEnabled: boolean;
  /** 每周一 09:00（服务器时区）向 IM 渠道推送度量周报 */
  weeklyReportEnabled: boolean;
  /** /fix 命令全局默认开关（默认关，安全起见按仓库 opt-in） */
  fixEnabled: boolean;
  /** 仓库知识库：首次 review 后生成架构摘要，注入后续 review/问答 */
  knowledgeEnabled: boolean;
  knowledgeTtlDays: number;

  notify: NotifyConfig;
  /** 按 project/repoName 覆盖，来自 BOT_CONFIG_FILE 指向的 JSON */
  repoOverrides: Record<string, RepoOverrides>;
}

function req(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`缺少必需的环境变量 ${name}`);
  return v;
}

function num(env: NodeJS.ProcessEnv, name: string, def: number): number {
  const v = env[name];
  if (!v) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`环境变量 ${name} 不是数字: ${v}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const configFile = env.BOT_CONFIG_FILE;
  let repoOverrides: Record<string, RepoOverrides> = {};
  if (configFile && fs.existsSync(configFile)) {
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    repoOverrides = parsed.repoOverrides ?? {};
  }

  const events = (env.NOTIFY_EVENTS ?? 'review_completed,must_fix_found,job_failed,weekly_report')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as NotifyConfig['events'];

  return {
    host: env.HOST ?? '0.0.0.0',
    port: num(env, 'PORT', 3000),

    adoUrl: req(env, 'ADO_URL').replace(/\/+$/, ''),
    adoPat: req(env, 'ADO_PAT'),
    webhookSecret: req(env, 'WEBHOOK_SECRET'),

    botAccountId: env.BOT_ACCOUNT_ID ?? '',
    botDisplayName: env.BOT_DISPLAY_NAME ?? 'ai-review-bot',

    debounceMs: num(env, 'DEBOUNCE_MS', 3 * 60 * 1000),
    reviewConcurrency: num(env, 'REVIEW_CONCURRENCY', 2),
    qaConcurrency: num(env, 'QA_CONCURRENCY', 2),

    dataDir: env.DATA_DIR ?? path.resolve('data'),

    codexBin: env.CODEX_BIN ?? 'codex',
    codexTimeoutMs: num(env, 'CODEX_TIMEOUT_MS', 15 * 60 * 1000),
    codexSandbox: env.CODEX_SANDBOX ?? 'read-only',
    codexExtraArgs: (env.CODEX_EXTRA_ARGS ?? '').split(/\s+/).filter(Boolean),
    codexRetries: num(env, 'CODEX_RETRIES', 1),

    maxInlineComments: num(env, 'MAX_INLINE_COMMENTS', 10),
    maxChangedFiles: num(env, 'MAX_CHANGED_FILES', 50),
    promptsDir: env.PROMPTS_DIR ?? path.resolve('prompts'),

    challengeEnabled: env.CHALLENGE_ENABLED !== 'false',
    weeklyReportEnabled: env.WEEKLY_REPORT_ENABLED === 'true',
    fixEnabled: env.FIX_ENABLED === 'true',
    knowledgeEnabled: env.KNOWLEDGE_ENABLED !== 'false',
    knowledgeTtlDays: num(env, 'KNOWLEDGE_TTL_DAYS', 14),

    notify: {
      rocketchatWebhookUrl: env.ROCKETCHAT_WEBHOOK_URL || undefined,
      wecomWebhookKey: env.WECOM_WEBHOOK_KEY || undefined,
      events,
    },
    repoOverrides,
  };
}
