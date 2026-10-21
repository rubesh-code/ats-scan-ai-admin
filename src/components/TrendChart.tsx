import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

import type { DailyPoint } from '@/api/types';
import { formatDay } from '@/lib/format';

type Props = {
  title: string;
  points: DailyPoint[];
  /** Formats values on the axis, tooltip, end label and table. */
  format: (n: number) => string;
  /** Axis ticks can use a shorter form (₹12K instead of ₹12,000). */
  formatTick?: (n: number) => string;
  /** Previous data stays drawn, dimmed, while a new range loads. */
  stale?: boolean;
};

const HEIGHT = 220;
const PAD = { top: 16, right: 56, bottom: 28, left: 52 };

/** Clean axis ticks: 0 and 3–5 round steps that cover the max. */
function niceTicks(max: number) {
  if (max <= 0) return [0, 1];
  const rough = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? rough;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 1000) / 1000);
  if ((ticks.at(-1) ?? 0) < max) ticks.push((ticks.at(-1) ?? 0) + step);
  return ticks;
}

/**
 * Single-series daily trend. One series needs no legend: the card title names
 * it. Values are reachable without hovering through the end label, the axis
 * and the "Show table" view.
 */
export function TrendChart({ title, points, format, formatTick = format, stale = false }: Props) {
  const tableId = useId();
  const frameRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);

  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const update = () => setWidth(Math.max(280, Math.round(el.getBoundingClientRect().width)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const geometry = useMemo(() => {
    const max = Math.max(0, ...points.map((p) => p.value));
    const ticks = niceTicks(max);
    const top = ticks.at(-1) || 1;
    const plotW = width - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const x = (i: number) => PAD.left + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
    const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join('');
    const area = points.length
      ? `${line}L${x(points.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`
      : '';
    // Roughly one x label per 70px, always including the first and last day.
    const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(plotW / 70))));
    const xLabels = points
      .map((p, i) => ({ i, label: formatDay(p.date) }))
      .filter(({ i }) => i % every === 0 || i === points.length - 1)
      .filter(({ i }, k, all) => i === points.length - 1 || (all[k + 1]?.i ?? Infinity) - i >= every * 0.6);
    return { ticks, x, y, line, area, xLabels, plotW };
  }, [points, width]);

  const { ticks, x, y, line, area, xLabels } = geometry;
  const last = points.length - 1;
  const lastPoint = points[last];
  const activePoint = active === null ? null : points[active];

  function pointerToIndex(event: PointerEvent<SVGRectElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / rect.width;
    return Math.min(last, Math.max(0, Math.round(ratio * last)));
  }

  function onKeyDown(event: KeyboardEvent<SVGSVGElement>) {
    if (!points.length) return;
    const moves: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      Home: -Infinity,
      End: Infinity,
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    setActive((current) => {
      const from = current ?? last;
      return Math.min(last, Math.max(0, Number.isFinite(move) ? from + move : move < 0 ? 0 : last));
    });
  }

  const tooltipLeft = activePoint ? Math.min(Math.max(x(active!), 70), width - 70) : 0;

  return (
    <figure className="chart" data-stale={stale || undefined}>
      <figcaption className="chart-head">
        <span className="chart-title">{title}</span>
        <button
          type="button"
          className="link-btn"
          aria-expanded={showTable}
          aria-controls={tableId}
          onClick={() => setShowTable((v) => !v)}
        >
          {showTable ? 'Show chart' : 'Show table'}
        </button>
      </figcaption>

      {showTable ? (
        <div className="table-wrap chart-table" id={tableId}>
          <table>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col" className="num">
                  {title}
                </th>
              </tr>
            </thead>
            <tbody>
              {[...points].reverse().map((p) => (
                <tr key={p.date}>
                  <td>{formatDay(p.date)}</td>
                  <td className="num">{format(p.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-frame" ref={frameRef}>
          {points.length === 0 ? (
            <p className="empty">No data for this range.</p>
          ) : (
            <>
              <svg
                width={width}
                height={HEIGHT}
                role="img"
                aria-label={`${title}. Latest ${lastPoint ? `${formatDay(lastPoint.date)}: ${format(lastPoint.value)}` : 'no data'}. Use arrow keys to read each day.`}
                tabIndex={0}
                onKeyDown={onKeyDown}
                onBlur={() => setActive(null)}
              >
                {ticks.map((t) => (
                  <g key={t}>
                    <line className="grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
                    <text className="tick" x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">
                      {formatTick(t)}
                    </text>
                  </g>
                ))}
                <line className="baseline" x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} />
                {xLabels.map(({ i, label }) => (
                  <text key={i} className="tick" x={x(i)} y={HEIGHT - 8} textAnchor="middle">
                    {label}
                  </text>
                ))}

                <path className="series-area" d={area} />
                <path className="series-line" d={line} />

                {lastPoint && (
                  <>
                    <circle className="series-dot" cx={x(last)} cy={y(lastPoint.value)} r={4} />
                    <text className="end-label" x={x(last) + 10} y={y(lastPoint.value)} dy="0.32em">
                      {formatTick(lastPoint.value)}
                    </text>
                  </>
                )}

                {activePoint && (
                  <>
                    <line className="crosshair" x1={x(active!)} x2={x(active!)} y1={PAD.top} y2={y(0)} />
                    <circle className="series-dot" cx={x(active!)} cy={y(activePoint.value)} r={5} />
                  </>
                )}

                {/* Hit area covers the whole plot so the reader aims at a date, not a 2px line. */}
                <rect
                  className="hit"
                  x={PAD.left - 8}
                  y={PAD.top}
                  width={geometry.plotW + 16}
                  height={HEIGHT - PAD.top - PAD.bottom}
                  onPointerMove={(e) => setActive(pointerToIndex(e))}
                  onPointerLeave={() => setActive(null)}
                />
              </svg>

              {activePoint && (
                <div className="tooltip" style={{ left: tooltipLeft }} role="status">
                  <strong>{format(activePoint.value)}</strong>
                  <span>
                    <i className="key-line" aria-hidden="true" />
                    {formatDay(activePoint.date)}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </figure>
  );
}
