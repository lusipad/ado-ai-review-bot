import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Config, RepoOverrides } from './config';
import type { Finding, Logger, ReviewOutput, Severity } from './types';
import { prKey as toPrKey, repoKey as toRepoKey } from './types';
import { findingFingerprint, truncateUtf8Bytes } from './util';
import { AdoClient } from './ado/client';
import { parsePrResource, type PrInfo } from './ado/events';
import { StateDb } from './state/db';
import { Workspace } from './repo/workspace';
import { loadPrompt, renderTemplate } from './engine/prompts';
import { runCodex, parseReviewOutput, type CodexRunResult } from './engine/codex';
import { NotifyDispatcher } from './notify';

const SEVERITY_RANK: Record<Severity, number> = { 'must-fix': 0, suggestion: 1, nit: 2 };
const SEVERITY_LABEL: Record<Severity, string> = {
  'must-fix': '🔴 必须修复',
  suggestion: '🟡 建议',
  nit: '🔵 细节',
};
/** diff 塞进提示词的字节上限，超出截断（agent 会在 worktree 里自己看） */
const MAX_DIFF_BYTES = 300_000;

/** 仓库内 .ai-review.yml 支持的字段 */
interface RepoYamlConfig {
  autoReview?: boolean;
  maxInlineComments?: number;
  minSeverity?: Severity;
  ignorePaths?: string[];
  focus?: string;
}

interface EffectiveRepoConfig extends Required<Pick<RepoYamlConfig, 'autoReview' | 'maxInlineComments' | 'minSeverity'>> {
  ignorePaths: string[];
  focus: string;
}

export interface QaJob {
  pr: PrInfo;
  threadId: number;
  commentId: number;
  question: string;
}

export type CodexRunner = (worktree: string, prompt: string) => Promise<CodexRunResult>;

export interface PipelineDeps {
  config: Config;
  db: StateDb;
  ado: AdoClient;
  workspace: Workspace;
  notify: NotifyDispatcher;
  logger: Logger;
  /** 可注入，测试时替换真实 codex 子进程 */
  codexRun?: CodexRunner;
}

export class Pipeline {
  private readonly codexRun: CodexRunner;

  constructor(private readonly deps: PipelineDeps) {
    this.codexRun =
      deps.codexRun ??
      ((worktree, prompt) =>
        runCodex(
          {
            bin: deps.config.codexBin,
            sandbox: deps.config.codexSandbox,
            timeoutMs: deps.config.codexTimeoutMs,
            extraArgs: deps.config.codexExtraArgs,
            logger: deps.logger,
          },
          worktree,
          prompt,
        ));
  }

  // ---------- 全量 review ----------

  async runFullReview(pr: PrInfo, reason: string, manual = false): Promise<void> {
    await this.runReview(pr, 'full', reason, manual);
  }

  async runIncrementalReview(pr: PrInfo): Promise<void> {
    await this.runReview(pr, 'incremental', 'push 更新', false);
  }

