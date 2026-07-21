package protocol

const Version = 1

type StepStatus string

const (
	StatusPending StepStatus = "pending"
	StatusActive  StepStatus = "active"
	StatusDone    StepStatus = "done"
	StatusSkipped StepStatus = "skipped"
	StatusFailed  StepStatus = "failed"
)

type Mode string

const (
	ModeOff       Mode = "off"
	ModePlanning  Mode = "planning"
	ModeExecuting Mode = "executing"
	ModeComplete  Mode = "complete"
)

type PlanStep struct {
	ID     string     `json:"id"`
	Step   int        `json:"step"`
	Title  string     `json:"title"`
	Detail string     `json:"detail,omitempty"`
	Status StepStatus `json:"status"`
	Files  []string   `json:"files,omitempty"`
	Notes  string     `json:"notes,omitempty"`
}

type ExecutionActivity struct {
	ToolCallID string `json:"toolCallId"`
	ToolName   string `json:"toolName"`
	Summary    string `json:"summary,omitempty"`
	Path       string `json:"path,omitempty"`
	Status     string `json:"status"`
	StartedAt  int64  `json:"startedAt"`
	EndedAt    int64  `json:"endedAt,omitempty"`
}

type ExecutionFile struct {
	Path      string `json:"path"`
	Operation string `json:"operation"`
	Count     int    `json:"count"`
	UpdatedAt int64  `json:"updatedAt"`
}

// ExecutionTelemetry is optional so viewers can continue to render saved v1 plans
// created before execution metrics were introduced.
type ExecutionTelemetry struct {
	StartedAt          int64               `json:"startedAt"`
	UpdatedAt          int64               `json:"updatedAt"`
	ToolCallsStarted   int                 `json:"toolCallsStarted"`
	ToolCallsCompleted int                 `json:"toolCallsCompleted"`
	ToolCallsFailed    int                 `json:"toolCallsFailed"`
	Activities         []ExecutionActivity `json:"activities"`
	Files              []ExecutionFile     `json:"files"`
}

type PlanState struct {
	V            int                 `json:"v"`
	Mode         Mode                `json:"mode"`
	Title        string              `json:"title,omitempty"`
	Markdown     string              `json:"markdown,omitempty"`
	Steps        []PlanStep          `json:"steps"`
	ActiveStepID string              `json:"activeStepId,omitempty"`
	UpdatedAt    int64               `json:"updatedAt"`
	SessionID    string              `json:"sessionId,omitempty"`
	Cwd          string              `json:"cwd,omitempty"`
	Execution    *ExecutionTelemetry `json:"execution,omitempty"`
}

// Envelope is used for decoding by type field.
type Envelope struct {
	V    int    `json:"v"`
	Type string `json:"type"`
}

type Hello struct {
	V               int    `json:"v"`
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocolVersion"`
	SessionID       string `json:"sessionId"`
	Cwd             string `json:"cwd"`
}

type HelloAck struct {
	V               int    `json:"v"`
	Type            string `json:"type"`
	ProtocolVersion int    `json:"protocolVersion"`
	Client          string `json:"client"`
}

type PlanStateMsg struct {
	V     int       `json:"v"`
	Type  string    `json:"type"`
	State PlanState `json:"state"`
}

type PlanOp map[string]any

type PlanOpsMsg struct {
	V    int      `json:"v"`
	Type string   `json:"type"`
	Ops  []PlanOp `json:"ops"`
}

type PlanReplaceMsg struct {
	V     int       `json:"v"`
	Type  string    `json:"type"`
	State PlanState `json:"state"`
}

type ExecuteMsg struct {
	V    int    `json:"v"`
	Type string `json:"type"`
}

type RefineMsg struct {
	V    int    `json:"v"`
	Type string `json:"type"`
	Text string `json:"text"`
}

type SetModeMsg struct {
	V    int    `json:"v"`
	Type string `json:"type"`
	Mode string `json:"mode"`
}

type ActivityMsg struct {
	V          int    `json:"v"`
	Type       string `json:"type"`
	ToolCallID string `json:"toolCallId"`
	ToolName   string `json:"toolName"`
	Phase      string `json:"phase"`
	Summary    string `json:"summary,omitempty"`
	IsError    bool   `json:"isError,omitempty"`
}

type StatusMsg struct {
	V         int    `json:"v"`
	Type      string `json:"type"`
	AgentIdle bool   `json:"agentIdle,omitempty"`
	Message   string `json:"message,omitempty"`
}

type GoodbyeMsg struct {
	V      int    `json:"v"`
	Type   string `json:"type"`
	Reason string `json:"reason,omitempty"`
}

type ErrorMsg struct {
	V       int    `json:"v"`
	Type    string `json:"type"`
	Message string `json:"message"`
}

type PingMsg struct {
	V    int    `json:"v"`
	Type string `json:"type"`
}
