import "iconify-icon";
import "./style.css";
import * as echarts from "echarts";
import {
    fetchConfig,
    fetchInfo,
    fetchScanFans,
    removeFan,
    saveConfig,
    setFanAlgorithm,
    setFanCurve,
    setFanManualPWM,
    setFanMode,
    setGlobalConfig,
} from "./api";
import type {ConfigPayload, CurvePoint, FanConfig, GlobalConfig, ScannedFan, Telemetry} from "./types";

const DEFAULT_CURVE: CurvePoint[] = [
    {temp: 30, pwm: 80},
    {temp: 55, pwm: 140},
    {temp: 75, pwm: 200},
    {temp: 100, pwm: 255}
];

const emptyGlobal = (): GlobalConfig => ({
    pwm_deadzone: 5,
    update_interval_ms: 2000,
    emergency_temp: 80,
    stop_behavior: "keep",
    stop_pwm: 200,
    stop_hysteresis: 2,
    log_level: "info",
    max_step: 12,
    min_hold_sec: 10,
    temp_deviance: 2,
    response_delay_ms: 5000
});

let config: ConfigPayload = {fans: [], global: emptyGlobal()};
let telemetry: Telemetry | undefined;

let fanCurveChart: echarts.ECharts | null = null;
let fanCurveChartBound = false;
let curveData: number[][] = [];
let selectedCurveFanId = "";
let historyChart: echarts.ECharts | null = null;

// 圆环周长 (2 * PI * 15.5 ≈ 97.4)
const RING_CIRCUMFERENCE = 97.4;

function formatTime(d: Date): string {
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    return `${h}:${min}:${s}`;
}

function formatDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}年${m}月${day}日`;
}

function updateSystemTime() {
    const now = new Date();
    $("system-date").textContent = formatDate(now);
    $("system-time").textContent = formatTime(now);
}

function formatUptime(seconds?: number): string {
    if (seconds === undefined || seconds <= 0) return "--";
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}天`);
    if (hours > 0) parts.push(`${hours}时`);
    if (minutes > 0) parts.push(`${minutes}分`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}秒`);

    return parts.join(" ");
}

function updateRingProgress(ringId: string, percentage: number) {
    const ring = document.getElementById(ringId) as SVGCircleElement | null;
    if (ring) {
        const offset = RING_CIRCUMFERENCE - (percentage / 100) * RING_CIRCUMFERENCE;
        ring.style.strokeDashoffset = String(offset);
    }
}

function updateSubtitleDate() {
    updateSystemTime();
    // 每秒更新运行时间（基于后端最后一次推送的时间计算）
    updateUptimeFromServer();
}

// 存储服务器最后一次推送时的 uptime 和本地时间
let lastUptime = 0;
let lastUptimeReceived = 0;

function updateUptimeFromServer() {
    if (lastUptime > 0) {
        // 计算从收到服务器数据到现在过了多少秒
        const elapsed = Math.floor((Date.now() - lastUptimeReceived) / 1000);
        const currentUptime = lastUptime + elapsed;
        $("uptime-text").textContent = formatUptime(currentUptime);
    }
}

// 在收到后端遥测数据时更新
function onTelemetryReceived(t: Telemetry) {
    lastUptime = t.uptime ?? 0;
    lastUptimeReceived = Date.now();
}

let editFanIdx: number | null = null;
let lastScanResults: ScannedFan[] = [];

function $(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error(`#${id} not found`);
    return el;
}

function esc(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

type ToastKind = "success" | "error" | "info";

const TOAST_ICON: Record<ToastKind, string> = {
    success: "mdi:check-circle",
    error: "mdi:alert-circle",
    info: "mdi:information"
};

const TOAST_CLASS: Record<ToastKind, string> = {
    success: "border-emerald-500/35 bg-emerald-950/85 text-emerald-50",
    error: "border-red-500/40 bg-red-950/85 text-red-50",
    info: "border-slate-500/40 bg-slate-900/92 text-slate-100"
};

/** 非阻塞提示（替代 window.alert） */
function toast(message: string, kind: ToastKind = "info") {
    const root = document.getElementById("toast-root");
    if (!root) {
        console.error("[toast]", message);
        return;
    }
    const el = document.createElement("div");
    el.setAttribute("role", "status");
    el.className = `toast-item pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-xl backdrop-blur-sm ${TOAST_CLASS[kind]}`;
    const icon = document.createElement("iconify-icon");
    icon.className = "text-xl flex-shrink-0 mt-0.5";
    icon.setAttribute("icon", TOAST_ICON[kind]);
    const p = document.createElement("p");
    p.className = "flex-1 min-w-0 break-words leading-snug";
    p.textContent = message;
    el.append(icon, p);
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add("toast-item-visible"));
    const ms = kind === "error" ? 6000 : 4200;
    window.setTimeout(() => {
        el.classList.remove("toast-item-visible");
        el.classList.add("toast-item-exit");
        window.setTimeout(() => el.remove(), 220);
    }, ms);
}

/** 确认框（替代 window.confirm），依赖 #confirm-action-dialog 内 form method=dialog */
function openConfirm(message: string): Promise<boolean> {
    const dlg = $("confirm-action-dialog") as HTMLDialogElement;
    $("confirm-action-message").textContent = message;
    return new Promise(resolve => {
        const onClose = () => {
            resolve(dlg.returnValue === "ok");
        };
        dlg.addEventListener("close", onClose, {once: true});
        dlg.showModal();
    });
}

function formatTemp(v?: number): string {
    return v === undefined ? "--" : `${v.toFixed(1)}`;
}

function curveToPairs(curve: CurvePoint[]): number[][] {
    return curve.map(p => [p.temp, p.pwm]);
}

function pairsToCurve(pairs: number[][]): CurvePoint[] {
    return pairs
        .map(([temp, pwm]) => ({
            temp: Math.round(Math.max(0, Math.min(100, temp)) * 10) / 10,
            pwm: Math.max(0, Math.min(255, Math.round(pwm)))
        }))
        .sort((a, b) => a.temp - b.temp);
}