  private async runReview(
    prStale: PrInfo,
    kind: 'full' | 'incremental',
    reason: string,
    manual: boolean,
  ): Promise<void> {
    const { config, db, ado, workspace, notify, logger } = this.deps;

    // 事件可能已过时（尤其防抖之后），以 ADO 当前状态为准
    const fresh = await ado.getPullRequest(prStale);
    const pr: PrInfo = { ...prStale, ...parsePrResource(fresh, config.adoUrl), remoteUrl: prStale.remoteUrl };
    const key = toPrKey(pr);
    const rKey = toRepoKey(pr);

    if (pr.status !== 'active' || pr.isDraft) {
      logger.info({ key, status: pr.status, isDraft: pr.isDraft }, '跳过：PR 非 active 或已回到草稿');
      return;
    }
    if (!pr.sourceCommit) {
      logger.warn({ key }, '跳过：PR 缺少源 commit');
      return;
    }

    const prior = db.getPrState(key);
    // 增量但没有基线 → 升级为全量
    if (kind === 'incremental' && !prior?.lastReviewedCommit) {
      kind = 'full';
      reason = '首次 review（无增量基线）';
    }
    // 防抖窗口后 commit 已被 review 过（例如手动 /review 先跑了）
    if (kind === 'incremental' && prior?.lastReviewedCommit === pr.sourceCommit) {
      logger.info({ key }, '跳过：该 commit 已 review 过');
      return;
    }

    await workspace.ensureMirror(rKey, pr.remoteUrl);
    const repoConf = this.effectiveRepoConfig(rKey, undefined);
    if (!repoConf.autoReview && !manual) {
      logger.info({ key }, '跳过：该仓库已关闭自动 review');
      return;
    }

    logger.info({ key, kind, reason }, '开始 review');
    await ado
      .setPrStatus(pr, { state: 'pending', description: `AI review 进行中（${reason}）` })
      .catch((err) => logger.warn({ err: String(err) }, '设置 PR status 失败'));

    const checkoutCommit = pr.mergeCommit ?? pr.sourceCommit;
    const conflictNote = pr.mergeCommit
      ? ''
      : '注意：该 PR 存在合并冲突，本次 review 基于源分支代码（非预合并结果）。';
    let worktree: string | undefined;

    try {
      worktree = await workspace.createWorktree(
        rKey,
        checkoutCommit,
        `pr-${pr.pullRequestId}-${Date.now()}`,
      );
      // worktree 内的 .ai-review.yml 优先级最高，拿到代码后重新合并一次
      const conf = this.effectiveRepoConfig(rKey, worktree);
      if (!conf.autoReview && !manual) {
        logger.info({ key }, '跳过：仓库 .ai-review.yml 关闭了自动 review');
        return;
      }

      const { diffText, changedFiles, degradedDiff } = await this.collectDiff(pr, rKey, kind, prior?.lastReviewedCommit, conf);

      const openFindings = db.listOpenFindings(key);
      const template = loadPrompt(config.promptsDir, kind === 'full' ? 'review-full.md' : 'review-incremental.md');
      const prompt = renderTemplate(template, {
        pr_title: pr.title,
        pr_description: pr.description || '（无描述）',
        source_branch: pr.sourceRefName.replace('refs/heads/', ''),
        target_branch: pr.targetRefName.replace('refs/heads/', ''),
        changed_files: changedFiles.join('\n'),
        diff: diffText,
        focus: conf.focus,
        conflict_note: conflictNote,
        degraded_note: degradedDiff
          ? `变更规模较大（${changedFiles.length} 个文件），diff 已截断，请在仓库中直接查看关键文件。`
          : '',
        open_findings: openFindings.length
          ? openFindings
              .map((f) => `- [threadId=${f.threadId}] ${f.file}:${f.line} ${f.title}`)
              .join('\n')
          : '（无）',
      });

      const result = await this.codexRun(worktree, prompt);
      if (!result.ok) throw new Error(result.error ?? 'codex 执行失败');
      const output = parseReviewOutput(result.output);

      await this.publishReview(pr, key, rKey, kind, output, conf, openFindings);

      db.upsertPrState(key, {
        isDraft: false,
        lastReviewedCommit: pr.sourceCommit,
        lastSourceCommit: pr.sourceCommit,
      });

      await ado
        .setPrStatus(pr, { state: 'succeeded', description: this.statusDescription(output) })
        .catch((err) => logger.warn({ err: String(err) }, '设置 PR status 失败'));

      this.notifyReviewDone(pr, rKey, output);
      logger.info({ key, findings: output.findings.length, degraded: output.degraded }, 'review 完成');
    } catch (err) {
      logger.error({ key, err: String(err) }, 'review 失败');
      await ado
        .setPrStatus(pr, { state: 'failed', description: 'AI review 执行失败，可评论 /review 重试' })
        .catch(() => undefined);
      notify.dispatch({
        type: 'job_failed',
        repoKey: rKey,
        title: `AI review 失败：${pr.title}`,
        text: `${key}\n${String(err).slice(0, 500)}`,
        url: ado.prWebUrl(pr),
      });
      throw err;
    } finally {
      if (worktree) await workspace.removeWorktree(rKey, worktree);
    }
  }

