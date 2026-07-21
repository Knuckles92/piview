package open

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// OpenURL opens a browser window; prefers Chrome app mode when available.
func OpenURL(url, title string) error {
	_ = title
	switch runtime.GOOS {
	case "darwin":
		// Try Chrome app window first for a chromeless feel.
		// Use Run (not Start) so a missing app falls through instead of
		// treating a successful `open` process spawn as success.
		for _, app := range []string{
			"Google Chrome",
			"Chromium",
			"Microsoft Edge",
			"Brave Browser",
		} {
			if err := exec.Command("open", "-na", app, "--args", "--app="+url, "--new-window").Run(); err == nil {
				return nil
			}
		}
		return exec.Command("open", url).Run()
	case "linux":
		if isWSL() {
			// Inside WSL there is usually no Linux browser; hand the URL to
			// Windows. wslview (from wslu) respects the default browser,
			// otherwise fall back to cmd.exe start.
			if path, err := exec.LookPath("wslview"); err == nil {
				return exec.Command(path, url).Start()
			}
			if path, err := exec.LookPath("cmd.exe"); err == nil {
				return exec.Command(path, "/c", "start", "", url).Start()
			}
		}
		if path, err := exec.LookPath("google-chrome"); err == nil {
			return exec.Command(path, "--app="+url).Start()
		}
		if path, err := exec.LookPath("chromium"); err == nil {
			return exec.Command(path, "--app="+url).Start()
		}
		if path, err := exec.LookPath("xdg-open"); err == nil {
			return exec.Command(path, url).Start()
		}
		return fmt.Errorf("no browser launcher found")
	case "windows":
		// start via cmd
		return exec.Command("cmd", "/c", "start", "", url).Start()
	default:
		return fmt.Errorf("unsupported OS: %s", runtime.GOOS)
	}
}

// isWSL reports whether we're running inside Windows Subsystem for Linux.
func isWSL() bool {
	if os.Getenv("WSL_DISTRO_NAME") != "" || os.Getenv("WSL_INTEROP") != "" {
		return true
	}
	if data, err := os.ReadFile("/proc/version"); err == nil {
		return strings.Contains(strings.ToLower(string(data)), "microsoft")
	}
	return false
}

func FocusHint() {
	// Best-effort: nothing portable; UI already open
	_, _ = fmt.Fprintln(os.Stderr, "piview: focused existing instance")
}