function applyTelemetry(t: Telemetry) {
    telemetry = t;

    // CPU
    $("cpu-temp-text").textContent = formatTemp(t.cpu_temp);
    updateRingProgress("cpu-ring", t.cpu_usage);
    $("cpu-ring-text").textContent = `${t.cpu_usage.toFixed(0)}%`;

    // GPU
    $("gpu-temp-text").textContent = formatTemp(t.gpu_temp);
    updateRingProgress("gpu-ring", 0); // GPU使用率暂未提供
    $("gpu-ring-text").textContent = "--%";

    // 内存
    updateRingProgress("mem-ring", t.mem_usage);
    $("mem-ring-text").textContent = `${t.mem_usage.toFixed(0)}%`;
    // 计算可用内存
    if (t.mem_total && t.mem_total > 0) {
        const available = (t.mem_total * (100 - t.mem_usage) / 100).toFixed(2);
        $("mem-available-text").textContent = available;
    } else {
        // 估算可用内存（假设总内存为使用量的1.5倍）
        const estimated = (t.mem_usage * 0.01 * 16 * (100 - t.mem_usage) / 100).toFixed(2);
        $("mem-available-text").textContent = estimated;
    }

    // 硬盘
    $("disk-avg-text").textContent = formatTemp(t.disks.avg_temp);

    // 运行时间（收到后端数据时更新）
    onTelemetryReceived(t);


    syncFanCardsFromTelemetryOrRender();
    renderStorageList();
    updateHistoryChart();
}

function renderStorageList() {
    const list = $("storage-list");
    const d = telemetry?.disks.details ?? [];

    // 如果列表为空且当前也为空，不重绘
    if (d.length === 0) {
        if (list.children.length === 0) return;
        list.innerHTML = "";
        return;
    }

    // 如果数量变化，完全重绘
    if (list.children.length !== d.length) {
        list.innerHTML = d
            .map(
                disk => `
      <div class="flex justify-between items-center text-xs" data-disk-name="${esc(disk.name)}">
        <span class="text-slate-400 flex items-center gap-2"><iconify-icon icon="mdi:harddisk"></iconify-icon> ${esc(disk.name)}</span>
        <span class="disk-temp font-mono">${
                    disk.status === "sleep" ? '<span class="text-slate-500 uppercase">休眠</span>' : `<span class="text-emerald-400">${formatTemp(disk.temp)}<span class="text-slate-500 text-xs">°C</span></span>`
                }</span>
      </div>`
            )
            .join("");
        return;
    }

    // 数量不变，只更新温度值和状态，避免闪烁
    d.forEach((disk, idx) => {
        const item = list.children[idx] as HTMLElement;
        if (item.dataset.diskName !== disk.name) {
            // 名称变化，完全重绘
            list.innerHTML = d
                .map(
                    disk => `
        <div class="flex justify-between items-center text-xs" data-disk-name="${esc(disk.name)}">
          <span class="text-slate-400 flex items-center gap-2"><iconify-icon icon="mdi:harddisk"></iconify-icon> ${esc(disk.name)}</span>
          <span class="disk-temp font-mono">${
                        disk.status === "sleep" ? '<span class="text-slate-500 uppercase">休眠</span>' : `<span class="text-emerald-400">${formatTemp(disk.temp)}<span class="text-slate-500 text-xs">°C</span></span>`
                    }</span>
        </div>`
                )
                .join("");
            return;
        }
        // 更新温度和状态
        const tempSpan = item.querySelector(".disk-temp");
        if (tempSpan) {
            const isSleep = disk.status === "sleep";
            const iconEl = item.querySelector("iconify-icon") as HTMLElement | null;
            if (iconEl) {
                iconEl.setAttribute("icon", isSleep ? "mdi:harddisk" : "mdi:harddisk");
                iconEl.className = isSleep ? "text-slate-500" : "text-slate-400";
            }
            tempSpan.innerHTML = isSleep
                ? '<span class="text-slate-500 uppercase">休眠</span>'
                : `<span class="text-emerald-400">${formatTemp(disk.temp)}<span class="text-slate-500 text-xs">°C</span></span>`;
        }
    });
}

function runtimeFor(id: string) {
    return telemetry?.fans.find(f => f.id === id);
}

