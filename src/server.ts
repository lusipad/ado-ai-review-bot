import Fastify, { type FastifyInstance } from 'fastify';
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { loadConfig, type Config } from './config';
import {
  routeEvent,
  flatCommentRef,
  EVENT_PR_COMMENTED,
  type ServiceHookEvent,
} from './ado/events';
import { AdoClient } from './ado/client';
import { StateDb } from './state/db';
import { Workspace } from './repo/workspace';
import { Scheduler } from './queue/scheduler';
import { Pipeline, type PipelineDeps } from './pipeline';
import { NotifyDispatcher } from './notify';
import { prKey as toPrKey, type Logger } from './types';
import { collectStats, formatWeeklyReport } from './stats';
import { msUntilNextWeekly } from './util';
import { ADMIN_HTML, buildOverview } from './admin';
import {
  handleChatCommand,
  isStructuredCommand,
  resolveRepoForChat,
  type RocketChatOutgoing,
} from './chatops';
import { runDoctor } from './doctor';
import { KnowledgeStore } from './knowledge';

export interface AppDeps {
  config: Config;
  db: StateDb;
  ado: AdoClient;
  workspace: Workspace;
  scheduler: Scheduler;
  pipeline: Pipeline;
  notify: NotifyDispatcher;
}

/** 校验 Service Hook 请求：basic auth 密码 或 x-webhook-secret 头 */
export function isAuthorized(
  headers: Record<string, string | string[] | undefined>,
  secret: string,
): boolean {
  const custom = headers['x-webhook-secret'];
  if (typeof custom === 'string' && timingSafeEqual(custom, secret)) return true;
  const auth = headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const pass = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : decoded;
    if (timingSafeEqual(pass, secret)) return true;
  }
  return false;
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return cryptoTimingSafeEqual(ab, bb);
}

