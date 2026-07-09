import { barChart, shareBar } from './charts';
import { formatDuration } from '../shared/usage';
import { tr, localeTag } from './i18n-runtime';
import { renderLoadError } from './loadError';
import { filterProjectRows } from '../shared/usageFilter';

type UsageReport = Awaited<ReturnType<Window['devdeck']['usageReport']>>;

const RANGES: { key: string; label: string; days: number }[] = [
  { key: '7d', label: '7d', days: 7 },
  { key: '30d', label: '30d', days: 30 },
  { key: '90d', label: '90d', days: 90 },
  { key: 'all', label: '', days: Infinity as unknown as number },
];
const COLORS = ['#6366f1', '#3b82f6', '#d98a1f', '#e0623f', '#9aa1ad'];

let viewEl: HTMLElement;
let activeRange = '30d';
let sortKey: 'cost' | 'input' | 'output' | 'sessions' | 'active' = 'cost';
let sortDir: 'desc' | 'asc' = 'desc';
let showDeleted = true; // deleted projects (folder gone, usage remains) shown by default; totals always include them
let searchQuery = ''; // filters the project table only — the summary above always reflects the full range

function fmt(n: number): string { return new Intl.NumberFormat(localeTag()).format(n); }
function usd(n: number | null): string { return n == null ? '—' : `~$${n.toFixed(2)}`; }

async function load(): Promise<void> {
  const range = RANGES.find((r) => r.key === activeRange)!;
  const sinceMs = range.days === Infinity ? Infinity : Date.now() - range.days * 86_400_000;
  const sk = document.createElement('div'); sk.className = 'skeleton'; sk.style.margin = '16px';
  viewEl.replaceChildren(sk);
  try {
    render(await window.devdeck.usageReport(sinceMs));
  } catch (e) {
    console.error('DevDeck: usage load failed', e); // otherwise the skeleton would stay forever
    renderLoadError(viewEl, () => void load());
  }
}

