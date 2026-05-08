package main

import (
	"context"
	"embed"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"

	"fancontrolserver/internal/api"
	"fancontrolserver/internal/logging"
	"fancontrolserver/internal/service"
)

//go:embed web
var staticFS embed.FS

func resolveConfigPath() string {
	if cfgDir := os.Getenv("TRIM_PKGETC"); cfgDir != "" {
		return filepath.Join(cfgDir, "config.json")
	}
	return "config.json"
}

func listenAddr() string {
	bind := "127.0.0.1"
	if os.Getenv("external_access") == "true" {
		bind = "0.0.0.0"
	}
	port := os.Getenv("service_port")
	if port == "" {
		port = "19527"
	}
	return bind + ":" + port
}

func main() {
	logging.Init()
	gin.SetMode(gin.ReleaseMode)

	webFS, err := fs.Sub(staticFS, "web")
	if err != nil {
		logrus.Fatalf("获取嵌入的 web 子目录失败: %v", err)
	}

	cfgPath := resolveConfigPath()
	store, err := service.NewStore(cfgPath)
	if err != nil {
		logrus.Fatalf("[主程序] 加载配置失败：%v", err)
	}
	if store.Get().Global.LogLevel != "" {
		logging.SetLevel(store.Get().Global.LogLevel)
	}

	controller := service.NewController(store)
	if err = controller.Start(); err != nil {
		logrus.Fatalf("[主程序] 启动控制器失败：%v", err)
	}

	router := api.NewRouter(webFS, controller, store)
	addr := listenAddr()
	server := &http.Server{
		Addr:    addr,
		Handler: router,
	}

	go func() {
		logrus.Infof("[主程序] HTTP 服务已监听，地址：%s，配置文件：%q", addr, cfgPath)
		if err = server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logrus.Fatalf("[主程序] HTTP 服务异常退出：%v", err)
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	sig := <-sigCh
	logrus.Infof("[主程序] 收到信号 %s，开始优雅关机…", sig)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	controller.Stop()
	if err = server.Shutdown(ctx); err != nil {
		logrus.Warnf("[主程序] 关闭 HTTP 服务时出错：%v", err)
	}
	logrus.Info("[主程序] 已退出")
}
