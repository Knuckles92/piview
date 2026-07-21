package open

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
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

func FocusHint() {
	// Best-effort: nothing portable; UI already open
	_, _ = fmt.Fprintln(os.Stderr, "piview: focused existing instance")
}
