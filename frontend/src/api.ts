import axios from "axios";
import type {ConfigPayload, CurvePoint, GlobalConfig, ScannedFan, Telemetry} from "./types";

/** 自动检测当前路径是否包含 index.cgi，构造正确的 API 基础路径 */
function getAPIBase(): string {
    try {
        let basePath = "/";
        if (typeof import.meta !== 'undefined' && import.meta.url) {
            try {
                basePath = new URL('.', import.meta.url).pathname;
            } catch (e) {
                basePath = window.location.pathname || '/';
            }
        } else {
            basePath = window.location.pathname || '/';
        }
        // 如果路径中包含 index.cgi，确保保留到 index.cgi/ 前缀
        const idx = basePath.indexOf('index.cgi');
        if (idx >= 0) {
            return basePath.slice(0, idx + 'index.cgi'.length) + '/';
        }
        if (!basePath.endsWith('/')) {
            const last = basePath.lastIndexOf('/');
            basePath = last >= 0 ? basePath.slice(0, last + 1) : '/';
        }
        return basePath;
    } catch (e) {
        return '/';
    }
}

const API_BASE = getAPIBase();

const client = axios.create({
    baseURL: API_BASE
});

export async function fetchScanFans() {
    const {data} = await client.get<{ fans: ScannedFan[] | null }>("api/device/scan");
    return data.fans ?? [];
}

export async function fetchInfo() {
    const {data} = await client.get<Telemetry>("api/device/info");
    return data;
}

export async function fetchConfig() {
    const {data} = await client.get<ConfigPayload>("api/fan/config");
    return data;
}

export async function saveConfig(payload: ConfigPayload) {
    await client.post("api/fan/config", payload);
}

export async function setFanMode(id: string, mode: "manual" | "curve") {
    await client.post("api/fan/mode", {id, mode});
}

export async function setFanSource(id: string, source: string) {
    await client.post("api/fan/source", {id, source});
}

export async function setFanAlgorithm(id: string, algorithm: "identity" | "standard" | "ema") {
    await client.post("api/fan/algorithm", {id, algorithm});
}

export async function setFanManualPWM(id: string, pwm: number) {
    await client.post("api/fan/set", {id, pwm});
}

export async function setFanCurve(id: string, curve: CurvePoint[]) {
    await client.post("api/fan/curve", {id, curve});
}

export async function removeFan(id: string) {
    await client.post("api/fan/remove", {id});
}

export async function setGlobalConfig(payload: GlobalConfig) {
    await client.post("api/global/config", payload);
}
