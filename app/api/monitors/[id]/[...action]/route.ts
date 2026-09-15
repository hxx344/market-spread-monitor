import { getMonitor } from "../../../../../lib/monitors";
import { readMonitorData } from "../../../../../lib/monitor-service";
import { exchangeFromAction } from "../../../../../lib/exchange-quotes";
import { OIL_CANDLE_ACTION } from "../../../../../modules/oil/intraday.mjs";

export async function GET(_request: Request, context: { params: Promise<{ id: string; action: string[] }> }) {
  const { id, action } = await context.params;
  const name = action.join("/");
  const monitor = getMonitor(id);
  const headers = { "Cache-Control": "no-store" };
  if (!monitor) return Response.json({ error: "监控模块不存在" }, { status: 404, headers });
  if (["alerts", "status"].includes(name)) return Response.json({ available: false, monitorId: id, reason: "当前为网页行情版。Linux 一键部署后可运行常驻监控并保存飞书告警。" }, { headers });
  if ((!exchangeFromAction(name) && !["quote", "history", "funding", OIL_CANDLE_ACTION].includes(name)) || !monitor.capabilities.includes(exchangeFromAction(name) ? "quote" : name)) return Response.json({ error: "模块不支持此接口" }, { status: 404, headers });
  try { return Response.json(await readMonitorData(id, name), { headers }); }
  catch { return Response.json({ error: "行情暂不可用，请稍后重试" }, { status: 503, headers }); }
}
