import { createLifecycle } from './lifecycle.mjs';
export function mount(root) {
const life=createLifecycle(); let editorLoaded=false;
const $ = id => root.getElementById(id);
let token = 'session', revision = 0, dirty = false, busy = false, connected = false;
const labels = { spread: '布伦特 − WTI 价差', brent: '布伦特价格', wti: 'WTI 价格' };
const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚无';

function feedback(message = '', error = false) {
  $('alert-feedback').textContent = message; $('alert-feedback').hidden = !message;
  $('alert-feedback').classList.toggle('alert-failure', error);
}
function setDirty(value) { dirty = value; $('alert-dirty').textContent = value ? '有未保存的修改' : `已保存 · 版本 ${revision}`; }
async function api(path, { method = 'GET', body, authenticate = true } = {}) {
  const response = await life.fetch(`/api/monitors/oil/${path}`, { method, headers: {  ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), cache: 'no-store', signal: AbortSignal.timeout(method === 'GET' ? 15_000 : 45_000) });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('此地址未连接 Linux 监控服务，请在部署后的服务地址设置告警。');
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || `服务请求失败 (${response.status})`); error.status = response.status; throw error; }
  return result;
}
function addRule(rule) {
  const row = document.createElement('fieldset'); row.className = 'alert-rule'; row.dataset.id = rule.id;
  row.innerHTML = '<legend>告警梯度</legend><label>名称<input name="label" required maxlength="60" /></label><label>监控指标<select name="metric"><option value="spread">布伦特 − WTI 价差</option><option value="brent">布伦特价格</option><option value="wti">WTI 价格</option></select></label><label>触发方向<select name="operator"><option value="gte">达到或高于 ≥</option><option value="lte">达到或低于 ≤</option></select></label><label>阈值<input name="threshold" type="number" step="any" min="-1000000" max="1000000" required /></label><label>冷却 / 分钟<input name="cooldownMinutes" type="number" step="any" min="0" max="10080" required /></label><label>回差<input name="hysteresis" type="number" step="any" min="0" max="1000000" required /></label><div class="alert-rule-actions"><label class="alert-toggle"><input name="enabled" type="checkbox" />启用</label><button type="button" class="alert-remove">删除</button></div>';
  for (const [name, value] of Object.entries(rule)) {
    const input = row.querySelector(`[name="${name}"]`);
    if (input) { if (name === 'enabled') input.checked = value; else input.value = value; }
  }
  row.querySelector('.alert-remove').addEventListener('click', () => { row.remove(); setDirty(true); });
  $('alert-rules').append(row);
}
function readRules() {
  return [...$('alert-rules').children].map(row => {
    const rule = { id: row.dataset.id };
    for (const field of row.querySelectorAll('[name]')) rule[field.name] = field.type === 'checkbox' ? field.checked : field.type === 'number' ? Number(field.value) : field.value;
    return rule;
  });
}
async function loadConfig() {
  const result = await api('config'); if (life.signal.aborted) return; revision = result.revision;
  $('alert-enabled').checked = result.config.enabled; $('alert-rules').replaceChildren(); result.config.rules.forEach(addRule); setDirty(false);
}
async function loadEvents() {
  const result = await api('events'); if (life.signal.aborted) return; $('alert-events-list').replaceChildren();
  if (!result.events.length) { const p = document.createElement('p'); p.className = 'alert-note'; p.textContent = '暂无发送记录'; $('alert-events-list').append(p); }
  for (const event of result.events) {
    const item = document.createElement('article'); item.className = 'alert-event';
    const title = document.createElement('p'), detail = document.createElement('p');
    title.textContent = `${time(event.time)} · ${{ sent: '发送成功', failed: '发送失败', sending: '发送中或结果待确认' }[event.status] || event.status}${event.test ? ' · 连接测试' : ''}`;
    detail.textContent = event.error || event.rules.map(rule => `${rule.label}：${labels[rule.metric]} ${rule.value.toFixed(4)} ${rule.operator === 'gte' ? '≥' : '≤'} ${rule.threshold}`).join('；');
    item.append(title, detail); $('alert-events-list').append(item);
  }
}
async function updateStatus() {
  try {
    const status = await api('status', { authenticate: false });
    if (life.signal.aborted) return;
    if (status.monitorId !== 'oil' || !status.available) throw new Error(status.reason || '此地址未连接 Linux 监控服务，请在部署后的服务地址设置告警。');
    connected = true;
    $('alert-service-state').textContent = status.error ? '采集异常' : !status.webhookConfigured ? '等待配置飞书' : status.enabled ? '告警已启用' : '告警已暂停';
    $('alert-runtime').textContent = `服务器每 ${status.pollSeconds} 秒采集，关闭网页后继续运行。${status.enabledRules} 个梯度已启用。最近成功采集：${time(status.lastSuccessAt)}。`;
    $('alert-service-error').textContent = [status.error, status.deliveryError, !status.webhookConfigured ? '服务器尚未设置 OIL_FEISHU_WEBHOOK_URL；可先保存梯度，配置机器人后生效。' : ''].filter(Boolean).join('；');
    $('alert-service-error').hidden = !$('alert-service-error').textContent;
    if (status.market) {
      const brent = status.market.brent.markPx, wti = status.market.wti.markPx;
      $('alert-market').textContent = `服务器标记价${status.stale ? '（已过期）' : ''} · 布伦特 ${brent.toFixed(4)} / WTI ${wti.toFixed(4)} / 价差 ${(brent - wti).toFixed(4)} 美元/桶`;
    } else $('alert-market').textContent = '服务器尚未取得有效行情。';
    if (!editorLoaded) { await loadConfig(); if (life.signal.aborted) return; await loadEvents(); if (life.signal.aborted) return; editorLoaded = true; $('alert-editor').hidden = false; }
  } catch (error) { if (life.signal.aborted) return;
    connected = false; $('alert-service-state').textContent = '监控服务未连接';
    $('alert-runtime').textContent = '请从 Linux 服务地址打开页面，告警由服务器运行。';
    $('alert-service-error').textContent = error.message; $('alert-service-error').hidden = false;
    $('alert-market').textContent = '';
  }
}
async function action(task) {
  if (busy) return; busy = true; feedback();
  root.querySelectorAll('#alerts button, #alerts input, #alerts select').forEach(input => input.disabled = true);
  try { await task(); } catch (error) { if (life.signal.aborted) return; feedback(error.message, true); }
  finally { if (life.signal.aborted) return; busy = false; root.querySelectorAll('#alerts button, #alerts input, #alerts select').forEach(input => input.disabled = false); }
}
$('alert-form').addEventListener('input', () => setDirty(true));
$('alert-form').addEventListener('change', () => setDirty(true));
$('alert-form').addEventListener('submit', event => {
  event.preventDefault();
  const config = { enabled: $('alert-enabled').checked, rules: readRules() };
  void action(async () => {
    const result = await api('config', { method: 'PUT', body: { revision, config } }); if (life.signal.aborted) return; revision = result.revision;
    setDirty(false); feedback('设置已保存，服务器将在下一次采集时应用。'); await updateStatus();
  });
});
$('alert-add').addEventListener('click', () => {
  if ($('alert-rules').children.length >= 50) return feedback('最多允许 50 个梯度', true);
  const id = `r-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  addRule({ id, label: `梯度 ${$('alert-rules').children.length + 1}`, metric: 'spread', operator: 'gte', threshold: 0, cooldownMinutes: 30, hysteresis: 0.1, enabled: true });
  setDirty(true); $('alert-rules').lastElementChild.querySelector('input').focus();
});
$('alert-reload').addEventListener('click', () => { if (!dirty || window.confirm('重新载入将放弃尚未保存的修改。')) void action(loadConfig); });
$('alert-test').addEventListener('click', () => void action(async () => {
  try { await api('test-notification', { method: 'POST', body: {} }); if (!life.signal.aborted) feedback('飞书测试消息已发送。'); }
  finally { if (life.signal.aborted) return; await loadEvents(); }
}));
life.on(window, 'beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
let refreshing = false;
async function refresh() {
  if (life.signal.aborted || refreshing || document.hidden || busy) return; refreshing = true;
  try { await updateStatus(); if (token && connected) await loadEvents(); }
  catch (error) { if (life.signal.aborted) return; feedback(error.message, true); }
  finally { if (life.signal.aborted) return; refreshing = false; }
}
void refresh(); const timer = setInterval(refresh, 15_000);
life.on(document, 'visibilitychange', () => { if (!document.hidden) void refresh(); });

return { hasUnsavedChanges: () => dirty, dispose() { token=''; dirty=false; clearInterval(timer); life.dispose(); } };
}