function render(r: UsageReport): void {
  viewEl.replaceChildren();

  const bar = document.createElement('div'); bar.className = 'usage-toolbar';
  for (const rg of RANGES) {
    const b = document.createElement('button'); b.className = 'chip' + (rg.key === activeRange ? ' active' : ''); b.textContent = rg.key === 'all' ? tr('usage.range_all') : rg.label;
    b.addEventListener('click', () => { activeRange = rg.key; load(); });
    bar.appendChild(b);
  }
  const search = document.createElement('input'); search.type = 'search'; search.className = 'usage-search';
  search.placeholder = tr('usage.search_ph');
  search.setAttribute('aria-label', tr('usage.search_ph'));
  search.value = searchQuery;
  search.addEventListener('input', () => { searchQuery = search.value; renderTable(); });
  bar.appendChild(search);
  viewEl.appendChild(bar);

  const sum = document.createElement('div'); sum.className = 'usage-summary';
  const stats = document.createElement('div'); stats.className = 'usage-stats';
  const cacheHitPct = r.global.cacheRead + r.global.input > 0
    ? Math.round((r.global.cacheRead / (r.global.cacheRead + r.global.input)) * 100)
    : 0;
  stats.append(...([
    [tr('usage.est_cost'), usd(r.globalCost) + (r.hasUnknownModel ? ' *' : '')],
    [tr('usage.cache_hit'), `${cacheHitPct}%`],
    [tr('usage.input'), fmt(r.global.input)], [tr('usage.output'), fmt(r.global.output)],
    [tr('usage.cache_w'), fmt(r.global.cacheWrite)], [tr('usage.cache_r'), fmt(r.global.cacheRead)],
    [tr('usage.web'), `${r.webSearch + r.webFetch}`], [tr('usage.sessions'), `${r.sessions}`],
    [tr('usage.active_time'), formatDuration(r.activeMs)],
  ] as [string, string][]).map(([k, v], i) => { const d = document.createElement('div'); d.className = i === 0 ? 'stat stat-lead' : 'stat'; d.innerHTML = `<b></b><span></span>`; d.querySelector('b')!.textContent = v; d.querySelector('span')!.textContent = k; return d; }));
  sum.appendChild(stats);
  sum.appendChild(shareBar(r.byModel.map((m, i) => ({ label: m.model, value: m.totals.input + m.totals.output, color: COLORS[i % COLORS.length] }))));
  const legend = document.createElement('div'); legend.className = 'usage-legend';
  const totalTok = r.byModel.reduce((acc, m) => acc + m.totals.input + m.totals.output, 0) || 1;
  r.byModel.forEach((m, i) => {
    const item = document.createElement('span'); item.className = 'legend-item';
    const sw = document.createElement('span'); sw.className = 'legend-swatch'; sw.style.background = COLORS[i % COLORS.length];
    const pct = Math.round(((m.totals.input + m.totals.output) / totalTok) * 100);
    const label = document.createElement('span'); label.textContent = `${m.model} · ${pct}%`;
    item.append(sw, label); legend.appendChild(item);
  });
  sum.appendChild(legend);
  viewEl.appendChild(sum);

  if (r.daily.length) {
    const chartBox = document.createElement('div'); chartBox.className = 'chart-box';
    const h = document.createElement('div'); h.className = 'chart-title';
    const dailyTotal = r.daily.reduce((acc, d) => acc + d.tokens, 0);
    h.textContent = `${tr('usage.daily_tokens')} · Σ ${fmt(dailyTotal)}`;
    const titles = r.daily.map((d) => `${d.day} · ${fmt(d.tokens)}`);
    chartBox.append(h, barChart(r.daily.map((d) => ({ label: d.day, value: d.tokens })), 80, titles));
    viewEl.appendChild(chartBox);
  }

  // Table-only region: rebuilt in isolation by search/sort/show-deleted so the summary above
  // (computed from the full, unfiltered r.global etc.) never re-renders on a search keystroke.
  const tableWrap = document.createElement('div'); tableWrap.className = 'usage-table-wrap';
  viewEl.appendChild(tableWrap);

  function renderTable(): void {
    tableWrap.replaceChildren();
    const allRows = [...r.byProject].filter((p) => p.sessions > 0);
    const searched = filterProjectRows(allRows, searchQuery);
    const deletedTotal = searched.filter((p) => p.status === 'deleted').length;
    const rows = searched.filter((p) => showDeleted || p.status !== 'deleted').sort((a, b) => {
      // Active projects first, deleted (🗑) grouped below; then by the chosen sort key within each group.
      if ((a.status === 'deleted') !== (b.status === 'deleted')) return a.status === 'deleted' ? 1 : -1;
      const val = (p: typeof a): number =>
        sortKey === 'cost' ? (p.costEstimate ?? -1) : sortKey === 'sessions' ? p.sessions : sortKey === 'active' ? p.activeMs : p.totals[sortKey];
      const av = val(a), bv = val(b);
      return sortDir === 'desc' ? bv - av : av - bv;
    });
    if (deletedTotal > 0) {
      const ctl = document.createElement('label'); ctl.className = 'usage-show-deleted';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = showDeleted;
      cb.addEventListener('change', () => { showDeleted = cb.checked; renderTable(); });
      const sp = document.createElement('span'); sp.textContent = tr('usage.show_deleted');
      ctl.append(cb, sp); tableWrap.appendChild(ctl);
    }
    const table = document.createElement('table'); table.className = 'usage-table';
    const head = document.createElement('tr');
    for (const [key, label] of [['name', tr('usage.col_project')], ['cost', tr('usage.col_cost')], ['sessions', tr('proj.sessions')], ['active', tr('usage.col_time')], ['input', tr('usage.input')], ['output', tr('usage.output')]] as const) {
      const th = document.createElement('th');
      const isSortable = key !== 'name';
      const isActive = isSortable && key === sortKey;

      if (isSortable) {
        th.setAttribute('tabindex', '0');
        th.setAttribute('aria-sort', isActive ? (sortDir === 'desc' ? 'descending' : 'ascending') : 'none');
        const lbl = document.createElement('span'); lbl.textContent = label;
        const ind = document.createElement('span');
        ind.setAttribute('aria-hidden', 'true');
        ind.textContent = isActive ? (sortDir === 'desc' ? ' ▼' : ' ▲') : '';
        th.append(lbl, ind);
        const activate = (): void => {
          if (sortKey === (key as typeof sortKey)) sortDir = sortDir === 'desc' ? 'asc' : 'desc';
          else { sortKey = key as typeof sortKey; sortDir = 'desc'; }
          renderTable();
        };
        th.addEventListener('click', activate);
        th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } });
      } else {
        th.textContent = label;
        th.setAttribute('aria-sort', 'none');
      }
      head.appendChild(th);
    }
    table.appendChild(head);
    for (const p of rows) {
      const tr2 = document.createElement('tr');
      if (p.status === 'deleted') tr2.className = 'pu-deleted';
      const nameTd = document.createElement('td');
      if (p.status === 'deleted') {
        nameTd.append(`🗑 ${p.name} `);
        const badge = document.createElement('span'); badge.className = 'pu-badge'; badge.textContent = tr('usage.deleted_badge');
        nameTd.appendChild(badge);
      } else { nameTd.textContent = p.name; }
      tr2.appendChild(nameTd);
      for (const c of [usd(p.costEstimate), String(p.sessions), formatDuration(p.activeMs), fmt(p.totals.input), fmt(p.totals.output)]) {
        const td = document.createElement('td'); td.textContent = c; tr2.appendChild(td);
      }
      table.appendChild(tr2);
    }
    tableWrap.appendChild(table);
    if (deletedTotal > 0 && !showDeleted) {
      const hint = document.createElement('div'); hint.className = 'usage-deleted-hint';
      hint.textContent = tr('usage.deleted_hidden').replace('{n}', String(deletedTotal));
      tableWrap.appendChild(hint);
    }
  }
  renderTable();

  if (r.hasUnknownModel) {
    const note = document.createElement('div'); note.className = 'usage-note';
    note.textContent = tr('usage.disclaimer');
    viewEl.appendChild(note);
  }
}

export function mountUsage(): void { viewEl = document.getElementById('view-usage')!; }
export function showUsage(): void { load(); }
