package main

import (
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/dtf/piview/internal/client"
	"github.com/dtf/piview/internal/instance"
	"github.com/dtf/piview/internal/open"
	"github.com/dtf/piview/internal/protocol"
	"github.com/dtf/piview/internal/ui"
)

//go:embed web/*
var webEmbed embed.FS

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "open":
		cmdOpen(os.Args[2:])
	case "focus":
		cmdFocus(os.Args[2:])
	case "quit":
		if err := instance.SendControl("quit", ""); err != nil {
			fmt.Fprintf(os.Stderr, "piview quit: %v\n", err)
			os.Exit(1)
		}
	case "version":
		fmt.Println("piview 0.1.0")
	case "protocol-version":
		fmt.Println(protocol.Version)
	case "help", "-h", "--help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", os.Args[1])
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, `piview — plan GUI companion for pi

Usage:
  piview open  --ws <url> [--title <t>] [--cwd <dir>]
  piview focus [--ws <url>]
  piview quit
  piview version
  piview protocol-version
`)
}

func cmdFocus(args []string) {
	flagSet := flag.NewFlagSet("focus", flag.ExitOnError)
	ws := flagSet.String("ws", "", "websocket url")
	_ = flagSet.Parse(args)
	if instance.IsRunning() {
		if err := instance.SendControl("focus", *ws); err != nil {
			fmt.Fprintf(os.Stderr, "focus: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if *ws == "" {
		fmt.Fprintln(os.Stderr, "no running piview instance")
		os.Exit(1)
	}
	// No instance — open fresh
	cmdOpen([]string{"--ws", *ws})
}

func cmdOpen(args []string) {
	flagSet := flag.NewFlagSet("open", flag.ExitOnError)
	wsURL := flagSet.String("ws", "", "extension websocket url (required)")
	title := flagSet.String("title", "piview", "window title")
	cwd := flagSet.String("cwd", "", "working directory label")
	_ = flagSet.Parse(args)

	if *wsURL == "" {
		fmt.Fprintln(os.Stderr, "--ws is required")
		os.Exit(2)
	}

	// Single instance: focus if same bridge; otherwise replace (e.g. leftover spike)
	if instance.IsRunning() {
		if info, err := instance.Read(); err == nil && info.WSURL == *wsURL {
			_ = instance.SendControl("focus", *wsURL)
			uiURL := "http://" + info.UIAddr + "/"
			_ = open.OpenURL(uiURL, *title)
			fmt.Fprintf(os.Stderr, "piview UI: %s\n", uiURL)
			return
		}
		_ = instance.SendControl("quit", "")
		// Wait briefly for lock/sock cleanup before binding again
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			if !instance.IsRunning() {
				break
			}
			time.Sleep(50 * time.Millisecond)
		}
		instance.Clear()
	}

	webFS, err := fs.Sub(webEmbed, "web")
	if err != nil {
		fatal(err)
	}

	// UI server needs a bridge adapter; client created next and wired.
	var cl *client.Client
	uiServer := ui.New(webFS, bridgeAdapter{get: func() *client.Client { return cl }})

	cl = client.New(*wsURL, client.Handlers{
		OnConn: func(ok bool) { uiServer.SetConnected(ok) },
		OnHello: func(h protocol.Hello) {
			uiServer.SetHello(h.Cwd)
		},
		OnPlanState: func(st protocol.PlanState) { uiServer.SetPlan(st) },
		OnActivity:  func(a protocol.ActivityMsg) { uiServer.SetActivity(a) },
		OnStatus:    func(st protocol.StatusMsg) { uiServer.SetStatus(st) },
		OnGoodbye: func(reason string) {
			uiServer.SetStatus(protocol.StatusMsg{V: 1, Type: "status", Message: "bridge closed: " + reason})
			// Give UI a moment, then exit
			go func() {
				time.Sleep(400 * time.Millisecond)
				os.Exit(0)
			}()
		},
		OnError: func(message string) {
			uiServer.SetStatus(protocol.StatusMsg{V: 1, Type: "status", Message: "error: " + message})
		},
	})

	addr, err := uiServer.Start()
	if err != nil {
		fatal(err)
	}
	uiURL := uiServer.URL()

	ctrl, err := instance.StartControl(
		func(newWS string) {
			if newWS != "" && newWS != *wsURL {
				*wsURL = newWS
				if err := cl.Reconnect(newWS); err != nil {
					fmt.Fprintf(os.Stderr, "warning: ws reconnect failed: %v\n", err)
					uiServer.SetConnected(false)
				} else {
					_ = instance.Write(instance.Info{
						PID:    os.Getpid(),
						UIAddr: addr,
						WSURL:  newWS,
					})
				}
			}
			_ = open.OpenURL(uiURL, *title)
			fmt.Fprintf(os.Stderr, "piview UI: %s\n", uiURL)
		},
		func() {
			cl.Close()
			uiServer.Close()
			instance.Clear()
			os.Exit(0)
		},
	)
	if err != nil {
		fatal(err)
	}
	defer ctrl.Close()

	if err := instance.Write(instance.Info{
		PID:    os.Getpid(),
		UIAddr: addr,
		WSURL:  *wsURL,
	}); err != nil {
		fatal(err)
	}
	defer instance.Clear()

	if err := cl.Connect(); err != nil {
		fmt.Fprintf(os.Stderr, "warning: ws connect failed: %v (UI still open)\n", err)
		uiServer.SetConnected(false)
	}

	if *cwd != "" {
		uiServer.SetHello(*cwd)
	}

	if err := open.OpenURL(uiURL, *title); err != nil {
		fmt.Fprintf(os.Stderr, "open browser: %v\nUI: %s\n", err, uiURL)
	} else {
		fmt.Fprintf(os.Stderr, "piview UI: %s\n", uiURL)
	}

	// Stay alive until signal / quit control
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	cl.Close()
	uiServer.Close()
	instance.Clear()
}

type bridgeAdapter struct {
	get func() *client.Client
}

func (b bridgeAdapter) SendReplace(state protocol.PlanState) error {
	c := b.get()
	if c == nil {
		return fmt.Errorf("not connected")
	}
	return c.SendReplace(state)
}

func (b bridgeAdapter) Execute() error {
	c := b.get()
	if c == nil {
		return fmt.Errorf("not connected")
	}
	return c.Execute()
}

func (b bridgeAdapter) Refine(text string) error {
	c := b.get()
	if c == nil {
		return fmt.Errorf("not connected")
	}
	return c.Refine(text)
}

func (b bridgeAdapter) SetMode(mode string) error {
	c := b.get()
	if c == nil {
		return fmt.Errorf("not connected")
	}
	return c.SetMode(mode)
}

func fatal(err error) {
	fmt.Fprintf(os.Stderr, "piview: %v\n", err)
	os.Exit(1)
}
