import React from 'react';
import { Calendar, Zap } from 'lucide-react';

function metricDays(analysis, displayKey, workKey, { forceZero = false } = {}) {
  if (forceZero) return 0;
  if (analysis && Object.prototype.hasOwnProperty.call(analysis, displayKey)) {
    const n = Number(analysis[displayKey]);
    if (Number.isFinite(n)) return Math.round(n);
  }
  if (workKey && analysis) {
    const n = Number(analysis[workKey]);
    if (Number.isFinite(n)) return Math.round(n);
  }
  return 0;
}

function isSingleOrderTimeline(analysis) {
  if (analysis?.show_new_order_timeline === false) return true;
  if (analysis?.show_new_order_timeline === true) return false;
  const count = Number(analysis?.committed_order_count);
  if (Number.isFinite(count)) return count <= 1;
  return true;
}

function newOrderStartDays(analysis) {
  if (isSingleOrderTimeline(analysis)) return 0;
  return metricDays(analysis, 'new_order_start_days', 'new_order_start_work_days');
}

function newOrderFinishDays(analysis) {
  if (isSingleOrderTimeline(analysis)) return 0;
  return metricDays(analysis, 'expected_finish_days', 'expected_finish_work_days');
}

function materialBoundDays(analysis) {
  return Math.round(
    Number(analysis?.material_ready_calendar_days ?? analysis?.material_lead_time ?? 0)
  );
}

function processingBandDays(analysis) {
  const proc = Number(analysis?.processing_work_days);
  if (!Number.isFinite(proc) || proc <= 0) return 0;
  return Math.ceil(proc);
}

function pipelineBoundDays(analysis) {
  return Math.round(
    Number(
      analysis?.production_clear_work_days
        ?? analysis?.pipeline_bound_work_days
        ?? 0
    )
  );
}

function currentOrderFinishDays(analysis) {
  const api = metricDays(analysis, 'current_finish_days', 'current_finish_work_days');
  const material = materialBoundDays(analysis);
  const proc = processingBandDays(analysis);
  const pipeline = pipelineBoundDays(analysis);
  const recomputed = Math.max(pipeline, material) + proc;
  return Math.max(api, recomputed);
}

function laterIsoDate(isoA, isoB) {
  if (!isoA) return isoB || null;
  if (!isoB) return isoA;
  return isoA >= isoB ? isoA : isoB;
}

function currentOrderFinishDate(analysis, currentDays) {
  const material = materialBoundDays(analysis);
  const merged = laterIsoDate(
    analysis?.current_finish_date,
    analysis?.expected_finish_date
  );
  if (material > 0 && currentDays > material) {
    return formatMetricDate(merged);
  }
  return formatMetricDate(analysis?.current_finish_date || merged);
}

function formatMetricDate(iso) {
  if (!iso || typeof iso !== 'string') return null;
  const [y, m, d] = iso.split('-');
  if (y && m && d) return `${d}/${m}/${y}`;
  return iso;
}

function committedOrderCount(analysis) {
  const n = Number(analysis?.committed_order_count);
  if (Number.isFinite(n) && n >= 0) return Math.round(n);
  return isSingleOrderTimeline(analysis) ? 1 : 2;
}

