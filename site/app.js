const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

const CONFIDENCE_LABELS = {
  high: '信頼度 高',
  medium: '信頼度 中',
  low: '信頼度 低',
};

const RATE_SOURCE_LABELS = {
  '20m': '直近20分の観測',
  '60m': '直近60分の観測',
  '120m': '直近120分の観測',
  weekday_hour_history: '同じ曜日・時間帯の履歴',
  hour_history: '同じ時間帯の履歴',
};

const state = {
  locations: [],
  location: null,
  latest: null,
  stats: null,
  day: null,
  status: null,
  metric: 'rate',
  chart: null,
};

const el = (id) => document.getElementById(id);

async function loadJson(path) {
  const response = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

function parseIso(value) {
  return value ? new Date(value) : null;
}

function formatTime(iso) {
  const date = parseIso(iso);
  if (!date) return '-';
  return date.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tokyo',
  });
}

function formatDateTime(iso) {
  const date = parseIso(iso);
  if (!date) return '-';
  const parts = new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Tokyo',
  }).format(date);
  return parts;
}

function formatDuration(minutes) {
  if (minutes === null || minutes === undefined) return '不明';
  if (minutes < 1) return 'ほぼ待ちなし';
  if (minutes < 60) return `約${minutes}分`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `約${hours}時間` : `約${hours}時間${rest}分`;
}

function numberOrDash(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) return '-';
  return Number(value).toFixed(digits).replace(/\.0$/, '');
}

function card({ label, value, unit, sub, primary = false }) {
  const wrapper = document.createElement('div');
  wrapper.className = primary ? 'card is-primary' : 'card';
  const labelEl = document.createElement('span');
  labelEl.className = 'card-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = 'card-value';
  valueEl.textContent = value;
  if (unit) {
    const unitEl = document.createElement('span');
    unitEl.className = 'card-unit';
    unitEl.textContent = unit;
    valueEl.append(unitEl);
  }
  wrapper.append(labelEl, valueEl);
  if (sub) {
    const subEl = document.createElement('span');
    subEl.className = 'card-sub';
    if (sub instanceof Node) subEl.append(sub);
    else subEl.textContent = sub;
    wrapper.append(subEl);
  }
  return wrapper;
}

function renderCards() {
  const latest = state.latest;
  const container = el('cards');
  container.replaceChildren();

  if (!latest || !latest.observed_at) {
    container.append(card({ label: '状態', value: '観測待ち', sub: 'まだデータがありません' }));
    return;
  }

  container.append(
    card({
      label: '現在の待ち組数',
      value: latest.waitings_count,
      unit: '組',
      sub: `保留 ${latest.pendings_count}組(待ち時間の計算には含めません)`,
      primary: true,
    }),
  );

  const rateSub = document.createElement('span');
  if (latest.rate_source) {
    rateSub.append(document.createTextNode(`${RATE_SOURCE_LABELS[latest.rate_source] ?? latest.rate_source}`));
    if (latest.estimate_confidence) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = CONFIDENCE_LABELS[latest.estimate_confidence] ?? latest.estimate_confidence;
      rateSub.append(' ', badge);
    }
  } else {
    rateSub.textContent = '有効な観測区間がまだありません';
  }

  container.append(
    card({
      label: `列消化速度${latest.rate_is_lower_bound ? '(下限)' : ''}`,
      value: numberOrDash(latest.queue_exit_rate_used),
      unit: '組/時',
      sub: rateSub,
    }),
  );

  container.append(
    card({
      label: '推定待ち時間',
      value: latest.estimated_wait_minutes === null ? '-' : latest.estimated_wait_minutes,
      unit: latest.estimated_wait_minutes === null ? '' : '分',
      sub: formatDuration(latest.estimated_wait_minutes),
    }),
  );

  const history = latest.history;
  let historySub = '履歴がまだ足りません';
  let historyValue = '-';
  if (history && history.rate_per_hour) {
    historyValue = numberOrDash(history.rate_per_hour);
    if (latest.queue_exit_rate_used) {
      const diff = latest.queue_exit_rate_used - history.rate_per_hour;
      const sign = diff > 0 ? '+' : '';
      historySub = `現在との差 ${sign}${numberOrDash(diff)}組/時(${WEEKDAYS[history.weekday]}曜 ${history.hour}時台・${history.interval_count}区間)`;
    } else {
      historySub = `${WEEKDAYS[history.weekday]}曜 ${history.hour}時台の平均`;
    }
  }
  container.append(
    card({ label: '同じ時間帯の履歴速度', value: historyValue, unit: '組/時', sub: historySub }),
  );
}

function renderNotes() {
  const list = el('notes');
  list.replaceChildren();
  for (const note of state.latest?.notes ?? []) {
    const li = document.createElement('li');
    li.textContent = note;
    list.append(li);
  }
}