/** 与 WebSocket 推送频率解耦：仅在结构变化时 innerHTML，否则就地更新，避免整卡重绘与动画重启导致闪烁 */
function syncFanCardsFromTelemetryOrRender() {
    const root = $("fan-root");
    const fans = config.fans;
    const cards = root.querySelectorAll(":scope > [data-fan-id]");

    if (fans.length === 0) {
        if (root.innerHTML !== "") root.innerHTML = "";
        return;
    }

    if (cards.length !== fans.length) {
        renderFanCards();
        return;
    }
    for (let i = 0; i < fans.length; i++) {
        if ((cards[i] as HTMLElement).dataset.fanId !== fans[i].id) {
            renderFanCards();
            return;
        }
    }

    fans.forEach((fan, idx) => {
        const card = cards[idx] as HTMLElement;
        const rt = runtimeFor(fan.id);
        const rpm = rt?.rpm ?? 0;
        const stopped = rpm <= 0 || rt?.status === "stopped";
        const manual = fan.mode === "manual";
        const pwmVal = fan.manual_pwm;

        // 更新风扇名称
        const fanName = card.querySelector("[data-fan-name]") as HTMLElement | null;
        if (fanName) fanName.textContent = fan.name;

        // 更新 PWM 路径
        const pwmPath = card.querySelector("[data-fan-pwm-path]") as HTMLElement | null;
        if (pwmPath) {
            pwmPath.textContent = fan.pwm_path || "未配置 PWM";
            pwmPath.setAttribute("title", fan.pwm_path || "");
        }

        const iconBg = card.querySelector("[data-fan-icon-bg]") as HTMLElement | null;
        const iconEl = card.querySelector("[data-fan-icon]") as HTMLElement | null;
        if (iconBg) {
            iconBg.className = `w-9 h-9 rounded-full ${stopped ? "bg-slate-700" : "bg-sky-500/10"} flex items-center justify-center flex-shrink-0`;
        }
        if (iconEl) {
            iconEl.setAttribute("icon", stopped ? "mdi:fan-off" : "mdi:fan");
            iconEl.className = stopped ? "text-slate-500" : "text-sky-400 animate-spin-slow";
        }

        const rpmRow = card.querySelector("[data-fan-rpm-row]") as HTMLElement | null;
        const rpmNum = card.querySelector("[data-fan-rpm]") as HTMLElement | null;
        const rpmUnit = card.querySelector("[data-fan-rpm-unit]") as HTMLElement | null;
        if (rpmNum) rpmNum.textContent = String(rpm);
        if (rpmUnit) rpmUnit.textContent = stopped ? "STOPPED" : "RPM";
        if (rpmRow) {
            rpmRow.className = `text-xl font-mono font-bold ${stopped ? "text-slate-500 italic" : "text-sky-400"}`;
        }

        const curveBtn = card.querySelector('[data-mode="curve"]') as HTMLElement | null;
        const manualBtn = card.querySelector('[data-mode="manual"]') as HTMLElement | null;
        if (curveBtn) {
            curveBtn.className = `px-2.5 py-0.5 text-xs rounded-md ${!manual ? "bg-sky-500 text-white shadow-lg" : "text-slate-400 hover:text-white"}`;
        }
        if (manualBtn) {
            manualBtn.className = `px-2.5 py-0.5 text-xs rounded-md ${manual ? "bg-sky-500 text-white shadow-lg" : "text-slate-400 hover:text-white"}`;
        }

        const manualUi = card.querySelector("[data-manual-ui]") as HTMLElement | null;
        const autoUi = card.querySelector("[data-auto-ui]") as HTMLElement | null;
        if (manualUi) manualUi.classList.toggle("hidden", !manual);
        if (autoUi) autoUi.classList.toggle("hidden", manual);

        // 更新温度源显示
        const fanSource = card.querySelector("[data-fan-source]") as HTMLElement | null;
        if (fanSource) {
            fanSource.textContent = getSourceLabel(fan.source);
            fanSource.setAttribute("data-source", fan.source);
        }

        const algoSelect = card.querySelector("[data-fan-algorithm]") as HTMLSelectElement | null;
        if (algoSelect) {
            algoSelect.value = fan.algorithm || "standard";
        }

        const pwmDisplay = card.querySelector("[data-fan-pwm-display]") as HTMLElement | null;
        const range = card.querySelector('input[data-field="pwm-range"]') as HTMLInputElement | null;
        if (pwmDisplay) pwmDisplay.textContent = `${pwmVal} / 255`;
        if (range && document.activeElement !== range) {
            range.value = String(pwmVal);
        }
    });
}

function renderFanCards() {
    const root = $("fan-root");
    const fans = config.fans;
    root.innerHTML = fans
        .map((fan, idx) => {
            const rt = runtimeFor(fan.id);
            const rpm = rt?.rpm ?? 0;
            const stopped = rpm <= 0 || rt?.status === "stopped";
            const manual = fan.mode === "manual";
            const pwmVal = fan.manual_pwm;
            return `
<div class="bg-slate-900/40 rounded-2xl p-4 border border-slate-700/50" data-fan-idx="${idx}" data-fan-id="${esc(fan.id)}">
  <div class="flex justify-between items-start mb-3">
    <div class="flex items-center gap-2.5 min-w-0">
      <div data-fan-icon-bg class="w-9 h-9 rounded-full ${stopped ? "bg-slate-700" : "bg-sky-500/10"} flex items-center justify-center flex-shrink-0">
        <iconify-icon data-fan-icon class="${stopped ? "text-slate-500" : "text-sky-400 animate-spin-slow"}" icon="${stopped ? "mdi:fan-off" : "mdi:fan"}"></iconify-icon>
      </div>
      <div class="min-w-0">
        <h4 data-fan-name class="font-bold text-white text-sm truncate">${esc(fan.name)}</h4>
        <p data-fan-pwm-path class="text-[10px] text-slate-500 font-mono truncate leading-tight" title="${esc(fan.pwm_path)}">${esc(fan.pwm_path || "未配置 PWM")}</p>
      </div>
    </div>
    <div class="flex items-center gap-0.5 flex-shrink-0">
      <button type="button" class="p-1.5 hover:bg-red-900/40 rounded-md text-slate-400 hover:text-red-300 flex-shrink-0" data-act="fan-delete" title="从配置中删除此风扇">
        <iconify-icon class="text-lg" icon="mdi:delete-outline"></iconify-icon>
      </button>
      <button type="button" class="p-1.5 hover:bg-slate-700 rounded-md text-slate-400 flex-shrink-0" data-act="fan-settings" title="风扇设置">
        <iconify-icon class="text-lg" icon="mdi:cog-outline"></iconify-icon>
      </button>
    </div>
  </div>
  <div class="flex items-center justify-between mb-3">
    <div data-fan-rpm-row class="text-xl font-mono font-bold ${stopped ? "text-slate-500 italic" : "text-sky-400"}">
      <span data-fan-rpm>${rpm}</span> <span data-fan-rpm-unit class="text-[10px] text-slate-500 font-normal not-italic">${stopped ? "STOPPED" : "RPM"}</span>
    </div>
    <div class="flex items-center p-0.5 bg-slate-800 rounded-lg">
      <button type="button" data-mode="curve" class="px-2.5 py-0.5 text-xs rounded-md ${!manual ? "bg-sky-500 text-white shadow-lg" : "text-slate-400 hover:text-white"}">自动</button>
      <button type="button" data-mode="manual" class="px-2.5 py-0.5 text-xs rounded-md ${manual ? "bg-sky-500 text-white shadow-lg" : "text-slate-400 hover:text-white"}">手动</button>
    </div>
  </div>
  <div class="${manual ? "" : "hidden"}" data-manual-ui>
    <div class="flex justify-between text-[10px] text-slate-500 mb-1.5 uppercase tracking-tighter">
      <span>PWM 输出</span>
      <span data-fan-pwm-display class="text-sky-400 font-bold">${pwmVal} / 255</span>
    </div>
    <input data-field="pwm-range" class="w-full" type="range" min="0" max="255" value="${pwmVal}" />
  </div>
  <div class="${manual ? "hidden" : ""} flex items-center gap-2 text-xs text-slate-400 bg-slate-800/40 py-1.5 px-2 rounded-lg mt-1" data-auto-ui>
    <iconify-icon class="text-sky-400 flex-shrink-0" icon="mdi:chart-bell-curve"></iconify-icon>
    <span class="leading-tight">温度源: </span>
    <span data-fan-source class="leading-tight text-sky-300" data-source="${fan.source}">${getSourceLabel(fan.source)}</span>
    <span class="leading-tight text-slate-500 mx-0.5">·</span>
    <select data-fan-algorithm class="text-[10px] bg-slate-700/60 border border-slate-600/60 rounded px-1 py-0.5 text-slate-300 focus:outline-none focus:ring-1 focus:ring-sky-500">
      <option value="identity" ${fan.algorithm === "identity" ? "selected" : ""}>直通</option>
      <option value="standard" ${fan.algorithm === "standard" ? "selected" : ""}>标准</option>
      <option value="ema" ${fan.algorithm === "ema" ? "selected" : ""}>EMA</option>
    </select>
    <span class="leading-tight text-slate-500">· 齿轮编辑曲线</span>
  </div>
</div>`;
        })
        .join("");
}

