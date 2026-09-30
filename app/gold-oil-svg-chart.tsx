"use client";

import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GoldOilPoint } from '../lib/gold-oil';
import type { analyzeGoldOilFunding } from '../lib/gold-oil-funding';
import { chartDomain, chartPath } from '../lib/gold-oil-chart';
import { nearestTimeIndex } from '../modules/oil/chart-performance.mjs';

const date = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const shortDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' });
type Row = { time: number; [key: string]: number | null };
type Series = { key: string; label: string; color: string; unit: string; digits: number; right?: boolean };
const ratioSeries: Series[] = [{ key: 'ratio', label: '金油比 XAU / CL', color: '#087f83', unit: '桶/盎司', digits: 3 }];
const priceSeries: Series[] = [{ key: 'xau', label: '黄金 XAU', color: '#087f83', unit: 'USDT/盎司', digits: 2 }, { key: 'cl', label: '原油 CL', color: '#356dc4', unit: 'USDT/桶', digits: 3, right: true }];
const fundingSeries = (annual: boolean): Series[] => [
  { key: annual ? 'longAnnualized' : 'longRate', label: '做多金油比', color: '#356dc4', unit: annual ? '% / 年' : '% / 小时', digits: 5 },
  { key: annual ? 'shortAnnualized' : 'shortRate', label: '做空金油比', color: '#087f83', unit: annual ? '% / 年' : '% / 小时', digits: 5 },
];
const annualSeries = fundingSeries(true), rateSeries = fundingSeries(false);

