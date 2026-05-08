package service

import (
	"math"

	"fancontrolserver/internal/model"
)

// TempFilterInput 算法处理的输入上下文
type TempFilterInput struct {
	RawTemp         float64   // 本次原始温度
	LastAppliedTemp float64   // 上次实际使用的温度（导致PWM变化的那次）
	TempHistory     []float64 // 最近N个周期的原始温度（最新在末尾）
	Deviance        float64   // 温度变化阈值（°C）
}

// FanAlgorithm 风扇温度算法接口
type FanAlgorithm interface {
	// FilterTemp 对原始温度做处理，返回用于查曲线的温度
	FilterTemp(input TempFilterInput) float64
}

// ---- Identity：直通，不做任何处理 ---- //

type IdentityAlgorithm struct{}

func (s *IdentityAlgorithm) FilterTemp(input TempFilterInput) float64 {
	return input.RawTemp
}

// ---- Standard：CoolerControl 风格 ----
// 当所有历史温度都在 lastAppliedTemp ± deviance 内时保持当前PWM不变，
// 否则用最早超出范围的那个温度

type StandardAlgorithm struct{}

func (s *StandardAlgorithm) FilterTemp(input TempFilterInput) float64 {
	if input.Deviance <= 0 || len(input.TempHistory) == 0 {
		return input.RawTemp
	}

	// 检查所有历史温度是否在 lastAppliedTemp ± deviance 范围内
	allWithin := true
	for _, t := range input.TempHistory {
		if math.Abs(t-input.LastAppliedTemp) > input.Deviance {
			allWithin = false
			break
		}
	}

	if allWithin {
		// 温度波动在允许范围内，保持上次应用的温度
		return input.LastAppliedTemp
	}

	// 有温度超出范围，用最早超出范围的那个
	outlierIdx := -1
	for i, t := range input.TempHistory {
		if math.Abs(t-input.LastAppliedTemp) > input.Deviance {
			outlierIdx = i
			break
		}
	}
	if outlierIdx >= 0 && outlierIdx < len(input.TempHistory) {
		return input.TempHistory[outlierIdx]
	}
	return input.RawTemp
}

// ---- EMA：指数移动平均 ---- //

type EMAAlgorithm struct {
	Alpha float64 // 平滑因子，0<Alpha≤1，越小越平滑；默认 0.25
}

func NewEMAAlgorithm(alpha float64) *EMAAlgorithm {
	if alpha <= 0 {
		alpha = 0.25
	}
	if alpha > 1 {
		alpha = 1
	}
	return &EMAAlgorithm{Alpha: alpha}
}

func (e *EMAAlgorithm) FilterTemp(input TempFilterInput) float64 {
	return e.Alpha*input.RawTemp + (1-e.Alpha)*input.LastAppliedTemp
}

// AlgorithmParams 逐风扇算法参数
type AlgorithmParams struct {
	Alpha          float64 // EMA 平滑因子 (0~1)
	TempDeviance   float64 // Standard 温度变化阈值 (°C)
	ResponseDelayMs int    // Standard 响应延迟 (ms)
}

// GetAlgorithm 根据算法类型和参数返回对应的算法实例
func GetAlgorithm(algoType model.AlgorithmType, params AlgorithmParams) FanAlgorithm {
	switch algoType {
	case model.AlgorithmStandard:
		return &StandardAlgorithm{}
	case model.AlgorithmEMA:
		alpha := params.Alpha
		if alpha <= 0 {
			alpha = 0.25
		}
		if alpha > 1 {
			alpha = 1
		}
		return &EMAAlgorithm{Alpha: alpha}
	default:
		return &IdentityAlgorithm{}
	}
}