export function registerRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config, db, scheduler, pipeline } = deps;

  app.get('/healthz', async () => ({ ok: true }));

  // 度量：与 webhook 相同的密钥鉴权（x-webhook-secret 头或 basic auth 密码）
  app.get('/stats', async (req, reply) => {
    if (!isAuthorized(req.headers, config.webhookSecret)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }
    const q = req.query as { days?: string; repo?: string };
    const days = Math.min(365, Math.max(1, Number(q.days) || 30));
    return collectStats(deps.db, days, q.repo || undefined);
  });

  // RocketChat 双向问答（outgoing webhook）：token 鉴权、bot 消息防回环
  if (config.rocketchatOutgoingToken) {
    const chatDeps = {
      db: deps.db,
      scheduler: deps.scheduler,
      adoUrl: config.adoUrl,
      knowledge: new KnowledgeStore(path.join(config.dataDir, 'knowledge')),
    };
    app.post('/webhook/rocketchat', async (req, reply) => {
      const body = (req.body ?? {}) as RocketChatOutgoing;
      if (!body.token || !timingSafeEqual(body.token, config.rocketchatOutgoingToken!)) {
        return reply.status(401).send({ error: 'unauthorized' });
      }
      // 集成账号/机器人自己的消息不回应，防止回环
      if (body.bot) return reply.status(200).send({});
      let text = (body.text ?? '').trim();
      // 剥掉触发词（RC 配置的 trigger word 或 @机器人 前缀）
      if (body.trigger_word && text.toLowerCase().startsWith(body.trigger_word.toLowerCase())) {
        text = text.slice(body.trigger_word.length).trim();
      }
      text = text.replace(/^@\S+\s*/, '');
      if (!text) return reply.status(200).send({});
      req.log.info({ user: body.user_name, cmd: text.slice(0, 50) }, '聊天命令');

      // 结构化命令：秒回（出站 webhook 同步应答）
      if (isStructuredCommand(text)) {
        return reply.status(200).send({ text: handleChatCommand(text, chatDeps) });
      }

      // 自由问答：需要 RC REST 身份（占位、线程回复、讨论），异步跑 agent
      if (deps.pipeline.chatQaAvailable() && body.channel_id) {
        const forceDiscussion = /^(讨论|discuss)\s+/i.test(text);
        const question = text.replace(/^(讨论|discuss)\s+/i, '').trim();
        const resolved = resolveRepoForChat(
          question,
          body.channel_name,
          deps.db.listKnownRepoKeys(),
          config.channelRepos ?? {},
        );
        if (!resolved.repoKey) return reply.status(200).send({ text: resolved.hint });
        const job = {
          repoKey: resolved.repoKey,
          question,
          userName: body.user_name ?? '群友',
          roomId: body.channel_id,
          tmid: body.message_id,
          forceDiscussion,
        };
        deps.scheduler.enqueueQa(() => deps.pipeline.runChatQa(job));
        return reply.status(200).send({});
      }

      // 没配 REST 身份 → 退回帮助
      return reply.status(200).send({ text: handleChatCommand(text, chatDeps) });
    });
  }

  // 管理面板（只读）：浏览器 basic auth，用户名任意、密码=WEBHOOK_SECRET
  app.get('/admin', async (req, reply) => {
    if (!isAuthorized(req.headers, config.webhookSecret)) {
      return reply
        .status(401)
        .header('www-authenticate', 'Basic realm="ai-review-bot"')
        .send({ error: 'unauthorized' });
    }
    return reply.type('text/html; charset=utf-8').send(ADMIN_HTML);
  });

  app.get('/admin/api/overview', async (req, reply) => {
    if (!isAuthorized(req.headers, config.webhookSecret)) {
      return reply
        .status(401)
        .header('www-authenticate', 'Basic realm="ai-review-bot"')
        .send({ error: 'unauthorized' });
    }
    const q = req.query as { days?: string };
    const days = Math.min(365, Math.max(1, Number(q.days) || 7));
    return buildOverview(deps.db, deps.scheduler, days);
  });

  app.post('/webhook/ado', async (req, reply) => {
    if (!isAuthorized(req.headers, config.webhookSecret)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    let event = req.body as ServiceHookEvent;
    if (!event?.eventType) return reply.status(400).send({ error: 'bad payload' });

    // Server 2022 的评论事件只投递 1.0 扁平 comment，反查 PR 补全成 2.0 形态
    if (event.eventType === EVENT_PR_COMMENTED) {
      const ref = flatCommentRef(event.resource as Record<string, unknown>);
      if (ref) {
        try {
          const prRes = await deps.ado.getPullRequestById(ref.repoId, ref.pullRequestId);
          event = {
            eventType: event.eventType,
            resource: { comment: event.resource, pullRequest: prRes },
          } as ServiceHookEvent;
        } catch (err) {
          req.log.error({ err: String(err), ...ref }, '扁平评论事件补全 PR 失败');
          return reply.status(200).send({ ok: false, error: 'hydrate failed' });
        }
      }
    }

    // 路由需要既有状态（draft 转换、commit 比对）；判定后立即 ACK，任务全部异步执行
    let action;
    try {
      action = routeEvent(
        event,
        {
          botAccountId: config.botAccountId,
          botDisplayName: config.botDisplayName,
          priorState: lookupPriorState(event, db),
        },
        config.adoUrl,
      );
    } catch (err) {
      req.log.error({ err: String(err) }, '事件解析失败');
      return reply.status(200).send({ ok: false, error: 'parse failed' });
    }

    req.log.info({ eventType: event.eventType, action: action.type }, '事件已路由');

    switch (action.type) {
      case 'record_draft': {
        const pr = action.pr;
        db.upsertPrState(toPrKey(pr), {
          isDraft: true,
          lastSourceCommit: pr.sourceCommit,
          repoId: pr.repoId,
          remoteUrl: pr.remoteUrl,
        });
        break;
      }
      case 'full_review': {
        const pr = action.pr;
        const key = toPrKey(pr);
        db.upsertPrState(key, {
          isDraft: false,
          lastSourceCommit: pr.sourceCommit,
          repoId: pr.repoId,
          remoteUrl: pr.remoteUrl,
        });
        const manual = action.reason === '/review 命令';
        scheduler.enqueueReview(key, 'full', () => pipeline.runFullReview(pr, action.reason, manual));
        break;
      }
      case 'incremental_review': {
        const pr = action.pr;
        const key = toPrKey(pr);
        // 立即记录已见 commit：同一 commit 的重复 updated 事件在路由层被忽略
        db.upsertPrState(key, {
          isDraft: false,
          lastSourceCommit: pr.sourceCommit,
          repoId: pr.repoId,
          remoteUrl: pr.remoteUrl,
        });
        scheduler.debouncePush(key, () =>
          scheduler.enqueueReview(key, 'incremental', (kind) =>
            kind === 'full'
              ? pipeline.runFullReview(pr, '合并触发', false)
              : pipeline.runIncrementalReview(pr),
          ),
        );
        break;
      }
      case 'qa': {
        const { pr, threadId, commentId, question } = action;
        scheduler.enqueueQa(() => pipeline.runQa({ pr, threadId, commentId, question }));
        break;
      }
      case 'fix': {
        // 与 review 同一 per-PR 串行域：修复会改源分支，不能与 review 并发
        const { pr, threadId, commentId, instruction } = action;
        scheduler.enqueueTask(toPrKey(pr), () =>
          pipeline.runFix({ pr, threadId, commentId, instruction }),
        );
        break;
      }
      case 'pr_closed': {
        const pr = action.pr;
        const key = toPrKey(pr);
        scheduler.cancelPending(key);
        const stale = db.markPrFindingsStale(key);
        // 基线对齐：防止启动恢复扫描把已关闭的 PR 重新入队
        db.upsertPrState(key, { isDraft: false, lastReviewedCommit: pr.sourceCommit, lastSourceCommit: pr.sourceCommit });
        req.log.info({ key, closedStatus: action.closedStatus, staleFindings: stale }, 'PR 已关闭，收尾归档');
        break;
      }
      case 'ignore':
        break;
    }

    return reply.status(200).send({ ok: true, action: action.type });
  });
}

