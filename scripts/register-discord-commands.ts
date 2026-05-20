/**
 * B3-001/B3-002: Discord Slash Command 注册脚本
 *
 * 用法：npx tsx scripts/register-discord-commands.ts
 *
 * 需要在 .env 中配置 DISCORD_BOT_TOKEN 和 DISCORD_APP_ID
 */
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_APP_ID = process.env.DISCORD_APPLICATION_ID;

if (!DISCORD_BOT_TOKEN || !DISCORD_APP_ID) {
  console.error('Error: DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID must be set');
  console.error('DISCORD_BOT_TOKEN:', DISCORD_BOT_TOKEN ? 'set' : 'MISSING');
  console.error('DISCORD_APPLICATION_ID:', DISCORD_APP_ID ? 'set' : 'MISSING');
  process.exit(1);
}

const commands = [
  {
    name: 'studio',
    description: 'Studio 服务管理',
    options: [
      {
        name: 'status',
        description: '查看 daemon 和 Agent 状态',
        type: 1, // SUB_COMMAND
      },
      {
        name: 'restart',
        description: '重启 daemon（reload session cache）',
        type: 1, // SUB_COMMAND
      },
      {
        name: 'log',
        description: '查看最近日志（最后 20 行）',
        type: 1, // SUB_COMMAND
      },
      {
        name: 'send',
        description: '发送 shell 命令到服务器执行',
        type: 1, // SUB_COMMAND
        options: [
          {
            name: 'command',
            description: '要执行的命令',
            type: 3, // STRING
            required: true,
          },
        ],
      },
      {
        name: 'run',
        description: '提交需求到 #研发，触发 @Analyst 分析执行',
        type: 1, // SUB_COMMAND
        options: [
          {
            name: 'requirement',
            description: '需求描述（≥30字，自动 @Analyst）',
            type: 3, // STRING
            required: true,
          },
        ],
      },
      {
        name: 'progress',
        description: '查看正在执行的 Goal 进度（.progress.json）',
        type: 1, // SUB_COMMAND
      },
      {
        name: 'stop',
        description: '停止指定的执行（输入 executionId）',
        type: 1, // SUB_COMMAND
        options: [
          {
            name: 'execution_id',
            description: '要停止的 Execution ID（首 8 位即可）',
            type: 3, // STRING
            required: true,
          },
        ],
      },
    ],
  },
];

async function register() {
  const { execSync } = await import('child_process');
  const url = `https://discord.com/api/v10/applications/${DISCORD_APP_ID}/commands`;

  try {
    const result = execSync(
      `curl -s -w "\\n%{http_code}" -X PUT "${url}" ` +
      `-H "Authorization: Bot ${DISCORD_BOT_TOKEN}" ` +
      `-H "Content-Type: application/json" ` +
      `-d '${JSON.stringify(commands).replace(/'/g, "'\\''")}' ` +
      `--proxy http://127.0.0.1:7890`,
      { encoding: 'utf-8', timeout: 15000 }
    );

    const lines = result.trim().split('\n');
    const httpCode = lines.pop() || '0';
    const body = lines.join('\n');

    if (httpCode === '200' || httpCode === '201') {
      const data = JSON.parse(body);
      const cmds = Array.isArray(data) ? data : [];
      console.log(`Registered ${cmds.length} commands:`);
      for (const cmd of cmds) {
        console.log(`  /${cmd.name} — ${cmd.description}`);
      }
    } else {
      console.error(`Failed (HTTP ${httpCode}): ${body.slice(0, 500)}`);
    }
  } catch (err: any) {
    console.error('Registration failed:', err.message || String(err));
  }
}

register();
