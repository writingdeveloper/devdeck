import { barChart, shareBar } from './charts';
import { formatDuration } from '../shared/usage';
import { tr, localeTag } from './i18n-runtime';
import { renderLoadError } from './loadError';
import { filterProjectRows, aggregateDeleted } from '../shared/usageFilter';
import { selectProviderUsage, type LocalProjectUsage, type LocalUsageFilter, type LocalUsageProvider, type LocalUsageReport, type ProviderUsageSlice } from '../shared/localUsage';
import { createProviderLogo, providerName } from './providerLogo';

const RANGES: { key: string; label: string; days: number }[] = [
  { key: '7d', label: '7d', days: 7 },
  { key: '30d', label: '30d', days: 30 },
  { key: '90d', label: '90d', days: 90 },
  { key: 'all', label: '', days: Infinity as unknown as number },
];
const PROVIDERS: LocalUsageProvider[] = ['claude', 'codex'];
const COLORS = ['#6366f1', '#3b82f6', '#d98a1f', '#e0623f', '#9aa1ad'];

let viewEl: HTMLElement;
let activeRange = '30d';
let activeProvider: LocalUsageFilter = 'all';
let sortKey: 'cost' | 'input' | 'output' | 'sessions' | 'active' = 'cost';
let sortDir: 'desc' | 'asc' = 'desc';
let expandDeleted = false;
let searchQuery = '';

function fmt(n: number): string { return new Intl.NumberFormat(localeTag()).format(n); }
function usd(n: number | null): string { return n == null ? '—' : `~$${n.toFixed(2)}`; }
function providerSlice(report: LocalUsageReport, id: LocalUsageProvider): ProviderUsageSlice | undefined {
  return report.byProvider.find((slice) => slice.providerId === id);
}
function isUsageReport(value: unknown): value is LocalUsageReport {
  if (!value || typeof value !== 'object') return false;
  const report = value as Partial<LocalUsageReport>;
  return Array.isArray(report.byProvider) && Array.isArray(report.byProject) && Array.isArray(report.byModel) && Array.isArray(report.daily);
}

async function load(): Promise<void> {
  const range = RANGES.find((r) => r.key === activeRange)!;
  const sinceMs = range.days === Infinity ? Infinity : Date.now() - range.days * 86_400_000;
  const sk = document.createElement('div'); sk.className = 'skeleton'; sk.style.margin = '16px';
  viewEl.replaceChildren(sk);
  try {
    render(await window.devdeck.usageReport(sinceMs));
  } catch (e) {
    console.error('DevDeck: usage load failed', e);
    renderLoadError(viewEl, () => void load());
  }
}

function appendCostCard(parent: HTMLElement, label: string, cost: number | null, partial: boolean, providerId?: LocalUsageProvider, state: 'ready' | 'error' = 'ready'): void {
  const card = document.createElement('div');
  card.className = `usage-cost-card${providerId ? '' : ' lead'}`;
  const head = document.createElement('div'); head.className = 'usage-cost-label';
  if (providerId) head.append(createProviderLogo(providerId, 'ck-provider-logo sm'));
  const labelEl = document.createElement('span'); labelEl.textContent = label; head.appendChild(labelEl);
  const value = document.createElement('b'); value.textContent = state === 'error' ? tr('usage.provider_error_short') : usd(cost);
  card.append(head, value);
  if (partial && state !== 'error') {
    const note = document.createElement('span'); note.className = 'usage-partial'; note.textContent = tr('usage.partial'); card.appendChild(note);
  }
  parent.appendChild(card);
}

function appendCostCell(row: HTMLTableRowElement, cost: number | null, providerCosts: LocalProjectUsage['providerCosts'], partial: boolean): void {
  const td = document.createElement('td');
  const main = document.createElement('div'); main.textContent = `${usd(cost)}${partial ? ' *' : ''}`; td.appendChild(main);
  const claude = providerCosts.claude;
  const codex = providerCosts.codex;
  if (activeProvider === 'all' && claude !== undefined && codex !== undefined) {
    const sub = document.createElement('div'); sub.className = 'usage-cost-breakdown';
    sub.textContent = `${providerName('claude')} ${usd(claude)} · ${providerName('codex')} ${usd(codex)}`;
    td.appendChild(sub);
  }
  row.appendChild(td);
}

