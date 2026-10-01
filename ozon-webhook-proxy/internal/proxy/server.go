// 接收侧 HTTP 处理：快速回包给 Ozon，事件先落盘再异步转发 erp。
package proxy

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"time"

	"ozon-webhook-proxy/internal/config"
	"ozon-webhook-proxy/internal/spool"
)

type Server struct {
	cfg *config.Config
	sp  *spool.Spool
	fwd *Forwarder
}

func NewServer(cfg *config.Config, sp *spool.Spool, fwd *Forwarder) *Server {
	return &Server{cfg: cfg, sp: sp, fwd: fwd}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/webhook/ozon", s.handleOzon)
	mux.HandleFunc("/webhook/health", s.handleHealth)
	return mux
}

// ozonError 是 Ozon 规定的错误响应模板，code 只能取文档允许的三个值。
type ozonError struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
		Details string `json:"details"`
	} `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("[server] 写响应失败: %v", err)
	}
}

func writeOzonError(w http.ResponseWriter, status int, code, message string) {
	var e ozonError
	e.Error.Code = code
	e.Error.Message = message
	e.Error.Details = ""
	writeJSON(w, status, e)
}

// handleOzon 收 Ozon 推送。
//
// 响应时延目标：一次文件写入 + 内存操作，毫秒级。Ozon 侧单条超过 5 秒会计入
// "服务不可用"，因此这里绝不同步等 erp；落盘成功即视为接收成功。
func (s *Server) handleOzon(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeOzonError(w, http.StatusMethodNotAllowed, "ERROR_UNKNOWN", "method not allowed")
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, s.cfg.MaxBodyBytes))
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			log.Printf("[server] body 超过 %d 字节，拒绝: %v", s.cfg.MaxBodyBytes, err)
			writeOzonError(w, http.StatusBadRequest, "ERROR_PARAMETER_VALUE_MISSED", "payload too large")
			return
		}
		// 读一半断连属于客户端问题，回 4xx 让 Ozon 重投
		log.Printf("[server] 读 body 失败: %v", err)
		writeOzonError(w, http.StatusBadRequest, "ERROR_UNKNOWN", "read body failed")
		return
	}

	// 只解析 message_type 用于分流；原始字节整体留档转发，
	// 不做任何重新序列化（大整数经 float64 会丢精度，破坏 erp 侧幂等键）。
	var header struct {
		MessageType string `json:"message_type"`
	}
	if err := json.Unmarshal(body, &header); err != nil {
		log.Printf("[server] JSON 解析失败: %v body=%s", err, truncate(string(body), 200))
		writeOzonError(w, http.StatusBadRequest, "ERROR_PARAMETER_VALUE_MISSED", "invalid json")
		return
	}
	if header.MessageType == "" {
		writeOzonError(w, http.StatusBadRequest, "ERROR_PARAMETER_VALUE_MISSED", "message_type 缺失")
		return
	}

	// 探活心跳：本地直接应答，不进队列（erp 也不存 PING）。
	// 必须在 Content-Type 上严格给 application/json，否则 Ozon 判 INVALID_BODY。
	if header.MessageType == "TYPE_PING" {
		writeJSON(w, http.StatusOK, map[string]string{
			"version": s.cfg.AppVersion,
			"name":    s.cfg.AppName,
			"time":    time.Now().UTC().Format(time.RFC3339),
		})
		return
	}

	srcIP := clientIP(r)
	env := &spool.Envelope{
		SrcIP:       srcIP,
		MessageType: header.MessageType,
		Payload:     json.RawMessage(body),
	}
	name, err := s.sp.Append(env)
	if err != nil {
		// 落盘失败（磁盘满/只读）时回 5xx，让 Ozon 按它自己的退避策略重投，
		// 比假成功回 200 丢消息要好。
		log.Printf("[server] 落盘失败，交给 Ozon 重投: %v", err)
		writeOzonError(w, http.StatusInternalServerError, "ERROR_UNKNOWN", "storage unavailable")
		return
	}

	s.fwd.CountReceived()
	s.fwd.Signal()

	// 200 比例是 Ozon 判定是否暂停推送的核心指标：除入参非法外一律回成功。
	log.Printf("[server] 接收 %s src=%s -> %s (%d bytes)", header.MessageType, srcIP, name, len(body))
	writeJSON(w, http.StatusOK, map[string]bool{"result": true})
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	st := s.fwd.Stats()
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "ok",
		"name":    s.cfg.AppName,
		"version": s.cfg.AppVersion,
		"role":    "webhook-proxy",
		"time":    time.Now().UTC().Format(time.RFC3339),
		"proxy":   st,
	})
}

// clientIP 取 Ozon 真实源 IP，用于写进转发出去的 X-Forwarded-For。
//
// 上游是本机 nginx（ozonerp.conf 里 proxy_set_header X-Real-IP $remote_addr），
// 而 erp 的 ipWhitelist 取 XFF 首段比对 Ozon 网段，所以必须还原出真实源 IP。
// 信任这些头并不比现状更差：伪造者同样可以直连 erp 伪造 XFF。
// 收紧到共享密钥是第二阶段和 erp 一起做的事，见 DESIGN.md。
func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		first := strings.TrimSpace(strings.Split(xff, ",")[0])
		if ip := normalizeIP(first); ip != "" {
			return ip
		}
	}
	if ip := normalizeIP(r.Header.Get("X-Real-IP")); ip != "" {
		return ip
	}
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		return normalizeIP(host)
	}
	return normalizeIP(r.RemoteAddr)
}

// normalizeIP 把 IPv4 保持点分十进制、IPv6 去掉方括号和 zone，
// 保证写进 XFF 的是 erp 能直接比对 CIDR 的形式。
func normalizeIP(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Trim(s, "[]")
	if i := strings.IndexByte(s, '%'); i >= 0 {
		s = s[:i]
	}
	if s == "" {
		return ""
	}
	ip := net.ParseIP(s)
	if ip == nil {
		return ""
	}
	return ip.String()
}
