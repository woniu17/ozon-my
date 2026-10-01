// Package spool 是一个基于文件系统的持久化队列：一条消息一个文件，
// 写入成功才算接收成功（掉电/崩溃不丢），转发成功即删除，永久失败移入 dead 目录。
//
// 选单文件队列而非 WAL + 内存索引：这个量级（6 个店铺、每天几百到几千条）下
// 文件数量完全可控，换来的好处是崩溃恢复天然正确、且 dead 目录里的文件
// 可以直接用 jq/curl 检查重放，运维不需要额外工具。
package spool

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	dirPerm  = 0o750
	filePerm = 0o600
)

// Envelope 是落盘的一条记录。Payload 用 json.RawMessage，
// 序列化时按原始字节原样写出（json.Marshal 只会去掉多余空白，
// 不会重排字段、不会改写数字字面量），因此 erp 侧据以计算幂等键的
// product_id / sku 等大整数不会被 float64 精度截断。
type Envelope struct {
	Seq         int64           `json:"seq"`
	ReceivedMs  int64           `json:"received_ms"`
	SrcIP       string          `json:"src_ip"`
	MessageType string          `json:"message_type"`
	Payload     json.RawMessage `json:"payload"`
}

type Item struct {
	Name string
	Path string
}

type Spool struct {
	dir    string
	mu     sync.Mutex
	seq    int64
	cached int // pending 计数，避免每次 Stat 目录
}

func Open(dir string) (*Spool, error) {
	for _, sub := range []string{"pending", "dead"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), dirPerm); err != nil {
			return nil, fmt.Errorf("spool: mkdir %s: %w", sub, err)
		}
	}
	s := &Spool{dir: dir}
	n, err := s.countPending()
	if err != nil {
		return nil, err
	}
	s.cached = n
	return s, nil
}

// Append 原子落盘：写临时文件 → fsync → rename → fsync 目录。
// 任一环节失败都会返回错误，调用方据此决定给 Ozon 回 5xx（让 Ozon 重投）而不是假成功。
func (s *Spool) Append(env *Envelope) (string, error) {
	env.ReceivedMs = time.Now().UnixMilli()

	body, err := json.Marshal(env)
	if err != nil {
		return "", fmt.Errorf("spool: marshal: %w", err)
	}

	name := s.fileName(env)
	tmpPath := filepath.Join(s.dir, "pending", name+".tmp")
	finalPath := filepath.Join(s.dir, "pending", name)

	f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, filePerm)
	if err != nil {
		return "", fmt.Errorf("spool: create: %w", err)
	}
	if _, err := f.Write(body); err != nil {
		f.Close()
		os.Remove(tmpPath)
		return "", fmt.Errorf("spool: write: %w", err)
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmpPath)
		return "", fmt.Errorf("spool: fsync: %w", err)
	}
	if err := f.Close(); err != nil {
		os.Remove(tmpPath)
		return "", fmt.Errorf("spool: close: %w", err)
	}
	if err := os.Rename(tmpPath, finalPath); err != nil {
		os.Remove(tmpPath)
		return "", fmt.Errorf("spool: rename: %w", err)
	}
	syncDir(filepath.Join(s.dir, "pending"))

	s.mu.Lock()
	s.cached++
	s.mu.Unlock()
	return name, nil
}

// fileName 形如 1730000000000123456-000001-TYPE_NEW_POSTING.json，
// 前缀是纳秒时间戳，目录内按文件名排序即为接收顺序。
func (s *Spool) fileName(env *Envelope) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seq++
	env.Seq = s.seq
	return fmt.Sprintf("%d-%06d-%s.json",
		time.Now().UnixNano(), s.seq, sanitizeType(env.MessageType))
}

// Pending 按接收顺序返回待转发文件名（只读目录项，不解析内容）。
func (s *Spool) Pending() ([]Item, error) {
	ents, err := os.ReadDir(filepath.Join(s.dir, "pending"))
	if err != nil {
		return nil, fmt.Errorf("spool: read pending: %w", err)
	}
	names := make([]string, 0, len(ents))
	for _, e := range ents {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)

	items := make([]Item, len(names))
	for i, n := range names {
		items[i] = Item{Name: n, Path: filepath.Join(s.dir, "pending", n)}
	}
	return items, nil
}

func (s *Spool) Read(it Item) (*Envelope, error) {
	data, err := os.ReadFile(it.Path)
	if err != nil {
		return nil, fmt.Errorf("spool: read %s: %w", it.Name, err)
	}
	var env Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, fmt.Errorf("spool: parse %s: %w", it.Name, err)
	}
	return &env, nil
}

func (s *Spool) Done(it Item) error {
	if err := os.Remove(it.Path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("spool: remove %s: %w", it.Name, err)
	}
	syncDir(filepath.Join(s.dir, "pending"))
	s.mu.Lock()
	if s.cached > 0 {
		s.cached--
	}
	s.mu.Unlock()
	return nil
}

// Dead 把永久失败的消息移入 dead 目录，并写一个 .reason 边车文件。
// dead 里的文件保持原始 payload，可直接 curl --data-binary 重放。
func (s *Spool) Dead(it Item, reason string) error {
	dst := filepath.Join(s.dir, "dead", it.Name)
	if err := os.Rename(it.Path, dst); err != nil {
		return fmt.Errorf("spool: move dead %s: %w", it.Name, err)
	}
	_ = os.WriteFile(dst+".reason", []byte(reason+"\n"), filePerm)
	syncDir(filepath.Join(s.dir, "dead"))

	s.mu.Lock()
	if s.cached > 0 {
		s.cached--
	}
	s.mu.Unlock()
	return nil
}

func (s *Spool) Depth() int {
	n, err := s.countPending()
	if err != nil {
		return s.cached
	}
	s.mu.Lock()
	s.cached = n
	s.mu.Unlock()
	return n
}

func (s *Spool) countPending() (int, error) {
	ents, err := os.ReadDir(filepath.Join(s.dir, "pending"))
	if err != nil {
		return 0, fmt.Errorf("spool: stat pending: %w", err)
	}
	n := 0
	for _, e := range ents {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
			n++
		}
	}
	return n, nil
}

// OldestAge 返回队头消息等待时长，队列为空时返回 0。
func (s *Spool) OldestAge() time.Duration {
	items, err := s.Pending()
	if err != nil || len(items) == 0 {
		return 0
	}
	ns, _, _, ok := parseName(items[0].Name)
	if !ok {
		return 0
	}
	recv := time.Unix(0, ns)
	if d := time.Since(recv); d > 0 {
		return d
	}
	return 0
}

func parseName(name string) (unixNano int64, seq int, msgType string, ok bool) {
	base := strings.TrimSuffix(name, ".json")
	parts := strings.SplitN(base, "-", 3)
	if len(parts) != 3 {
		return 0, 0, "", false
	}
	unixNano, err1 := strconv.ParseInt(parts[0], 10, 64)
	seq, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil {
		return 0, 0, "", false
	}
	return unixNano, seq, parts[2], true
}

// sanitizeType 只留大写字母数字下划线：message_type 来自外部输入，会进文件名。
func sanitizeType(t string) string {
	var b strings.Builder
	for i := 0; i < len(t); i++ {
		c := t[i]
		if c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' {
			b.WriteByte(c)
		} else {
			b.WriteByte('_')
		}
	}
	if b.Len() == 0 {
		return "UNKNOWN"
	}
	if b.Len() > 64 {
		return b.String()[:64]
	}
	return b.String()
}

func syncDir(dir string) {
	f, err := os.Open(dir)
	if err != nil {
		return
	}
	_ = f.Sync()
	_ = f.Close()
}
