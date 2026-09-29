"use client";

import { memo } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { GoldOilPoint } from '../lib/gold-oil';
import type { analyzeGoldOilFunding } from '../lib/gold-oil-funding';

const date = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
export const FundingChart = memo(function FundingChart({ points, view }: { points: ReturnType<typeof analyzeGoldOilFunding>['points']; view: 'annualized' | 'rate' }) {
  return <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 700, height: 210 }}>
    <LineChart data={points} accessibilityLayer margin={{ top: 18, right: 16, bottom: 8, left: 2 }}>
      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e0e7ef"/>
      <XAxis dataKey="time" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={value => date.format(new Date(value))} minTickGap={65} tick={{ fontSize: 11 }}/>
      <YAxis tickFormatter={value => `${(Number(value) * 100).toFixed(view === 'rate' ? 4 : 2)}%`} width={74} tick={{ fontSize: 11 }}/>
      <ReferenceLine y={0} stroke="#66748a" strokeDasharray="3 3"/>
      <Tooltip labelFormatter={value => `${date.format(new Date(Number(value)))} 北京时间`} formatter={(value, name) => [`${(Number(value) * 100).toFixed(5)}%${view === 'annualized' ? ' / 年' : ' / 小时'}`, name]}/>
      <Line dataKey={view === 'annualized' ? 'longAnnualized' : 'longRate'} name="做多金油比" stroke="#356dc4" strokeWidth={1.6} dot={false} connectNulls={false} isAnimationActive={false}/>
      <Line dataKey={view === 'annualized' ? 'shortAnnualized' : 'shortRate'} name="做空金油比" stroke="#087f83" strokeWidth={1.6} dot={false} connectNulls={false} isAnimationActive={false}/>
    </LineChart>
  </ResponsiveContainer>;
});
export default memo(function GoldOilChart({ points, view = 'ratio', average }: { points: GoldOilPoint[]; view?: 'ratio' | 'prices'; average?: number }) {
  return <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 700, height: 340 }}>
    <LineChart data={points} accessibilityLayer margin={{ top: 20, right: 12, bottom: 12, left: 2 }}>
      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#dce5e7"/>
      <XAxis dataKey="time" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={value => date.format(new Date(value))} minTickGap={65} tick={{ fontSize: 11 }}/>
      <YAxis yAxisId="left" domain={['auto', 'auto']} tickFormatter={value => Number(value).toFixed(view === 'ratio' ? 2 : 0)} width={58} tick={{ fontSize: 12 }}/>
      {view === 'prices' && <YAxis yAxisId="right" orientation="right" domain={['auto', 'auto']} tickFormatter={value => Number(value).toFixed(2)} width={58} tick={{ fontSize: 12 }}/>}
      <Tooltip labelFormatter={value => `${date.format(new Date(Number(value)))} 北京时间`} formatter={(value, name) => [`${Number(value).toFixed(3)} ${view === 'ratio' ? '桶/盎司' : name === '黄金 XAU' ? 'USDT/盎司' : 'USDT/桶'}`, name]}/>
      {view === 'ratio' ? <><ReferenceLine yAxisId="left" y={average} stroke="#66748a" strokeDasharray="4 4"/><Line yAxisId="left" dataKey="ratio" name="金油比 XAU / CL" stroke="#087f83" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false}/></> : <><Line yAxisId="left" dataKey="xau" name="黄金 XAU" stroke="#087f83" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false}/><Line yAxisId="right" dataKey="cl" name="原油 CL" stroke="#356dc4" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false}/></>}
    </LineChart>
  </ResponsiveContainer>;
});
