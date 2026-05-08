package service

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/sirupsen/logrus"

	"fancontrolserver/internal/driver"
	"fancontrolserver/internal/model"
)

type Controller struct {
	store               *Store
	hwmon               *driver.HWMONDriver
	system              *driver.SystemDriver
	smartctl            *driver.SmartCtlDriver
	gpu                 *driver.GPUDriver
	mu                  sync.RWMutex
	telemetry           model.Telemetry
	history             model.HistorySeries
	lastPWM             map[string]int
	lastValidPWM        map[string]int          // 滞回区间保留的最后有效PWM
	lastAlgoTemp        map[string]float64      // 算法最后使用的温度（EMA平滑值/Standard最后应用温度）
	algoTempHistory     map[string][]float64    // Standard算法：温度历史缓冲区（最新在末尾）
	lastPWMSetTime      map[string]time.Time    // 最近一次写入PWM的时间（最小保持时间用）
	subs                map[chan model.Telemetry]struct{}
	stopCh              chan struct{}
	stopped             bool
	loopDoneCh          chan struct{}
	startTime           time.Time
	lastCPUHistoryTime  time.Time
	lastGPUHistoryTime  time.Time
	lastDiskHistoryTime time.Time
	lastFanHistoryTime  time.Time
}

func NewController(store *Store) *Controller {
	return &Controller{
		store:        store,
		hwmon:        driver.NewHWMONDriver(),
		system:       driver.NewSystemDriver(),
		smartctl:     driver.NewSmartCtlDriver(),
		gpu:          driver.NewGPUDriver(),
		lastPWM:      map[string]int{},
		lastValidPWM: map[string]int{},
		lastAlgoTemp: map[string]float64{},
		algoTempHistory: map[string][]float64{},
		lastPWMSetTime: map[string]time.Time{},
		subs:         map[chan model.Telemetry]struct{}{},
		stopCh:       make(chan struct{}),
		loopDoneCh:   make(chan struct{}),
		startTime:    time.Now(),
		history: model.HistorySeries{
			CPUTemp: []model.HistoryPoint{},
			GPUTemp: []model.HistoryPoint{},
			DiskAvg: []model.HistoryPoint{},
			Fans:    map[string][]model.FanHistoryPoint{},
		},
	}
}

func (c *Controller) Start() error {
	c.autoDiscoverFansOnFirstRun()
	go c.loop()
	return nil
}

func (c *Controller) Stop() {
	c.mu.Lock()
	if c.stopped {
		c.mu.Unlock()
		return
	}
	c.stopped = true
	close(c.stopCh)
	c.mu.Unlock()

	<-c.loopDoneCh
	c.applyStopBehavior()
}

func (c *Controller) Telemetry() model.Telemetry {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.telemetry
}

func (c *Controller) Subscribe() chan model.Telemetry {
	ch := make(chan model.Telemetry, 4)
	c.mu.Lock()
	c.subs[ch] = struct{}{}
	c.mu.Unlock()
	return ch
}

func (c *Controller) Unsubscribe(ch chan model.Telemetry) {
	c.mu.Lock()
	delete(c.subs, ch)
	close(ch)
	c.mu.Unlock()
}

func (c *Controller) loop() {
	defer close(c.loopDoneCh)
	for {
		cfg := c.store.Get()
		t := c.collectAndApply(cfg)
		c.mu.Lock()
		t.History = c.history
		c.telemetry = t
		for sub := range c.subs {
			select {
			case sub <- t:
			default:
			}
		}
		c.mu.Unlock()

		wait := time.Duration(cfg.Global.UpdateIntervalMS) * time.Millisecond
		select {
		case <-time.After(wait):
		case <-c.stopCh:
			return
		}
	}
}

