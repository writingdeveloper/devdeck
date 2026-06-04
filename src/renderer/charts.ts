const NS = 'http://www.w3.org/2000/svg';

/** A simple bar chart. values: [{label, value}], height in px. */
export function barChart(values: { label: string; value: number }[], height = 80): SVGSVGElement {
  const LABEL_H = 14;
  const chartH = height - LABEL_H;
  const w = Math.max(values.length * 14, 60), max = Math.max(1, ...values.map((v) => v.value));
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(height));
  svg.setAttribute('role', 'img');

  const svgTitle = document.createElementNS(NS, 'title');
  svgTitle.textContent = 'Daily token usage bar chart';
  svg.appendChild(svgTitle);

  values.forEach((v, i) => {
    const h = Math.round((v.value / max) * (chartH - 4));
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', String(i * 14 + 2));
    rect.setAttribute('y', String(chartH - h));
    rect.setAttribute('width', '10');
    rect.setAttribute('height', String(h));
    rect.setAttribute('rx', '2');
    rect.setAttribute('fill', '#6366f1');
    rect.setAttribute('aria-label', `${v.label}: ${v.value.toLocaleString()}`);
    const title = document.createElementNS(NS, 'title');
    title.textContent = `${v.label}: ${v.value.toLocaleString()}`;
    rect.appendChild(title);
    svg.appendChild(rect);
  });

  if (values.length > 0) {
    const labelY = String(height - 2);
    const first = values[0];
    const firstTxt = document.createElementNS(NS, 'text');
    firstTxt.setAttribute('x', '2');
    firstTxt.setAttribute('y', labelY);
    firstTxt.setAttribute('font-size', '9');
    firstTxt.setAttribute('fill', '#9aa1ad');
    firstTxt.setAttribute('aria-hidden', 'true');
    firstTxt.textContent = first.label.slice(-5);
    svg.appendChild(firstTxt);

    if (values.length > 1) {
      const last = values[values.length - 1];
      const lastX = (values.length - 1) * 14 + 12;
      const lastTxt = document.createElementNS(NS, 'text');
      lastTxt.setAttribute('x', String(lastX));
      lastTxt.setAttribute('y', labelY);
      lastTxt.setAttribute('font-size', '9');
      lastTxt.setAttribute('fill', '#9aa1ad');
      lastTxt.setAttribute('text-anchor', 'end');
      lastTxt.setAttribute('aria-hidden', 'true');
      lastTxt.textContent = last.label.slice(-5);
      svg.appendChild(lastTxt);
    }
  }

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
