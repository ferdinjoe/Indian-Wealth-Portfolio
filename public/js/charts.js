import { shortINR, money } from './format.js';

export const PALETTE = ['#4ade80', '#60a5fa', '#fbbf24', '#c084fc', '#22d3ee', '#fb7185', '#a3e635', '#f97316', '#38bdf8', '#e879f9'];

const GRID = 'rgba(148, 163, 184, .12)';
const TICK = '#97a5b6';

let themed = false;

export function themeCharts() {
  if (themed) return;
  Chart.defaults.color = TICK;
  Chart.defaults.font.family = '"Segoe UI", system-ui, sans-serif';
  Chart.defaults.font.size = 11.5;
  Chart.defaults.borderColor = GRID;
  Chart.defaults.plugins.legend.labels.boxWidth = 10;
  Chart.defaults.plugins.legend.labels.boxHeight = 10;
  Chart.defaults.plugins.legend.labels.padding = 12;
  Chart.defaults.plugins.tooltip.backgroundColor = '#0d1117';
  Chart.defaults.plugins.tooltip.borderColor = '#26303f';
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.padding = 11;
  Chart.defaults.plugins.tooltip.titleFont = { size: 12, weight: '600' };
  Chart.defaults.plugins.tooltip.bodyFont = { family: 'ui-monospace, Consolas, monospace', size: 12 };
  Chart.defaults.maintainAspectRatio = false;
  themed = true;
}

const registry = new Map();

export function render(canvasId, config) {
  themeCharts();
  const el = document.getElementById(canvasId);
  if (!el) return null;
  if (registry.has(canvasId)) registry.get(canvasId).destroy();
  const chart = new Chart(el, config);
  registry.set(canvasId, chart);
  return chart;
}

export function destroyCharts() {
  for (const c of registry.values()) c.destroy();
  registry.clear();
}

const inrTick = {
  callback: (v) => shortINR(v),
};

const pctTick = {
  callback: (v) => `${v}%`,
};

function valueTicks(opts) {
  return opts.percent ? pctTick : inrTick;
}

export function doughnut(canvasId, labels, values, opts = {}) {
  const total = values.reduce((a, b) => a + b, 0) || 1;
  return render(canvasId, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: labels.map((_, i) => PALETTE[i % PALETTE.length]),
        borderColor: '#171e28',
        borderWidth: 2,
        hoverOffset: 6,
      }],
    },
    options: {
      cutout: opts.cutout || '62%',
      plugins: {
        legend: { position: opts.legend || 'right', labels: { boxWidth: 9, font: { size: 11.5 } } },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.label}: ${money(ctx.parsed)}  (${(ctx.parsed / total * 100).toFixed(1)}%)`,
          },
        },
      },
    },
  });
}

export function barChart(canvasId, labels, values, opts = {}) {
  return render(canvasId, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: opts.label || 'INR',
        data: values,
        backgroundColor: opts.colors || labels.map((_, i) => PALETTE[i % PALETTE.length]),
        borderRadius: 5,
        borderSkipped: false,
        maxBarThickness: opts.horizontal ? 26 : 54,
      }],
    },
    options: {
      indexAxis: opts.horizontal ? 'y' : 'x',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => ` ${money(ctx.parsed[opts.horizontal ? 'x' : 'y'])}` } },
      },
      scales: {
        x: { beginAtZero: true, ...axis(opts, opts.horizontal), ticks: opts.horizontal ? inrTick : { autoSkip: false } },
        y: { beginAtZero: true, ...axis(opts, !opts.horizontal), ticks: opts.horizontal ? { autoSkip: false } : inrTick },
      },
    },
  });
}

function axis(opts, isValue) {
  if (opts.stacked) return { stacked: true, grid: { display: isValue }, border: { display: false } };
  return { grid: { display: isValue, drawBorder: false }, border: { display: false } };
}

export function stackedBar(canvasId, labels, datasets, opts = {}) {
  return render(canvasId, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      indexAxis: opts.horizontal ? 'y' : 'x',
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 9, font: { size: 11 } } },
        tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${money(ctx.parsed[opts.horizontal ? 'x' : 'y'])}` } },
      },
      scales: {
        x: { stacked: true, grid: { display: !!opts.horizontal }, border: { display: false }, ticks: opts.horizontal ? inrTick : {} },
        y: { stacked: true, grid: { display: !opts.horizontal }, border: { display: false }, ticks: opts.horizontal ? {} : inrTick },
      },
    },
  });
}

export function groupedBar(canvasId, labels, datasets, opts = {}) {
  const fmt = opts.percent ? (v) => `${Number(v).toFixed(1)}%` : (v) => money(v);
  return render(canvasId, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      indexAxis: opts.horizontal ? 'y' : 'x',
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 9, font: { size: 11 } } },
        tooltip: { callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmt(ctx.parsed[opts.horizontal ? 'x' : 'y'])}` } },
      },
      scales: {
        x: { grid: { display: !!opts.horizontal }, border: { display: false }, ticks: opts.horizontal ? valueTicks(opts) : {} },
        y: { grid: { display: !opts.horizontal }, border: { display: false }, ticks: opts.horizontal ? {} : valueTicks(opts), beginAtZero: true },
      },
    },
  });
}

export function lineChart(canvasId, labels, datasets, opts = {}) {
  return render(canvasId, {
    type: 'line',
    data: { labels, datasets },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: datasets.length > 1, position: 'bottom', labels: { boxWidth: 10, usePointStyle: true, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ${money(ctx.parsed.y)}`,
            ...(opts.tooltipLabel ? { title: opts.tooltipLabel } : {}),
          },
        },
      },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { autoSkip: opts.autoSkip ?? true, maxRotation: 0 } },
        y: {
          grid: { color: GRID },
          border: { display: false },
          ticks: inrTick,
          ...(opts.includeNegative ? {} : { beginAtZero: false }),
        },
      },
    },
  });
}

export function dataset(label, data, color, extra = {}) {
  return {
    label,
    data,
    borderColor: color,
    backgroundColor: extra.fillColor ?? hexToRgba(color, .13),
    fill: extra.fill ?? true,
    tension: .3,
    borderWidth: 2,
    pointRadius: extra.pointRadius ?? 0,
    pointHoverRadius: 4,
    pointBackgroundColor: color,
    borderDash: extra.dash || [],
  };
}

function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}