func (c *Controller) collectAndApply(cfg model.Config) model.Telemetry {
	now := time.Now()
	cpuTemp, _ := c.system.CPUTemp()
	cpuUsage, _ := c.system.CPUUsage()
	memUsage, _ := c.system.MemUsage()
	memTotal, _ := c.system.MemTotal()
	gpuTemp, _ := c.gpu.Temp()
	logrus.Debugf("[温度] CPU=%.1f°C GPU=%.1f°C", ptrOrNil(cpuTemp), ptrOrNil(gpuTemp))

	// 计算系统运行时间（秒）
	uptime := int64(now.Sub(c.startTime).Seconds())

	disks := c.readDisks()
	fans := make([]model.FanRuntime, 0, len(cfg.Fans))
	for _, fan := range cfg.Fans {
		target, controlTemp := c.calculateTargetPWM(fan, cfg.Global, cpuTemp, gpuTemp, disks)
		applied := c.applyPWM(fan, cfg.Global, target)
		rpm := 0
		if fan.RPMPath != "" {
			if value, err := c.hwmon.ReadRPM(fan.RPMPath); err == nil {
				rpm = value
			}
		}
		status := evaluateFanStatus(rpm)
		fans = append(fans, model.FanRuntime{
			ID:        fan.ID,
			Name:      fan.Name,
			PWM:       applied,
			RPM:       rpm,
			Status:    status,
			Source:    fan.Source,
			Mode:      fan.Mode,
			TargetPWM: target,
			Algorithm: fan.Algorithm,
		})
		//  前端尚未展示风扇历史图表，暂时禁用采集以减少开销
		// c.pushFanHistory(fan.ID, now, rpm, applied)
		_ = controlTemp
	}

	c.pushTempHistory(&c.history.CPUTemp, &c.lastCPUHistoryTime, now, cpuTemp)
	c.pushTempHistory(&c.history.GPUTemp, &c.lastGPUHistoryTime, now, gpuTemp)
	c.pushTempHistory(&c.history.DiskAvg, &c.lastDiskHistoryTime, now, disks.AvgTemp)

	//  与 pushFanHistory 配套，前端实现后取消注释
	// if now.Sub(c.lastFanHistoryTime) >= time.Minute {
	// 	c.lastFanHistoryTime = now
	// }

	return model.Telemetry{
		CPUTemp:   cpuTemp,
		CPUUsage:  round(cpuUsage),
		MemUsage:  round(memUsage),
		MemTotal:  memTotal,
		GPUTemp:   gpuTemp,
		Uptime:    uptime,
		Disks:     disks,
		Fans:      fans,
		Timestamp: now,
		History:   c.history,
	}
}

func (c *Controller) readDisks() model.DiskPayload {
	names, err := c.smartctl.ScanDisks()
	if err != nil {
		logrus.Debugf("[磁盘] 扫描磁盘失败: %v", err)
		return model.DiskPayload{}
	}
	details := make([]model.DiskInfo, 0, len(names))
	var sum float64
	var count int
	for _, name := range names {
		info := c.smartctl.ReadDisk(name)
		details = append(details, info)
		if info.Status == model.DiskStatusActive && info.Temp != nil {
			sum += *info.Temp
			count++
		}
	}
	var avg *float64
	if count > 0 {
		v := round(sum / float64(count))
		avg = &v
		logrus.Debugf("[磁盘] 发现%d个活跃磁盘，平均温度%.1f°C", count, *avg)
	}
	return model.DiskPayload{AvgTemp: avg, Details: details}
}