function renderSourceOptions(current: string): string {
    const disks = telemetry?.disks.details ?? [];
    const opts: { v: string; l: string }[] = [
        {v: "cpu", l: "CPU"},
        {v: "gpu", l: "GPU"},
        {v: "disk_avg", l: "硬盘平均"},
        {v: "max", l: "最大值"}
    ];
    disks.forEach(d => opts.push({v: `disk:${d.name}`, l: `硬盘 ${d.name}`}));
    return opts
        .map(o => `<option value="${esc(o.v)}" ${o.v === current ? "selected" : ""}>${esc(o.l)}</option>`)
        .join("");
}

function getSourceLabel(source: string): string {
    const disks = telemetry?.disks.details ?? [];
    if (source === "cpu") return "CPU";
    if (source === "gpu") return "GPU";
    if (source === "disk_avg") return "硬盘平均";
    if (source === "max") return "最大值";
    if (source.startsWith("disk:")) {
        const name = source.slice(5);
        const disk = disks.find(d => d.name === name);
        return disk ? `硬盘 ${name}` : name;
    }
    return source;
}

function updateHistoryChart() {
    if (!historyChart || !telemetry) return;
    const h = telemetry.history;

    // 后端 HistoryPoint.Value 带 omitempty，nil 时字段被省略，
    // 所以前端需要用 'in' 判断字段是否存在，而非只检查值
    function getValue(p: any): number | null {
        return ("value" in p && p.value != null) ? p.value : null;
    }

    // 计算所有温度数据的最大/最小值，用于 Y 轴自适应
    function getStats(arr: any[]): { min: number; max: number } {
        const vals = arr.map(getValue).filter((v): v is number => v !== null);
        if (vals.length === 0) return {min: Infinity, max: -Infinity};
        return {min: Math.min(...vals), max: Math.max(...vals)};
    }

    const cpuStats = getStats(h.cpu_temp);
    const gpuStats = getStats(h.gpu_temp);
    const diskStats = getStats(h.disk_avg);
    const dataMin = Math.min(cpuStats.min, gpuStats.min, diskStats.min);
    const dataMax = Math.max(cpuStats.max, gpuStats.max, diskStats.max);
    // Y 轴范围：最小值向下取整，最大值向上取整，留适当余量
    // 如果 dataMin 或 dataMax 是无穷大（所有数据源都为空），使用默认值
    const yMin = isFinite(dataMin) ? Math.floor(dataMin / 5) * 5 - 5 : 0;
    const yMax = isFinite(dataMax) ? Math.ceil(dataMax / 5) * 5 + 5 : 100;

    const x = h.cpu_temp.map((p: any) => p.time);
    historyChart.setOption({
        xAxis: {data: x},
        yAxis: {type: "value", min: Math.max(0, yMin), max: yMax},
        series: [
            {
                data: h.cpu_temp.map(getValue),
                color: "#38bdf8",
                showSymbol: false,
                lineStyle: {color: "#38bdf8", width: 2},
                emphasis: {scale: 2}
            },
            {
                data: h.gpu_temp.map(getValue),
                color: "#f97316",
                showSymbol: false,
                lineStyle: {color: "#f97316", width: 2},
                emphasis: {scale: 2}
            },
            {
                data: h.disk_avg.map(getValue),
                color: "#10b981",
                showSymbol: false,
                lineStyle: {color: "#10b981", width: 2},
                emphasis: {scale: 2}
            }
        ]
    });
}

function initHistoryChart() {
    const el = $("history-chart");
    historyChart = echarts.init(el);
    historyChart.setOption({
        backgroundColor: "transparent",
        textStyle: {color: "#cbd5e1"},
        legend: {top: 0, textStyle: {color: "#cbd5e1"}, data: ["CPU", "GPU", "硬盘平均"]},
        tooltip: {trigger: "axis"},
        grid: {left: 40, right: 20, top: 36, bottom: 24},
        xAxis: {
            type: "category",
            data: [],
            boundaryGap: false,
            axisLine: {lineStyle: {color: "rgba(148,163,184,0.4)"}}
        },
        yAxis: {
            type: "value",
            axisLine: {lineStyle: {color: "rgba(148,163,184,0.4)"}},
            splitLine: {lineStyle: {color: "rgba(148,163,184,0.12)"}}
        },
        series: [
            {
                name: "CPU",
                type: "line",
                smooth: true,
                data: [],
                color: "#38bdf8",
                lineStyle: {color: "#38bdf8", width: 2},
                showSymbol: false,
                emphasis: {scale: 2}
            },
            {
                name: "GPU",
                type: "line",
                smooth: true,
                data: [],
                color: "#f97316",
                lineStyle: {color: "#f97316", width: 2},
                showSymbol: false,
                emphasis: {scale: 2}
            },
            {
                name: "硬盘平均",
                type: "line",
                smooth: true,
                data: [],
                color: "#10b981",
                lineStyle: {color: "#10b981", width: 2},
                showSymbol: false,
                emphasis: {scale: 2}
            }
        ]
    });
    window.addEventListener("resize", () => historyChart?.resize());
}

