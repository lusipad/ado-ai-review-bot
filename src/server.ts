import Fastify, { type FastifyInstance } from 'fastify';
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { loadConfig, type Config } from './config';
import { routeEvent, type ServiceHookEvent } from './ado/events';
import { AdoClient } from './ado/client';
import { StateDb } from './state/db';
import { Workspace } from './repo/workspace';
import { Scheduler } from './queue/scheduler';
import { Pipeline, type PipelineDeps } from './pipeline';
import { NotifyDispatcher } from './notify';
import { prKey as toPrKey } from './types';

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

  app.post('/webhook/ado', async (req, reply) => {
    if (!isAuthorized(req.headers, config.webhookSecret)) {
      return reply.status(401).send({ error: 'unauthorized' });
    }

    const event = req.body as ServiceHookEvent;
    if (!event?.eventType) return reply.status(400).send({ error: 'bad payload' });

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

async function main(): Promise<void> {
  const config = loadConfig();
  const { app, deps } = createApp(config);
  await deps.workspace.cleanupOrphans();
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