/** Compact numeric breakdown — no narrative text. */
function TimelineNumericGrid({ analysis, compact }) {
  const useCalendar = analysis?.timeline_day_unit !== 'business';
  const unit = useCalendar ? 'cal' : 'bus';
  const pipeline = pipelineBoundDays(analysis);
  const material = materialBoundDays(analysis);
  const build = processingBandDays(analysis);
  const bottleneck = analysis?.shop_floor_bottleneck_line || analysis?.bottleneck_line;
  const matBottleneck = analysis?.bottleneck_material ?? analysis?.job_bottleneck_material;

  const items = [
    { key: 'pipeline', label: 'Pipeline', value: pipeline, unit: 'd' },
    { key: 'material', label: 'Materials', value: material, unit: 'd' },
    { key: 'build', label: 'Build band', value: build, unit: 'd' },
    {
      key: 'floor',
      label: 'Floor bind',
      value: bottleneck || '—',
      unit: '',
      isText: true,
    },
    {
      key: 'supply',
      label: 'Slowest mat.',
      value: matBottleneck || '—',
      unit: '',
      isText: true,
    },
    {
      key: 'refqty',
      label: 'Ref. qty',
      value: analysis?.reference_quantity ?? analysis?.quantity ?? 1,
      unit: '',
      isText: true,
    },
  ];

  return (
    <div className={`timeline-numeric-grid${compact ? ' timeline-numeric-grid-compact' : ''}`}>
      {items.map((item) => (
        <div key={item.key} className="timeline-num-cell">
          <span className="timeline-num-label">{item.label}</span>
          <span className="timeline-num-value">
            {item.isText ? item.value : (
              <>
                {item.value}
                <small className="timeline-num-unit"> {item.unit} {unit}</small>
              </>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function BannerDueCard({ label, days, date, primary, muted }) {
  const showDate = date && days > 0;
  return (
    <div
      className={[
        'banner-due-card',
        primary ? 'banner-due-card-primary' : '',
        muted ? 'banner-due-card-muted' : '',
      ].filter(Boolean).join(' ')}
    >
      <label>{label}</label>
      {showDate ? (
        <div className="banner-due-date">
          <Calendar size={primary ? 18 : 14} strokeWidth={2.25} aria-hidden />
          <span>{date}</span>
        </div>
      ) : (
        <div className="banner-due-date banner-due-date-empty">—</div>
      )}
      <div className="banner-due-days">
        <span className="banner-due-days-num">{days}</span>
        <span className="banner-due-days-unit">days</span>
      </div>
    </div>
  );
}

function ProductionTimelineAdvisor({ analysis, variant = 'banner' }) {
  if (!analysis) return null;

  const singleOrder = isSingleOrderTimeline(analysis);
  const currentDays = currentOrderFinishDays(analysis);
  const currentDate = currentOrderFinishDate(analysis, currentDays);
  const startDays = newOrderStartDays(analysis);
  const finishDays = newOrderFinishDays(analysis);
  const newOrderStartDate = singleOrder ? null : formatMetricDate(analysis.new_order_start_date);
  const newOrderFinishDate = singleOrder ? null : formatMetricDate(analysis.expected_finish_date);
  const orderCount = committedOrderCount(analysis);

  if (variant === 'modal') {
    return (
      <div className="analysis-card analysis-card-numeric">
        <div className="analysis-header">
          <Zap size={18} color="var(--accent)" />
          <h4>Timeline numbers</h4>
          {analysis.advisor?.version && (
            <span className="analysis-version">v{analysis.advisor.version}</span>
          )}
        </div>
        <div className="analysis-metrics analysis-metrics-due">
          <BannerDueCard
            label="Total orders due in"
            days={currentDays}
            date={currentDate}
            primary
          />
          {!singleOrder && (
            <>
              <BannerDueCard
                label="Next order can start in"
                days={startDays}
                date={newOrderStartDate}
              />
              <BannerDueCard
                label="Next order due in"
                days={finishDays}
                date={newOrderFinishDate}
              />
            </>
          )}
        </div>
        <TimelineNumericGrid analysis={analysis} />
      </div>
    );
  }

  return (
    <div className="global-analysis-banner timeline-banner-v2">
      <div className="timeline-banner-side">
        <div className="banner-tag-row">
          <div className="banner-tag">
            <Zap size={14} fill="currentColor" /> Production timeline
          </div>
          {analysis.advisor?.version && (
            <span className="banner-tag-version">v{analysis.advisor.version}</span>
          )}
        </div>
        <div className="timeline-active-orders">
          <span className="timeline-active-orders-count">{orderCount}</span>
          <span className="timeline-active-orders-label">
            active order{orderCount === 1 ? '' : 's'} on floor
          </span>
        </div>
        <TimelineNumericGrid analysis={analysis} compact />
      </div>
      <div className="timeline-banner-dates">
        <BannerDueCard
          label="Total orders due in"
          days={currentDays}
          date={currentDate}
          primary
        />
        <BannerDueCard
          label="Next order can start in"
          days={startDays}
          date={newOrderStartDate}
          muted={singleOrder}
        />
        <BannerDueCard
          label="Next order due in"
          days={finishDays}
          date={newOrderFinishDate}
          muted={singleOrder}
        />
      </div>
    </div>
  );
}

export default ProductionTimelineAdvisor;
