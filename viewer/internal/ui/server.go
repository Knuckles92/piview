package ui

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/dtf/piview/internal/protocol"
)

type Bridge interface {
	SendReplace(state protocol.PlanState) error
	Execute() error
	Refine(text string) error
	SetMode(mode string) error
}

type Server struct {
	webFS  fs.FS
	bridge Bridge

	mu      sync.RWMutex
	state   protocol.PlanState
	connOK  bool
	cwd     string
	subs    map[chan string]struct{}
	ln      net.Listener
	httpSrv *http.Server
}

func New(webFS fs.FS, bridge Bridge) *Server {
	return &Server{
		webFS:  webFS,
		bridge: bridge,
		state:  protocol.PlanState{V: 1, Mode: protocol.ModeOff, Steps: []protocol.PlanStep{}, UpdatedAt: time.Now().UnixMilli()},
		subs:   make(map[chan string]struct{}),
	}
}

func (s *Server) SetConnected(ok bool) {
	s.mu.Lock()
	s.connOK = ok
	s.mu.Unlock()
	s.emit("conn", map[string]any{"connected": ok, "cwd": s.cwd})
}

func (s *Server) SetHello(cwd string) {
	s.mu.Lock()
	s.cwd = cwd
	s.mu.Unlock()
	s.emit("conn", map[string]any{"connected": s.connOK, "cwd": cwd})
}

func (s *Server) SetPlan(state protocol.PlanState) {
	s.mu.Lock()
	s.state = state
	s.mu.Unlock()
	s.emit("state", state)
}

func (s *Server) SetActivity(a protocol.ActivityMsg) {
	s.emit("activity", a)
}

func (s *Server) SetStatus(st protocol.StatusMsg) {
	s.emit("status", st)
}

func (s *Server) emit(event string, payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	msg := fmt.Sprintf("event: %s\ndata: %s\n\n", event, data)
	s.mu.RLock()
	defer s.mu.RUnlock()
	for ch := range s.subs {
		select {
		case ch <- msg:
		default:
		}
	}
}

func (s *Server) Start() (addr string, err error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	s.ln = ln

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(s.webFS)))
	mux.HandleFunc("/api/events", s.handleEvents)
	mux.HandleFunc("/api/replace", s.handleReplace)
	mux.HandleFunc("/api/execute", s.handleExecute)
	mux.HandleFunc("/api/refine", s.handleRefine)
	mux.HandleFunc("/api/state", s.handleGetState)

	s.httpSrv = &http.Server{Handler: mux}
	go func() { _ = s.httpSrv.Serve(ln) }()
	return ln.Addr().String(), nil
}

func (s *Server) Close() {
	if s.httpSrv != nil {
		_ = s.httpSrv.Close()
	}
	if s.ln != nil {
		_ = s.ln.Close()
	}
}

func (s *Server) URL() string {
	if s.ln == nil {
		return ""
	}
	return "http://" + s.ln.Addr().String() + "/"
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "no flush", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ch := make(chan string, 16)
	s.mu.Lock()
	s.subs[ch] = struct{}{}
	state := s.state
	connOK := s.connOK
	cwd := s.cwd
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.subs, ch)
		s.mu.Unlock()
		close(ch)
	}()

	// initial snapshot
	if b, err := json.Marshal(state); err == nil {
		fmt.Fprintf(w, "event: state\ndata: %s\n\n", b)
	}
	if b, err := json.Marshal(map[string]any{"connected": connOK, "cwd": cwd}); err == nil {
		fmt.Fprintf(w, "event: conn\ndata: %s\n\n", b)
	}
	flusher.Flush()

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-ch:
			_, _ = w.Write([]byte(msg))
			flusher.Flush()
		case <-ticker.C:
			_, _ = w.Write([]byte(": ping\n\n"))
			flusher.Flush()
		}
	}
}

func (s *Server) handleGetState(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	writeJSON(w, s.state)
}

func (s *Server) handleReplace(w http.ResponseWriter, r *http.Request) {
	var body struct {
		State protocol.PlanState `json:"state"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	body.State.V = 1
	if err := s.bridge.SendReplace(body.State); err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	s.SetPlan(body.State)
	writeJSON(w, map[string]any{"ok": true})
}

func (s *Server) handleExecute(w http.ResponseWriter, r *http.Request) {
	if err := s.bridge.Execute(); err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func (s *Server) handleRefine(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, err.Error(), 400)
		return
	}
	if err := s.bridge.Refine(body.Text); err != nil {
		http.Error(w, err.Error(), 502)
		return
	}
	writeJSON(w, map[string]any{"ok": true})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
