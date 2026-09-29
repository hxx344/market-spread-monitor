"use client";

import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { GoldOilPoint } from '../lib/gold-oil';

const date = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
export default function GoldOilChart({ points }: { points: GoldOilPoint[] }) {
  return <ResponsiveContainer width="100%" height="100%" minWidth={0}>
    <LineChart data={points} accessibilityLayer margin={{ top: 20, right: 20, bottom: 12, left: 8 }}>
      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#dce5e7"/>
      <XAxis dataKey="time" type="number" scale="time" domain={['dataMin', 'dataMax']} tickFormatter={value => date.format(new Date(value))} minTickGap={65} tick={{ fontSize: 11 }}/>
      <YAxis domain={['auto', 'auto']} tickFormatter={value => Number(value).toFixed(2)} width={58} tick={{ fontSize: 12 }}/>
      <Tooltip labelFormatter={value => `${date.format(new Date(Number(value)))} 北京时间`} formatter={value => [`${Number(value).toFixed(3)} 桶/盎司`, '金油比 XAU / CL']}/>
      <Line dataKey="ratio" name="金油比 XAU / CL" stroke="#9a6718" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false}/>
    </LineChart>
  </ResponsiveContainer>;
}