  private async collectDiff(
    pr: PrInfo,
    rKey: string,
    kind: 'full' | 'incremental',
    lastReviewedCommit: string | undefined,
    conf: EffectiveRepoConfig,
  ): Promise<{ diffText: string; changedFiles: string[]; degradedDiff: boolean }> {
    const { workspace, config } = this.deps;
    let raw: string;
    let files: string[];
    if (kind === 'incremental' && lastReviewedCommit) {
      raw = await workspace.rangeDiff(rKey, lastReviewedCommit, pr.sourceCommit!);
      files = await workspace.changedFiles(rKey, lastReviewedCommit, pr.sourceCommit!, false);
    } else {
      raw = await workspace.prDiff(rKey, pr.targetCommit!, pr.sourceCommit!);
      files = await workspace.changedFiles(rKey, pr.targetCommit!, pr.sourceCommit!, true);
    }
    files = files.filter((f) => !this.isIgnored(f, conf.ignorePaths));

    let degraded = false;
    let diffText = raw;
    if (files.length > config.maxChangedFiles || Buffer.byteLength(raw, 'utf8') > MAX_DIFF_BYTES) {
      degraded = true;
      diffText = truncateUtf8Bytes(raw, MAX_DIFF_BYTES, '\n…（diff 已截断）');
    }
    return { diffText, changedFiles: files, degradedDiff: degraded };
  }

  // ---------- 结果发布 ----------

  private async publishReview(
    pr: PrInfo,
    key: string,
    rKey: string,
    kind: 'full' | 'incremental',
    output: ReviewOutput,
    conf: EffectiveRepoConfig,
    openFindings: ReturnType<StateDb['listOpenFindings']>,
  ): Promise<void> {
    const { ado, db, logger } = this.deps;

    // 1) 过滤 + 排序 + 指纹去重
    const eligible = output.findings
      .filter((f) => SEVERITY_RANK[f.severity] <= SEVERITY_RANK[conf.minSeverity])
      .filter((f) => !this.isIgnored(f.file, conf.ignorePaths))
      .filter((f) => !db.hasFingerprint(key, findingFingerprint(f.file, f.title)))
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

    const inline = eligible.slice(0, conf.maxInlineComments);
    const overflow = eligible.slice(conf.maxInlineComments);

    // 2) 行内评论
    for (const f of inline) {
      try {
        const thread = await ado.createThread(pr, {
          comments: [{ content: this.formatFindingComment(f), commentType: 1 }],
          status: 'active',
          threadContext: {
            filePath: '/' + f.file,
            rightFileStart: { line: f.line, offset: 1 },
            rightFileEnd: { line: f.endLine ?? f.line, offset: 1 },
          },
        });
        db.insertFinding({
          prKey: key,
          fingerprint: findingFingerprint(f.file, f.title),
          threadId: thread.id,
          severity: f.severity,
          file: f.file,
          title: f.title,
          line: f.line,
        });
      } catch (err) {
        // 行号越界等导致创建失败 → 归并进总评，不让单条失败中断整个发布
        logger.warn({ file: f.file, line: f.line, err: String(err) }, '行内评论创建失败，归并进总评');
        overflow.push(f);
      }
    }

    // 3) 增量：自动关闭已修复的旧 finding 线程
    if (kind === 'incremental') {
      const openByThread = new Map(openFindings.map((f) => [f.threadId, f]));
      for (const threadId of output.resolvedThreadIds) {
        if (!openByThread.has(threadId)) continue;
        try {
          await ado.replyToThread(pr, threadId, '✅ 该问题已在最新提交中修复。');
          await ado.updateThreadStatus(pr, threadId, 'fixed');
          db.markFindingFixed(key, threadId);
        } catch (err) {
          logger.warn({ threadId, err: String(err) }, '关闭已修复线程失败');
        }
      }
    }

    // 4) 总评（编辑同一条，不新发）
    const summaryContent = this.formatSummaryComment(pr, kind, output, inline.length, overflow);
    const state = db.getPrState(key);
    let updated = false;
    if (state?.summaryThreadId) {
      updated = await ado
        .updateThreadFirstComment(pr, state.summaryThreadId, summaryContent)
        .catch(() => false);
    }
    if (!updated) {
      const thread = await ado.createThread(pr, {
        comments: [{ content: summaryContent, commentType: 1 }],
        status: 'closed',
      });
      db.upsertPrState(key, { summaryThreadId: thread.id });
    }
  }

