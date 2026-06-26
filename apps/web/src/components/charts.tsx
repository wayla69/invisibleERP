'use client';

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

const axisProps = {
  stroke: 'var(--muted-foreground)',
  fontSize: 12,
  tickLine: false,
  axisLine: false,
} as const;

function ChartTooltip({ active, payload, label, fmt }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-medium text-popover-foreground">{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2 text-muted-foreground">
          <span className="inline-block size-2 rounded-full" style={{ background: p.color }} />
          <span>{p.name}:</span>
          <span className="font-medium text-popover-foreground tabular-nums">
            {fmt ? fmt(p.value) : p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function TrendAreaChart({
  data,
  xKey,
  yKey,
  height = 260,
  color = 'var(--chart-1)',
  fmt,
}: {
  data: any[];
  xKey: string;
  yKey: string;
  height?: number;
  color?: string;
  fmt?: (v: number) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`grad-${yKey}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={color} stopOpacity={0.25} />
            <stop offset="95%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey={xKey} {...axisProps} />
        <YAxis {...axisProps} width={48} />
        <Tooltip content={<ChartTooltip fmt={fmt} />} />
        <Area
          type="monotone"
          dataKey={yKey}
          stroke={color}
          strokeWidth={2}
          fill={`url(#grad-${yKey})`}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function SimpleBarChart({
  data,
  xKey,
  yKey,
  height = 260,
  color = 'var(--chart-1)',
  fmt,
  onBarClick,
}: {
  data: any[];
  xKey: string;
  yKey: string;
  height?: number;
  color?: string;
  fmt?: (v: number) => string;
  onBarClick?: (entry: any) => void;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={data}
        margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
        onClick={onBarClick ? (d) => { if (d?.activePayload?.[0]) onBarClick(d.activePayload[0].payload); } : undefined}
        style={onBarClick ? { cursor: 'pointer' } : undefined}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
        <XAxis dataKey={xKey} {...axisProps} />
        <YAxis {...axisProps} width={48} />
        <Tooltip cursor={{ fill: 'var(--muted)', opacity: 0.4 }} content={<ChartTooltip fmt={fmt} />} />
        <Bar dataKey={yKey} radius={[6, 6, 0, 0]} fill={color}>
          {data.map((_, i) => (
            <Cell key={i} fill={color} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
