import fs from 'node:fs';
import path from 'node:path';
import type { Severity } from './types';
import { parseQuietHours, type QuietHours } from './util';

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
  /** 多模型交叉 review 的 codex profile 列表（覆盖全局 REVIEW_PROFILES） */
  profiles?: string[];
  /** 沟通风格卡（覆盖全局 PERSONA） */
  persona?: string;
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
  /**
   * 多模型交叉 review 的 profile 列表，独立 review 后合并 findings。
   * 支持 engine 前缀：'deepseek'（默认引擎的 profile）、'claude'、'claude:opus'、
   * 'codex:deepseek'。'default' = 默认引擎默认配置。
   */
  reviewProfiles: string[];
  /** 无 engine 前缀时使用的默认引擎 */
  reviewEngine: 'codex' | 'claude';
  claudeBin: string;
  claudeExtraArgs: string[];
  /** 沟通风格卡，注入 review/问答/修复的提示词 */
  persona: string;
  /** 优雅停机时等待在跑任务收尾的最长时间（毫秒） */
  shutdownGraceMs: number;
  /** 公开只读状态页 /status（不含错误详情）；false 关闭 */
  statusPage: boolean;

  maxInlineComments: number;
  maxChangedFiles: number;
  promptsDir: string;

  /** review 后追加一轮「质疑 pass」复核 findings，过滤假阳性 */
  challengeEnabled: boolean;
  /** 每周一 09:00（服务器时区）向 IM 渠道推送度量周报 */
  weeklyReportEnabled: boolean;
  /** /fix 命令全局默认开关（默认关，安全起见按仓库 opt-in） */
  fixEnabled: boolean;
  /** /fix 护栏：改动文件数/行数超限直接拒绝 push */
  fixMaxFiles: number;
  fixMaxLines: number;
  /** 仓库知识库：首次 review 后生成架构摘要，注入后续 review/问答 */
  knowledgeEnabled: boolean;
  knowledgeTtlDays: number;
  /** dream：每周日 03:00 用模型整理各仓库长期记忆（合并/淘汰/归纳） */
  dreamEnabled: boolean;

  notify: NotifyConfig;
  /** 通知静默时段（如 21-9）：期间通知积压，结束时汇总发出；review 本身照跑 */
  quietHours?: QuietHours;
  /** 触发筛选：这些扩展名/文件名的变更不算需要 review 的变更（全中则跳过 review） */
  reviewIgnoreExtensions: string[];
  reviewIgnoreFilenames: string[];
  /** RocketChat outgoing webhook 的 token（双向问答鉴权），不配则该端点关闭 */
  rocketchatOutgoingToken?: string;
  /** RC REST 身份（自由问答/线程/讨论需要）；三项齐全才启用 */
  rocketchatUrl?: string;
  rocketchatBotUserId?: string;
  rocketchatBotToken?: string;
  /** 按 project/repoName 覆盖，来自 BOT_CONFIG_FILE 指向的 JSON */
  repoOverrides: Record<string, RepoOverrides>;
  /** ADO 账号（uniqueName 或 displayName）→ RocketChat 用户名，通知 @ 人用；来自 BOT_CONFIG_FILE */
  userMap: Record<string, string>;
  /** RC 频道名 → 默认仓库（自由问答没写明仓库时用）；来自 BOT_CONFIG_FILE */
  channelRepos: Record<string, string>;
}

/** 默认沟通风格卡：决定 review 评论 / 问答 / 修复说明的语气（可用 PERSONA 或 .ai-review.yml persona 覆盖） */
export const DEFAULT_PERSONA =
  '你是一位资深而友善的同事型评审者：指出问题时先说清楚在什么场景下会出什么事（给证据、给复现路径），' +
  '再给出具体改法；语气直接但不居高临下，不说教、不打官腔、不堆砌客套话；对事不对人，' +
  '认可作者合理的设计取舍。用自然的中文表达，能一句话说清的不展开长篇。';

/** 默认不值得 review 的扩展名（图片/字体/二进制/媒体） */
export const DEFAULT_IGNORE_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pdf', '.zip', '.7z', '.tar', '.gz', '.exe', '.dll', '.so', '.dylib', '.bin',
  '.mp3', '.mp4', '.mov', '.avi',
];

/** 默认不值得 review 的文件名（各语言 lockfile） */
export const DEFAULT_IGNORE_FILENAMES = [
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json',
  'uv.lock', 'poetry.lock', 'Pipfile.lock',
  'Cargo.lock', 'go.sum', 'composer.lock', 'Gemfile.lock', 'packages.lock.json',
];

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
  let userMap: Record<string, string> = {};
  let channelRepos: Record<string, string> = {};
  if (configFile && fs.existsSync(configFile)) {
    const parsed = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    repoOverrides = parsed.repoOverrides ?? {};
    userMap = parsed.userMap ?? {};
    channelRepos = parsed.channelRepos ?? {};
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
    reviewProfiles: (env.REVIEW_PROFILES ?? 'default')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    reviewEngine: env.REVIEW_ENGINE === 'claude' ? 'claude' : 'codex',
    claudeBin: env.CLAUDE_BIN ?? 'claude',
    claudeExtraArgs: (env.CLAUDE_EXTRA_ARGS ?? '').split(/\s+/).filter(Boolean),
    persona: env.PERSONA || DEFAULT_PERSONA,
    shutdownGraceMs: num(env, 'SHUTDOWN_GRACE_MS', 2 * 60 * 1000),
    statusPage: env.STATUS_PAGE !== 'false',

    maxInlineComments: num(env, 'MAX_INLINE_COMMENTS', 10),
    maxChangedFiles: num(env, 'MAX_CHANGED_FILES', 50),
    promptsDir: env.PROMPTS_DIR ?? path.resolve('prompts'),

    challengeEnabled: env.CHALLENGE_ENABLED !== 'false',
    weeklyReportEnabled: env.WEEKLY_REPORT_ENABLED === 'true',
    fixEnabled: env.FIX_ENABLED === 'true',
    fixMaxFiles: num(env, 'FIX_MAX_FILES', 10),
    fixMaxLines: num(env, 'FIX_MAX_LINES', 300),
    knowledgeEnabled: env.KNOWLEDGE_ENABLED !== 'false',
    knowledgeTtlDays: num(env, 'KNOWLEDGE_TTL_DAYS', 14),
    dreamEnabled: env.DREAM_ENABLED !== 'false',

    notify: {
      rocketchatWebhookUrl: env.ROCKETCHAT_WEBHOOK_URL || undefined,
      wecomWebhookKey: env.WECOM_WEBHOOK_KEY || undefined,
      events,
    },
    quietHours: parseQuietHours(env.QUIET_HOURS),
    reviewIgnoreExtensions: env.REVIEW_IGNORE_EXTENSIONS
      ? env.REVIEW_IGNORE_EXTENSIONS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      : DEFAULT_IGNORE_EXTENSIONS,
    reviewIgnoreFilenames: env.REVIEW_IGNORE_FILENAMES
      ? env.REVIEW_IGNORE_FILENAMES.split(',').map((s) => s.trim()).filter(Boolean)
      : DEFAULT_IGNORE_FILENAMES,
    rocketchatOutgoingToken: env.ROCKETCHAT_OUTGOING_TOKEN || undefined,
    rocketchatUrl: env.ROCKETCHAT_URL || undefined,
    rocketchatBotUserId: env.ROCKETCHAT_BOT_USER_ID || undefined,
    rocketchatBotToken: env.ROCKETCHAT_BOT_TOKEN || undefined,
    repoOverrides,
    userMap,
    channelRepos,
  };
}
