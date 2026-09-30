"use client"

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { BellRing, Globe, MessageCircle, Smile, ShoppingBag } from 'lucide-react'
import type { DailyOrdersPoint, OrdersMetrics } from '@/lib/dashboard/orders-metrics'
import { MetricCard } from './metric-card'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'
import { cn } from '@/lib/utils'

// ------------------------------------------------------------
// Orders panel (Ferrobot): orders per day by channel, the WhatsApp
// order funnel, reminders, satisfaction, top products, origins.
// Same card/SVG conventions and series colors as the conversations
// chart. WhatsApp vs Web is a validated pair (ΔE 15.9 normal; 6.6
// deutan → carried with a legend, a 2px gap between stacked segments
// and labelled tooltips, never color alone).
// ------------------------------------------------------------

type RangeDays = 7 | 30 | 90
const WHATSAPP = '#3b82f6'
const WEB = '#7c3aed'

export function OrdersPanel() {
  const t = useTranslations('Dashboard.orders')
  const [range, setRange] = useState<RangeDays>(30)
  const [data, setData] = useState<Record<RangeDays, OrdersMetrics | null>>({ 7: null, 30: null, 90: null })
  const [loading, setLoading] = useState(true)

  // State is only set in promise callbacks here (never synchronously in
  // the effect); the "loading" flip for a range switch happens in the
  // click handler.
  const load = useCallback((r: RangeDays) => {
    return fetch(`/api/metrics/orders?days=${r}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((m: OrdersMetrics | null) => {
        if (m) setData((prev) => ({ ...prev, [r]: m }))
      })
      .catch((err) => console.error('[dashboard] orders metrics failed:', err))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    void load(30)
  }, [load])

  const onRange = (r: RangeDays) => {
    setRange(r)
    if (!data[r]) {
      setLoading(true)
      void load(r)
    }
  }
  const m = data[range]

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
          {([7, 30, 90] as RangeDays[]).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => onRange(r)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                range === r ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t('days', { count: r })}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {!m ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[118px] w-full rounded-xl" />)
        ) : (
          <>
            <MetricCard title={t('whatsappOrders')} value={m.totals.whatsapp.toLocaleString()} icon={MessageCircle} subtitle={t('lastDays', { count: m.days })} />
            <MetricCard title={t('webOrders')} value={m.totals.web.toLocaleString()} icon={Globe} subtitle={t('lastDays', { count: m.days })} />
            <MetricCard title={t('neededReminder')} value={m.needingReminder.toLocaleString()} icon={BellRing} subtitle={t('neededReminderHint')} />
            <MetricCard
              title={t('satisfaction')}
              value={m.satisfactionPct === null ? '—' : `${m.satisfactionPct}%`}
              icon={Smile}
              subtitle={t('ratings', { count: m.csat.excelente + m.csat.bien + m.csat.mal })}
            />
          </>
        )}
      </div>

      <section className="rounded-xl border border-border bg-card">
        <header className="border-b border-border px-5 py-4">
          <h3 className="text-sm font-semibold text-foreground">{t('perDayTitle')}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('perDayDescription')}</p>
        </header>
        <div className="p-5">
          {loading && !m ? (
            <Skeleton className="h-[220px] w-full" />
          ) : !m || m.totals.whatsapp + m.totals.web === 0 ? (
            <EmptyState icon={ShoppingBag} title={t('noOrders')} hint={t('noOrdersHint')} />
          ) : (
            <DailyColumns data={m.daily} t={t} />
          )}
        </div>
        <footer className="flex items-center gap-4 border-t border-border px-5 py-3 text-xs text-muted-foreground">
          <LegendDot color={WHATSAPP} label={t('whatsapp')} />
          <LegendDot color={WEB} label={t('web')} />
        </footer>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <section className="rounded-xl border border-border bg-card lg:col-span-1">
          <header className="border-b border-border px-5 py-4">
            <h3 className="text-sm font-semibold text-foreground">{t('funnelTitle')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('funnelDescription')}</p>
          </header>
          <div className="p-5">{m ? <Funnel steps={m.funnel} t={t} /> : <Skeleton className="h-[160px] w-full" />}</div>
        </section>

        <section className="rounded-xl border border-border bg-card">
          <header className="border-b border-border px-5 py-4">
            <h3 className="text-sm font-semibold text-foreground">{t('topProductsTitle')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('topProductsDescription')}</p>
          </header>
          <div className="p-5">
            {!m ? (
              <Skeleton className="h-[160px] w-full" />
            ) : m.topProducts.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noData')}</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="pb-2 font-medium">{t('product')}</th>
                    <th className="pb-2 text-right font-medium">{t('orders')}</th>
                  </tr>
                </thead>
                <tbody>
                  {m.topProducts.map((p) => (
                    <tr key={p.label} className="border-t border-border">
                      <td className="py-1.5 pr-2 text-foreground">{p.label}</td>
                      <td className="py-1.5 text-right tabular-nums text-foreground">{p.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card">
          <header className="border-b border-border px-5 py-4">
            <h3 className="text-sm font-semibold text-foreground">{t('originsTitle')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('originsDescription')}</p>
          </header>
          <div className="p-5">
            {!m ? (
              <Skeleton className="h-[160px] w-full" />
            ) : m.origins.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noOrigins')}</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="pb-2 font-medium">{t('origin')}</th>
                    <th className="pb-2 text-right font-medium">{t('contacts')}</th>
                  </tr>
                </thead>
                <tbody>
                  {m.origins.map((o) => (
                    <tr key={o.tag} className="border-t border-border">
                      <td className="py-1.5 pr-2 text-foreground">{o.tag}</td>
                      <td className="py-1.5 text-right tabular-nums text-foreground">{o.contacts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </section>
  )
}

// ------------------------------------------------------------
// Stacked daily columns: WhatsApp at the baseline, Web on top, a 2px
// surface gap between them, 4px rounded top on the column's end only.
// ------------------------------------------------------------

const VB_W = 760
const VB_H = 220
const PAD = { top: 12, right: 12, bottom: 26, left: 32 }
const GAP = 2

function DailyColumns({ data, t }: { data: DailyOrdersPoint[]; t: ReturnType<typeof useTranslations> }) {
  const [hover, setHover] = useState<number | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const chartW = VB_W - PAD.left - PAD.right
  const chartH = VB_H - PAD.top - PAD.bottom
  const max = Math.max(1, ...data.map((d) => d.whatsapp + d.web))
  const ceil = niceCeil(max)
  const ticks = Array.from(new Set([0, ceil / 2, ceil].map((v) => Math.round(v))))
  const slot = chartW / data.length
  const barW = Math.min(24, slot * 0.7)
  const y = (v: number) => (v / ceil) * chartH
  const labelEvery = data.length <= 7 ? 1 : data.length <= 30 ? 5 : 15

  return (
    <div ref={wrapRef} className="relative" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="h-auto w-full" role="img" aria-label={t('perDayTitle')}>
        {ticks.map((tick) => {
          const ty = PAD.top + chartH - y(tick)
          return (
            <g key={tick}>
              <line x1={PAD.left} x2={VB_W - PAD.right} y1={ty} y2={ty} className="stroke-border" strokeWidth={1} />
              <text x={PAD.left - 6} y={ty + 3} textAnchor="end" className="fill-muted-foreground text-[10px]">
                {tick}
              </text>
            </g>
          )
        })}
        {data.map((d, i) => {
          const cx = PAD.left + slot * i + slot / 2
          const x = cx - barW / 2
          const base = PAD.top + chartH
          const hw = y(d.whatsapp)
          const hweb = y(d.web)
          const hasWeb = d.web > 0
          const hasWa = d.whatsapp > 0
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)}>
              {/* Hit target: the whole slot, taller than the marks. */}
              <rect x={PAD.left + slot * i} y={PAD.top} width={slot} height={chartH} fill="transparent" />
              {hasWa && (
                <path d={columnPath(x, base - hw, barW, hw, !hasWeb)} fill={WHATSAPP} opacity={hover === null || hover === i ? 1 : 0.45} />
              )}
              {hasWeb && (
                <path
                  d={columnPath(x, base - hw - (hasWa ? GAP : 0) - hweb, barW, hweb, true)}
                  fill={WEB}
                  opacity={hover === null || hover === i ? 1 : 0.45}
                />
              )}
              {i % labelEvery === 0 && (
                <text x={cx} y={VB_H - 8} textAnchor="middle" className="fill-muted-foreground text-[10px]">
                  {d.day.slice(8, 10)}/{d.day.slice(5, 7)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md"
          style={{ left: `${((PAD.left + slot * hover + slot / 2) / VB_W) * 100}%`, transform: 'translateX(-50%)' }}
        >
          <p className="font-medium text-foreground">
            {data[hover].day.slice(8, 10)}/{data[hover].day.slice(5, 7)}
          </p>
          <p className="mt-1 flex items-center gap-2 text-muted-foreground">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: WHATSAPP }} />
            {t('whatsapp')}: <span className="tabular-nums text-foreground">{data[hover].whatsapp}</span>
          </p>
          <p className="flex items-center gap-2 text-muted-foreground">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: WEB }} />
            {t('web')}: <span className="tabular-nums text-foreground">{data[hover].web}</span>
          </p>
        </div>
      )}
    </div>
  )
}

/** A column segment; only the stack's top segment gets the 4px rounded end. */
function columnPath(x: number, top: number, w: number, h: number, roundTop: boolean): string {
  const r = roundTop ? Math.min(4, h, w / 2) : 0
  return [
    `M${x},${top + h}`,
    `L${x},${top + r}`,
    r ? `Q${x},${top} ${x + r},${top}` : '',
    `L${x + w - r},${top}`,
    r ? `Q${x + w},${top} ${x + w},${top + r}` : '',
    `L${x + w},${top + h}`,
    'Z',
  ].join(' ')
}

// ------------------------------------------------------------
// Funnel: one hue (a single measure), each bar sized to the first
// step, count and % of the previous step as text beside it.
// ------------------------------------------------------------

function Funnel({ steps, t }: { steps: OrdersMetrics['funnel']; t: ReturnType<typeof useTranslations> }) {
  const first = Math.max(1, steps[0]?.count ?? 0)
  return (
    <ol className="space-y-3">
      {steps.map((s, i) => {
        const prev = i === 0 ? null : steps[i - 1].count
        const pct = prev ? Math.round((s.count / prev) * 100) : null
        return (
          <li key={s.key}>
            <div className="flex items-baseline justify-between text-xs">
              <span className="text-foreground">{t(`funnel_${s.key}`)}</span>
              <span className="tabular-nums text-muted-foreground">
                <span className="font-medium text-foreground">{s.count}</span>
                {pct !== null && ` · ${pct}%`}
              </span>
            </div>
            <div className="mt-1 h-2 w-full rounded-full bg-muted">
              <div className="h-2 rounded-full" style={{ width: `${(s.count / first) * 100}%`, background: WHATSAPP }} />
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}

function niceCeil(v: number): number {
  if (v <= 4) return 4
  const pow = 10 ** Math.floor(Math.log10(v))
  const n = v / pow
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return nice * pow
}