function render(report: LocalUsageReport): void {
  viewEl.replaceChildren();
  const selected = selectProviderUsage(report, activeProvider);

  const scope = document.createElement('div'); scope.className = 'usage-scope';
  const title = document.createElement('h2'); title.className = 'usage-scope-title'; title.textContent = tr('usage.local_title');
  const explainer = document.createElement('p'); explainer.className = 'usage-scope-note'; explainer.textContent = tr('usage.local_explainer');
  scope.append(title, explainer); viewEl.appendChild(scope);

  const toolbar = document.createElement('div'); toolbar.className = 'usage-toolbar';
  const ranges = document.createElement('div'); ranges.className = 'usage-range-filter'; ranges.setAttribute('aria-label', tr('usage.range_label'));
  for (const range of RANGES) {
    const button = document.createElement('button'); button.className = `chip${range.key === activeRange ? ' active' : ''}`;
    button.textContent = range.key === 'all' ? tr('usage.range_all') : range.label;
    button.setAttribute('aria-pressed', String(range.key === activeRange));
    button.addEventListener('click', () => { activeRange = range.key; void load(); }); ranges.appendChild(button);
  }
  toolbar.appendChild(ranges);
  const providerFilter = document.createElement('div'); providerFilter.className = 'usage-provider-filter'; providerFilter.setAttribute('role', 'group'); providerFilter.setAttribute('aria-label', tr('usage.provider_filter_label'));
  for (const id of ['all', ...PROVIDERS] as LocalUsageFilter[]) {
    const button = document.createElement('button'); button.className = `chip${id === activeProvider ? ' active' : ''}`;
    button.textContent = id === 'all' ? tr('usage.filter_all') : providerName(id);
    button.setAttribute('aria-pressed', String(id === activeProvider));
    button.addEventListener('click', () => { activeProvider = id; searchQuery = ''; render(report); }); providerFilter.appendChild(button);
  }
  toolbar.appendChild(providerFilter);
  if (selected.sessions > 0) {
    const search = document.createElement('input'); search.type = 'search'; search.className = 'usage-search'; search.placeholder = tr('usage.search_ph');
    search.setAttribute('aria-label', tr('usage.search_ph')); search.value = searchQuery; toolbar.appendChild(search);
  }
  viewEl.appendChild(toolbar);

  const costs = document.createElement('div'); costs.className = 'usage-cost-cards';
  appendCostCard(costs, tr('usage.cost_combined'), report.globalCost, report.hasUnknownModel);
  for (const id of PROVIDERS) {
    const slice = providerSlice(report, id);
    appendCostCard(costs, id === 'claude' ? tr('usage.cost_claude') : tr('usage.cost_codex'), slice?.globalCost ?? null, slice?.hasUnknownModel ?? false, id, slice?.state ?? 'error');
  }
  viewEl.appendChild(costs);

  const selectedSlice = activeProvider === 'all' ? undefined : providerSlice(report, activeProvider);
  if (selectedSlice?.state === 'error') {
    const error = document.createElement('div'); error.className = 'usage-provider-error'; error.textContent = tr('usage.provider_error'); viewEl.appendChild(error);
  }
  if (selected.sessions === 0) {
    const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = tr('usage.empty'); viewEl.appendChild(empty); return;
  }

  const summary = document.createElement('div'); summary.className = 'usage-summary';
  const stats = document.createElement('div'); stats.className = 'usage-stats';
  const cacheHitPct = selected.global.cacheRead + selected.global.input > 0 ? Math.round((selected.global.cacheRead / (selected.global.cacheRead + selected.global.input)) * 100) : 0;
  stats.append(...([
    [tr('usage.cache_hit'), `${cacheHitPct}%`], [tr('usage.input'), fmt(selected.global.input)], [tr('usage.output'), fmt(selected.global.output)],
    [tr('usage.cache_w'), fmt(selected.global.cacheWrite)], [tr('usage.cache_r'), fmt(selected.global.cacheRead)],
    [tr('usage.web'), `${selected.webSearch + selected.webFetch}`], [tr('usage.sessions'), `${selected.sessions}`], [tr('usage.active_time'), formatDuration(selected.activeMs)],
  ] as [string, string][]).map(([key, value]) => { const stat = document.createElement('div'); stat.className = 'stat'; const b = document.createElement('b'); b.textContent = value; const span = document.createElement('span'); span.textContent = key; stat.append(b, span); return stat; }));
  summary.appendChild(stats);
  summary.appendChild(shareBar(selected.byModel.map((model, i) => ({ label: `${providerName(model.providerId)} · ${model.model}`, value: model.totals.input + model.totals.output, color: COLORS[i % COLORS.length] }))));
  const legend = document.createElement('div'); legend.className = 'usage-legend';
  const totalTokens = selected.byModel.reduce((sum, model) => sum + model.totals.input + model.totals.output, 0) || 1;
  selected.byModel.forEach((model, i) => {
    const item = document.createElement('span'); item.className = 'legend-item';
    const swatch = document.createElement('span'); swatch.className = 'legend-swatch'; swatch.style.background = COLORS[i % COLORS.length];
    const pct = Math.round(((model.totals.input + model.totals.output) / totalTokens) * 100);
    const label = document.createElement('span'); label.textContent = `${model.model} · ${pct}%`;
    item.append(swatch, createProviderLogo(model.providerId, 'ck-provider-logo xs'), label); legend.appendChild(item);
  });
  summary.appendChild(legend); viewEl.appendChild(summary);

  if (selected.daily.length) {
    const chartBox = document.createElement('div'); chartBox.className = 'chart-box';
    const chartTitle = document.createElement('div'); chartTitle.className = 'chart-title';
    chartTitle.textContent = `${tr('usage.daily_tokens')} · Σ ${fmt(selected.daily.reduce((sum, day) => sum + day.tokens, 0))}`;
    chartBox.append(chartTitle, barChart(selected.daily.map((day) => ({ label: day.day, value: day.tokens })), 80, selected.daily.map((day) => `${day.day} · ${fmt(day.tokens)}`)));
    viewEl.appendChild(chartBox);
  }

  const tableWrap = document.createElement('div'); tableWrap.className = 'usage-table-wrap'; viewEl.appendChild(tableWrap);
  const search = toolbar.querySelector<HTMLInputElement>('.usage-search');
  if (search) search.addEventListener('input', () => { searchQuery = search.value; renderTable(); });

  function renderTable(): void {
    tableWrap.replaceChildren();
    const searched = filterProjectRows(selected.byProject.filter((project) => project.sessions > 0), searchQuery);
    const group = aggregateDeleted(searched);
    const value = (project: LocalProjectUsage): number => sortKey === 'cost' ? (project.costEstimate ?? -1) : sortKey === 'sessions' ? project.sessions : sortKey === 'active' ? project.activeMs : project.totals[sortKey];
    const rows = (expandDeleted ? [...searched] : searched.filter((project) => project.status !== 'deleted')).sort((a, b) => {
      if ((a.status === 'deleted') !== (b.status === 'deleted')) return a.status === 'deleted' ? 1 : -1;
      return sortDir === 'desc' ? value(b) - value(a) : value(a) - value(b);
    });
    if (group) {
      const control = document.createElement('label'); control.className = 'usage-show-deleted';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = expandDeleted;
      checkbox.addEventListener('change', () => { expandDeleted = checkbox.checked; renderTable(); });
      const text = document.createElement('span'); text.textContent = tr('usage.expand_deleted'); control.append(checkbox, text); tableWrap.appendChild(control);
    }
    const table = document.createElement('table'); table.className = 'usage-table';
    const tableHead = document.createElement('tr');
    for (const [key, label] of [['name', tr('usage.col_project')], ['cost', tr('usage.col_cost')], ['sessions', tr('proj.sessions')], ['active', tr('usage.col_time')], ['input', tr('usage.input')], ['output', tr('usage.output')]] as const) {
      const th = document.createElement('th'); const sortable = key !== 'name'; const active = sortable && key === sortKey;
      if (sortable) {
        th.tabIndex = 0; th.setAttribute('aria-sort', active ? (sortDir === 'desc' ? 'descending' : 'ascending') : 'none');
        const text = document.createElement('span'); text.textContent = label; const indicator = document.createElement('span'); indicator.setAttribute('aria-hidden', 'true'); indicator.textContent = active ? (sortDir === 'desc' ? ' ▼' : ' ▲') : ''; th.append(text, indicator);
        const activate = (): void => { if (sortKey === key) sortDir = sortDir === 'desc' ? 'asc' : 'desc'; else { sortKey = key; sortDir = 'desc'; } renderTable(); };
        th.addEventListener('click', activate); th.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } });
      } else { th.textContent = label; th.setAttribute('aria-sort', 'none'); }
      tableHead.appendChild(th);
    }
    table.appendChild(tableHead);
    const appendRow = (project: LocalProjectUsage, groupedCount?: number): void => {
      const row = document.createElement('tr'); if (project.status === 'deleted') row.className = 'pu-deleted';
      const name = document.createElement('td');
      if (groupedCount != null) name.textContent = `🗑 ${tr('usage.deleted_group').replace('{n}', String(groupedCount))}`;
      else if (project.status === 'deleted') { name.append(`🗑 ${project.name} `); const badge = document.createElement('span'); badge.className = 'pu-badge'; badge.textContent = tr('usage.deleted_badge'); name.appendChild(badge); }
      else name.textContent = project.name;
      row.appendChild(name); appendCostCell(row, project.costEstimate, project.providerCosts, project.hasUnknownModel);
      for (const content of [String(project.sessions), formatDuration(project.activeMs), fmt(project.totals.input), fmt(project.totals.output)]) { const td = document.createElement('td'); td.textContent = content; row.appendChild(td); }
      table.appendChild(row);
    };
    rows.forEach((project) => appendRow(project));
    if (group && !expandDeleted) appendRow({ path: '', name: '', sessions: group.sessions, totals: group.totals, costEstimate: group.costEstimate, hasUnknownModel: group.hasUnknownModel, activeMs: group.activeMs, status: 'deleted', providerCosts: group.providerCosts }, group.count);
    tableWrap.appendChild(table);
  }
  renderTable();

  if (selected.hasUnknownModel) { const note = document.createElement('div'); note.className = 'usage-note'; note.textContent = tr('usage.disclaimer'); viewEl.appendChild(note); }
}

export function mountUsage(): void {
  viewEl = document.getElementById('view-usage')!;
  document.addEventListener('devdeck:local-usage-report', (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (isUsageReport(detail)) render(detail);
  });
}
export function showUsage(): void { void load(); }
