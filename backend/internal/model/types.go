package model

import "time"

type FanMode string

const (
	FanModeManual FanMode = "manual"
	FanModeCurve  FanMode = "curve"
)

type AlgorithmType string

const (
	AlgorithmIdentity  AlgorithmType = "identity"
	AlgorithmStandard AlgorithmType = "standard"
	AlgorithmEMA      AlgorithmType = "ema"
)

type FanStatus string

const (
	FanStatusNormal  FanStatus = "normal"
	FanStatusStopped FanStatus = "stopped"
)

type DiskStatus string

const (
	DiskStatusActive DiskStatus = "active"
	DiskStatusSleep  DiskStatus = "sleep"
)

type StopBehavior string

const (
	StopBehaviorKeep StopBehavior = "keep"
	StopBehaviorSet  StopBehavior = "set"
)

type CurvePoint struct {
	Temp float64 `json:"temp"`
	PWM  int     `json:"pwm"`
}

type FanConfig struct {
	ID             string        `json:"id"`
	Name           string        `json:"name"`
	PWMPath        string        `json:"pwm_path"`
	RPMPath        string        `json:"rpm_path"`
	EnablePath     string        `json:"enable_path"`
	Mode           FanMode       `json:"mode"`
	Source         string        `json:"source"`
	ManualPWM      int           `json:"manual_pwm"`
	Curve          []CurvePoint  `json:"curve"`
	Algorithm      AlgorithmType `json:"algorithm"`
	Alpha          float64       `json:"alpha,omitempty"`           // EMA 平滑因子 (0~1)，默认 0.25
	TempDeviance   float64       `json:"temp_deviance,omitempty"`   // Standard 温度变化阈值 (°C)，默认取全局
	ResponseDelayMs int          `json:"response_delay_ms,omitempty"` // Standard 响应延迟 (ms)，默认取全局
}

type GlobalConfig struct {
	PWMDeadzone      int          `json:"pwm_deadzone"`
	UpdateIntervalMS int          `json:"update_interval_ms"`
	EmergencyTemp    float64      `json:"emergency_temp"`
	StopBehavior     StopBehavior `json:"stop_behavior"`
	StopPWM          int          `json:"stop_pwm"`
	StopHysteresis   float64      `json:"stop_hysteresis"` // 停转滞回温度（°C）
	LogLevel         string       `json:"log_level"`
	MaxStep          int          `json:"max_step"`          // 单次PWM最大变化步长（0=不限制）
	MinHoldSec       int          `json:"min_hold_sec"`      // PWM最小保持时间（秒，0=不限制）
	TempDeviance     float64      `json:"temp_deviance"`     // Standard算法：温度变化阈值（°C）
	ResponseDelayMs  int          `json:"response_delay_ms"` // Standard算法：响应延迟（毫秒）
}

type Config struct {
	Fans   []FanConfig  `json:"fans"`
	Global GlobalConfig `json:"global"`
}

type DiskInfo struct {
	Name   string     `json:"name"`
	Temp   *float64   `json:"temp,omitempty"`
	Status DiskStatus `json:"status"`
}

type DiskPayload struct {
	AvgTemp *float64   `json:"avg_temp,omitempty"`
	Details []DiskInfo `json:"details"`
}

type FanRuntime struct {
	ID        string        `json:"id"`
	Name      string        `json:"name"`
	PWM       int           `json:"pwm"`
	RPM       int           `json:"rpm"`
	Status    FanStatus     `json:"status"`
	Source    string        `json:"source"`
	Mode      FanMode       `json:"mode"`
	TargetPWM int           `json:"target_pwm"`
	Algorithm AlgorithmType `json:"algorithm"`
}

type Telemetry struct {
	CPUTemp   *float64      `json:"cpu_temp,omitempty"`
	CPUUsage  float64       `json:"cpu_usage"`
	MemUsage  float64       `json:"mem_usage"`
	MemTotal  *float64      `json:"mem_total,omitempty"`
	GPUTemp   *float64      `json:"gpu_temp,omitempty"`
	Uptime    int64         `json:"uptime"`
	Disks     DiskPayload   `json:"disks"`
	Fans      []FanRuntime  `json:"fans"`
	Timestamp time.Time     `json:"timestamp"`
	History   HistorySeries `json:"history"`
}

type HistoryPoint struct {
	Time  string   `json:"time"`
	Value *float64 `json:"value,omitempty"`
}

type FanHistoryPoint struct {
	Time string `json:"time"`
	RPM  int    `json:"rpm"`
	PWM  int    `json:"pwm"`
}

type HistorySeries struct {
	CPUTemp []HistoryPoint               `json:"cpu_temp"`
	GPUTemp []HistoryPoint               `json:"gpu_temp"`
	DiskAvg []HistoryPoint               `json:"disk_avg"`
	Fans    map[string][]FanHistoryPoint `json:"fans"`
}
