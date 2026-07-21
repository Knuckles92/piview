package instance

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Info struct {
	PID    int    `json:"pid"`
	UIAddr string `json:"uiAddr"`
	WSURL  string `json:"wsUrl"`
}

func runtimeDir() string {
	if d := os.Getenv("XDG_RUNTIME_DIR"); d != "" {
		return filepath.Join(d, "piview")
	}
	return filepath.Join(os.TempDir(), "piview")
}

func paths() (lockPath, sockPath string) {
	dir := runtimeDir()
	_ = os.MkdirAll(dir, 0o700)
	return filepath.Join(dir, "instance.json"), filepath.Join(dir, "control.sock")
}

func Write(info Info) error {
	lockPath, _ := paths()
	data, err := json.Marshal(info)
	if err != nil {
		return err
	}
	return os.WriteFile(lockPath, data, 0o600)
}

func Read() (*Info, error) {
	lockPath, _ := paths()
	data, err := os.ReadFile(lockPath)
	if err != nil {
		return nil, err
	}
	var info Info
	if err := json.Unmarshal(data, &info); err != nil {
		return nil, err
	}
	return &info, nil
}

func Clear() {
	lockPath, sockPath := paths()
	_ = os.Remove(lockPath)
	_ = os.Remove(sockPath)
}

type ControlServer struct {
	ln net.Listener
}

func StartControl(onFocus func(wsURL string), onQuit func()) (*ControlServer, error) {
	_, sockPath := paths()
	_ = os.Remove(sockPath)
	ln, err := net.Listen("unix", sockPath)
	if err != nil {
		return nil, err
	}
	cs := &ControlServer{ln: ln}
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go handleControl(conn, onFocus, onQuit)
		}
	}()
	return cs, nil
}

func (c *ControlServer) Close() {
	if c != nil && c.ln != nil {
		_ = c.ln.Close()
	}
	_, sockPath := paths()
	_ = os.Remove(sockPath)
}

func handleControl(conn net.Conn, onFocus func(string), onQuit func()) {
	defer conn.Close()
	buf := make([]byte, 4096)
	n, err := conn.Read(buf)
	if err != nil || n == 0 {
		return
	}
	line := strings.TrimSpace(string(buf[:n]))
	parts := strings.SplitN(line, " ", 2)
	cmd := parts[0]
	arg := ""
	if len(parts) > 1 {
		arg = parts[1]
	}
	switch cmd {
	case "focus":
		if onFocus != nil {
			onFocus(arg)
		}
		_, _ = conn.Write([]byte("ok\n"))
	case "quit":
		_, _ = conn.Write([]byte("ok\n"))
		if onQuit != nil {
			onQuit()
		}
	case "ping":
		_, _ = conn.Write([]byte("pong\n"))
	default:
		_, _ = conn.Write([]byte("err unknown\n"))
	}
}

func SendControl(cmd string, arg string) error {
	_, sockPath := paths()
	conn, err := net.DialTimeout("unix", sockPath, 500*time.Millisecond)
	if err != nil {
		return err
	}
	defer conn.Close()
	msg := cmd
	if arg != "" {
		msg += " " + arg
	}
	msg += "\n"
	if _, err := conn.Write([]byte(msg)); err != nil {
		return err
	}
	_ = conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	buf := make([]byte, 64)
	n, _ := conn.Read(buf)
	if n > 0 && (strings.HasPrefix(string(buf[:n]), "ok") || strings.HasPrefix(string(buf[:n]), "pong")) {
		return nil
	}
	return fmt.Errorf("control failed: %s", string(buf[:n]))
}

func IsRunning() bool {
	return SendControl("ping", "") == nil
}
