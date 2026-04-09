/**
 * Cloudflare Worker - GitHub Actions 监控器
 *
 * 定时检查 GitHub Actions 的执行状态：
 * 1. 如果 download workflow 上次执行距当前时间超过 10 分钟，则触发 download
 * 2. 如果 detail workflow 上次执行距当前时间超过 60 分钟，则触发 detail
 *
 * 需要配置的环境变量（Secrets）：
 * - GITHUB_TOKEN: GitHub Personal Access Token（需要 repo + actions 权限）
 * - GITHUB_OWNER: 仓库所有者
 * - GITHUB_REPO:  仓库名称
 */

// Workflow 监控配置
const WORKFLOW_CONFIGS = [
  {
    name: "下载新闻列表",
    fileName: "download.yml",
    timeoutMinutes: 10,
  },
  {
    name: "下载新闻详情",
    fileName: "detail.yml",
    timeoutMinutes: 60,
  },
];

/**
 * 查询指定 workflow 最近一次运行的信息
 * @param {string} owner - 仓库所有者
 * @param {string} repo - 仓库名称
 * @param {string} workflowFileName - workflow 文件名
 * @param {string} token - GitHub Token
 * @returns {Object|null} 最近一次运行信息，包含 status, conclusion, created_at, updated_at
 */
async function getLatestWorkflowRun(owner, repo, workflowFileName, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFileName}/runs?per_page=1`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "CloudflareWorker-ActionMonitor",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `查询 ${workflowFileName} 运行记录失败: ${response.status} ${text}`
    );
  }

  const data = await response.json();

  if (!data.workflow_runs || data.workflow_runs.length === 0) {
    return null;
  }

  return data.workflow_runs[0];
}

/**
 * 触发指定 workflow 的 workflow_dispatch 事件
 * @param {string} owner - 仓库所有者
 * @param {string} repo - 仓库名称
 * @param {string} workflowFileName - workflow 文件名
 * @param {string} token - GitHub Token
 * @param {string} ref - 分支名称，默认 main
 */
async function triggerWorkflow(
  owner,
  repo,
  workflowFileName,
  token,
  ref = "main"
) {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflowFileName}/dispatches`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "CloudflareWorker-ActionMonitor",
    },
    body: JSON.stringify({ ref }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `触发 ${workflowFileName} 失败: ${response.status} ${text}`
    );
  }

  return true;
}

/**
 * 检查单个 workflow 是否需要触发
 * @param {Object} config - workflow 配置
 * @param {string} owner - 仓库所有者
 * @param {string} repo - 仓库名称
 * @param {string} token - GitHub Token
 * @returns {Object} 检查结果
 */
async function checkAndTriggerWorkflow(config, owner, repo, token) {
  const { name, fileName, timeoutMinutes } = config;
  const result = {
    workflow: name,
    fileName,
    triggered: false,
    reason: "",
  };

  try {
    const latestRun = await getLatestWorkflowRun(owner, repo, fileName, token);

    if (!latestRun) {
      // 从未执行过，直接触发
      result.reason = "从未执行过，触发运行";
      await triggerWorkflow(owner, repo, fileName, token);
      result.triggered = true;
      return result;
    }

    // 如果当前有正在运行的任务（queued / in_progress），则跳过
    if (
      latestRun.status === "queued" ||
      latestRun.status === "in_progress"
    ) {
      result.reason = `当前正在运行中 (status: ${latestRun.status})，跳过触发`;
      return result;
    }

    // 计算距离上次运行完成的时间差（分钟）
    const lastRunTime = new Date(latestRun.updated_at);
    const now = new Date();
    const diffMinutes = (now - lastRunTime) / (1000 * 60);

    result.lastRunAt = latestRun.updated_at;
    result.lastRunStatus = latestRun.status;
    result.lastRunConclusion = latestRun.conclusion;
    result.minutesSinceLastRun = Math.round(diffMinutes * 100) / 100;

    if (diffMinutes > timeoutMinutes) {
      result.reason = `距上次执行已过 ${result.minutesSinceLastRun} 分钟，超过阈值 ${timeoutMinutes} 分钟，触发运行`;
      await triggerWorkflow(owner, repo, fileName, token);
      result.triggered = true;
    } else {
      result.reason = `距上次执行 ${result.minutesSinceLastRun} 分钟，未超过阈值 ${timeoutMinutes} 分钟，无需触发`;
    }
  } catch (error) {
    result.reason = `检查出错: ${error.message}`;
    result.error = true;
  }

  return result;
}

export default {
  /**
   * 定时触发入口（Cron Trigger）
   */
  async scheduled(event, env, ctx) {
    const results = await checkAllWorkflows(env);
    console.log("定时检查结果:", JSON.stringify(results, null, 2));
  },

  /**
   * HTTP 请求入口（用于手动测试）
   * GET / - 执行检查并返回结果
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      const results = await checkAllWorkflows(env);
      return new Response(JSON.stringify(results, null, 2), {
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};

/**
 * 检查所有 workflow 的执行状态
 * @param {Object} env - 环境变量
 * @returns {Object} 检查结果汇总
 */
async function checkAllWorkflows(env) {
  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO } = env;

  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    return {
      success: false,
      error: "缺少必要的环境变量: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO",
    };
  }

  // 并行检查所有 workflow
  const results = await Promise.all(
    WORKFLOW_CONFIGS.map((config) =>
      checkAndTriggerWorkflow(config, GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN)
    )
  );

  return {
    success: true,
    checkedAt: new Date().toISOString(),
    results,
  };
}