const symbolSize = 16;

function initFanCurveChartShell() {
    if (fanCurveChart) return;
    const chartDom = $("fan-curve-editor");
    fanCurveChart = echarts.init(chartDom);
    const option: echarts.EChartsOption = {
        backgroundColor: "transparent",
        tooltip: {
            triggerOn: "none",
            formatter: (p: unknown) => {
                const item = p as { data: [number, number] };
                const d = item.data;
                return `温度: ${d[0].toFixed(1)}°C\nPWM: ${d[1].toFixed(0)}`;
            }
        },
        grid: {top: "10%", bottom: "15%", left: "10%", right: "10%"},
        xAxis: {
            min: 30,
            max: 100,
            type: "value",
            axisLine: {lineStyle: {color: "#334155"}},
            splitLine: {lineStyle: {color: "rgba(51, 65, 85, 0.3)", type: "dashed"}},
            name: "温度 (°C)",
            nameLocation: "middle",
            nameGap: 35,
            nameTextStyle: {color: "#64748b", fontSize: 12}
        },
        yAxis: {
            min: 0,
            max: 255,
            type: "value",
            axisLine: {lineStyle: {color: "#334155"}},
            splitLine: {lineStyle: {color: "rgba(51, 65, 85, 0.3)", type: "dashed"}},
            name: "PWM 值",
            nameLocation: "middle",
            nameGap: 45,
            nameTextStyle: {color: "#64748b", fontSize: 12}
        },
        series: [
            {
                id: "curve",
                type: "line",
                smooth: false,
                symbolSize,
                data: curveData,
                lineStyle: {color: "#0ea5e9", width: 4, shadowBlur: 15, shadowColor: "rgba(14, 165, 233, 0.4)"},
                itemStyle: {color: "#fff", borderColor: "#0ea5e9", borderWidth: 3},
                areaStyle: {
                    color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        {offset: 0, color: "rgba(14, 165, 233, 0.3)"},
                        {offset: 1, color: "rgba(14, 165, 233, 0)"}
                    ])
                }
            }
        ]
    };
    fanCurveChart.setOption(option);
    updateFanCurveGraphic();

    if (!fanCurveChartBound) {
        fanCurveChartBound = true;
        window.addEventListener("resize", () => {
            fanCurveChart?.resize();
            updateFanCurveGraphic();
        });

        fanCurveChart.getZr().on("dblclick", (params: { offsetX: number; offsetY: number }) => {
            if (!fanCurveChart) return;
            const pt = fanCurveChart.convertFromPixel("grid", [params.offsetX, params.offsetY]) as number[];
            if (pt[0] >= 0 && pt[0] <= 100 && pt[1] >= 0 && pt[1] <= 255) {
                curveData.push(pt);
                curveData.sort((a, b) => a[0] - b[0]);
                syncCurveToConfig();
                updateFanCurveDataAndGraphic();
            }
        });

        chartDom.addEventListener("contextmenu", e => {
            e.preventDefault();
            if (!fanCurveChart) return;
            const pt = fanCurveChart.convertFromPixel("grid", [e.offsetX, e.offsetY]) as number[];
            let idx = -1;
            curveData.forEach((d, i) => {
                if (Math.abs(d[0] - pt[0]) < 3 && Math.abs(d[1] - pt[1]) < 10) idx = i;
            });
            if (idx !== -1 && curveData.length > 2) {
                curveData.splice(idx, 1);
                syncCurveToConfig();
                updateFanCurveDataAndGraphic();
            }
        });
    }
}

function updateFanCurveDataAndGraphic() {
    if (!fanCurveChart) return;
    fanCurveChart.setOption({series: [{id: "curve", data: curveData}]});
    updateFanCurveGraphic();
}

function onFanPointDrag(dataIndex: number, pos: number[]) {
    if (!fanCurveChart) return;
    const pt = fanCurveChart.convertFromPixel("grid", pos) as number[];
    const newTemp = Math.round(Math.max(0, Math.min(100, pt[0])));
    const newPwm = Math.round(Math.max(0, Math.min(255, pt[1])));
    curveData[dataIndex] = [newTemp, newPwm];
    curveData.sort((a, b) => a[0] - b[0]);

    // 排序后重新查找当前拖动点的 dataIndex，确保 tooltip 显示正确数据
    const newDataIndex = curveData.findIndex(p => p[0] === newTemp && p[1] === newPwm);

    syncCurveToConfig();
    updateFanCurveDataAndGraphic();

    if (newDataIndex !== -1) {
        fanCurveChart.dispatchAction({type: "showTip", seriesIndex: 0, dataIndex: newDataIndex});
    }
}

function updateFanCurveGraphic() {
    if (!fanCurveChart) return;
    const g: any[] = curveData.map((item, dataIndex) => ({
        type: "circle",
        position: fanCurveChart!.convertToPixel("grid", item) as number[],
        shape: {r: symbolSize / 1.5},
        invisible: true,
        draggable: true,
        z: 100,
        ondrag(this: any) {
            onFanPointDrag(dataIndex, [this.x, this.y]);
        },
        onmousemove() {
            fanCurveChart?.dispatchAction({type: "showTip", seriesIndex: 0, dataIndex});
        },
        onmouseout() {
            fanCurveChart?.dispatchAction({type: "hideTip"});
        }
    }));
    fanCurveChart.setOption({graphic: g}, {replaceMerge: ["graphic"]});
}

function syncCurveToConfig() {
    const fan = config.fans.find(f => f.id === selectedCurveFanId);
    if (fan) fan.curve = pairsToCurve(curveData);
}

