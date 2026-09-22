"use client";

/**
 * Webhooks per hour, the last 24 hours, stacked by the system that sent them.
 *
 * Two series in categorical slots 1 and 2 (validated for both themes against this dashboard's surfaces), a legend,
 * thin columns rounded only at the data end, a 2px surface gap between stacked segments, a recessive grid, and a
 * tooltip per hour that keyboard focus shows too. The same numbers are in the table below it, so the tooltip is never
 * the only way to read a value.
 */

import { useEffect, useRef, useState } from "react";
import type { HourBucket } from "@/lib/control";

const H = 190, LEFT = 34, RIGHT = 8, TOP = 12, BOTTOM = 26;
const PLOT_H = H - TOP - BOTTOM;

const dubaiHour = (iso: string) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit" });

/** A step for the axis that gives about three gridlines: 1, 2, 5, 10, 20, 50 … */
function niceMax(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 4, step: 2 };
  const raw = max / 3;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  return { top: Math.ceil(max / step) * step, step };
}

/** A column segment, rounded at the top only when it is the data end. */
function segment(x: number, y: number, w: number, h: number, roundTop: boolean): string {
  if (h <= 0) return "";
  const r = roundTop ? Math.min(4, h, w / 2) : 0;
  return `M${x},${y + h} V${y + r} ${r ? `Q${x},${y} ${x + r},${y}` : ""} H${x + w - r} ${r ? `Q${x + w},${y} ${x + w},${y + r}` : ""} V${y + h} Z`;
}

export function ActivityChart({ buckets }: { buckets: HourBucket[] }) {
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the box's real width, one SVG unit to one pixel: scaled instead, a wide screen blew the labels up to 18px
  // and the columns past 24px, and a phone shrank the labels out of reading.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const PLOT_W = W - LEFT - RIGHT;
  const labelEvery = W < 520 ? 6 : 3;
  const max = Math.max(...buckets.map((b) => b.zuper + b.tuper), 0);
  const { top, step } = niceMax(max);
  const band = PLOT_W / buckets.length;
  const colW = Math.max(3, Math.min(18, band - 4));
  const yOf = (v: number) => TOP + PLOT_H - (v / top) * PLOT_H;
  const total = buckets.reduce((n, b) => n + b.zuper + b.tuper, 0);
  const shown = hover !== null ? buckets[hover] : null;

  return (
    <figure className="chart">
      <div className="legend" aria-hidden="true">
        <span><i className="swatch s1" />Zuper</span>
        <span><i className="swatch s2" />Tuper</span>
        <span className="dim">{total.toLocaleString()} in 24 hours</span>
      </div>
      <div className="chart-wrap" ref={box}>
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`Webhooks per hour over the last 24 hours: ${total} in all. The table below has every hour.`}>
          {Array.from({ length: top / step + 1 }, (_, i) => i * step).map((v) => (
            <g key={v}>
              <line x1={LEFT} x2={W - RIGHT} y1={yOf(v)} y2={yOf(v)} className="grid" />
              <text x={LEFT - 6} y={yOf(v) + 4} className="tick" textAnchor="end">{v}</text>
            </g>
          ))}
          {buckets.map((b, i) => {
            const x = LEFT + i * band + (band - colW) / 2;
            const zTop = yOf(b.zuper), tTop = yOf(b.zuper + b.tuper);
            const zH = TOP + PLOT_H - zTop;
            // 2px surface gap between the two segments, taken from the upper one.
            const tH = Math.max(0, zTop - tTop - (b.zuper && b.tuper ? 2 : 0));
            return (
              <g key={b.hour} tabIndex={0} role="img" className={`col${hover === i ? " on" : ""}`}
                aria-label={`${dubaiHour(b.hour)}: ${b.zuper} from Zuper, ${b.tuper} from Tuper${b.failed ? `, ${b.failed} failed` : ""}`}
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
                <rect x={LEFT + i * band} y={TOP} width={band} height={PLOT_H} className="hit" />
                <path d={segment(x, zTop, colW, zH, !b.tuper)} className="s1" />
                <path d={segment(x, tTop, colW, tH, true)} className="s2" />
                {i % labelEvery === 0 ? <text x={x + colW / 2} y={H - 8} className="tick" textAnchor="middle">{dubaiHour(b.hour)}</text> : null}
              </g>
            );
          })}
          <line x1={LEFT} x2={W - RIGHT} y1={TOP + PLOT_H} y2={TOP + PLOT_H} className="axis" />
        </svg>
        {shown && hover !== null ? (
          <div className="tip" style={{ left: `${((LEFT + hover * band + band / 2) / W) * 100}%` }} role="status">
            <strong>{dubaiHour(shown.hour)}–{dubaiHour(new Date(new Date(shown.hour).getTime() + 3_600_000).toISOString())}</strong>
            <span><i className="swatch s1" />Zuper <b>{shown.zuper}</b></span>
            <span><i className="swatch s2" />Tuper <b>{shown.tuper}</b></span>
            {shown.failed ? <span className="bad-text">{shown.failed} failed</span> : null}
          </div>
        ) : null}
      </div>
      <details className="table-view">
        <summary>Table</summary>
        <table>
          <thead><tr><th>Hour (Dubai)</th><th className="num">Zuper</th><th className="num">Tuper</th><th className="num">Failed</th></tr></thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.hour}><td>{dubaiHour(b.hour)}</td><td className="num">{b.zuper}</td><td className="num">{b.tuper}</td><td className="num">{b.failed}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
