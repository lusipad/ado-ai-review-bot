import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Config, RepoOverrides } from './config';
import type { Finding, Logger, ReviewOutput, Severity } from './types';
import { prKey as toPrKey, repoKey as toRepoKey } from './types';
import { findingFingerprint, sleep, truncateUtf8Bytes } from './util';
import { AdoClient } from './ado/client';
import { parsePrResource, type PrInfo } from './ado/events';
import { StateDb } from './state/db';
import { Workspace } from './repo/workspace';
import { loadPrompt, renderTemplate } from './engine/prompts';
import {
  runCodex,
  parseReviewOutput,
  parseChallengeVerdicts,
  type CodexRunResult,
} from './engine/codex';
import { NotifyDispatcher } from './notify';
import { KnowledgeStore } from './knowledge';

const SEVERITY_RANK: Record<Severity, number> = { 'must-fix': 0, suggestion: 1, nit: 2 };
const SEVERITY_LABEL: Record<Severity, string> = {
  'must-fix': '🔴 必须修复',
  suggestion: '🟡 建议',
  nit: '🔵 细节',
};
/** diff 塞进提示词的字节上限，超出截断（agent 会在 worktree 里自己看） */
const MAX_DIFF_BYTES = 300_000;
/** 注入提示词的历史被拒意见条数上限 */
const MAX_REJECTED_FEEDBACK = 15;
/** 自动收紧：nit 级 finding 已裁决数达到该值且采纳率低于阈值 → 该仓库不再上报 nit */
const TIGHTEN_MIN_RESOLVED = 8;
const TIGHTEN_ACCEPT_RATE = 0.25;

/** 仓库内 .ai-review.yml 支持的字段 */
interface RepoYamlConfig {
  autoReview?: boolean;
  maxInlineComments?: number;
  minSeverity?: Severity;
  ignorePaths?: string[];
  focus?: string;
  challenge?: boolean;
  allowFix?: boolean;
  knowledgeBase?: boolean;
  profiles?: string[];
}

/** 变更文件扩展名 → prompts/checklists/ 下的专项清单 */
const CHECKLIST_BY_EXT: Record<string, string> = {
  '.c': 'cpp', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.h': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp',
  '.cs': 'csharp',
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'typescript', '.jsx': 'typescript',
  '.mjs': 'typescript', '.cjs': 'typescript', '.vue': 'typescript',
  '.py': 'python',
  '.java': 'java',
  '.go': 'go',
};

interface EffectiveRepoConfig extends Required<Pick<RepoYamlConfig, 'autoReview' | 'maxInlineComments' | 'minSeverity' | 'challenge' | 'allowFix' | 'knowledgeBase'>> {
  ignorePaths: string[];
  focus: string;
  profiles: string[];
  /** minSeverity 是被采纳率数据自动收紧的（总评里要向用户说明） */
  autoTightened: boolean;
}

export interface QaJob {
  pr: PrInfo;
  threadId: number;
  commentId: number;
  question: string;
}

export interface FixJob {
  pr: PrInfo;
  threadId: number;
  commentId: number;
  instruction: string;
}

export type CodexRunner = (
  worktree: string,
  prompt: string,
  opts?: { sandbox?: string; profile?: string },
) => Promise<CodexRunResult>;

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

/**
 * 多模型 findings 合并：指纹相同，或同文件近邻行号（±2）且同严重度，视为同一问题；
 * agreedBy 记录独立命中的模型数。resolvedThreadIds 取交集（错关线程比漏关更糟），
 * riskLevel 取最严重。
 */