function loadCurveIntoEditor() {
    const fan = config.fans.find(f => f.id === selectedCurveFanId);
    curveData = fan ? curveToPairs(fan.curve?.length ? fan.curve : DEFAULT_CURVE) : [[35, 80], [55, 140], [75, 200], [100, 255]];
    updateFanCurveDataAndGraphic();
}

function fillGlobalForm() {
    const g = config.global;
    ($("g-deadzone") as HTMLInputElement).value = String(g.pwm_deadzone);
    ($("g-interval") as HTMLInputElement).value = String(Math.round(g.update_interval_ms / 1000));
    ($("g-emergency") as HTMLInputElement).value = String(g.emergency_temp);
    ($("g-stop-beh") as HTMLSelectElement).value = g.stop_behavior;
    ($("g-stop-pwm") as HTMLInputElement).value = String(g.stop_pwm);
    ($("g-hysteresis") as HTMLInputElement).value = String(g.stop_hysteresis);
    ($("g-log-level") as HTMLSelectElement).value = g.log_level || "info";
    ($("g-max-step") as HTMLInputElement).value = String(g.max_step);
    ($("g-min-hold") as HTMLInputElement).value = String(g.min_hold_sec);
    ($("g-temp-deviance") as HTMLInputElement).value = String(g.temp_deviance);
    ($("g-response-delay") as HTMLInputElement).value = String(Math.round(g.response_delay_ms / 1000));
    updateStopPWMRow();
}

function updateStopPWMRow() {
    const stopBeh = ($("g-stop-beh") as HTMLSelectElement).value;
    const row = $("g-stop-pwm-row");
    if (row) {
        row.classList.toggle("hidden", stopBeh !== "set");
    }
}

function clampPWM(v: number): number {
    return Math.max(0, Math.min(255, Math.round(v)));
}

function readGlobalForm(): GlobalConfig {
    const stopBeh = ($("g-stop-beh") as HTMLSelectElement).value;
    return {
        pwm_deadzone: clampPWM(Number(($("g-deadzone") as HTMLInputElement).value) || 0),
        update_interval_ms: Math.max(1000, Number(($("g-interval") as HTMLInputElement).value) * 1000) || 2000,
        emergency_temp: Math.max(0, Number(($("g-emergency") as HTMLInputElement).value) || 80),
        stop_behavior: stopBeh === "set" ? "set" : "keep",
        stop_pwm: clampPWM(Number(($("g-stop-pwm") as HTMLInputElement).value) || 200),
        stop_hysteresis: Math.max(0, Number(($("g-hysteresis") as HTMLInputElement).value) || 2),
        log_level: ($("g-log-level") as HTMLSelectElement).value || "info",
        max_step: Math.max(0, Math.min(255, Number(($("g-max-step") as HTMLInputElement).value) || 12)),
        min_hold_sec: Math.max(0, Number(($("g-min-hold") as HTMLInputElement).value) || 10),
        temp_deviance: Math.max(0, Number(($("g-temp-deviance") as HTMLInputElement).value) || 2),
        response_delay_ms: Math.max(0, Number(($("g-response-delay") as HTMLInputElement).value) * 1000) || 5000
    };
}

function openFanSettingsDialog(idx: number) {
    editFanIdx = idx;
    const fan = config.fans[idx];
    if (!fan) return;
    selectedCurveFanId = fan.id;

    ($("fan-edit-title") as HTMLElement).textContent = `风扇设置 · ${fan.name}`;
    ($("fe-name") as HTMLInputElement).value = fan.name;
    ($("fe-pwm") as HTMLInputElement).value = fan.pwm_path;
    ($("fe-rpm") as HTMLInputElement).value = fan.rpm_path;
    ($("fe-en") as HTMLInputElement).value = fan.enable_path;
    const src = $("fe-source") as HTMLSelectElement;
    src.innerHTML = renderSourceOptions(fan.source);
    src.value = fan.source;

    ($("fe-algorithm") as HTMLSelectElement).value = fan.algorithm || "standard";

    initFanCurveChartShell();
    loadCurveIntoEditor();

    const dlg = $("fan-edit-dialog") as HTMLDialogElement;
    dlg.showModal();
    requestAnimationFrame(() => {
        fanCurveChart?.resize();
        updateFanCurveGraphic();
    });
}

function readFanFormIntoConfig(): FanConfig | null {
    if (editFanIdx === null) return null;
    const fan = config.fans[editFanIdx];
    if (!fan) return null;
    fan.name = ($("fe-name") as HTMLInputElement).value;
    fan.pwm_path = ($("fe-pwm") as HTMLInputElement).value.trim();
    fan.rpm_path = ($("fe-rpm") as HTMLInputElement).value.trim();
    fan.enable_path = ($("fe-en") as HTMLInputElement).value.trim();
    fan.source = ($("fe-source") as HTMLSelectElement).value;
    fan.algorithm = ($("fe-algorithm") as HTMLSelectElement).value as "identity" | "standard" | "ema";
    return fan;
}