function renderBanner() {
  const banner = el('status-banner');
  const messages = [];

  const result = state.status?.results?.find((entry) => entry.location_id === state.location?.id);
  if (result && !result.ok) {
    messages.push(
      `最新の取得に失敗しています(${formatDateTime(state.status.attempted_at)}): ${result.error}`,
    );
  }

  const observedAt = parseIso(state.latest?.observed_at);
  if (observedAt) {
    const ageMinutes = Math.round((Date.now() - observedAt.getTime()) / 60000);
    if (ageMinutes > 60) {
      messages.push(`最終観測から${ageMinutes}分経過しています。表示は最新の状況ではない可能性があります。`);
    }
  }

  if (!messages.length) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.textContent = messages.join(' / ');
}

function renderChart() {
  const canvas = el('daily-chart');
  const day = state.day;
  if (!window.Chart || !day) return;

  const labels = day.snapshots.map((snapshot) => formatTime(snapshot.observed_at));
  const waiting = day.snapshots.map((snapshot) => snapshot.waitings_count);
  const pending = day.snapshots.map((snapshot) => snapshot.pendings_count);

  const intervalByEnd = new Map(day.intervals.map((interval) => [interval.interval_end, interval]));
  const rate = day.snapshots.map((snapshot) => {
    const interval = intervalByEnd.get(snapshot.observed_at);
    if (!interval) return null;
    if (!interval.rate_eligible && !interval.censored) return null;
    return interval.queue_exit_rate_per_hour;
  });
  const barColors = day.snapshots.map((snapshot) => {
    const interval = intervalByEnd.get(snapshot.observed_at);
    if (interval?.censored) return 'rgba(230, 145, 56, 0.75)';
    return 'rgba(31, 111, 235, 0.55)';
  });

  const data = {
    labels,
    datasets: [
      {
        type: 'bar',
        label: '列消化速度(組/時)',
        data: rate,
        backgroundColor: barColors,
        borderWidth: 0,
        yAxisID: 'y1',
        order: 2,
      },
      {
        type: 'line',
        label: '待ち組数',
        data: waiting,
        borderColor: '#1f6feb',
        backgroundColor: '#1f6feb',
        borderWidth: 2,
        tension: 0.25,
        pointRadius: 2,
        yAxisID: 'y',
        order: 1,
      },
      {
        type: 'line',
        label: '保留',
        data: pending,
        borderColor: '#8a93a0',
        backgroundColor: '#8a93a0',
        borderWidth: 1.5,
        borderDash: [4, 3],
        tension: 0.25,
        pointRadius: 0,
        yAxisID: 'y',
        order: 1,
      },
    ],
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    scales: {
      y: {
        position: 'left',
        beginAtZero: true,
        title: { display: true, text: '組' },
      },
      y1: {
        position: 'right',
        beginAtZero: true,
        grid: { drawOnChartArea: false },
        title: { display: true, text: '組/時' },
      },
    },
    plugins: {
      legend: { labels: { boxWidth: 12 } },
      tooltip: {
        callbacks: {
          afterBody: (items) => {
            const index = items[0]?.dataIndex;
            const snapshot = day.snapshots[index];
            const interval = snapshot ? intervalByEnd.get(snapshot.observed_at) : null;
            if (!interval) return '';
            const lines = [`この区間の消化: ${interval.queue_advance_observed}組 / ${Math.round(interval.duration_seconds / 60)}分`];
            if (interval.censored) lines.push('表示20件が全件消化(下限値)');
            if (interval.exclusion_reasons.length) {
              lines.push(`速度計算から除外: ${interval.exclusion_reasons.join(', ')}`);
            }
            return lines;
          },
        },
      },
    },
  };

  if (state.chart) {
    state.chart.data = data;
    state.chart.options = options;
    state.chart.update();
  } else {
    state.chart = new window.Chart(canvas, { type: 'bar', data, options });
  }

  const eligible = day.intervals.filter((interval) => interval.rate_eligible).length;
  const censored = day.intervals.filter((interval) => interval.censored).length;
  el('chart-caption').textContent =
    `${day.business_date}: 観測${day.snapshot_count}回、区間${day.intervals.length}件(速度計算に採用${eligible}件、打ち切り${censored}件)。棒グラフのオレンジは下限値です。`;
}

function heatmapCell(value, max, text, title) {
  const td = document.createElement('td');
  if (value === null || value === undefined) {
    td.className = 'empty';
    td.textContent = '·';
    return td;
  }
  const alpha = max > 0 ? Math.min(0.9, 0.12 + (value / max) * 0.78) : 0.12;
  td.style.backgroundColor = `rgba(31, 111, 235, ${alpha.toFixed(3)})`;
  if (alpha > 0.55) td.style.color = '#fff';
  td.textContent = text;
  if (title) td.title = title;
  return td;
}

