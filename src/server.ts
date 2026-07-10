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
        const key = toPrKey(action.pr);
        db.upsertPrState(key, { isDraft: true, lastSourceCommit: action.pr.sourceCommit });
        break;
      }
      case 'full_review': {
        const pr = action.pr;
        const key = toPrKey(pr);
        db.upsertPrState(key, { isDraft: false, lastSourceCommit: pr.sourceCommit });
        const manual = action.reason === '/review 命令';
        scheduler.enqueueReview(key, 'full', () => pipeline.runFullReview(pr, action.reason, manual));
        break;
      }
      case 'incremental_review': {
        const pr = action.pr;
        const key = toPrKey(pr);
        // 立即记录已见 commit：同一 commit 的重复 updated 事件在路由层被忽略
        db.upsertPrState(key, { isDraft: false, lastSourceCommit: pr.sourceCommit });
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
  await app.listen({ host: config.host, port: config.port });
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