function bindFanRoot() {
    const root = $("fan-root");

    /** 在 composed path（含 Shadow DOM）中查找匹配 selector 的元素 */
    function composedClosest(ev: Event, selector: string): Element | null {
        return (ev.composedPath?.() ?? []).find(el => (el as Element).matches?.(selector)) as Element | null ?? null;
    }

    root.addEventListener("click", async ev => {
        const row = composedClosest(ev, "[data-fan-idx]") as HTMLElement | null;
        const del = composedClosest(ev, "[data-act=fan-delete]");
        if (del && row) {
            const id = row.dataset.fanId!;
            const name = config.fans.find(f => f.id === id)?.name ?? id;
            if (!(await openConfirm(`确定从配置中删除风扇「${name}」吗？`))) return;
            try {
                await removeFan(id);
                const idx = config.fans.findIndex(f => f.id === id);
                if (idx >= 0) {
                    config.fans.splice(idx, 1);
                }
                renderFanCards();
                toast("已删除该风扇配置", "success");
            } catch (e) {
                console.error(e);
                toast(String(e), "error");
            }
            return;
        }
        const gear = composedClosest(ev, "[data-act=fan-settings]");
        if (gear && row) {
            openFanSettingsDialog(Number(row.dataset.fanIdx));
            return;
        }
        const modeBtn = composedClosest(ev, "[data-mode]") as HTMLElement | null;
        if (modeBtn && row) {
            const id = row.dataset.fanId!;
            const mode = modeBtn.dataset.mode as "manual" | "curve";
            const fan = config.fans.find(f => f.id === id);
            if (!fan || fan.mode === mode) return;
            fan.mode = mode;
            try {
                await setFanMode(id, mode);
                await refresh();
            } catch (e) {
                console.error(e);
                toast(String(e), "error");
            }
        }
    });

    root.addEventListener("input", ev => {
        const t = ev.target as HTMLInputElement;
        const row = t.closest("[data-fan-idx]") as HTMLElement | null;
        if (!row) return;
        const fan = config.fans.find(f => f.id === row.dataset.fanId);
        if (!fan) return;
        if (t.dataset.field === "pwm-range") {
            const v = Number(t.value);
            fan.manual_pwm = v;
            const span = row.querySelector("[data-fan-pwm-display]");
            if (span) span.textContent = `${v} / 255`;
        }
    });

    // 算法切换
    root.addEventListener("change", async ev => {
        const t = ev.target as HTMLSelectElement;
        if (!t.matches("[data-fan-algorithm]")) return;
        const row = t.closest("[data-fan-idx]") as HTMLElement | null;
        if (!row) return;
        const id = row.dataset.fanId!;
        const algorithm = t.value as "identity" | "standard" | "ema";
        const fan = config.fans.find(f => f.id === id);
        if (!fan || fan.algorithm === algorithm) return;
        fan.algorithm = algorithm;
        try {
            await setFanAlgorithm(id, algorithm);
            const labels: Record<string, string> = {identity: "直通", standard: "标准", ema: "EMA"};
            toast(`算法已切换为 ${labels[algorithm]}`, "success");
        } catch (e) {
            console.error(e);
            toast(String(e), "error");
        }
    });

    // 拖动结束（松开鼠标）时才调用接口
    root.addEventListener("pointerup", async ev => {
        const t = ev.target as HTMLInputElement;
        const row = t.closest("[data-fan-idx]") as HTMLElement | null;
        if (!row) return;
        const id = row.dataset.fanId!;
        const fan = config.fans.find(f => f.id === id);
        if (!fan) return;
        if (t.dataset.field === "pwm-range") {
            const v = Number(t.value);
            try {
                await setFanManualPWM(id, v);
            } catch (e) {
                console.error(e);
                toast(String(e), "error");
            }
        }
    });
}

function pwmPathTaken(path: string): boolean {
    return config.fans.some(f => f.pwm_path === path);
}

async function runHardwareScan() {
    const status = $("scan-status");
    status.textContent = "正在扫描…";
    try {
        lastScanResults = await fetchScanFans();
        status.textContent = `共发现 ${lastScanResults?.length ?? 0} 个 PWM 通道`;
        renderScanTable();
    } catch (e) {
        console.error(e);
        status.textContent = `扫描失败：${String(e)}`;
        ($("scan-fans-tbody") as HTMLElement).innerHTML = "";
    }
}

function renderScanTable() {
    const tbody = $("scan-fans-tbody") as HTMLElement;
    tbody.innerHTML = lastScanResults
        .map((s, i) => {
            const taken = pwmPathTaken(s.pwm_path);
            return `
<tr class="border-b border-slate-800 ${taken ? "opacity-50" : ""}">
  <td class="p-2 align-top">
    <input type="checkbox" data-scan-idx="${i}" class="scan-cb rounded border-slate-600" ${taken ? "disabled" : ""} />
  </td>
  <td class="p-2 align-top text-slate-300">${esc(s.name)}<div class="text-[10px] text-slate-500 font-mono mt-1">${esc(s.id)}</div></td>
  <td class="p-2 align-top font-mono text-[10px] text-slate-400 break-all">${esc(s.pwm_path)}</td>
  <td class="p-2 align-top font-mono text-[10px] text-slate-400 break-all">${esc(s.rpm_path || "—")}</td>
</tr>`;
        })
        .join("");
}

async function addScannedFansFromSelection() {
    const boxes = document.querySelectorAll<HTMLInputElement>(".scan-cb:checked:not(:disabled)");
    let n = 0;
    boxes.forEach(box => {
        const i = Number(box.dataset.scanIdx);
        const s = lastScanResults[i];
        if (!s || pwmPathTaken(s.pwm_path)) return;
        let id = s.id;
        if (config.fans.some(f => f.id === id)) {
            id = `${s.id}-${Date.now().toString(36)}`;
        }
        const fan: FanConfig = {
            id,
            name: s.name,
            pwm_path: s.pwm_path,
            rpm_path: s.rpm_path,
            enable_path: s.enable_path,
            mode: "curve",
            source: "cpu",
            manual_pwm: 120,
            curve: DEFAULT_CURVE.map(c => ({...c})),
            algorithm: "identity"
        };
        config.fans.push(fan);
        n++;
    });
    if (n === 0) {
        toast("请勾选尚未加入配置的项。", "info");
        return;
    }
    try {
        await saveConfig(config);
        ($("scan-fans-dialog") as HTMLDialogElement).close();
        await refresh();
        toast(`已添加 ${n} 个风扇并已保存到服务端。`, "success");
    } catch (e) {
        console.error(e);
        toast(String(e), "error");
    }
}

async function refresh() {
    const [info, cfg] = await Promise.all([fetchInfo(), fetchConfig()]);
    config = cfg;
    applyTelemetry(info);
    fillGlobalForm();
}

// ============================================================
// Theme Management
// ============================================================
const THEME_STORAGE_KEY = "fancontrol_theme";
type ThemeMode = "auto" | "light" | "dark";
let themeMode: ThemeMode = "auto";
let colorSchemeMedia: MediaQueryList | null = null;

