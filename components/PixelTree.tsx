"use client";

/**
 * A pixel-art tree that grows up from the bottom of its box, drawn on a canvas.
 *
 * Decorative only. The tree is generated, not an asset: a seeded random walk
 * lays down branches on a coarse cell grid, each cell gets a heat value (hot
 * at a branch's core, cooling to its edges), and a palette maps heat to colour
 * from deep red through brand orange to near-white. The graph nodes are a nod
 * to the graph Hydra builds from your context.
 *
 * It grows in once on mount, then keeps moving like the reference: every cell
 * flickers on a stepped clock, a slow wave of heat climbs the branches, and a
 * handful of graph nodes drift between spots on the canopy, joined by dashed
 * edges. With reduced motion it draws the finished tree once and stops. Animation also pauses while the tab
 * is hidden, so it costs nothing in the background.
 */
import { useEffect, useRef } from "react";

const CELL = 7; // CSS px per cell, gap included
const GAP = 1;
const GROW_MS = 1800;
const FRAME_MS = 1000 / 24;

/** Heat → colour stops, from cool ember to white-hot core. */
const STOPS: [number, [number, number, number]][] = [
  [0.0, [60, 10, 4]],
  [0.25, [125, 20, 8]],
  [0.42, [196, 34, 12]],
  [0.58, [255, 72, 22]],
  [0.74, [255, 134, 42]],
  [0.88, [255, 204, 112]],
  [1.0, [255, 244, 222]],
];

const PALETTE: string[] = Array.from({ length: 64 }, (_, i) => {
  const v = i / 63;
  let k = 0;
  while (k < STOPS.length - 2 && v > STOPS[k + 1]![0]) k++;
  const [a, ca] = STOPS[k]!;
  const [b, cb] = STOPS[k + 1]!;
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  const c = ca.map((x, j) => Math.round(x + (cb[j]! - x) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
});

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Cell {
  x: number;
  y: number;
  heat: number;
  order: number;
  phase: number;
}

interface Tree {
  cells: Cell[];
  maxOrder: number;
  anchors: { x: number; y: number }[];
}

/** Lay out a tree on a cols × rows grid. Deterministic for a given seed. */
function growTree(cols: number, rows: number, seed: number): Tree {
  const rand = mulberry32(seed);
  const heat = new Float32Array(cols * rows);
  const order = new Float32Array(cols * rows).fill(Infinity);
  const tips: { x: number; y: number }[] = [];
  // Hard cap on branch count. Long limbs spawn children as they go, so
  // without a budget the recursion multiplies into thousands of branches.
  let budget = 70;
  const trunk = Math.max(4, Math.round(rows * 0.075));

  const stamp = (cx: number, cy: number, width: number, dist: number) => {
    const r = width / 2 + 0.35;
    const peak = Math.min(1, 0.55 + 0.45 * Math.sqrt(width / trunk));
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        const x = Math.round(cx + dx);
        const y = Math.round(cy + dy);
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
        const d = Math.hypot(x - cx, y - cy);
        if (d > r) continue;
        const v = peak * (1 - 0.65 * (d / (r + 0.4))) * (0.62 + 0.38 * rand());
        const i = y * cols + x;
        if (v > heat[i]!) heat[i] = v;
        if (dist < order[i]!) order[i] = dist;
      }
    }
  };

  const branch = (
    x: number,
    y: number,
    angle: number,
    target: number,
    length: number,
    width: number,
    depth: number,
    dist: number,
  ) => {
    budget--;
    const steps = Math.max(4, Math.round(length));
    for (let i = 0; i < steps; i++) {
      angle += (target - angle) * 0.035 + (rand() - 0.5) * 0.16;
      x += Math.cos(angle);
      y += Math.sin(angle);
      const w = Math.max(1, width * (1 - (i / steps) * 0.55));
      stamp(x, y, w, dist + i);
      const major = depth === 0 ? MAJOR.find((m) => m.at === i) : undefined;
      if (major) {
        branch(
          x,
          y,
          angle + (major.target - angle) * 0.25,
          major.target + (rand() - 0.5) * 0.08,
          major.across ? cols * major.length : rows * major.length,
          Math.max(1.5, w * major.width),
          1,
          dist + i,
        );
      } else if (budget > 0 && depth > 0 && depth < 4 && i > steps * 0.12 && rand() < 0.035) {
        // Children mostly sweep right and level out, like the reference,
        // with the odd one reaching up or back to the left.
        const roll = rand();
        const childTarget =
          roll < 0.55 ? -0.18 + rand() * 0.25 : roll < 0.8 ? -1.15 + rand() * 0.4 : -2.5 + rand() * 0.35;
        branch(
          x,
          y,
          angle + (childTarget - angle) * 0.35,
          childTarget,
          Math.min(length * (0.35 + rand() * 0.4), (childTarget > -0.5 ? cols * 0.3 : rows * 0.4)),
          Math.max(1, w * (0.55 + rand() * 0.2)),
          depth + 1,
          dist + i,
        );
      }
      if (x < -4 || x > cols + 4 || y < -4) break;
    }
    tips.push({ x, y });
  };

  // The trunk throws a fixed set of big limbs so every layout reads as the
  // same tree: two long ones sweeping right across the box, one reaching up,
  // one back to the left. Smaller branches grow from those at random.
  const trunkLen = Math.round(rows * 0.82);
  const MAJOR = [
    { at: Math.round(trunkLen * 0.34), target: -0.12, length: 0.78, width: 0.62, across: true },
    { at: Math.round(trunkLen * 0.46), target: -2.55, length: 0.42, width: 0.55, across: false },
    { at: Math.round(trunkLen * 0.55), target: -0.3, length: 0.62, width: 0.55, across: true },
    { at: Math.round(trunkLen * 0.72), target: -1.2, length: 0.55, width: 0.5, across: false },
  ];
  branch(cols * 0.17, rows + 1, -Math.PI / 2, -Math.PI / 2 + 0.08, trunkLen, trunk, 0, 0);

  // Embers: faint speckle around the canopy, sparser further out.
  for (let n = 0; n < cols * rows * 0.09; n++) {
    const x = Math.floor(rand() * cols);
    const y = Math.floor(rand() * rows);
    const i = y * cols + x;
    if (heat[i]! > 0) continue;
    let near = 0;
    for (let k = 0; k < 6 && !near; k++) {
      const j = (y + Math.round((rand() - 0.5) * 8)) * cols + x + Math.round((rand() - 0.5) * 8);
      if (j >= 0 && j < heat.length && heat[j]! > 0.25) near = 1;
    }
    if (!near && rand() > 0.04) continue;
    heat[i] = 0.06 + rand() * (near ? 0.3 : 0.12);
    order[i] = Number.isFinite(order[i]!) ? order[i]! : rows * 1.6 * rand();
  }

  const cells: Cell[] = [];
  let maxOrder = 1;
  for (let i = 0; i < heat.length; i++) {
    const h = heat[i]!;
    if (h <= 0.04) continue;
    const o = Number.isFinite(order[i]!) ? order[i]! : 0;
    if (o > maxOrder) maxOrder = o;
    cells.push({ x: i % cols, y: Math.floor(i / cols), heat: h, order: o, phase: rand() * Math.PI * 2 });
  }

  // Anchor points for the graph nodes: hot cells in the right-hand canopy,
  // where the long limbs reach. Nodes wander between these.
  const anchors = cells
    .filter((c) => c.heat > 0.45 && c.x > cols * 0.45 && c.x < cols - 4 && c.y > 3 && c.y < rows - 3)
    .map((c) => ({ x: c.x, y: c.y }));
  return { cells, maxOrder, anchors };
}

