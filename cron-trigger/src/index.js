const OWNER = 'bonjinnorenka';
const REPO = 'queue-observer-jp';
const WORKFLOW = 'collect.yml';
const REF = 'main';

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 10_000;

/**
 * 進行中の collect ワークフローが存在するかチェックする。
 * 既に実行中なら新しいdispatchをスキップして、キャンセルを回避する。
 */
async function hasInProgressRun(token) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/runs?status=in_progress&per_page=1`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'queue-observer-cron-worker',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`workflow runs check failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  return data.total_count > 0;
}

async function dispatchWorkflow(token) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'queue-observer-cron-worker',
    },
    body: JSON.stringify({ ref: REF }),
  });
  if (res.status !== 204) {
    const body = await res.text();
    throw new Error(`workflow_dispatch failed: ${res.status} ${body}`);
  }
}

export default {
  async scheduled(controller, env, ctx) {
    // まず進行中のrunをチェック
    const inProgress = await hasInProgressRun(env.GITHUB_TOKEN);
    if (inProgress) {
      console.log(`skipping dispatch: ${WORKFLOW} is already in progress`);
      return;
    }

    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await dispatchWorkflow(env.GITHUB_TOKEN);
        console.log(`dispatched ${WORKFLOW} (attempt ${attempt})`);
        return;
      } catch (err) {
        lastError = err;
        console.warn(`attempt ${attempt} failed: ${err.message}`);
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    }
    throw lastError;
  },
};