/** React owns SVG and inspection state; no asynchronous renderer or measurement gate. */
const Plot = memo(function Plot({ points, series, label, reference, percent = false, annual = false }: { points: Row[]; series: Series[]; label: string; reference?: number; percent?: boolean; annual?: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 700, height: percent ? 230 : 340 });
  const [selected, setSelected] = useState<number | null>(null);
  useLayoutEffect(() => {
    const node = element.current;
    if (!node) return;
    const measure = () => {
      const { width, height } = node.getBoundingClientRect();
      // A hidden market keeps its last measured geometry and DOM.
      if (width > 0 && height > 0) setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const geometry = useMemo(() => {
    const left = percent ? 78 : 58, right = series.some(item => item.right) ? 58 : 14, top = 18, bottom = size.height - 36;
    const width = Math.max(1, size.width - left - right), start = points[0]?.time ?? 0, end = points.at(-1)?.time ?? start;
    const domains = [false, true].map(right => chartDomain(points.flatMap(row => series.filter(item => Boolean(item.right) === right).map(item => row[item.key])), right ? undefined : reference));
    const x = (time: number) => left + (end === start ? 0.5 : (time - start) / (end - start)) * width;
    const y = (value: number, right = false) => { const domain = domains[Number(right)]; return top + (domain.max - value) / (domain.max - domain.min) * (bottom - top); };
    const paths = series.map(item => chartPath(points, row => row[item.key], x, value => y(value, item.right)));
    const count = end === start ? 1 : Math.max(2, Math.min(6, Math.floor(width / 115)));
    const times = Array.from({ length: count }, (_, index) => start + (end - start) * index / Math.max(1, count - 1));
    return { left, right, top, bottom, width, start, end, domains, x, y, paths, times };
  }, [points, series, reference, size, percent]);
  const row = selected === null ? null : points[Math.min(selected, points.length - 1)];
  const tick = (value: number, right: boolean) => percent ? `${(value * 100).toFixed(annual ? 1 : 4)}%` : value.toFixed(series.find(item => Boolean(item.right) === right)?.key === 'xau' ? 0 : 2);
  const inspect = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const target = geometry.start + ((event.clientX - rect.left) * size.width / rect.width - geometry.left) / geometry.width * (geometry.end - geometry.start);
    setSelected(nearestTimeIndex(points, target));
  };
  return <div ref={element} className="gold-svg-chart">
    <svg className="gold-chart-svg" width="100%" height="100%" viewBox={`0 0 ${size.width} ${size.height}`} role="graphics-document" aria-label={label} tabIndex={0}
      onPointerMove={inspect} onPointerDown={inspect} onPointerLeave={event => { if (event.pointerType === 'mouse') setSelected(null); }}
      onFocus={() => setSelected(previous => previous ?? points.length - 1)} onBlur={() => setSelected(null)}
      onKeyDown={event => { if (event.key === 'Escape') { setSelected(null); return; } if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); setSelected(previous => event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1 : Math.max(0, Math.min(points.length - 1, (previous ?? points.length - 1) + (event.key === 'ArrowLeft' ? -1 : 1)))); }}>
      <title>{label}</title><desc>缺失时段断线；触摸、鼠标或左右方向键查看数值。价格完整记录另见下方滑块和明细。</desc>
      {[0, 1, 2, 3, 4].map(index => { const y = geometry.bottom - index / 4 * (geometry.bottom - geometry.top); return <g key={index}>
        <line x1={geometry.left} x2={size.width - geometry.right} y1={y} y2={y} stroke="#dce5e7" strokeDasharray="3 5"/>
        {[false, ...(series.some(item => item.right) ? [true] : [])].map(right => { const domain = geometry.domains[Number(right)]; return <text key={String(right)} className={right ? 'gold-axis-right' : 'gold-axis-left'} x={right ? size.width - geometry.right + 8 : geometry.left - 8} y={y + 4} textAnchor={right ? 'start' : 'end'}>{tick(domain.min + index / 4 * (domain.max - domain.min), right)}</text>; })}
      </g>; })}
      {geometry.times.map((time, index) => <text key={index} x={geometry.x(time)} y={size.height - 12} textAnchor={index === 0 ? 'start' : index === geometry.times.length - 1 ? 'end' : 'middle'}>{geometry.end - geometry.start > 172800000 ? shortDate.format(time) : date.format(time)}</text>)}
      {reference !== undefined && <line className="gold-reference-line" x1={geometry.left} x2={size.width - geometry.right} y1={geometry.y(reference)} y2={geometry.y(reference)} stroke="#66748a" strokeDasharray="4 4"/>}
      {series.map((item, index) => <path className="gold-line" data-series={item.key} key={item.key} d={geometry.paths[index]} fill="none" stroke={item.color} strokeWidth={percent ? 1.6 : 2} strokeLinecap="round" strokeLinejoin="round"/>)}
      {row && <g aria-hidden="true"><line x1={geometry.x(row.time)} x2={geometry.x(row.time)} y1={geometry.top} y2={geometry.bottom} stroke="#66748a" strokeDasharray="3 4"/>{series.map(item => { const value = row[item.key]; return value === null ? null : <circle key={item.key} cx={geometry.x(row.time)} cy={geometry.y(value, item.right)} r={3.5} fill={item.color} stroke="white" strokeWidth={1.5}/>; })}</g>}
    </svg>
    {row && <output className="gold-chart-tooltip" aria-live="polite"><span>{date.format(row.time)} 北京时间</span>{series.map(item => { const value = row[item.key]; return <span key={item.key}>{item.label}：{value === null ? '缺失' : `${(value * (percent ? 100 : 1)).toFixed(item.digits)} ${item.unit}`}</span>; })}</output>}
  </div>;
});

export const FundingChart = memo(function FundingChart({ points, view }: { points: ReturnType<typeof analyzeGoldOilFunding>['points']; view: 'annualized' | 'rate' }) {
  return <Plot points={points} series={view === 'annualized' ? annualSeries : rateSeries} label={`历史多空资金费率 · ${view === 'annualized' ? '累计年化 % / 年' : '日均小时率 % / 小时'}`} reference={0} percent annual={view === 'annualized'}/>;
});
export default memo(function GoldOilChart({ points, view = 'ratio', average }: { points: GoldOilPoint[]; view?: 'ratio' | 'prices'; average?: number }) {
  return <Plot points={points} series={view === 'ratio' ? ratioSeries : priceSeries} label={view === 'ratio' ? '金油比走势 · 桶/盎司' : '黄金左轴 USDT/盎司 · 原油右轴 USDT/桶'} reference={view === 'ratio' ? average : undefined}/>;
});
