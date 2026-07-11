import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import type { Config } from './config';
import { AdoClient } from './ado/client';

const execFileAsync = promisify(execFile);

/**
 * 部署自检（node dist/server.js --doctor）：把实测踩过的坑固化成检查项，
 * 新环境部署与每次升级后跑一遍，10 秒定位配置问题。
 */

type Level = 'ok' | 'warn' | 'fail';
const ICON: Record<Level, string> = { ok: '✅', warn: '⚠️', fail: '❌' };

function report(level: Level, name: string, detail: string): boolean {
  console.log(`${ICON[level]} ${name} — ${detail}`);
  return level !== 'fail';
}

/** 检测系统环境变量遮蔽 .env（node --env-file 不覆盖已存在的变量，实测坑） */
export function detectEnvShadow(
  envFileContent: string,
  processEnv: NodeJS.ProcessEnv,
  keys: string[],
): string[] {
  const fileVals = new Map<string, string>();
  for (const line of envFileContent.split(/\r?\n/)) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) fileVals.set(m[1], m[2]);
  }
  return keys.filter((k) => {
    const f = fileVals.get(k);
    return f !== undefined && f !== '' && processEnv[k] !== undefined && processEnv[k] !== f;
  });
}

async function tryExec(bin: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await execFileAsync(bin, args, { timeout: 15_000 });
    return { ok: true, out: stdout.trim().split('\n')[0] };
  } catch (err) {
    return { ok: false, out: String(err).slice(0, 200) };
  }
}

export async function runDoctor(config: Config): Promise<boolean> {
  let allOk = true;
  const check = (level: Level, name: string, detail: string) => {
    if (!report(level, name, detail)) allOk = false;
  };
  console.log('AI Review Bot 部署自检\n');

  // 1. 环境变量遮蔽（.env 里的值被系统环境变量顶掉 → 经典 401 之谜）
  if (fs.existsSync('.env')) {
    const shadowed = detectEnvShadow(fs.readFileSync('.env', 'utf8'), process.env, [
      'ADO_PAT', 'WEBHOOK_SECRET', 'ADO_URL', 'ROCKETCHAT_BOT_TOKEN', 'INTRANET_API_KEY',
    ]);
    if (shadowed.length > 0) {
      check('warn', '环境变量遮蔽', `系统环境变量覆盖了 .env 里的 ${shadowed.join('、')}（node --env-file 不覆盖已有变量），请清理或确认`);
    } else {
      check('ok', '环境变量', '.env 与进程环境一致');
    }
  }

  // 2. git
  const git = await tryExec('git', ['--version']);
  check(git.ok ? 'ok' : 'fail', 'git', git.out);

  // 3. ADO 连通 + PAT
  const ado = new AdoClient({ baseUrl: config.adoUrl, pat: config.adoPat });
  try {
    const user = await ado.getAuthenticatedUser();
    check('ok', 'ADO 连通', `${config.adoUrl}（PAT 属于 ${user.displayName ?? user.id}）`);
  } catch (err) {
    check('fail', 'ADO 连通', `${String(err).slice(0, 200)}（检查 ADO_URL 是否 collection 级、PAT 是否有效）`);
  }

  // 4. Service Hooks 订阅是否指向本服务
  try {
    const res = await fetch(`${config.adoUrl}/_apis/hooks/subscriptions?api-version=7.0`, {
      headers: { authorization: 'Basic ' + Buffer.from(`:${config.adoPat}`).toString('base64') },
    });
    const subs = ((await res.json()) as { value?: Array<{ consumerInputs?: { url?: string } }> }).value ?? [];
    const mine = subs.map((s) => s.consumerInputs?.url ?? '').filter((u) => u.includes('/webhook/ado'));
    if (mine.length === 0) {
      check('warn', 'Service Hooks', '没有任何指向 /webhook/ado 的订阅（用 scripts/setup-hooks.ps1 配置）');
    } else if (!mine.some((u) => u.includes(`:${config.port}/`))) {
      check('warn', 'Service Hooks', `找到 ${mine.length} 个订阅但端口与本服务(${config.port})不符：${[...new Set(mine)].join('、')}`);
    } else {
      check('ok', 'Service Hooks', `${mine.length} 个订阅指向本服务`);
    }
  } catch (err) {
    check('warn', 'Service Hooks', `查询失败：${String(err).slice(0, 150)}`);
  }

  // 5. codex 引擎
  const codex = await tryExec(config.codexBin, ['--version']);
  check(
    codex.ok ? 'ok' : 'fail',
    'codex 引擎',
    codex.ok
      ? `${codex.out}${process.env.CODEX_HOME ? `（CODEX_HOME=${process.env.CODEX_HOME}）` : '（未设 CODEX_HOME，将继承部署账号个人配置，注意 MCP 拖慢问题）'}`
      : `${codex.out}（Windows 需指向真实 exe 而非 npm 包装器，见 README）`,
  );

  // 6. claude 引擎（配置了才检查）
  const usesClaude =
    config.reviewEngine === 'claude' || config.reviewProfiles.some((p) => p.startsWith('claude'));
  if (usesClaude) {
    const claude = await tryExec(config.claudeBin, ['--version']);
    check(claude.ok ? 'ok' : 'fail', 'claude 引擎', claude.ok ? claude.out : `${claude.out}（CLAUDE_BIN 需指向真实 exe）`);
  }

  // 7. RocketChat
  if (config.rocketchatUrl) {
    try {
      const info = (await (await fetch(`${config.rocketchatUrl}/api/info`)).json()) as { version?: string };
      check('ok', 'RocketChat 服务', `${config.rocketchatUrl}（v${info.version ?? '?'}）`);
    } catch (err) {
      check('fail', 'RocketChat 服务', String(err).slice(0, 150));
    }
    if (config.rocketchatBotUserId && config.rocketchatBotToken) {
      try {
        const me = (await (
          await fetch(`${config.rocketchatUrl}/api/v1/me`, {
            headers: { 'X-Auth-Token': config.rocketchatBotToken, 'X-User-Id': config.rocketchatBotUserId },
          })
        ).json()) as { username?: string; success?: boolean };
        check(me.username ? 'ok' : 'fail', 'RC bot 身份', me.username ? `@${me.username}` : 'token 无效');
      } catch (err) {
        check('fail', 'RC bot 身份', String(err).slice(0, 150));
      }
    } else {
      check('warn', 'RC bot 身份', '未配置（自由问答/线程/讨论不可用，仅结构化命令）');
    }
  }

  // 8. 数据目录与磁盘
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const st = fs.statfsSync(config.dataDir);
    const freeGb = (st.bavail * st.bsize) / 1024 ** 3;
    check(freeGb < 5 ? 'warn' : 'ok', '数据目录', `${config.dataDir}（剩余 ${freeGb.toFixed(1)} GB${freeGb < 5 ? '，偏低' : ''}）`);
  } catch (err) {
    check('fail', '数据目录', String(err).slice(0, 150));
  }

  console.log(`\n${allOk ? '✅ 自检通过，可以启动服务' : '❌ 存在需要处理的问题（见上）'}`);
  return allOk;
}