/** Cheap integer hash → [0, 1). Gives each cell its own flicker per time step. */
function hash3(x: number, y: number, z: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const NODE_COUNT = 5;
/** Flicker steps per second. Stepped, not smooth, so it reads as pixel art. */
const FLICKER_HZ = 9;

interface GraphNode {
  fx: number;
  fy: number;
  tx: number;
  ty: number;
  t0: number;
  dur: number;
  size: number;
  label: string;
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export function PixelTree({ className, seed = 7 }: { className?: string; seed?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let tree: Tree = { cells: [], maxOrder: 1, anchors: [] };
    let nodes: GraphNode[] = [];
    let width = 0;
    let height = 0;
    let raf = 0;
    let last = 0;
    let start = performance.now();

    const pickAnchor = () => {
      const a = tree.anchors[Math.floor(Math.random() * tree.anchors.length)];
      return a ? { x: a.x * CELL + 3, y: a.y * CELL + 3 } : { x: width * 0.75, y: height * 0.5 };
    };
    const score = () => Math.random().toFixed(4);

    const seedNodes = (now: number) => {
      nodes = Array.from({ length: tree.anchors.length ? NODE_COUNT : 0 }, (_, i) => {
        const p = pickAnchor();
        return {
          fx: p.x,
          fy: p.y,
          tx: p.x,
          ty: p.y,
          // Stagger the first moves so the nodes never travel in lockstep.
          t0: now + i * 450,
          dur: 0,
          size: 16 + Math.round(Math.random() * 22),
          label: score(),
        };
      });
    };

    const layout = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      tree = growTree(Math.ceil(width / CELL), Math.ceil(height / CELL), seed);
      seedNodes(performance.now());
    };

    const draw = (now: number) => {
      const t = (now - start) / 1000;
      const grow = reduced ? 1 : Math.min(1, (now - start) / GROW_MS);
      const front = grow * tree.maxOrder;
      const step = Math.floor(t * FLICKER_HZ);
      ctx.clearRect(0, 0, width, height);

      for (const c of tree.cells) {
        if (c.order > front) continue;
        let v: number;
        if (reduced) {
          v = Math.pow(c.heat, 0.75);
        } else {
          // Each cell re-rolls its brightness every step, so the branches
          // boil like the reference; a slow wave of heat also climbs the tree.
          const n = hash3(c.x, c.y, step);
          const wave = 0.22 * Math.max(0, Math.sin(c.order * 0.12 - t * 2.4));
          v = Math.pow(c.heat * (0.45 + 0.8 * n), 0.75) + wave;
          if (n > 0.985 && c.heat > 0.3) v = 1; // the odd white-hot spark
          // Fresh growth arrives hot, then settles.
          v += Math.max(0, 1 - (front - c.order) / 6) * 0.3;
        }
        ctx.fillStyle = PALETTE[Math.round(Math.min(1, v) * 63)]!;
        ctx.fillRect(c.x * CELL, c.y * CELL, CELL - GAP, CELL - GAP);
      }

      if (grow < 1 || nodes.length === 0) return;

      // Graph nodes drift between spots on the canopy, joined by dashed edges.
      const fade = reduced ? 1 : Math.min(1, (now - start - GROW_MS) / 600);
      const pts = nodes.map((n) => {
        if (!reduced && now >= n.t0 + n.dur + 1400) {
          const p = pickAnchor();
          n.fx = n.tx;
          n.fy = n.ty;
          n.tx = p.x;
          n.ty = p.y;
          n.t0 = now;
          n.dur = 1600 + Math.random() * 1600;
          n.label = score();
        }
        const k = n.dur ? easeInOut(Math.min(1, Math.max(0, (now - n.t0) / n.dur))) : 1;
        return { x: n.fx + (n.tx - n.fx) * k, y: n.fy + (n.ty - n.fy) * k, size: n.size, label: n.label };
      });

      ctx.globalAlpha = Math.max(0, fade);
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      pts.forEach((p, i) => {
        for (const j of [i + 1, i + 2]) {
          const q = pts[j % pts.length]!;
          if (q === p) continue;
          ctx.moveTo(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5);
          ctx.lineTo(Math.round(q.x) + 0.5, Math.round(q.y) + 0.5);
        }
      });
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.strokeStyle = "#ffffff";
      ctx.fillStyle = "#ffffff";
      ctx.font = "8px ui-monospace, SFMono-Regular, Menlo, monospace";
      for (const p of pts) {
        const s = p.size;
        const x0 = Math.round(p.x - s / 2) + 0.5;
        const y0 = Math.round(p.y - s / 2) + 0.5;
        ctx.strokeRect(x0, y0, s, s);
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x0 + s, y0 + s);
        ctx.moveTo(x0 + s, y0);
        ctx.lineTo(x0, y0 + s);
        ctx.stroke();
        // Score sits inside the box's lower edge, like the reference; keep it on screen.
        const tw = ctx.measureText(p.label).width;
        const lx = Math.min(width - tw - 2, x0 + s / 2 - tw / 2);
        ctx.fillText(p.label, lx, y0 + s - 3);
      }
      ctx.globalAlpha = 1;
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < FRAME_MS) return;
      last = now;
      draw(now);
    };

    const run = () => {
      cancelAnimationFrame(raf);
      if (reduced) draw(performance.now());
      else raf = requestAnimationFrame(tick);
    };

    layout();
    run();

    // ResizeObserver fires once as soon as it starts observing. Only a real
    // size change re-lays the tree, so that first call doesn't skip the growth.
    let seenW = width;
    let seenH = height;
    const ro = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect();
      if (Math.abs(rect.width - seenW) < 1 && Math.abs(rect.height - seenH) < 1) return;
      seenW = rect.width;
      seenH = rect.height;
      layout();
      // Re-lay without replaying the growth on every resize.
      start = performance.now() - GROW_MS - 600;
      run();
    });
    ro.observe(canvas);

    const onVisibility = () => {
      if (document.hidden) cancelAnimationFrame(raf);
      else run();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [seed]);

  return <canvas ref={canvasRef} aria-hidden className={className} />;
}
