export interface CurvePoint {
    temp: number;
    pwm: number;
}

/** GET /api/device/scan 单条结果（与后端 hwmon.ScanFans 字段一致） */
export interface ScannedFan {
    id: string;
    name: string;
    pwm_path: string;
    rpm_path: string;
    enable_path: string;
}

export interface FanConfig {
    id: string;
    name: string;
    pwm_path: string;
    rpm_path: string;
    enable_path: string;
    mode: "manual" | "curve";
    source: string;
    manual_pwm: number;
    curve: CurvePoint[];
    algorithm: "identity" | "standard" | "ema";
    alpha?: number;                // EMA 平滑因子 (0~1)
    temp_deviance?: number;        // Standard 温度变化阈值 (°C)
    response_delay_ms?: number;    // Standard 响应延迟 (ms)
}

export interface GlobalConfig {
    pwm_deadzone: number;
    update_interval_ms: number;
    emergency_temp: number;
    stop_behavior: "keep" | "set";
    stop_pwm: number;
    stop_hysteresis: number;
    log_level: string;
    max_step: number;
    min_hold_sec: number;
    temp_deviance: number;
    response_delay_ms: number;
}

export interface ConfigPayload {
    fans: FanConfig[];
    global: GlobalConfig;
}

export interface DiskInfo {
    name: string;
    temp?: number;
    status: "active" | "sleep";
}

export interface FanRuntime {
    id: string;
    name: string;
    pwm: number;
    rpm: number;
    status: "normal" | "stopped";
    source: string;
    mode: "manual" | "curve";
    target_pwm: number;
    algorithm: "identity" | "standard" | "ema";
}

export interface HistoryPoint {
    time: string;
    value?: number;
}

export interface FanHistoryPoint {
    time: string;
    rpm: number;
    pwm: number;
}

export interface Telemetry {
    cpu_temp?: number;
    cpu_usage: number;
    mem_usage: number;
    mem_total?: number;  // 内存总量（GB）
    gpu_temp?: number;
    disks: {
        avg_temp?: number;
        details: DiskInfo[];
    };
    fans: FanRuntime[];
    timestamp: string;
    uptime?: number;  // 系统运行时间（秒）
    history: {
        cpu_temp: HistoryPoint[];
        gpu_temp: HistoryPoint[];
        disk_avg: HistoryPoint[];
        fans: Record<string, FanHistoryPoint[]>;
    };
}
