// src/renderer/imageMarkup.ts
// Boxes, arrows and freehand marks drawn over an image in the viewer — "this button, here" — so the
// marked-up picture can go straight back to the session instead of round-tripping through an editor.
//
// Marks are kept in the image's own pixels, so they land where they were drawn whatever size the
// viewer shows the image at, and the picture that is sent is the full-resolution original with them.
export type MarkTool = 'box' | 'arrow' | 'pen';

interface Pt { x: number; y: number }
interface Mark { tool: MarkTool; pts: Pt[] }

const COLOR = '#ff3b30';
/** A drag shorter than this (image pixels) was a click, not a mark. */
const MIN_DRAG = 4;

export class ImageMarkup {
  readonly canvas = document.createElement('canvas');
  tool: MarkTool = 'box';
  private marks: Mark[] = [];
  private drawing: Mark | null = null;
  private enabled = false;
  private readonly resize = new ResizeObserver(() => this.redraw());

  /** `img` is the shown image; the canvas covers `stage`, which contains it. */
  constructor(private readonly img: HTMLImageElement, private readonly stage: HTMLElement, private readonly changed: () => void) {
    this.canvas.className = 'ck-img-markup';
    stage.appendChild(this.canvas);
    this.resize.observe(stage);
    this.canvas.addEventListener('pointerdown', (e) => this.down(e));
    this.canvas.addEventListener('pointermove', (e) => this.move(e));
    this.canvas.addEventListener('pointerup', (e) => this.up(e));
    this.canvas.addEventListener('pointercancel', () => { this.drawing = null; this.redraw(); });
  }

  get count(): number { return this.marks.length; }
  get active(): boolean { return this.enabled; }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.canvas.classList.toggle('on', on);
    this.redraw();
  }

  undo(): void { this.marks.pop(); this.redraw(); this.changed(); }
  clear(): void { this.marks = []; this.drawing = null; this.redraw(); this.changed(); }
  dispose(): void { this.resize.disconnect(); this.canvas.remove(); }

  /** The image with the marks on it, at the image's own resolution. Null before the image has loaded. */
  composite(): HTMLCanvasElement | null {
    const w = this.img.naturalWidth, h = this.img.naturalHeight;
    if (!w || !h) return null;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); if (!ctx) return null;
    ctx.drawImage(this.img, 0, 0);
    for (const m of this.marks) paint(ctx, m, strokeFor(w, h), (p) => p);
    return c;
  }

  /** Where the image is drawn inside the stage, in CSS pixels; null while it has no size. */
  private shown(): { left: number; top: number; width: number; height: number } | null {
    const s = this.stage.getBoundingClientRect(), r = this.img.getBoundingClientRect();
    if (!r.width || !r.height || !this.img.naturalWidth) return null;
    return { left: r.left - s.left, top: r.top - s.top, width: r.width, height: r.height };
  }

  private toImage(e: PointerEvent): Pt | null {
    const at = this.shown(); if (!at) return null;
    const s = this.stage.getBoundingClientRect();
    const x = (e.clientX - s.left - at.left) / at.width * this.img.naturalWidth;
    const y = (e.clientY - s.top - at.top) / at.height * this.img.naturalHeight;
    return { x: clamp(x, 0, this.img.naturalWidth), y: clamp(y, 0, this.img.naturalHeight) };
  }

  private down(e: PointerEvent): void {
    if (!this.enabled || e.button !== 0) return;
    const p = this.toImage(e); if (!p) return;
    e.preventDefault(); e.stopPropagation();
    this.canvas.setPointerCapture(e.pointerId);
    this.drawing = { tool: this.tool, pts: [p, p] };
  }

  private move(e: PointerEvent): void {
    if (!this.drawing) return;
    const p = this.toImage(e); if (!p) return;
    if (this.drawing.tool === 'pen') this.drawing.pts.push(p);
    else this.drawing.pts[1] = p;
    this.redraw();
  }

  private up(e: PointerEvent): void {
    const m = this.drawing; this.drawing = null;
    if (!m) return;
    e.stopPropagation();
    const a = m.pts[0], b = m.pts[m.pts.length - 1];
    const span = m.tool === 'pen' ? m.pts.length : Math.hypot(b.x - a.x, b.y - a.y);
    if (span >= MIN_DRAG) { this.marks.push(m); this.changed(); }
    this.redraw();
  }

  redraw(): void {
    const s = this.stage.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(s.width * dpr), h = Math.round(s.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    const ctx = this.canvas.getContext('2d'); if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const at = this.shown(); if (!at) return;
    const sx = at.width / this.img.naturalWidth, sy = at.height / this.img.naturalHeight;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const map = (p: Pt): Pt => ({ x: at.left + p.x * sx, y: at.top + p.y * sy });
    // Drawn as thick on screen as it will be in the sent image, relative to the picture.
    const width = strokeFor(this.img.naturalWidth, this.img.naturalHeight) * sx;
    for (const m of this.marks) paint(ctx, m, width, map);
    if (this.drawing) paint(ctx, this.drawing, width, map);
  }
}

function clamp(v: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, v)); }

/** A line that reads at a glance on a 4K screenshot and does not swamp a small one. */
function strokeFor(w: number, h: number): number { return Math.max(3, Math.round(Math.max(w, h) / 320)); }

function paint(ctx: CanvasRenderingContext2D, m: Mark, width: number, map: (p: Pt) => Pt): void {
  ctx.save();
  ctx.strokeStyle = COLOR; ctx.lineWidth = width; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // A dark halo keeps red legible on red or busy backgrounds.
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)'; ctx.shadowBlur = width * 1.5;
  const pts = m.pts.map(map);
  const a = pts[0], b = pts[pts.length - 1];
  ctx.beginPath();
  if (m.tool === 'box') {
    ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  } else if (m.tool === 'arrow') {
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const head = width * 4 + 6;
    for (const side of [-1, 1]) {
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(b.x - head * Math.cos(angle + side * 0.5), b.y - head * Math.sin(angle + side * 0.5));
    }
  } else {
    ctx.moveTo(a.x, a.y);
    for (const p of pts.slice(1)) ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.restore();
}