func (c *Controller) calculateTargetPWM(fan model.FanConfig, global model.GlobalConfig, cpuTemp, gpuTemp *float64, disks model.DiskPayload) (int, *float64) {
	// 不论手动/自动模式，都先解析温度并应用算法平滑，保持算法状态连贯
	temp := c.resolveSourceTemp(fan.Source, cpuTemp, gpuTemp, disks)

	// 温度有效性过滤：传感器异常（<5°C或>110°C）时视为无效
	if temp != nil && (*temp < 5 || *temp > 110) {
		logrus.Warnf("[控制器] 风扇 %s 温度%.1f°C 超出有效范围(5~110°C)，忽略此周期", fan.Name, *temp)
		temp = nil
	}

	var smoothedTemp float64
	if temp != nil {
		algo := GetAlgorithm(fan.Algorithm)

		// 构建温度历史缓冲（Standard 算法需要）
		historyBufSize := 0
		if global.ResponseDelayMs > 0 && global.UpdateIntervalMS > 0 {
			historyBufSize = (global.ResponseDelayMs + global.UpdateIntervalMS - 1) / global.UpdateIntervalMS
		}
		if historyBufSize > 0 {
			c.algoTempHistory[fan.ID] = append(c.algoTempHistory[fan.ID], *temp)
			if len(c.algoTempHistory[fan.ID]) > historyBufSize {
				c.algoTempHistory[fan.ID] = c.algoTempHistory[fan.ID][len(c.algoTempHistory[fan.ID])-historyBufSize:]
			}
		}

		input := TempFilterInput{
			RawTemp:         *temp,
			LastAppliedTemp: c.lastAlgoTemp[fan.ID],
			TempHistory:     c.algoTempHistory[fan.ID],
			Deviance:        global.TempDeviance,
		}
		smoothedTemp = algo.FilterTemp(input)
		c.lastAlgoTemp[fan.ID] = smoothedTemp
	}

	// 紧急温度保护（使用平滑后的温度判断）
	if temp != nil && smoothedTemp >= global.EmergencyTemp {
		logrus.Warnf("[控制器] 风扇 %s 平滑温度%.1f°C ≥ 紧急温度%.1f°C，全速!", fan.Name, smoothedTemp, global.EmergencyTemp)
		return 255, temp
	}

	if fan.Mode == model.FanModeManual {
		logrus.Debugf("[控制器] 风扇 %s 手动模式 PWM=%d | 平滑温度=%.1f°C", fan.Name, fan.ManualPWM, smoothedTemp)
		return clampPWM(fan.ManualPWM), nil
	}

	if temp == nil {
		logrus.Warnf("[控制器] 风扇 %s 无法获取温度(源=%s)，跳过", fan.Name, fan.Source)
		return 0, nil
	}

	// 用平滑后的温度查曲线
	basePWM := interpolateCurve(fan.Curve, smoothedTemp)

	// 边界滞回：在曲线分界点附近做滞回，防止温度临界时PWM频繁跳变
	curPWM := c.lastPWM[fan.ID]
	pwmAfterHysteresis := c.applyBoundaryHysteresis(fan.ID, fan.Curve, *temp, basePWM, curPWM, global.StopHysteresis)

	// 停转滞回：温度低于曲线首点时防止频繁启停
	pwm := c.applyStopHysteresis(fan.ID, fan.Curve, *temp, pwmAfterHysteresis, global.StopHysteresis)

	logrus.Debugf("[控制器] 风扇 %s | 原始温度=%.1f°C | 平滑温度=%.1f°C | 算法=%s | 曲线PWM=%d | 边界滞回=%d | 最终PWM=%d",
		fan.Name, *temp, smoothedTemp, fan.Algorithm, basePWM, pwmAfterHysteresis, pwm)
	return clampPWM(pwm), temp
}