  private formatFindingComment(f: Finding): string {
    return `**${SEVERITY_LABEL[f.severity]}** ${f.title}\n\n${f.detail}`;
  }

  private formatSummaryComment(
    pr: PrInfo,
    kind: 'full' | 'incremental',
    output: ReviewOutput,
    inlineCount: number,
    overflow: Finding[],
  ): string {
    const parts: string[] = ['## 🤖 AI Code Review'];
    if (output.degraded) parts.push('> ⚠️ 结果解析降级：以下为模型原始输出。');
    if (!pr.mergeCommit) parts.push('> ⚠️ 该 PR 存在合并冲突，本次 review 基于源分支代码。');
    parts.push(kind === 'incremental' ? '_（增量 review：仅针对最新 push 的变更）_' : '');
    parts.push('### 摘要', output.summary);
    if (output.walkthrough) parts.push('### 变更导览', output.walkthrough);
    if (output.riskLevel) parts.push(`**整体风险**：${output.riskLevel}`);
    if (inlineCount > 0) parts.push(`已就 ${inlineCount} 个问题添加行内评论。`);
    if (overflow.length > 0) {
      parts.push(
        '### 其他发现',
        overflow
          .map((f) => `- ${SEVERITY_LABEL[f.severity]} \`${f.file}:${f.line}\` ${f.title} — ${f.detail}`)
          .join('\n'),
      );
    }
    parts.push(
      '<details><summary>支持的命令</summary>\n\n' +
        `- 评论 \`/review\` 强制重新全量 review\n` +
        `- 在任意线程 \`@${this.deps.config.botDisplayName} <问题>\` 进行追问\n` +
        '</details>',
    );
    return parts.filter(Boolean).join('\n\n');
  }

  private statusDescription(output: ReviewOutput): string {
    const mustFix = output.findings.filter((f) => f.severity === 'must-fix').length;
    if (output.degraded) return 'AI review 完成（结果解析降级）';
    if (mustFix > 0) return `AI review 完成：${mustFix} 个必须修复问题`;
    return `AI review 完成：${output.findings.length} 个发现`;
  }

  private notifyReviewDone(pr: PrInfo, rKey: string, output: ReviewOutput): void {
    const { notify, ado } = this.deps;
    const mustFix = output.findings.filter((f) => f.severity === 'must-fix');
    const url = ado.prWebUrl(pr);
    notify.dispatch({
      type: 'review_completed',
      repoKey: rKey,
      title: `AI review 完成：${pr.title}`,
      text: `${output.summary}\n（发现 ${output.findings.length} 个问题，其中必须修复 ${mustFix.length} 个）`,
      url,
    });
    if (mustFix.length > 0) {
      notify.dispatch({
        type: 'must_fix_found',
        repoKey: rKey,
        title: `发现 ${mustFix.length} 个必须修复问题：${pr.title}`,
        text: mustFix.map((f) => `- ${f.file}:${f.line} ${f.title}`).join('\n'),
        url,
      });
    }
  }

  // ---------- @bot 问答 ----------