function applyTheme(theme: string) {
    document.documentElement.setAttribute("data-theme", theme);
}

function onSystemThemeChanged(event: MediaQueryListEvent) {
    if (themeMode !== "auto") return;
    applyTheme(event.matches ? "dark" : "light");
}

function setupThemeSync() {
    if (!window.matchMedia) {
        themeMode = "light";
        applyTheme("light");
        return;
    }
    colorSchemeMedia = window.matchMedia("(prefers-color-scheme: dark)");

    // Load saved preference
    const saved = localStorage.getItem(THEME_STORAGE_KEY) as ThemeMode | null;
    if (saved === "light" || saved === "dark") {
        themeMode = saved;
        applyTheme(saved);
    } else {
        themeMode = "auto";
        applyTheme(colorSchemeMedia.matches ? "dark" : "light");
    }

    if (typeof colorSchemeMedia.addEventListener === "function") {
        colorSchemeMedia.addEventListener("change", onSystemThemeChanged);
    } else if (typeof (colorSchemeMedia as any).addListener === "function") {
        (colorSchemeMedia as any).addListener(onSystemThemeChanged);
    }

    updateThemeIcon();
}

function cycleTheme() {
    if (themeMode === "auto") {
        themeMode = "light";
        applyTheme("light");
    } else if (themeMode === "light") {
        themeMode = "dark";
        applyTheme("dark");
    } else {
        themeMode = "auto";
        if (colorSchemeMedia) {
            applyTheme(colorSchemeMedia.matches ? "dark" : "light");
        } else {
            applyTheme("light");
        }
    }
    localStorage.setItem(THEME_STORAGE_KEY, themeMode);
    updateThemeIcon();
}

function updateThemeIcon() {
    const icon = document.getElementById("theme-icon") as HTMLElement | null;
    if (!icon) return;
    if (themeMode === "auto") {
        icon.setAttribute("icon", "mdi:theme-light-dark");
        (icon.parentElement as HTMLElement)?.setAttribute("title", "主题: 自动");
    } else if (themeMode === "light") {
        icon.setAttribute("icon", "mdi:white-balance-sunny");
        (icon.parentElement as HTMLElement)?.setAttribute("title", "主题: 浅色");
    } else {
        icon.setAttribute("icon", "mdi:moon-waning-crescent");
        (icon.parentElement as HTMLElement)?.setAttribute("title", "主题: 深色");
    }
}

// ============================================================

async function main() {
    updateSubtitleDate();
    window.setInterval(updateSubtitleDate, 1000);

    // Initialize theme
    setupThemeSync();
    $("btn-theme").addEventListener("click", cycleTheme);

    $("btn-refresh").addEventListener("click", () => refresh().catch(console.error));

    $("btn-scan-fans").addEventListener("click", () => {
        ($("scan-fans-dialog") as HTMLDialogElement).showModal();
        runHardwareScan().catch(console.error);
    });
    $("scan-close").addEventListener("click", () => ($("scan-fans-dialog") as HTMLDialogElement).close());
    $("scan-refresh").addEventListener("click", () => runHardwareScan().catch(console.error));
    $("scan-add-selected").addEventListener("click", () => addScannedFansFromSelection().catch(console.error));

    $("btn-global-save").addEventListener("click", async () => {
        config.global = readGlobalForm();
        try {
            await setGlobalConfig(config.global);
            toast("全局设置已保存", "success");
            await refresh();
        } catch (e) {
            console.error(e);
            toast(String(e), "error");
        }
    });

    $("btn-global-discard").addEventListener("click", () => {
        refresh().catch(console.error);
    });

    $("g-stop-beh").addEventListener("change", updateStopPWMRow);

    const fanDlg = $("fan-edit-dialog") as HTMLDialogElement;
    $("fe-close").addEventListener("click", () => fanDlg.close());
    $("fe-cancel").addEventListener("click", () => fanDlg.close());
    $("fe-save").addEventListener("click", async () => {
        syncCurveToConfig();
        const fan = readFanFormIntoConfig();
        if (!fan) return;
        try {
            await saveConfig(config);
            await setFanCurve(fan.id, fan.curve);
            fanDlg.close();
            editFanIdx = null;
            // 使用已更新的配置刷新风扇卡片
            syncFanCardsFromTelemetryOrRender();
            toast("已保存", "success");
        } catch (e) {
            console.error(e);
            toast(String(e), "error");
        }
    });
    fanDlg.addEventListener("close", () => {
        editFanIdx = null;
    });

    bindFanRoot();
    initHistoryChart();

    await refresh();

    // 3 秒轮询遥测数据（替代 WebSocket）
    const POLL_INTERVAL = 3000;
    let pollTimer: number | undefined;

    async function pollTelemetry() {
        try {
            const info = await fetchInfo();
            applyTelemetry(info);
            $("ws-text").textContent = "3s";
            ($("ws-text") as HTMLElement).className = "text-sky-400 text-sm font-mono";
        } catch {
            $("ws-text").textContent = "失败";
            ($("ws-text") as HTMLElement).className = "text-red-400 text-sm font-mono";
        }
    }

    pollTimer = window.setInterval(pollTelemetry, POLL_INTERVAL);

    // WebSocket 连接代码保留备用
    function connectWs() {
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const ws = new WebSocket(`${proto}//${window.location.host}/api/ws`);
        ws.addEventListener("open", () => {
            $("ws-text").textContent = "已连接";
            ($("ws-text") as HTMLElement).className = "text-sky-400 text-sm font-mono";
        });
        ws.addEventListener("message", ev => {
            try {
                applyTelemetry(JSON.parse(ev.data) as Telemetry);
            } catch {
                /* ignore */
            }
        });
        ws.addEventListener("close", () => {
            $("ws-text").textContent = "重连中…";
            ($("ws-text") as HTMLElement).className = "text-amber-400 text-sm font-mono";
            window.setTimeout(connectWs, 1500);
        });
    }
    // connectWs(); // 取消注释可切换为 WebSocket 模式
}

main().catch(err => {
    console.error(err);
    toast(`启动失败: ${err}`, "error");
});