function lookupPriorState(
  event: ServiceHookEvent,
  db: StateDb,
): { isDraft: boolean; lastSourceCommit?: string } | undefined {
  const res = event.resource as {
    repository?: { name?: string; project?: { name?: string } };
    pullRequestId?: number;
    pullRequest?: {
      repository?: { name?: string; project?: { name?: string } };
      pullRequestId?: number;
    };
  };
  const prRes = res.pullRequest ?? res;
  const project = prRes.repository?.project?.name;
  const repoName = prRes.repository?.name;
  const prId = prRes.pullRequestId;
  if (!project || !repoName || !prId) return undefined;
  const s = db.getPrState(`${project}/${repoName}/${prId}`);
  return s ? { isDraft: s.isDraft, lastSourceCommit: s.lastSourceCommit } : undefined;
}

export function createApp(config: Config): { app: FastifyInstance; deps: AppDeps } {
  const app = Fastify({ logger: true });
  const logger = app.log;

  const db = new StateDb(path.join(config.dataDir, 'state.db'));
  const ado = new AdoClient({ baseUrl: config.adoUrl, pat: config.adoPat });
  const workspace = new Workspace({ dataDir: config.dataDir, pat: config.adoPat, logger });
  const notify = new NotifyDispatcher(config, logger);
  const scheduler = new Scheduler({
    reviewConcurrency: config.reviewConcurrency,
    qaConcurrency: config.qaConcurrency,
    debounceMs: config.debounceMs,
    logger,
  });
  const pipelineDeps: PipelineDeps = { config, db, ado, workspace, notify, logger };
  const pipeline = new Pipeline(pipelineDeps);

  const deps: AppDeps = { config, db, ado, workspace, scheduler, pipeline, notify };
  registerRoutes(app, deps);
  return { app, deps };
}

/**
 * 重启恢复：上次停机时被打断/错过的 review（源 commit 落后于已 review commit 的 active PR）
 * 重新入队为增量 review。PrInfo 只需最小字段，runReview 会重新拉取最新 PR 状态。
 */
export function recoverPendingReviews(deps: AppDeps, logger: Logger): number {
  const stale = deps.db.listPrStatesNeedingReview();
  for (const s of stale) {
    const [project, repoName, prId] = splitPrKey(s.prKey);
    if (!project || !repoName || !prId || !s.repoId || !s.remoteUrl) continue;
    const pr = {
      project,
      repoName,
      pullRequestId: prId,
      repoId: s.repoId,
      remoteUrl: s.remoteUrl,
      isDraft: false,
      status: 'active',
      title: '',
      description: '',
      sourceRefName: '',
      targetRefName: '',
      sourceCommit: s.lastSourceCommit,
    };
    logger.info({ prKey: s.prKey }, '恢复上次停机遗留的 review');
    deps.scheduler.enqueueReview(s.prKey, 'incremental', (kind) =>
      kind === 'full'
        ? deps.pipeline.runFullReview(pr, '重启恢复', false)
        : deps.pipeline.runIncrementalReview(pr),
    );
  }
  return stale.length;
}

