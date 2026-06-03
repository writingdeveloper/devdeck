const NS = 'http://www.w3.org/2000/svg';

/** A simple bar chart. values: [{label, value}], height in px. */
export function barChart(values: { label: string; value: number }[], height = 80): SVGSVGElement {
  const w = Math.max(values.length * 14, 60), max = Math.max(1, ...values.map((v) => v.value));
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${height}`); svg.setAttribute('width', '100%'); svg.setAttribute('height', String(height));
  values.forEach((v, i) => {
    const h = Math.round((v.value / max) * (height - 4));
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', String(i * 14 + 2)); rect.setAttribute('y', String(height - h));
    rect.setAttribute('width', '10'); rect.setAttribute('height', String(h));
    rect.setAttribute('rx', '2'); rect.setAttribute('fill', '#6366f1');
    const title = document.createElementNS(NS, 'title'); title.textContent = `${v.label}: ${v.value.toLocaleString()}`;
    rect.appendChild(title); svg.appendChild(rect);
  });
  return svg;
}

/** A horizontal stacked share bar. parts: [{label, value, color}]. */
export function shareBar(parts: { label: string; value: number; color: string }[]): HTMLElement {
  const total = Math.max(1, parts.reduce((s, p) => s + p.value, 0));
  const wrap = document.createElement('div'); wrap.className = 'sharebar';
  for (const p of parts) {
    const seg = document.createElement('span');
    seg.style.width = `${(p.value / total) * 100}%`; seg.style.background = p.color;
    seg.title = `${p.label}: ${Math.round((p.value / total) * 100)}%`;
    wrap.appendChild(seg);
  }
  return wrap;
}
