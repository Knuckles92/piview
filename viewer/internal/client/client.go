package client

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/dtf/piview/internal/protocol"

	"github.com/gorilla/websocket"
)

type Handlers struct {
	OnPlanState func(protocol.PlanState)
	OnActivity  func(protocol.ActivityMsg)
	OnStatus    func(protocol.StatusMsg)
	OnHello     func(protocol.Hello)
	OnGoodbye   func(reason string)
	OnError     func(message string)
	OnConn      func(connected bool)
}

type Client struct {
	url      string
	handlers Handlers

	mu   sync.Mutex
	conn *websocket.Conn
	stop chan struct{}
}

func New(url string, h Handlers) *Client {
	return &Client{url: url, handlers: h, stop: make(chan struct{})}
}

func (c *Client) Connect() error {
	dialer := websocket.Dialer{
		Proxy:            http.ProxyFromEnvironment,
		HandshakeTimeout: 8 * time.Second,
	}
	conn, _, err := dialer.Dial(c.url, nil)
	if err != nil {
		return fmt.Errorf("ws dial: %w", err)
	}
	c.mu.Lock()
	c.conn = conn
	// Ensure stop channel is open for a fresh read loop
	select {
	case <-c.stop:
		c.stop = make(chan struct{})
	default:
	}
	c.mu.Unlock()

	if c.handlers.OnConn != nil {
		c.handlers.OnConn(true)
	}

	ack, _ := json.Marshal(protocol.HelloAck{
		V:               1,
		Type:            "hello_ack",
		ProtocolVersion: protocol.Version,
		Client:          "piview-go",
	})
	if err := conn.WriteMessage(websocket.TextMessage, ack); err != nil {
		return err
	}

	go c.readLoop()
	return nil
}

// Reconnect closes the current socket and dials url (same handlers).
func (c *Client) Reconnect(url string) error {
	c.mu.Lock()
	old := c.conn
	c.conn = nil
	c.url = url
	c.mu.Unlock()
	if old != nil {
		_ = old.Close()
	}
	// Give the old readLoop a moment to notice the closed conn
	time.Sleep(50 * time.Millisecond)
	return c.Connect()
}

func (c *Client) Close() {
	select {
	case <-c.stop:
	default:
		close(c.stop)
	}
	c.mu.Lock()
	if c.conn != nil {
		_ = c.conn.WriteMessage(websocket.TextMessage, mustJSON(protocol.GoodbyeMsg{V: 1, Type: "goodbye", Reason: "client quit"}))
		_ = c.conn.Close()
		c.conn = nil
	}
	c.mu.Unlock()
	if c.handlers.OnConn != nil {
		c.handlers.OnConn(false)
	}
}

func (c *Client) Send(v any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil {
		return fmt.Errorf("not connected")
	}
	return c.conn.WriteMessage(websocket.TextMessage, mustJSON(v))
}

func (c *Client) SendOps(ops []protocol.PlanOp) error {
	return c.Send(protocol.PlanOpsMsg{V: 1, Type: "plan_ops", Ops: ops})
}

func (c *Client) SendReplace(state protocol.PlanState) error {
	return c.Send(protocol.PlanReplaceMsg{V: 1, Type: "plan_replace", State: state})
}

func (c *Client) Execute(fromStepID string) error {
	return c.Send(protocol.ExecuteMsg{V: 1, Type: "execute", FromStepID: fromStepID})
}

func (c *Client) Refine(text string) error {
	return c.Send(protocol.RefineMsg{V: 1, Type: "refine", Text: text})
}

func (c *Client) SetMode(mode string) error {
	return c.Send(protocol.SetModeMsg{V: 1, Type: "set_mode", Mode: mode})
}

func (c *Client) readLoop() {
	for {
		select {
		case <-c.stop:
			return
		default:
		}
		c.mu.Lock()
		conn := c.conn
		c.mu.Unlock()
		if conn == nil {
			return
		}
		_, data, err := conn.ReadMessage()
		if err != nil {
			select {
			case <-c.stop:
				return
			default:
			}
			log.Printf("ws read: %v", err)
			if c.handlers.OnConn != nil {
				c.handlers.OnConn(false)
			}
			return
		}
		c.dispatch(data)
	}
}

func (c *Client) dispatch(data []byte) {
	var env protocol.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return
	}
	switch env.Type {
	case "hello":
		var m protocol.Hello
		_ = json.Unmarshal(data, &m)
		if c.handlers.OnHello != nil {
			c.handlers.OnHello(m)
		}
	case "plan_state":
		var m protocol.PlanStateMsg
		_ = json.Unmarshal(data, &m)
		if c.handlers.OnPlanState != nil {
			c.handlers.OnPlanState(m.State)
		}
	case "activity":
		var m protocol.ActivityMsg
		_ = json.Unmarshal(data, &m)
		if c.handlers.OnActivity != nil {
			c.handlers.OnActivity(m)
		}
	case "status":
		var m protocol.StatusMsg
		_ = json.Unmarshal(data, &m)
		if c.handlers.OnStatus != nil {
			c.handlers.OnStatus(m)
		}
	case "goodbye":
		var m protocol.GoodbyeMsg
		_ = json.Unmarshal(data, &m)
		if c.handlers.OnGoodbye != nil {
			c.handlers.OnGoodbye(m.Reason)
		}
	case "error":
		var m protocol.ErrorMsg
		_ = json.Unmarshal(data, &m)
		if c.handlers.OnError != nil {
			c.handlers.OnError(m.Message)
		}
	case "pong":
		// ignore
	}
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		return []byte(`{"v":1,"type":"error","message":"encode failed"}`)
	}
	return b
}