/** prKey = project/repoName/prId；repo 名不含 /（ADO 命名规则），project 可能含（取首段） */
function splitPrKey(prKey: string): [string, string, number] | [] {
  const parts = prKey.split('/');
  if (parts.length < 3) return [];
  const prId = Number(parts[parts.length - 1]);
  const repoName = parts[parts.length - 2];
  const project = parts.slice(0, -2).join('/');
  if (!Number.isInteger(prId)) return [];
  return [project, repoName, prId];
}

/** 每周日 03:00（服务器本地时区）dream 整理各仓库长期记忆 */
export function scheduleDream(deps: AppDeps, logger: Logger): void {
  const tick = () => {
    const delay = msUntilNextWeekly(new Date(), 0, 3);
    const timer = setTimeout(() => {
      try {
        const repos = deps.pipeline.dreamCandidates();
        logger.info({ repos: repos.length }, 'dream 记忆整理开始');
        for (const rKey of repos) {
          deps.scheduler.enqueueTask(`dream:${rKey}`, () => deps.pipeline.runDream(rKey));
        }
      } catch (err) {
        logger.error({ err: String(err) }, 'dream 调度失败');
      } finally {
        tick();
      }
    }, delay);
    timer.unref();
  };
  tick();
}

/** 每周一 09:00（服务器本地时区）推送度量周报；定时器 unref，不阻止进程退出 */
export function scheduleWeeklyReport(deps: AppDeps, logger: Logger): void {
  const tick = () => {
    const delay = msUntilNextWeekly(new Date(), 1, 9);
    const timer = setTimeout(() => {
      try {
        deps.notify.dispatch({
          type: 'weekly_report',
          repoKey: '',
          title: '🤖 AI Review 周报',
          text: formatWeeklyReport(collectStats(deps.db, 7)),
        });
        logger.info({}, '周报已推送');
      } catch (err) {
        logger.error({ err: String(err) }, '周报生成失败');
      } finally {
        tick();
      }
    }, delay);
    timer.unref();
  };
  tick();
}

async function main(): Promise<void> {
  if (process.argv.includes('--doctor')) {
    let ok = false;
    try {
      ok = await runDoctor(loadConfig());
    } catch (err) {
      console.log(`❌ 配置加载失败 — ${String(err)}`);
    }
    process.exit(ok ? 0 : 1);
  }
  const config = loadConfig();
  const { app, deps } = createApp(config);
  // BOT_ACCOUNT_ID 未配置时自动获取：PAT 属于 bot 服务账号，connectionData 返回的就是它的 identity
  if (!config.botAccountId) {
    const user = await deps.ado.getAuthenticatedUser();
    config.botAccountId = user.id;
    app.log.info(
      { botAccountId: user.id, displayName: user.displayName },
      '已自动获取 bot 账号 identity（如需固定可写入 BOT_ACCOUNT_ID）',
    );
  }
  await deps.workspace.cleanupOrphans();
  if (config.weeklyReportEnabled) scheduleWeeklyReport(deps, app.log);
  if (config.dreamEnabled && config.knowledgeEnabled) scheduleDream(deps, app.log);

  // 优雅停机：停接新任务 → 等在跑任务收尾 → 退出（超时任务由下次启动的恢复扫描补跑）
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal, graceMs: config.shutdownGraceMs }, '收到停机信号，等待在跑任务收尾');
    const result = await deps.scheduler.drain(config.shutdownGraceMs);
    if (!result.completed) {
      app.log.warn({ interrupted: result.interrupted }, '排水超时，以下任务将由重启恢复补跑');
    }
    await app.close().catch(() => undefined);
    deps.db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
  const recovered = recoverPendingReviews(deps, app.log);
  if (recovered > 0) app.log.info({ recovered }, '已重新入队上次停机遗留的 review');
  app.log.info(
    { port: config.port, dataDir: config.dataDir },
    'AI Review Bot 已启动，等待 Service Hook 事件',
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
