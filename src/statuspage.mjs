// Pure HTML renderer for the public status page. No AWS calls, unit tested.
// Shows aggregate counts only: no email addresses, no city names.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function shortDate(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
}

/**
 * @param {{ alerts:number, cities:number, timezone:string, checkHour:string,
 *           days: Array<{ date:string, run?: { subscriptions:number, sent:number, not_triggered:number, already_sent:number, failed:number, durationMs?:number } }> }} d
 */
export function renderStatusPage(d) {
  const latest = d.days.find((x) => x.run)
  // Bars scale to the busiest day's total outcomes (several runs on one day add up).
  const total = (r) => (r.sent ?? 0) + (r.not_triggered ?? 0) + (r.already_sent ?? 0) + (r.failed ?? 0)
  const maxSubs = Math.max(1, ...d.days.map((x) => (x.run ? total(x.run) : 0)))
  const quietDays = d.days.filter((x) => x.run && x.run.sent === 0).length
  const ranDays = d.days.filter((x) => x.run).length

  const rows = d.days
    .slice()
    .reverse()
    .map((x) => {
      if (!x.run) return `<div class="day none"><span class="dl">${esc(shortDate(x.date))}</span><div class="bar"></div><span class="tag">no run</span></div>`
      const r = x.run
      const w = (n) => ((n / maxSubs) * 100).toFixed(1)
      const tag = r.failed > 0 ? `<span class="tag bad">${r.failed} failed</span>` : r.sent > 0 ? `<span class="tag ping">🔔 ${r.sent} sent</span>` : `<span class="tag quiet">🤫 quiet</span>`
      return `<div class="day"><span class="dl">${esc(shortDate(x.date))}</span><div class="bar">
        <i class="s" style="width:${w(r.sent)}%"></i><i class="q" style="width:${w(r.not_triggered)}%"></i><i class="a" style="width:${w(r.already_sent)}%"></i><i class="f" style="width:${w(r.failed)}%"></i>
      </div>${tag}</div>`
    })
    .join('')

  const last = latest
    ? `Last run <b>${esc(shortDate(latest.date))}</b>: checked ${latest.run.subscriptions} alert(s) in ${latest.run.durationMs ?? '?'} ms, sent ${latest.run.sent}, ${latest.run.failed} failed.`
    : 'No runs recorded yet.'

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60"><title>Weather Alerts · live status</title>
<style>
:root{--bg:#0b1e3a;--card:#11294d;--ink:#e0f2fe;--mute:#93c5fd;--sun:#fde68a;--ok:#4ade80;--ping:#f43f5e;--q:#475569;--a:#38bdf8;--bad:#fb7185}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,"Segoe UI",sans-serif}
main{max-width:720px;margin:0 auto;padding:28px 16px 40px}
.k{color:#7dd3fc;font-size:12px;letter-spacing:.2em;text-transform:uppercase;font-weight:700}
h1{margin:6px 0 2px;font-size:clamp(28px,6vw,40px)}h1 em{color:var(--sun);font-style:normal}
.live{display:inline-flex;align-items:center;gap:6px;color:var(--ok);font-size:13px;font-weight:600}
.live i{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 0 rgba(74,222,128,.7);animation:p 2s infinite}
@keyframes p{70%{box-shadow:0 0 0 10px rgba(74,222,128,0)}100%{box-shadow:0 0 0 0 rgba(74,222,128,0)}}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:22px 0}
.card{background:var(--card);border-radius:14px;padding:14px 16px}.n{font-size:30px;font-weight:800;color:#fff}.l{color:var(--mute);font-size:13px}
h2{font-size:18px;margin:26px 0 10px}
.day{display:grid;grid-template-columns:92px 1fr 96px;align-items:center;gap:10px;margin:8px 0;font-size:14px}
.dl{color:var(--mute)}.bar{display:flex;height:14px;border-radius:7px;background:#0f2443;overflow:hidden}
.bar i{display:block;height:100%}.s{background:var(--ping)}.q{background:var(--q)}.a{background:var(--a)}.f{background:var(--bad)}
.tag{font-size:12px;font-weight:600;text-align:right}.ping{color:#fda4af}.quiet{color:#cbd5e1}.bad{color:var(--bad)}.none .tag{color:#64748b}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--mute);margin-top:6px}.legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:-1px}
footer{margin-top:28px;font-size:13px;color:var(--mute)}a{color:#7dd3fc}
</style></head><body><main>
<div class="k">Live demo · serverless on AWS</div>
<h1>Silence is a <em>feature</em></h1>
<span class="live"><i></i>live · refreshes every minute</span>
<div class="grid">
  <div class="card"><div class="n">${d.alerts}</div><div class="l">active alerts</div></div>
  <div class="card"><div class="n">${d.cities}</div><div class="l">cities watched</div></div>
  <div class="card"><div class="n">${esc(d.checkHour)}:00</div><div class="l">daily check (${esc(d.timezone)})</div></div>
  <div class="card"><div class="n">${quietDays}/${ranDays}</div><div class="l">quiet mornings (last 7)</div></div>
</div>
<p>${last}</p>
<h2>Last 7 mornings</h2>
${rows}
<div class="legend"><span><i style="background:var(--ping)"></i>emailed</span><span><i style="background:var(--q)"></i>rule not crossed</span><span><i style="background:var(--a)"></i>already sent</span><span><i style="background:var(--bad)"></i>failed</span></div>
<footer>Counts only: no emails or city names are shown. Built with EventBridge Scheduler, Lambda, DynamoDB and SNS · <a href="https://github.com/Rajpreet12/weather-alerts">source code</a></footer>
</main></body></html>`
}
