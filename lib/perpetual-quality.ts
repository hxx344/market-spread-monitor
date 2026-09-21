import { perpetualSpreadKey, type PerpetualSpread } from './perpetual-spreads.ts';
import type { PerpetualQuote } from './perpetual-types.ts';
import { defaultQualityBudget, pairTakerFees, validFeePercent, type PairTakerFees, type QualityBudget } from './perpetual-fees.ts';
export { defaultQualityBudget, parseQualityBudget, type QualityBudget } from './perpetual-fees.ts';

export interface TokenFundamentals {
  coinId: string; name: string; marketCapUsd: number | null; fdvUsd: number | null;
  circulatingSupply: number | null; totalSupply: number | null; maxSupply: number | null;
  updatedAt: number | null; source: string;
}
export interface PositioningRatio {
  exchange: string; symbol: string; longRatio: number; shortRatio: number;
  kind: 'accounts' | 'positions'; scope: string; source: string; observedAt: number;
}
export interface PositioningOverview {
  kind: 'accounts'; method: 'equal-exchange'; periodMs: 300000;
  longRatio: number | null; shortRatio: number | null;
  availableExchanges: number; eligibleExchanges: number; totalExchanges: number;
  observedAt: number | null;
  constituents: Array<{
    exchange: string; key: string | null; symbol: string | null;
    status: 'fresh' | 'stale' | 'pending' | 'unsupported' | 'unavailable' | 'error' | 'rate-limited';
    reason: string | null;
  }>;
}
export interface StabilityStats {
  samples: number; expectedSamples: number; coverage: number; firstAt: number | null; lastAt: number | null;
  mean: number | null; stddev: number | null; positiveRatio: number | null; signChanges: number;
}
export interface PairQualityHistory {
  base: string; longKey: string; shortKey: string;
  identity?: string;
  /** All history values are percentage points. Funding is normalized to 8h. */
  spread: StabilityStats;
  funding: StabilityStats & { longStddev: number | null; shortStddev: number | null };
  /** Requested for one inspected pair only; real minute observations, never interpolated. */
  priceSeries?: Array<[number, number]>;
}
export interface PerpetualQualityReport {
  schemaVersion: 1; generatedAt: number; sampleIntervalMs: number; priceWindowMs: number; fundingWindowMs: number;
  pairs: Record<string, PairQualityHistory>;
  assets: Record<string, TokenFundamentals>;
  assetErrors: Record<string, string>;
  positioning: Record<string, PositioningRatio>;
  positioningErrors: Record<string, string>;
  positioningOverview?: Record<string, PositioningOverview>;
  error?: string | null;
}
export interface QualityDimension { id: string; label: string; weight: number; score: number | null; detail: string }
export interface OpportunityQuality {
  grade: 'strong' | 'watch' | 'weak' | 'insufficient' | 'reference'; label: string;
  score: number | null; coverage: number; dimensions: QualityDimension[]; reasons: string[];
  netSpreadPercent: number | null;
  fees: PairTakerFees;
}
export const qualityPairKey = perpetualSpreadKey;
export const qualityHistoryIdentity = (long: PerpetualQuote, short: PerpetualQuote): string => JSON.stringify([long.base, long.quoteCurrency, long.collateralCurrency ?? '', long.multiplier ?? 1, long.contractUnit ?? '', short.base, short.quoteCurrency, short.collateralCurrency ?? '', short.multiplier ?? 1, short.contractUnit ?? '']);
/** Existing history is in one common quote currency; never apply it to an FX-adjusted pair. */
export function pairQualityHistory(row: PerpetualSpread, report: PerpetualQualityReport | null | undefined): PairQualityHistory | undefined {
  const history = report?.pairs[qualityPairKey(row)];
  return !row.crossCurrency && history && (!history.identity || history.identity === qualityHistoryIdentity(row.long, row.short)) ? history : undefined;
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const fresh = (at: unknown, now: number, age: number) => finite(at) && at > 0 && at <= now + 5_000 && now - at <= age;
const clamp = (value: number) => Math.max(0, Math.min(100, value));

/** A transparent screening rubric, not a probability of profit. Missing evidence stays unscored. */
export function evaluateOpportunityQuality(row: PerpetualSpread, report: PerpetualQualityReport | null | undefined, now: number, budget: QualityBudget = defaultQualityBudget, mode: 'book' | 'mark' = 'book'): OpportunityQuality {
  const reasons: string[] = [];
  const currentReport = report && fresh(report.generatedAt, now, 180_000) ? report : undefined;
  const asset = currentReport?.assets[row.base];
  const assetFresh = asset && fresh(asset.updatedAt, now, 3_600_000);
  const cap = assetFresh && finite(asset.marketCapUsd) && asset.marketCapUsd > 0 ? asset.marketCapUsd : null;
  const fdv = assetFresh && finite(asset.fdvUsd) && asset.fdvUsd > 0 ? asset.fdvUsd : null;
  const dilution = cap !== null && fdv !== null && fdv >= cap * 0.95 ? Math.min(1, cap / fdv) : null;
  const capScore = cap === null ? null : cap >= 10e9 ? 100 : cap >= 1e9 ? 80 : cap >= 100e6 ? 60 : cap >= 10e6 ? 35 : 10;
  const history = pairQualityHistory(row, currentReport);
  const spread = history?.spread, funding = history?.funding;
  const spreadReady = spread && spread.samples >= 30 && spread.coverage >= 0.5 && fresh(spread.lastAt, now, 180_000) && finite(spread.mean) && finite(spread.stddev) && finite(spread.positiveRatio);
  const fundingReady = funding && funding.samples >= 12 && funding.coverage >= 1 / 24 && fresh(funding.lastAt, now, 600_000) && finite(funding.mean) && finite(funding.longStddev) && finite(funding.shortStddev);
  const spreadScore = spreadReady ? clamp(spread.mean! <= 0 ? 0 : 100 * spread.positiveRatio! / (1 + spread.stddev! / Math.max(Math.abs(spread.mean!), 0.05))) : null;
  const fundingScore = fundingReady ? clamp(100 / (1 + Math.max(funding.longStddev!, funding.shortStddev!) / 0.05) * (1 - Math.min(0.5, funding.signChanges / Math.max(1, funding.samples - 1)))) : null;
  const long = currentReport?.positioning[`${row.long.exchange}:${row.long.symbol}`], short = currentReport?.positioning[`${row.short.exchange}:${row.short.symbol}`];
  const validRatio = (item: PositioningRatio | undefined) => item && fresh(item.observedAt, now, 900_000) && finite(item.longRatio) && finite(item.shortRatio) && item.longRatio >= 0 && item.shortRatio >= 0 && item.longRatio <= 1 && item.shortRatio <= 1 && Math.abs(item.longRatio + item.shortRatio - 1) < 0.02;
  const positioningReady = validRatio(long) && validRatio(short) && long!.kind === short!.kind;
  // Only crowding in the proposed directions is measured; account counts are never treated as position size.
  const positioningScore = positioningReady ? clamp(100 - 200 * Math.max(0, Math.max(long!.longRatio, short!.shortRatio) - 0.5)) : null;
  const dimensions: QualityDimension[] = [
    { id: 'marketCap', label: '市值规模', weight: 20, score: capScore, detail: cap === null ? currentReport?.assetErrors[row.base] || '暂无新鲜市值数据' : '≥100亿 / 10亿 / 1亿 / 1000万美元对应100 / 80 / 60 / 35分，更小为10分' },
    { id: 'fdv', label: '市值 / FDV', weight: 15, score: dilution === null ? null : Math.round(dilution * 100), detail: dilution === null ? 'FDV缺失、过期或与市值不一致' : '市值÷FDV；衡量估值摊薄程度，不等于流通量÷最大供应量' },
    { id: 'positioning', label: '多空拥挤度', weight: 15, score: positioningScore, detail: positioningReady ? '做多侧多头占比与做空侧空头占比，较拥挤一侧超过50%的部分扣分；不预测涨跌' : '两腿需有新鲜且同类的官方多空比；账户人数与持仓量不混算' },
    { id: 'spread', label: '价差稳定度 · 1h', weight: 30, score: spreadScore, detail: spreadReady ? '同一平台组合：正价差占比 × 波动折扣；持续为负不会获得高分' : `每分钟采样，至少30个有效点；当前${spread?.samples ?? 0}/60点` },
    { id: 'funding', label: '资金费稳定度 · 24h', weight: 20, score: fundingScore, detail: fundingReady ? '按8h折算，分别检查两腿预估费率波动及费差变号；稳定不代表净收入' : `每5分钟采样，至少12个有效点；当前${funding?.samples ?? 0}/288点` },
  ];
  for (const item of dimensions) if (item.score !== null) item.score = Math.round(item.score);
  const coverage = dimensions.reduce((sum, item) => sum + (item.score === null ? 0 : item.weight), 0);
  const rawScore = coverage ? Math.round(dimensions.reduce((sum, item) => sum + (item.score ?? 0) * item.weight, 0) / coverage) : null;
  const fees = pairTakerFees(row, budget.takerOverrides, now);
  const validBudget = fees.roundTripPercent !== null && validFeePercent(budget.slippagePercent);
  const fxReady = !row.crossCurrency || (row.fxAdjusted === true && fresh(row.fxAt, now, 180_000));
  const reference = mode === 'mark' || !fxReady || !fresh(row.updatedAt, now, 30_000);
  const netSpreadPercent = !reference && validBudget ? row.spreadPercent - fees.roundTripPercent! - budget.slippagePercent : null;
  if (fees.roundTripPercent === null) reasons.push('两腿 taker 费率尚未齐全，暂不计算扣费价差，等级不评为较好');
  if (!validFeePercent(budget.slippagePercent)) reasons.push('滑点预算无效，暂不计算扣费价差');
  if (reference) reasons.push(mode === 'mark' ? '标记价不能用于判断可成交套利质量' : !fxReady ? '跨计价币汇率缺失或已过期，仅供参考' : '当前两腿价格已过期');
  if (row.fxAdjusted) reasons.push('跨计价币已按现货买卖价换算，未计额外换汇手续费；尚无相同换算口径的历史，不套用原币种历史评分');
  if (!spreadReady || !fundingReady) reasons.push('历史正在积累，未用回填或模拟数据补齐');
  if (fundingReady && funding.coverage < 0.5) reasons.push('资金费历史不足12小时，等级暂不评为较好');
  if (coverage < 100) reasons.push(`可评分数据覆盖${coverage}%，缺失项未计为零分`);
  const constrained = row.long.delisting === true || row.short.delisting === true || (netSpreadPercent !== null && netSpreadPercent <= 0) || (fundingReady && funding.mean! < 0 && netSpreadPercent !== null && -funding.mean! >= Math.max(0, netSpreadPercent));
  if (row.long.delisting || row.short.delisting) reasons.push('组合含已公告下架的合约');
  if (netSpreadPercent !== null && netSpreadPercent <= 0) reasons.push('当前毛价差不足覆盖双腿 taker 往返手续费与滑点预算');
  if (fundingReady && funding.mean! < 0) reasons.push('历史平均资金费差为净支出，需结合持有时间判断');
  const score = reference || coverage < 60 || !spreadReady ? null : rawScore;
  const grade = reference ? 'reference' : score === null ? 'insufficient' : constrained || score < 50 ? 'weak' : score >= 75 && coverage === 100 && fundingReady && funding.coverage >= 0.5 && validBudget ? 'strong' : 'watch';
  return { grade, label: ({ strong: '较好', watch: '观察', weak: '谨慎', insufficient: '资料不足', reference: '仅供参考' })[grade], score, coverage, dimensions, reasons, netSpreadPercent, fees };
}