function renderHeatmap() {
  const container = el('heatmap');
  container.replaceChildren();
  const stats = state.stats;
  const buckets = stats?.weekday_hours ?? [];

  const metricKey = state.metric === 'rate' ? 'rate_per_hour' : 'median_waitings_count';
  const usable = buckets.filter((bucket) => bucket[metricKey] !== null && bucket[metricKey] !== undefined);

  if (!usable.length) {
    const p = document.createElement('p');
    p.className = 'caption';
    p.textContent = '集計できる履歴がまだありません。数日分の観測が溜まると表示されます。';
    container.append(p);
    el('heatmap-caption').textContent = '';
    return;
  }

  const hours = [...new Set(usable.map((bucket) => bucket.hour))].sort((a, b) => a - b);
  const weekdays = [...new Set(usable.map((bucket) => bucket.weekday))].sort((a, b) => a - b);
  const max = Math.max(...usable.map((bucket) => bucket[metricKey]));
  const byKey = new Map(buckets.map((bucket) => [`${bucket.weekday}-${bucket.hour}`, bucket]));

  const table = document.createElement('table');
  table.className = 'heatmap';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.append(document.createElement('th'));
  for (const hour of hours) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = `${hour}時`;
    headRow.append(th);
  }
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement('tbody');
  for (const weekday of weekdays) {
    const row = document.createElement('tr');
    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = `${WEEKDAYS[weekday]}曜`;
    row.append(th);
    for (const hour of hours) {
      const bucket = byKey.get(`${weekday}-${hour}`);
      const value = bucket?.[metricKey] ?? null;
      const text = value === null ? '' : numberOrDash(value);
      const title = bucket
        ? `${WEEKDAYS[weekday]}曜 ${hour}時台\n列消化速度: ${numberOrDash(bucket.rate_per_hour)}組/時(${bucket.interval_count}区間)\n待ち組数の中央値: ${numberOrDash(bucket.median_waitings_count)}組(${bucket.snapshot_count}回観測)`
        : '';
      row.append(heatmapCell(value, max, text, title));
    }
    tbody.append(row);
  }
  table.append(tbody);
  container.append(table);

  const unit = state.metric === 'rate' ? '組/時' : '組(中央値)';
  const range = stats.date_range ? `${stats.date_range.from} 〜 ${stats.date_range.to}` : '-';
  el('heatmap-caption').textContent =
    `単位は${unit}。集計期間 ${range}(${stats.observation_days}日、観測${stats.snapshot_count}回、速度計算に採用した区間${stats.rate_eligible_interval_count}件)。`;
}

async function selectDate(businessDate) {
  state.day = await loadJson(`data/derived/${state.location.path}/${businessDate}.json`);
  renderChart();
}

function renderDateOptions() {
  const select = el('date-select');
  select.replaceChildren();
  const dates = [...(state.latest?.available_dates ?? [])].reverse();
  for (const date of dates) {
    const option = document.createElement('option');
    option.value = date;
    option.textContent = date;
    select.append(option);
  }
  select.disabled = dates.length === 0;
  return dates[0] ?? null;
}

async function selectLocation(location) {
  state.location = location;
  const base = `data/derived/${location.path}`;
  const [latest, stats] = await Promise.all([
    loadJson(`${base}/latest.json`),
    loadJson(`${base}/stats.json`).catch(() => null),
  ]);
  state.latest = latest;
  state.stats = stats;

  el('observed-at').textContent = latest.observed_at
    ? `最終観測 ${formatDateTime(latest.observed_at)}(${location.name})`
    : `${location.name}: 観測データがありません`;

  renderBanner();
  renderCards();
  renderNotes();
  renderHeatmap();

  const initialDate = renderDateOptions();
  if (initialDate) await selectDate(initialDate);

  el('source-caption').textContent = `観測間隔は約20分です。${location.name}(順番待ちAPI)を観測しています。`;
}

function bindEvents() {
  el('date-select').addEventListener('change', (event) => {
    selectDate(event.target.value).catch((error) => console.error(error));
  });

  el('location-select').addEventListener('change', (event) => {
    const location = state.locations.find((entry) => entry.id === event.target.value);
    if (location) selectLocation(location).catch((error) => console.error(error));
  });

  for (const button of document.querySelectorAll('.toggle button')) {
    button.addEventListener('click', () => {
      state.metric = button.dataset.metric;
      for (const other of document.querySelectorAll('.toggle button')) {
        other.classList.toggle('is-active', other === button);
      }
      renderHeatmap();
    });
  }
}

async function main() {
  bindEvents();

  const [locationsFile, status] = await Promise.all([
    loadJson('data/locations.json'),
    loadJson('data/status.json').catch(() => null),
  ]);
  state.locations = locationsFile.locations;
  state.status = status;

  if (state.locations.length > 1) {
    const panel = el('location-panel');
    const select = el('location-select');
    for (const location of state.locations) {
      const option = document.createElement('option');
      option.value = location.id;
      option.textContent = location.name;
      select.append(option);
    }
    panel.hidden = false;
  }

  await selectLocation(state.locations[0]);
}

function boot() {
  main().catch((error) => {
    console.error(error);
    const banner = el('status-banner');
    banner.hidden = false;
    banner.textContent = `データの読み込みに失敗しました: ${error.message}`;
  });
}

if (window.Chart) boot();
else window.addEventListener('load', boot, { once: true });
