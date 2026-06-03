import { barChart, shareBar } from './charts';

type UsageReport = Awaited<ReturnType<Window['devdeck']['usageReport']>>;

const RANGES: { key: string; label: string; days: number }[] = [
  { key: '7d', label: '7d', days: 7 },
  { key: '30d', label: '30d', days: 30 },
  { key: '90d', label: '90d', days: 90 },
  { key: 'all', label: '전체', days: Infinity as unknown as number },
];
const COLORS = ['#6366f1', '#3b82f6', '#d98a1f', '#e0623f', '#9aa1ad'];

let viewEl: HTMLElement;
let activeRange = '30d';
let sortKey: 'cost' | 'input' | 'output' | 'sessions' = 'cost';

function fmt(n: number): string { return n.toLocaleString(); }
function usd(n: number | null): string { return n == null ? '—' : `~$${n.toFixed(2)}`; }

async function load(): Promise<void> {
  const range = RANGES.find((r) => r.key === activeRange)!;
  const sinceMs = range.days === Infinity ? Infinity : Date.now() - range.days * 86_400_000;
  const sk = document.createElement('div'); sk.className = 'skeleton'; sk.style.margin = '16px';
  viewEl.replaceChildren(sk);
  const r = await window.devdeck.usageReport(sinceMs);
  render(r);
}

function render(r: UsageReport): void {
  viewEl.replaceChildren();

  const bar = document.createElement('div'); bar.className = 'usage-toolbar';
  for (const rg of RANGES) {
    const b = document.createElement('button'); b.className = 'chip' + (rg.key === activeRange ? ' active' : ''); b.textContent = rg.label;
    b.addEventListener('click', () => { activeRange = rg.key; load(); });
    bar.appendChild(b);
  }
  const cost = document.createElement('span'); cost.className = 'usage-total';
  cost.textContent = `추정 비용 ${usd(r.globalCost)}${r.hasUnknownModel ? ' *' : ''}`;
  bar.appendChild(cost);
  viewEl.appendChild(bar);

  const sum = document.createElement('div'); sum.className = 'usage-summary';
  const stats = document.createElement('div'); stats.className = 'usage-stats';
  stats.append(...([
    ['입력', fmt(r.global.input)], ['출력', fmt(r.global.output)],
    ['캐시 W', fmt(r.global.cacheWrite)], ['캐시 R', fmt(r.global.cacheRead)],
    ['web', `${r.webSearch + r.webFetch}`], ['세션', `${r.sessions}`],
  ] as [string, string][]).map(([k, v]) => { const d = document.createElement('div'); d.className = 'stat'; d.innerHTML = `<b></b><span></span>`; d.querySelector('b')!.textContent = v; d.querySelector('span')!.textContent = k; return d; }));
  sum.appendChild(stats);
  sum.appendChild(shareBar(r.byModel.map((m, i) => ({ label: m.model, value: m.totals.input + m.totals.output, color: COLORS[i % COLORS.length] }))));
  viewEl.appendChild(sum);

  if (r.daily.length) {
    const chartBox = document.createElement('div'); chartBox.className = 'chart-box';
    const h = document.createElement('div'); h.className = 'chart-title'; h.textContent = '일별 토큰';
    chartBox.append(h, barChart(r.daily.map((d) => ({ label: d.day, value: d.tokens }))));
    viewEl.appendChild(chartBox);
  }

  const rows = [...r.byProject].filter((p) => p.sessions > 0).sort((a, b) => {
    const av = sortKey === 'cost' ? (a.costEstimate ?? -1) : sortKey === 'sessions' ? a.sessions : a.totals[sortKey];
    const bv = sortKey === 'cost' ? (b.costEstimate ?? -1) : sortKey === 'sessions' ? b.sessions : b.totals[sortKey];
    return bv - av;
  });
  const table = document.createElement('table'); table.className = 'usage-table';
  const head = document.createElement('tr');
  for (const [key, label] of [['name', '프로젝트'], ['sessions', '세션'], ['input', '입력'], ['output', '출력'], ['cost', '추정비용']] as const) {
    const th = document.createElement('th'); th.textContent = label;
    if (key !== 'name') th.addEventListener('click', () => { sortKey = key as typeof sortKey; render(r); });
    head.appendChild(th);
  }
  table.appendChild(head);
  for (const p of rows) {
    const tr = document.createElement('tr');
    const cells = [p.name, String(p.sessions), fmt(p.totals.input), fmt(p.totals.output), usd(p.costEstimate)];
    for (const c of cells) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); }
    table.appendChild(tr);
  }
  viewEl.appendChild(table);

  if (r.hasUnknownModel) {
    const note = document.createElement('div'); note.className = 'usage-note';
    note.textContent = '* 일부 모델은 단가 미등록 — 비용 추정에서 제외됨. 비용은 공개 단가 기반 API 환산 추정치이며 실제 청구(구독)와 다를 수 있습니다.';
    viewEl.appendChild(note);
  }
}

export function mountUsage(): void { viewEl = document.getElementById('view-usage')!; }
export function showUsage(): void { load(); }