export function mergeReviewOutputs(outputs: ReviewOutput[]): ReviewOutput {
  const primary = outputs[0];
  const merged: Finding[] = [];
  for (const out of outputs) {
    for (const f of out.findings) {
      const dup = merged.find(
        (m) =>
          findingFingerprint(m.file, m.title) === findingFingerprint(f.file, f.title) ||
          (m.file === f.file && Math.abs(m.line - f.line) <= 2 && m.severity === f.severity),
      );
      if (dup) {
        dup.agreedBy = (dup.agreedBy ?? 1) + 1;
        if (f.detail.length > dup.detail.length) dup.detail = f.detail; // 保留更详尽的说明
      } else {
        merged.push({ ...f, agreedBy: 1 });
      }
    }
  }
  const resolved = outputs
    .map((o) => new Set(o.resolvedThreadIds))
    .reduce((a, b) => new Set([...a].filter((x) => b.has(x))));
  const RISK = ['low', 'medium', 'high'];
  const maxRisk = Math.max(...outputs.map((o) => RISK.indexOf((o.riskLevel ?? '').toLowerCase())));
  return {
    ...primary,
    findings: merged,
    resolvedThreadIds: [...resolved],
    riskLevel: maxRisk >= 0 ? RISK[maxRisk] : primary.riskLevel,
  };
}

export class Pipeline {
  private readonly codexRun: CodexRunner;
  private readonly knowledge: KnowledgeStore;

