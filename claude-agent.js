// claude-agent.js — 本机 Claude CLI 调用（headless）
// 把“分析类”任务（汇率走势、需要更准的推理）从 OpenRouter 免费模型切到 Claude/Sonnet。
// 聊天/智能回复仍走 OpenRouter（见 ai.js），互不影响。
//
// 前提：本机装了 claude CLI 且已登录（~/.claude/.credentials.json），pm2 与 CLI 同一用户。
// 用 DISABLE_OMC 跳过 OMC 编排层，纯文本分析更快更干净；cwd 用临时目录避免加载项目上下文。

const { spawn } = require('child_process');
const os = require('os');

// 调用 claude CLI 做一次纯文本分析，返回 stdout 文本。
// prompt 通过 stdin 传入，避免命令行转义问题。
function claudeAnalyze(prompt, opts = {}) {
  const {
    model = process.env.CLAUDE_ANALYSIS_MODEL || 'sonnet',
    timeoutMs = parseInt(process.env.CLAUDE_TIMEOUT_MS || '90000', 10),
  } = opts;
  return new Promise((resolve, reject) => {
    const bin = process.env.CLAUDE_BIN || 'claude';
    const child = spawn(bin, ['-p', '--model', model], {
      cwd: os.tmpdir(),
      env: { ...process.env, DISABLE_OMC: '1' },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude CLI 超时 (${timeoutMs}ms)`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) resolve(out.trim());
      else reject(new Error(`claude CLI 退出码 ${code}: ${(err || out).slice(0, 200)}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

module.exports = { claudeAnalyze };