// applyBoundaryHysteresis 曲线分界点滞回逻辑
// 在曲线各点的温度附近（±hysteresis）保持当前PWM，
// 防止温度在曲线分界点附近徘徊时PWM频繁跳变
func (c *Controller) applyBoundaryHysteresis(fanID string, curve []model.CurvePoint, temp float64, targetPWM, currentPWM int, hysteresis float64) int {
	if len(curve) < 2 || hysteresis <= 0 || targetPWM == currentPWM {
		return targetPWM
	}

	// 获取当前实际PWM
	c.mu.RLock()
	actualPWM, exists := c.lastPWM[fanID]
	c.mu.RUnlock()
	if !exists {
		actualPWM = currentPWM
	}

	if targetPWM > actualPWM {
		// 温度上升：检查每个曲线点，如果正在跨越某个点且温度未超过该点+hysteresis，保持当前值
		for _, pt := range curve {
			if pt.Temp <= temp && temp < pt.Temp+hysteresis {
				logrus.Debugf("[边界滞回] 上升: 温度%.1f°C在边界%.1f°C~%.1f°C，保持PWM=%d",
					temp, pt.Temp, pt.Temp+hysteresis, actualPWM)
				return actualPWM
			}
		}
	} else {
		// 温度下降：如果正在跨越某个点且温度未低于该点-hysteresis，保持当前值
		for _, pt := range curve {
			if pt.Temp-hysteresis < temp && temp <= pt.Temp {
				logrus.Debugf("[边界滞回] 下降: 温度%.1f°C在边界%.1f°C~%.1f°C，保持PWM=%d",
					temp, pt.Temp-hysteresis, pt.Temp, actualPWM)
				return actualPWM
			}
		}
	}

	return targetPWM
}

// applyStopHysteresis 滞回停转逻辑
// 启动温度：曲线首点温度
// 停止温度：曲线首点温度 - 滞回值
// 滞回区间内保持最后有效 PWM
func (c *Controller) applyStopHysteresis(fanID string, curve []model.CurvePoint, temp float64, basePWM int, hysteresis float64) int {
	if len(curve) == 0 || hysteresis <= 0 {
		return basePWM
	}

	firstTemp := curve[0].Temp
	stopThreshold := firstTemp - hysteresis

	// 温度低于停止阈值
	if temp < stopThreshold {
		// 风扇正在转动 -> 记录当前PWM为最后有效值，然后停转
		c.mu.Lock()
		if basePWM > 0 {
			c.lastValidPWM[fanID] = basePWM
		}
		c.mu.Unlock()
		logrus.Debugf("[滞回] 温度%.1f°C < 停转阈值%.1f°C，停转", temp, stopThreshold)
		return 0
	}

	// 温度在滞回区间（stopThreshold <= temp < firstTemp）
	if temp < firstTemp && basePWM == 0 {
		// 风扇已停转，滞回区间内保持停转
		logrus.Debugf("[滞回] 温度%.1f°C 在滞回区间[%.1f~%.1f]，保持停转", temp, stopThreshold, firstTemp)
		return 0
	}

	// 温度在滞回区间内，但曲线计算值非0
	if temp < firstTemp {
		// 返回最后有效 PWM（防止启停）
		c.mu.Lock()
		if lastValid, ok := c.lastValidPWM[fanID]; ok && lastValid > 0 {
			c.mu.Unlock()
			logrus.Debugf("[滞回] 温度%.1f°C 在滞回区间，保留最后有效PWM=%d", temp, lastValid)
			return lastValid
		}
		c.mu.Unlock()
		return basePWM
	}

	// 温度 >= 首点温度，正常按曲线计算
	c.mu.Lock()
	if basePWM > 0 {
		c.lastValidPWM[fanID] = basePWM
	}
	c.mu.Unlock()
	return basePWM
}

func (c *Controller) resolveSourceTemp(source string, cpuTemp, gpuTemp *float64, disks model.DiskPayload) *float64 {
	switch {
	case source == "cpu":
		return cpuTemp
	case source == "gpu":
		return gpuTemp
	case source == "disk_avg":
		return disks.AvgTemp
	case source == "max":
		var values []float64
		for _, v := range []*float64{cpuTemp, gpuTemp, disks.AvgTemp} {
			if v != nil {
				values = append(values, *v)
			}
		}
		for _, disk := range disks.Details {
			if disk.Temp != nil {
				values = append(values, *disk.Temp)
			}
		}
		if len(values) == 0 {
			return nil
		}
		sort.Float64s(values)
		v := values[len(values)-1]
		return &v
	case len(source) > 5 && source[:5] == "disk:":
		name := source[5:]
		for _, disk := range disks.Details {
			if disk.Name == name && disk.Status == model.DiskStatusActive && disk.Temp != nil {
				v := *disk.Temp
				return &v
			}
		}
	}
	return nil
}