  async runQa(job: QaJob): Promise<void> {
    const { config, ado, workspace, logger } = this.deps;
    const pr = job.pr;
    const rKey = toRepoKey(pr);

    // 先占位，用户立刻看到 bot 已响应
    const placeholder = await ado.replyToThread(pr, job.threadId, '🔍 正在分析，请稍候…');
    let worktree: string | undefined;
    try {
      const fresh = await ado.getPullRequest(pr);
      const current = parsePrResource(fresh, config.adoUrl);
      const thread = await ado.getThread(pr, job.threadId);

      const history = (thread.comments ?? [])
        .filter((c) => !c.isDeleted && c.id !== placeholder.id && c.content)
        .map((c) => `${c.author?.displayName ?? '未知'}：${c.content}`)
        .join('\n---\n');
      const anchor = thread.threadContext?.filePath
        ? `${thread.threadContext.filePath.replace(/^\//, '')} 第 ${thread.threadContext.rightFileStart?.line ?? '?'} 行`
        : '（该线程未锚定具体代码位置）';

      const checkoutCommit = current.mergeCommit ?? current.sourceCommit;
      if (!checkoutCommit) throw new Error('PR 缺少可 checkout 的 commit');
      await workspace.ensureMirror(rKey, pr.remoteUrl);
      worktree = await workspace.createWorktree(
        rKey,
        checkoutCommit,
        `qa-${pr.pullRequestId}-${Date.now()}`,
      );

      const prompt = renderTemplate(loadPrompt(config.promptsDir, 'qa.md'), {
        pr_title: current.title,
        pr_description: current.description || '（无描述）',
        thread_history: history || '（无历史评论）',
        anchor,
        question: job.question,
      });

      const result = await this.codexRun(worktree, prompt);
      if (!result.ok) throw new Error(result.error ?? 'codex 执行失败');

      await ado.updateComment(pr, job.threadId, placeholder.id, result.output.trim());
      logger.info({ pr: toPrKey(pr), threadId: job.threadId }, '问答完成');
    } catch (err) {
      logger.error({ pr: toPrKey(pr), threadId: job.threadId, err: String(err) }, '问答失败');
      // 失败也要编辑占位评论，绝不沉默
      await ado
        .updateComment(
          pr,
          job.threadId,
          placeholder.id,
          `⚠️ 分析失败：${String(err).slice(0, 300)}\n可重新 @${config.botDisplayName} 再试一次。`,
        )
        .catch(() => undefined);
    } finally {
      if (worktree) await workspace.removeWorktree(rKey, worktree);
    }
  }

  // ---------- 配置合并 ----------

  /** 优先级：worktree 内 .ai-review.yml > bot 按仓库配置 > 全局默认 */
  private effectiveRepoConfig(rKey: string, worktree: string | undefined): EffectiveRepoConfig {
    const { config } = this.deps;
    const override: RepoOverrides = config.repoOverrides[rKey] ?? {};
    let yamlConf: RepoYamlConfig = {};
    if (worktree) {
      const yamlPath = path.join(worktree, '.ai-review.yml');
      if (fs.existsSync(yamlPath)) {
        try {
          yamlConf = YAML.parse(fs.readFileSync(yamlPath, 'utf8')) ?? {};
        } catch (err) {
          this.deps.logger.warn({ rKey, err: String(err) }, '.ai-review.yml 解析失败，忽略');
        }
      }
    }
    return {
      autoReview: yamlConf.autoReview ?? override.autoReview ?? true,
      maxInlineComments:
        yamlConf.maxInlineComments ?? override.maxInlineComments ?? config.maxInlineComments,
      minSeverity: yamlConf.minSeverity ?? override.minSeverity ?? 'nit',
      ignorePaths: yamlConf.ignorePaths ?? override.ignorePaths ?? [],
      focus: yamlConf.focus ?? override.focus ?? '',
    };
  }

  private isIgnored(file: string, patterns: string[]): boolean {
    return patterns.some((p) => {
      const regex = new RegExp(
        '^' +
          p
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*\*/g, '§§')
            .replace(/\*/g, '[^/]*')
            .replace(/§§/g, '.*') +
          '(/|$)',
      );
      return regex.test(file);
    });
  }
}