  constructor(private readonly deps: PipelineDeps) {
    this.codexRun =
      deps.codexRun ??
      ((worktree, prompt, opts) =>
        runCodex(
          {
            bin: deps.config.codexBin,
            sandbox: opts?.sandbox ?? deps.config.codexSandbox,
            timeoutMs: deps.config.codexTimeoutMs,
            extraArgs: deps.config.codexExtraArgs,
            profile: opts?.profile,
            logger: deps.logger,
          },
          worktree,
          prompt,
        ));
    this.knowledge = new KnowledgeStore(path.join(deps.config.dataDir, 'knowledge'));
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
    // 幂等：该 commit 已 review 过（ADO 重发事件 / 防抖窗口内手动触发过）。手动 /review 不受限
    if (!manual && prior?.lastReviewedCommit === pr.sourceCommit) {
      logger.info({ key, kind }, '跳过：该 commit 已 review 过');
      return;
    }

    await workspace.ensureMirror(rKey, pr.remoteUrl);
    const repoConf = this.effectiveRepoConfig(rKey, undefined);
    if (!repoConf.autoReview && !manual) {
      logger.info({ key }, '跳过：该仓库已关闭自动 review');
      return;
    }

    logger.info({ key, kind, reason }, '开始 review');
    const startedAt = Date.now();
    await ado
      .setPrStatus(pr, { state: 'pending', description: `AI review 进行中（${reason}）` })
      .catch((err) => logger.warn({ err: String(err) }, '设置 PR status 失败'));

    // 反馈学习：先同步人工对 bot 历史 finding 线程的处置（wontFix/fixed），失败不阻塞 review
    await this.syncThreadFeedback(pr, key).catch((err) =>
      logger.warn({ key, err: String(err) }, '线程反馈同步失败，跳过'),
    );

    // 关联工作项（需求上下文），失败不阻塞
    const workItemsText = await this.fetchWorkItemsText(pr).catch((err) => {
      logger.warn({ key, err: String(err) }, '工作项获取失败，跳过');
      return '（无）';
    });

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
      const rejected = db.listRejectedFindings(rKey, MAX_REJECTED_FEEDBACK);
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
        rejected_feedback: rejected.length
          ? rejected
              .map((f) => `- ${f.file}: ${f.title}${f.note ? `（团队理由：${f.note}）` : ''}`)
              .join('\n')
          : '（无）',
        repo_map: this.repoMapFor(rKey, conf),
        work_items: workItemsText,
        language_checklists: this.languageChecklists(changedFiles),
      });

      const output = await this.runMultiModelReview(worktree, prompt, conf.profiles);

      // 质疑 pass：独立复核 findings，丢弃被证伪的（fail-open：复核失败保留全部）
      const findingsTotal = output.findings.length;
      let droppedByChallenge = 0;
      if (conf.challenge && !output.degraded && output.findings.length > 0) {
        droppedByChallenge = await this.runChallengePass(worktree, output);
      }

      const posted = await this.publishReview(pr, key, rKey, kind, output, conf, openFindings, droppedByChallenge);

      db.upsertPrState(key, {
        isDraft: false,
        lastReviewedCommit: pr.sourceCommit,
        lastSourceCommit: pr.sourceCommit,
      });

      await ado
        .setPrStatus(pr, { state: 'succeeded', description: this.statusDescription(output) })
        .catch((err) => logger.warn({ err: String(err) }, '设置 PR status 失败'));

      db.insertReviewRun({
        prKey: key,
        repoKey: rKey,
        kind,
        ok: true,
        durationMs: Date.now() - startedAt,
        findingsTotal,
        findingsPosted: posted,
        mustFix: output.findings.filter((f) => f.severity === 'must-fix').length,
        droppedByChallenge,
        degraded: output.degraded,
      });

      this.notifyReviewDone(pr, rKey, output);
      logger.info(
        { key, findings: output.findings.length, droppedByChallenge, degraded: output.degraded },
        'review 完成',
      );

      // 知识库缺失/过期 → 复用本次 worktree 生成（失败不影响 review 结果）
      if (conf.knowledgeBase) {
        await this.maybeGenerateKnowledge(rKey, worktree, checkoutCommit).catch((err) =>
          logger.warn({ rKey, err: String(err) }, '仓库知识库生成失败'),
        );
      }
    } catch (err) {
      logger.error({ key, err: String(err) }, 'review 失败');
      db.insertReviewRun({
        prKey: key,
        repoKey: rKey,
        kind,
        ok: false,
        durationMs: Date.now() - startedAt,
        findingsTotal: 0,
        findingsPosted: 0,
        mustFix: 0,
        droppedByChallenge: 0,
        degraded: false,
        error: String(err).slice(0, 500),
      });
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

  /**
   * codex 瞬时失败（网络/模型 API 抖动）自动重试。超时不重试——再等一个完整
   * 超时周期大概率仍失败，且会把任务时长翻倍。
   */
  private async codexRunWithRetry(
    worktree: string,
    prompt: string,
    opts?: { sandbox?: string; profile?: string },
  ): Promise<CodexRunResult> {
    const retries = this.deps.config.codexRetries;
    let last: CodexRunResult = { ok: false, output: '', error: '未执行' };
    for (let attempt = 0; attempt <= retries; attempt++) {
      last = await this.codexRun(worktree, prompt, opts);
      if (last.ok) return last;
      if (last.error?.includes('超时')) return last;
      if (attempt < retries) {
        this.deps.logger.warn(
          { attempt: attempt + 1, err: last.error?.slice(0, 200) },
          'codex 失败，重试',
        );
        await sleep(3000);
      }
    }
    return last;
  }

  /** 按变更文件扩展名拼接语言专项清单（prompts/checklists/ 下的模板可自行增删改） */
  private languageChecklists(changedFiles: string[]): string {
    const langs = new Set<string>();
    for (const f of changedFiles) {
      const lang = CHECKLIST_BY_EXT[path.extname(f).toLowerCase()];
      if (lang) langs.add(lang);
    }
    const parts: string[] = [];
    for (const lang of langs) {
      const p = path.join(this.deps.config.promptsDir, 'checklists', `${lang}.md`);
      if (fs.existsSync(p)) parts.push(fs.readFileSync(p, 'utf8').trim());
    }
    return parts.length ? parts.join('\n\n') : '（无）';
  }

  /** 多模型交叉：各 profile 独立 review，合并 findings（并行执行，注意实际 codex 并发翻倍） */
  private async runMultiModelReview(
    worktree: string,
    prompt: string,
    profiles: string[],
  ): Promise<ReviewOutput> {
    const { logger } = this.deps;
    const results = await Promise.all(
      profiles.map(async (profile) => ({
        profile,
        result: await this.codexRunWithRetry(worktree, prompt, { profile }),
      })),
    );
    for (const r of results.filter((x) => !x.result.ok)) {
      logger.warn({ profile: r.profile, err: r.result.error?.slice(0, 300) }, '该模型 review 失败');
    }
    const ok = results.filter((x) => x.result.ok);
    if (ok.length === 0) throw new Error(results[0]?.result.error ?? 'codex 执行失败');

    const parsed = ok.map((x) => ({ profile: x.profile, out: parseReviewOutput(x.result.output) }));
    // 有结构化结果就丢弃降级的（原文 summary 无法参与合并）
    const usable = parsed.filter((p) => !p.out.degraded);
    const chosen = usable.length > 0 ? usable : parsed.slice(0, 1);
    if (chosen.length === 1) return chosen[0].out;
    logger.info({ profiles: chosen.map((c) => c.profile) }, '多模型结果合并');
    return mergeReviewOutputs(chosen.map((c) => c.out));
  }

  /** PR 关联工作项 → 提示词文本（最多 3 个） */
  private async fetchWorkItemsText(pr: PrInfo): Promise<string> {
    const ids = (await this.deps.ado.getPrWorkItemRefs(pr)).slice(0, 3);
    if (ids.length === 0) return '（无）';
    const items = await this.deps.ado.getWorkItems(ids);
    if (items.length === 0) return '（无）';
    return items
      .map((w) => `#${w.id} [${w.type}] ${w.title}${w.description ? `\n${w.description}` : ''}`)
      .join('\n---\n');
  }

  // ---------- 反馈学习 ----------

  /**
   * 把人工对 bot finding 线程的处置同步进状态库：
   * wontFix/byDesign → 拒绝（连同人工回复的理由，注入后续 review 提示词）；
   * fixed/closed → 采纳。只处理 open 状态的 finding。
   */
  private async syncThreadFeedback(pr: PrInfo, key: string): Promise<void> {
    const { ado, db, config, logger } = this.deps;
    const open = db.listOpenFindings(key);
    if (open.length === 0) return;

    const threads = (await ado.getThreads(pr)).value ?? [];
    const byId = new Map(threads.map((t) => [t.id, t]));
    for (const f of open) {
      const thread = byId.get(f.threadId);
      const status = thread?.status?.toLowerCase();
      if (!status || status === 'active' || status === 'pending' || status === 'unknown') continue;

      if (status === 'wontfix' || status === 'bydesign') {
        // 拒绝理由 = 线程里最后一条非 bot 评论
        const lastHuman = [...(thread!.comments ?? [])]
          .reverse()
          .find(
            (c) =>
              !c.isDeleted &&
              c.content &&
              c.author?.id?.toLowerCase() !== config.botAccountId.toLowerCase(),
          );
        db.updateFindingFeedback(key, f.threadId, 'wontfix', lastHuman?.content?.slice(0, 300));
        logger.info({ key, threadId: f.threadId, title: f.title }, 'finding 被团队拒绝，已记入反馈');
      } else if (status === 'fixed' || status === 'closed') {
        db.updateFindingFeedback(key, f.threadId, status === 'fixed' ? 'fixed' : 'closed');
      }
    }
  }

  // ---------- 质疑 pass ----------

  /**
   * 用独立提示词（立场：证伪）复核 findings：wrong → 丢弃；confirmed/uncertain → 标注。
   * 复核本身失败时保留全部 findings（fail-open）。返回丢弃条数。
   */
  private async runChallengePass(worktree: string, output: ReviewOutput): Promise<number> {
    const { config, logger } = this.deps;
    try {
      const findingsJson = JSON.stringify(
        output.findings.map((f, index) => ({
          index,
          file: f.file,
          line: f.line,
          severity: f.severity,
          title: f.title,
          detail: f.detail,
        })),
        null,
        2,
      );
      const prompt = renderTemplate(loadPrompt(config.promptsDir, 'challenge.md'), {
        findings_json: findingsJson,
      });
      const result = await this.codexRun(worktree, prompt);
      if (!result.ok) throw new Error(result.error ?? 'codex 执行失败');
      const verdicts = parseChallengeVerdicts(result.output);
      if (!verdicts) throw new Error('质疑 pass 输出无法解析');

      const byIndex = new Map(verdicts.map((v) => [v.index, v]));
      const kept: typeof output.findings = [];
      let dropped = 0;
      for (let i = 0; i < output.findings.length; i++) {
        const f = output.findings[i];
        const v = byIndex.get(i);
        if (v?.verdict === 'wrong') {
          dropped++;
          logger.info(
            { file: f.file, title: f.title, reason: v.reason },
            '质疑 pass 判定为误报，丢弃',
          );
          continue;
        }
        if (v?.verdict === 'confirmed') {
          f.verification = 'confirmed';
          f.verificationNote = v.reason;
        } else if (v) {
          f.verification = 'uncertain';
        }
        kept.push(f);
      }
      output.findings = kept;
      return dropped;
    } catch (err) {
      logger.warn({ err: String(err) }, '质疑 pass 失败，保留全部 findings');
      return 0;
    }
  }

  // ---------- 仓库知识库 ----------

  /** 注入提示词的仓库地图（截断到 8KB） */
  private repoMapFor(rKey: string, conf: EffectiveRepoConfig): string {
    if (!conf.knowledgeBase) return '（未启用）';
    const entry = this.knowledge.get(rKey);
    if (!entry) return '（暂无，首次 review 后自动生成）';
    return truncateUtf8Bytes(entry.content, 8_000, '\n…（已截断）');
  }

  private async maybeGenerateKnowledge(
    rKey: string,
    worktree: string,
    commit: string,
  ): Promise<void> {
    const { config, logger } = this.deps;
    if (this.knowledge.isFresh(this.knowledge.get(rKey), config.knowledgeTtlDays)) return;
    const prompt = loadPrompt(config.promptsDir, 'repo-map.md');
    const result = await this.codexRun(worktree, prompt);
    if (!result.ok || !result.output.trim()) {
      throw new Error(result.error ?? 'repo-map 生成无输出');
    }
    this.knowledge.save(rKey, {
      generatedAt: new Date().toISOString(),
      commit,
      content: result.output.trim(),
    });
    logger.info({ rKey }, '仓库知识库已更新');
  }

  // ---------- /fix ----------

  async runFix(job: FixJob): Promise<void> {
    const { config, db, ado, workspace, logger } = this.deps;
    const pr = job.pr;
    const key = toPrKey(pr);
    const rKey = toRepoKey(pr);
    const startedAt = Date.now();
    const recordRun = (ok: boolean, error?: string) =>
      db.insertReviewRun({
        prKey: key,
        repoKey: rKey,
        kind: 'fix',
        ok,
        durationMs: Date.now() - startedAt,
        findingsTotal: 0,
        findingsPosted: 0,
        mustFix: 0,
        droppedByChallenge: 0,
        degraded: false,
        error,
      });

    const placeholder = await ado.replyToThread(pr, job.threadId, '🔧 正在实施修复，请稍候…');
    const finish = (content: string) =>
      ado.updateComment(pr, job.threadId, placeholder.id, content).catch(() => undefined);

    let worktree: string | undefined;
    try {
      const fresh = await ado.getPullRequest(pr);
      const current: PrInfo = { ...pr, ...parsePrResource(fresh, config.adoUrl), remoteUrl: pr.remoteUrl };
      if (current.status !== 'active') throw new Error(`PR 状态为 ${current.status}，无法修复`);
      if (!current.sourceCommit) throw new Error('PR 缺少源分支 commit');
      const branch = current.sourceRefName.replace('refs/heads/', '');

      await workspace.ensureMirror(rKey, pr.remoteUrl);
      // 修复必须基于源分支（而不是预合并结果），产出的 commit 才能推回去
      worktree = await workspace.createWorktree(
        rKey,
        current.sourceCommit,
        `fix-${pr.pullRequestId}-${Date.now()}`,
      );

      const conf = this.effectiveRepoConfig(rKey, worktree);
      if (!conf.allowFix) {
        await finish(
          '⛔ 该仓库未开启 /fix。在仓库根目录 `.ai-review.yml` 设置 `allowFix: true`（或联系 bot 管理员配置）后重试。',
        );
        recordRun(false, 'allowFix 未开启');
        return;
      }

      const thread = await ado.getThread(pr, job.threadId);
      const history = (thread.comments ?? [])
        .filter((c) => !c.isDeleted && c.id !== placeholder.id && c.content)
        .map((c) => `${c.author?.displayName ?? '未知'}：${c.content}`)
        .join('\n---\n');
      const anchor = thread.threadContext?.filePath
        ? `${thread.threadContext.filePath.replace(/^\//, '')} 第 ${thread.threadContext.rightFileStart?.line ?? '?'} 行`
        : '（该线程未锚定具体代码位置）';

      const prompt = renderTemplate(loadPrompt(config.promptsDir, 'fix.md'), {
        pr_title: current.title,
        pr_description: current.description || '（无描述）',
        source_branch: branch,
        target_branch: current.targetRefName.replace('refs/heads/', ''),
        thread_history: history || '（无历史评论）',
        anchor,
        instruction: job.instruction || '（无，按线程内容修复）',
        repo_map: this.repoMapFor(rKey, conf),
      });

      // 修复需要写权限：覆盖为 workspace-write 沙箱
      const result = await this.codexRunWithRetry(worktree, prompt, { sandbox: 'workspace-write' });
      if (!result.ok) throw new Error(result.error ?? 'codex 执行失败');
      const summary = result.output.trim();

      const title = `AI fix: PR #${pr.pullRequestId} thread ${job.threadId}`;
      const commitId = await workspace.commitAll(worktree, `${title}\n\n${summary}`, {
        name: config.botDisplayName,
        email: `${config.botDisplayName}@ai-review.bot`,
      });
      if (!commitId) {
        await finish(`ℹ️ 未做任何修改。\n\n${summary}`);
        recordRun(true);
        return;
      }

      await workspace.pushHead(worktree, pr.remoteUrl, branch);
      await finish(
        `✅ 已推送修复 \`${commitId.slice(0, 8)}\` 到 \`${branch}\`。\n\n${summary}\n\n_bot 将对该提交自动做一次增量 review。_`,
      );
      recordRun(true);
      logger.info({ key, threadId: job.threadId, commitId }, '/fix 完成');
    } catch (err) {
      recordRun(false, String(err).slice(0, 500));
      logger.error({ key, threadId: job.threadId, err: String(err) }, '/fix 失败');
      await finish(
        `⚠️ 修复失败：${String(err).slice(0, 300)}\n若源分支刚有新提交，请重新评论 \`/fix\` 再试。`,
      );
    } finally {
      if (worktree) await workspace.removeWorktree(rKey, worktree);
    }
  }

  // ---------- 结果发布 ----------

  /** 返回实际发布的 finding 数（行内 + 归并进总评的） */
  private async publishReview(
    pr: PrInfo,
    key: string,
    rKey: string,
    kind: 'full' | 'incremental',
    output: ReviewOutput,
    conf: EffectiveRepoConfig,
    openFindings: ReturnType<StateDb['listOpenFindings']>,
    droppedByChallenge: number,
  ): Promise<number> {
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
          repoKey: rKey,
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
    const summaryContent = this.formatSummaryComment(pr, kind, output, inline.length, overflow, {
      droppedByChallenge,
      autoTightened: conf.autoTightened,
      allowFix: conf.allowFix,
    });
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
    return eligible.length;
  }

  private formatFindingComment(f: Finding): string {
    const parts = [`**${SEVERITY_LABEL[f.severity]}** ${f.title}`, f.detail];
    if (f.agreedBy && f.agreedBy > 1) {
      parts.push(`> 🤝 ${f.agreedBy} 个模型独立发现了此问题`);
    }
    if (f.verification === 'confirmed') {
      parts.push(`> ✅ 已二次复核${f.verificationNote ? `：${f.verificationNote}` : ''}`);
    } else if (f.verification === 'uncertain') {
      parts.push('> ⚪ 推断性发现：复核未能在代码中完全证实，请人工判断。');
    }
    return parts.join('\n\n');
  }

  private formatSummaryComment(
    pr: PrInfo,
    kind: 'full' | 'incremental',
    output: ReviewOutput,
    inlineCount: number,
    overflow: Finding[],
    meta: { droppedByChallenge: number; autoTightened: boolean; allowFix: boolean },
  ): string {
    const parts: string[] = ['## 🤖 AI Code Review'];
    if (output.degraded) parts.push('> ⚠️ 结果解析降级：以下为模型原始输出。');
    if (!pr.mergeCommit) parts.push('> ⚠️ 该 PR 存在合并冲突，本次 review 基于源分支代码。');
    parts.push(kind === 'incremental' ? '_（增量 review：仅针对最新 push 的变更）_' : '');
    parts.push('### 摘要', output.summary);
    if (output.walkthrough) parts.push('### 变更导览', output.walkthrough);
    if (output.reviewerGuide) parts.push('### 👀 给人工审阅者', output.reviewerGuide);
    if (output.riskLevel) parts.push(`**整体风险**：${output.riskLevel}`);
    if (inlineCount > 0) parts.push(`已就 ${inlineCount} 个问题添加行内评论。`);
    if (meta.droppedByChallenge > 0)
      parts.push(`_二次复核丢弃了 ${meta.droppedByChallenge} 条疑似误报。_`);
    if (meta.autoTightened)
      parts.push('_根据本仓库的历史采纳率，细节级（nit）意见已自动折叠，不再上报。_');
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
        (meta.allowFix ? `- 在问题线程评论 \`/fix [额外指示]\` 让 bot 直接实施修复并推送\n` : '') +
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
    const { config, db, ado, workspace, logger } = this.deps;
    const pr = job.pr;
    const rKey = toRepoKey(pr);
    const startedAt = Date.now();
    const recordRun = (ok: boolean, error?: string) =>
      db.insertReviewRun({
        prKey: toPrKey(pr),
        repoKey: rKey,
        kind: 'qa',
        ok,
        durationMs: Date.now() - startedAt,
        findingsTotal: 0,
        findingsPosted: 0,
        mustFix: 0,
        droppedByChallenge: 0,
        degraded: false,
        error,
      });

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
        repo_map: this.repoMapFor(rKey, this.effectiveRepoConfig(rKey, worktree)),
      });

      const result = await this.codexRunWithRetry(worktree, prompt);
      if (!result.ok) throw new Error(result.error ?? 'codex 执行失败');

      await ado.updateComment(pr, job.threadId, placeholder.id, result.output.trim());
      recordRun(true);
      logger.info({ pr: toPrKey(pr), threadId: job.threadId }, '问答完成');
    } catch (err) {
      recordRun(false, String(err).slice(0, 500));
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

    // 反馈学习自动收紧：仅当 minSeverity 未被显式配置时生效
    let minSeverity = yamlConf.minSeverity ?? override.minSeverity;
    let autoTightened = false;
    if (!minSeverity) {
      minSeverity = 'nit';
      const { resolved, accepted } = this.deps.db.severityAcceptance(rKey, 'nit');
      if (resolved >= TIGHTEN_MIN_RESOLVED && accepted / resolved < TIGHTEN_ACCEPT_RATE) {
        minSeverity = 'suggestion';
        autoTightened = true;
        this.deps.logger.info(
          { rKey, resolved, accepted },
          'nit 级意见采纳率过低，本仓库自动收紧为 suggestion 及以上',
        );
      }
    }

    return {
      autoReview: yamlConf.autoReview ?? override.autoReview ?? true,
      maxInlineComments:
        yamlConf.maxInlineComments ?? override.maxInlineComments ?? config.maxInlineComments,
      minSeverity,
      ignorePaths: yamlConf.ignorePaths ?? override.ignorePaths ?? [],
      focus: yamlConf.focus ?? override.focus ?? '',
      challenge: yamlConf.challenge ?? override.challenge ?? config.challengeEnabled,
      allowFix: yamlConf.allowFix ?? override.allowFix ?? config.fixEnabled,
      knowledgeBase: yamlConf.knowledgeBase ?? override.knowledgeBase ?? config.knowledgeEnabled,
      profiles: yamlConf.profiles ?? override.profiles ?? config.reviewProfiles,
      autoTightened,
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