func (c *Controller) applyPWM(fan model.FanConfig, global model.GlobalConfig, target int) int {
	target = clampPWM(target)

	// 获取真实当前 PWM（从缓存或硬件读取）
	current, ok := c.lastPWM[fan.ID]
	if !ok {
		// 首次：从硬件读取
		if val, err := c.hwmon.ReadPWM(fan.PWMPath); err == nil {
			current = val
		} else {
			current = 0 // 读取失败时保守设为0
		}
		c.lastPWM[fan.ID] = current
	}

	// 最小保持时间：距离上次写入不足指定秒数则不调整
	if global.MinHoldSec > 0 {
		c.mu.RLock()
		lastSet, exists := c.lastPWMSetTime[fan.ID]
		c.mu.RUnlock()
		if exists && time.Since(lastSet).Seconds() < float64(global.MinHoldSec) {
			return current
		}
	}

	// 速率限制：单次变化不超过 MaxStep
	if global.MaxStep > 0 {
		delta := target - current
		if delta > global.MaxStep {
			target = current + global.MaxStep
		} else if delta < -global.MaxStep {
			target = current - global.MaxStep
		}
	}

	if abs(target-current) < global.PWMDeadzone {
		return current
	}

	// 写入硬件
	if err := c.hwmon.WritePWM(fan.EnablePath, fan.PWMPath, target); err != nil {
		logrus.Warnf("[PWM] 风扇 %s 写入失败: %v", fan.ID, err)
		return current
	}

	// 更新缓存
	c.lastPWM[fan.ID] = target
	c.mu.Lock()
	c.lastPWMSetTime[fan.ID] = time.Now()
	c.mu.Unlock()
	logrus.Infof("[PWM] 风扇 %s: PWM %d(%d%%) → %d(%d%%)", fan.Name, current, current*100/255, target, target*100/255)
	return target
}

func (c *Controller) applyStopBehavior() {
	cfg := c.store.Get()
	if cfg.Global.StopBehavior != model.StopBehaviorSet {
		logrus.Info("[控制器] 退出行为：保持当前 PWM")
		return
	}
	targetPWM := clampPWM(cfg.Global.StopPWM)
	logrus.Infof("[控制器] 退出行为：将所有风扇设为 PWM=%d", targetPWM)
	for _, fan := range cfg.Fans {
		if err := c.hwmon.WritePWM(fan.EnablePath, fan.PWMPath, targetPWM); err != nil {
			logrus.Warnf("[控制器] 退出写入 PWM 失败，风扇 %s（%s）：%v", fan.Name, fan.ID, err)
		} else {
			logrus.Infof("[控制器] 退出写入成功，风扇 %s → PWM=%d", fan.Name, targetPWM)
		}
	}
}

func (c *Controller) SaveConfig(cfg model.Config) error {
	return c.store.Save(cfg)
}

func (c *Controller) SetFanMode(id string, mode model.FanMode) error {
	cfg := c.store.Get()
	for i := range cfg.Fans {
		if cfg.Fans[i].ID == id {
			cfg.Fans[i].Mode = mode
			if mode == model.FanModeManual {
				// 切换到手动模式时，立即写入当前手动 PWM 值
				fan := cfg.Fans[i]
				if err := c.hwmon.WritePWM(fan.EnablePath, fan.PWMPath, fan.ManualPWM); err != nil {
					logrus.Warnf("[切换模式] 风扇 %s 手动模式写入失败: %v", fan.ID, err)
				} else {
					c.lastPWM[fan.ID] = fan.ManualPWM
					c.mu.Lock()
					c.lastPWMSetTime[fan.ID] = time.Now()
					c.mu.Unlock()
					logrus.Infof("[切换模式] 风扇 %s → 手动 PWM=%d", fan.Name, fan.ManualPWM)
				}
			}
			return c.store.Save(cfg)
		}
	}
	return errors.New("未找到指定风扇")
}

