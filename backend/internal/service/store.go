package service

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"

	"fancontrolserver/internal/model"
)

type Store struct {
	path     string
	mu       sync.RWMutex
	cfg      model.Config
	firstRun bool
}

func NewStore(path string) (*Store, error) {
	s := &Store{path: path}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) load() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}

	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		s.cfg = defaultConfig()
		s.firstRun = true
		return s.saveLocked()
	}
	if err != nil {
		return err
	}

	if err = json.Unmarshal(raw, &s.cfg); err != nil {
		return err
	}
	normalizeConfig(&s.cfg)
	return nil
}

func (s *Store) Get() model.Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cfg
}

func (s *Store) Save(cfg model.Config) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	normalizeConfig(&cfg)
	s.cfg = cfg
	if err := s.saveLocked(); err != nil {
		return err
	}
	s.firstRun = false
	return nil
}

func (s *Store) IsFirstRun() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.firstRun
}

func (s *Store) saveLocked() error {
	raw, err := json.MarshalIndent(s.cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, raw, 0o600)
}

func defaultConfig() model.Config {
	return model.Config{
		Fans: []model.FanConfig{},
		Global: model.GlobalConfig{
			PWMDeadzone:      5,
			StopHysteresis:   2,
			UpdateIntervalMS: 2000,
			EmergencyTemp:    80,
			StopBehavior:     model.StopBehaviorKeep,
			StopPWM:          200,
			MaxStep:          12,
			MinHoldSec:       10,
			TempDeviance:     2,
			ResponseDelayMs:  5000,
		},
	}
}

func normalizeConfig(cfg *model.Config) {
	if cfg.Global.UpdateIntervalMS <= 0 {
		cfg.Global.UpdateIntervalMS = 1500
	}
	if cfg.Global.EmergencyTemp <= 0 {
		cfg.Global.EmergencyTemp = 80
	}

	sort.Slice(cfg.Fans, func(i, j int) bool { return cfg.Fans[i].ID < cfg.Fans[j].ID })
	for i := range cfg.Fans {
		if cfg.Fans[i].Mode == "" {
			cfg.Fans[i].Mode = model.FanModeCurve
		}
		if cfg.Fans[i].Source == "" {
			cfg.Fans[i].Source = "cpu"
		}
		if cfg.Fans[i].Algorithm == "" {
			cfg.Fans[i].Algorithm = model.AlgorithmIdentity
		}
		sort.Slice(cfg.Fans[i].Curve, func(a, b int) bool {
			return cfg.Fans[i].Curve[a].Temp < cfg.Fans[i].Curve[b].Temp
		})
	}
}