func (c *Controller) SetFanSource(id, source string) error {
	cfg := c.store.Get()
	for i := range cfg.Fans {
		if cfg.Fans[i].ID == id {
			cfg.Fans[i].Source = source
			return c.store.Save(cfg)
		}
	}
	return errors.New("未找到指定风扇")
}

func (c *Controller) SetFanAlgorithm(id string, algo model.AlgorithmType) error {
	cfg := c.store.Get()
	for i := range cfg.Fans {
		if cfg.Fans[i].ID == id {
			cfg.Fans[i].Algorithm = algo
			// 切换算法时重置该风扇的温度状态
			c.mu.Lock()
			delete(c.lastAlgoTemp, id)
			delete(c.algoTempHistory, id)
			c.mu.Unlock()
			return c.store.Save(cfg)
		}
	}
	return errors.New("未找到指定风扇")
}

func (c *Controller) SetFanManualPWM(id string, pwm int) error {
	cfg := c.store.Get()
	for i := range cfg.Fans {
		if cfg.Fans[i].ID == id {
			cfg.Fans[i].ManualPWM = clampPWM(pwm)
			cfg.Fans[i].Mode = model.FanModeManual
			// 立即写入硬件，不等待控制器循环（绕过限速）
			fan := cfg.Fans[i]
			if err := c.hwmon.WritePWM(fan.EnablePath, fan.PWMPath, fan.ManualPWM); err != nil {
				logrus.Warnf("[手动PWM] 风扇 %s 直接写入失败: %v", fan.ID, err)
			} else {
				c.lastPWM[fan.ID] = fan.ManualPWM
				c.mu.Lock()
				c.lastPWMSetTime[fan.ID] = time.Now()
				c.mu.Unlock()
				logrus.Infof("[手动PWM] 风扇 %s → PWM=%d", fan.Name, fan.ManualPWM)
			}
			return c.store.Save(cfg)
		}
	}
	return errors.New("未找到指定风扇")
}

func (c *Controller) SetFanCurve(id string, curve []model.CurvePoint) error {
	cfg := c.store.Get()
	for i := range cfg.Fans {
		if cfg.Fans[i].ID == id {
			cfg.Fans[i].Curve = curve
			cfg.Fans[i].Mode = model.FanModeCurve
			return c.store.Save(cfg)
		}
	}
	return errors.New("未找到指定风扇")
}

// RemoveFan 从配置中移除指定风扇，并清理该风扇的历史曲线缓存。
func (c *Controller) RemoveFan(id string) error {
	cfg := c.store.Get()
	newFans := make([]model.FanConfig, 0, len(cfg.Fans))
	found := false
	for _, f := range cfg.Fans {
		if f.ID != id {
			newFans = append(newFans, f)
		} else {
			found = true
		}
	}
	if !found {
		return errors.New("未找到指定风扇")
	}
	cfg.Fans = newFans
	if err := c.store.Save(cfg); err != nil {
		return err
	}
	c.mu.Lock()
	delete(c.history.Fans, id)
	delete(c.lastPWM, id)
	delete(c.lastValidPWM, id)
	delete(c.lastAlgoTemp, id)
	delete(c.algoTempHistory, id)
	delete(c.lastPWMSetTime, id)
	c.mu.Unlock()
	return nil
}

func (c *Controller) ScanFans() ([]map[string]string, error) {
	return c.hwmon.ScanFans()
}

func (c *Controller) autoDiscoverFansOnFirstRun() {
	if !c.store.IsFirstRun() {
		return
	}

	cfg := c.store.Get()
	if len(cfg.Fans) > 0 {
		return
	}

	scanned, err := c.ScanFans()
	if err != nil {
		logrus.Warnf("[controller] first-run fan scan failed: %v", err)
		return
	}
	if len(scanned) == 0 {
		logrus.Infof("[controller] first-run fan scan found no PWM channels")
		return
	}

	cfg.Fans = make([]model.FanConfig, 0, len(scanned))
	for i, item := range scanned {
		id := strings.TrimSpace(item["id"])
		if id == "" {
			id = fmt.Sprintf("fan%d", i+1)
		}

		name := strings.TrimSpace(item["name"])
		if name == "" {
			name = fmt.Sprintf("Fan %d", i+1)
		}

		cfg.Fans = append(cfg.Fans, model.FanConfig{
			ID:         id,
			Name:       name,
			PWMPath:    strings.TrimSpace(item["pwm_path"]),
			RPMPath:    strings.TrimSpace(item["rpm_path"]),
			EnablePath: strings.TrimSpace(item["enable_path"]),
			Mode:       model.FanModeCurve,
			Source:     "cpu",
			Curve: []model.CurvePoint{
				{Temp: 35, PWM: 80},
				{Temp: 55, PWM: 140},
				{Temp: 75, PWM: 200},
				{Temp: 100, PWM: 255},
			},
		})
	}

	if err = c.store.Save(cfg); err != nil {
		logrus.Warnf("[controller] save auto-discovered fans failed: %v", err)
		return
	}
	logrus.Infof("[controller] first-run auto-discovered %d fan(s)", len(cfg.Fans))
}

func (c *Controller) pushTempHistory(dst *[]model.HistoryPoint, lastTime *time.Time, now time.Time, value *float64) {
	// 每1分钟记录一次历史数据
	if now.Sub(*lastTime) < time.Minute {
		return
	}
	*lastTime = now
	*dst = append(*dst, model.HistoryPoint{Time: now.Format("15:04"), Value: value})
	if len(*dst) > 60 {
		*dst = (*dst)[len(*dst)-60:]
	}
}

func (c *Controller) pushFanHistory(id string, now time.Time, rpm, pwm int) {
	if now.Sub(c.lastFanHistoryTime) < time.Minute {
		return
	}
	series := append(c.history.Fans[id], model.FanHistoryPoint{Time: now.Format("15:04"), RPM: rpm, PWM: pwm})
	if len(series) > 60 {
		series = series[len(series)-60:]
	}
	c.history.Fans[id] = series
}

func evaluateFanStatus(rpm int) model.FanStatus {
	if rpm == 0 {
		return model.FanStatusStopped
	}
	return model.FanStatusNormal
}

func interpolateCurve(points []model.CurvePoint, temp float64) int {
	if len(points) == 0 {
		return 0
	}
	if temp < points[0].Temp {
		logrus.Debugf("[曲线] 温度%.1f°C < 首点%.1f°C，停转", temp, points[0].Temp)
		return 0
	}
	for i := 1; i < len(points); i++ {
		if temp <= points[i].Temp {
			prev := points[i-1]
			next := points[i]
			ratio := (temp - prev.Temp) / (next.Temp - prev.Temp)
			result := int(math.Round(float64(prev.PWM) + ratio*float64(next.PWM-prev.PWM)))
			logrus.Debugf("[曲线] %.1f°C → [%d%%, %d%%] 插值 → PWM=%d", temp, prev.PWM, next.PWM, result)
			return result
		}
	}
	result := points[len(points)-1].PWM
	return result
}

func clampPWM(v int) int {
	return maxInt(0, minInt(255, v))
}

func round(v float64) float64 {
	return math.Round(v*10) / 10
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

// ptrOrNil 安全获取指针值
func ptrOrNil(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}
