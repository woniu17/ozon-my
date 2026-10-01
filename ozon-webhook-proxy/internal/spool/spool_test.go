package spool

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAppendReadRoundtrip(t *testing.T) {
	s := openTmp(t)
	env := &Envelope{SrcIP: "217.116.26.101", MessageType: "TYPE_NEW_POSTING",
		Payload: json.RawMessage(`{"message_type":"TYPE_NEW_POSTING"}`)}

	name, err := s.Append(env)
	if err != nil {
		t.Fatalf("Append: %v", err)
	}
	if !strings.HasSuffix(name, "-TYPE_NEW_POSTING.json") {
		t.Errorf("文件名不含 message_type: %s", name)
	}
	if env.ReceivedMs == 0 || env.Seq == 0 {
		t.Errorf("Append 未回填元信息 seq=%d received=%d", env.Seq, env.ReceivedMs)
	}

	items, err := s.Pending()
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	if len(items) != 1 || items[0].Name != name {
		t.Fatalf("Pending = %v, want 1 条 %s", items, name)
	}

	got, err := s.Read(items[0])
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if string(got.Payload) != string(env.Payload) {
		t.Errorf("payload 被改写:\n got %s\nwant %s", got.Payload, env.Payload)
	}
	if got.SrcIP != env.SrcIP || got.MessageType != env.MessageType {
		t.Errorf("元信息不符: %+v", got)
	}
}

// erp 的幂等键由 payload 里的字段明文拼接而来，product_id/sku 这类大整数
// 一旦经过 map[string]any 就会被 float64 截断。这里钉住字节保真。
func TestPayloadBigIntByteFidelity(t *testing.T) {
	s := openTmp(t)
	const raw = `{"message_type":"TYPE_POSTING_NUMBER_CHANGED","result":{"product_id":1812345678901234567,"sku":9223372036854775807,"d":1.0000000000000000001,"s":"含中文"}}`
	if _, err := s.Append(&Envelope{MessageType: "TYPE_POSTING_NUMBER_CHANGED", Payload: json.RawMessage(raw)}); err != nil {
		t.Fatalf("Append: %v", err)
	}
	items, _ := s.Pending()
	got, err := s.Read(items[0])
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if string(got.Payload) != raw {
		t.Errorf("大整数/小数精度被破坏:\n got %s\nwant %s", got.Payload, raw)
	}

	// 反向确认：如果换成 map[string]any 中转，确实会丢——证明这个测试有鉴别力
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatal(err)
	}
	if re, _ := json.Marshal(m); strings.Contains(string(re), "1812345678901234567") {
		t.Skip("该 Go 版本下 map 中转未丢精度，测试鉴别力下降")
	}
}

func TestPendingIsFIFO(t *testing.T) {
	s := openTmp(t)
	want := []string{"TYPE_A", "TYPE_B", "TYPE_C"}
	for _, mt := range want {
		if _, err := s.Append(&Envelope{MessageType: mt, Payload: json.RawMessage(`{"a":1}`)}); err != nil {
			t.Fatalf("Append %s: %v", mt, err)
		}
	}
	items, err := s.Pending()
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	if len(items) != len(want) {
		t.Fatalf("Pending 数量 = %d, want %d", len(items), len(want))
	}
	for i, it := range items {
		if !strings.Contains(it.Name, "-"+want[i]+".json") {
			t.Errorf("第 %d 条 = %s, want %s", i, it.Name, want[i])
		}
	}
	if s.Depth() != 3 {
		t.Errorf("Depth = %d, want 3", s.Depth())
	}
	if s.OldestAge() < 0 {
		t.Errorf("OldestAge 为负: %v", s.OldestAge())
	}
}

func TestDoneRemoves(t *testing.T) {
	s := openTmp(t)
	name, _ := s.Append(&Envelope{MessageType: "TYPE_A", Payload: json.RawMessage(`{}`)})
	items, _ := s.Pending()
	if err := s.Done(items[0]); err != nil {
		t.Fatalf("Done: %v", err)
	}
	if _, err := os.Stat(filepath.Join(s.dir, "pending", name)); !os.IsNotExist(err) {
		t.Errorf("Done 后文件仍在: %v", err)
	}
	if s.Depth() != 0 {
		t.Errorf("Depth = %d, want 0", s.Depth())
	}
	// 重复删除不应报错（崩溃恢复时可能重复处理）
	if err := s.Done(items[0]); err != nil {
		t.Errorf("重复 Done: %v", err)
	}
}

func TestDeadKeepsReplayableFile(t *testing.T) {
	s := openTmp(t)
	const raw = `{"message_type":"TYPE_X","result":{}}`
	name, _ := s.Append(&Envelope{MessageType: "TYPE_X", Payload: json.RawMessage(raw)})
	items, _ := s.Pending()
	if err := s.Dead(items[0], "403: forbidden"); err != nil {
		t.Fatalf("Dead: %v", err)
	}
	if s.Depth() != 0 {
		t.Errorf("进 dead 后 pending 应为空, Depth = %d", s.Depth())
	}
	// dead 文件必须还能解析出原始 payload，便于 curl --data-binary 重放
	dead, err := s.Read(Item{Name: name, Path: filepath.Join(s.dir, "dead", name)})
	if err != nil {
		t.Fatalf("读 dead: %v", err)
	}
	if string(dead.Payload) != raw {
		t.Errorf("dead payload = %s, want %s", dead.Payload, raw)
	}
	reason, err := os.ReadFile(filepath.Join(s.dir, "dead", name+".reason"))
	if err != nil {
		t.Fatalf("读 reason: %v", err)
	}
	if strings.TrimSpace(string(reason)) != "403: forbidden" {
		t.Errorf("reason = %q", reason)
	}
}

// 崩溃恢复：重启后（新的 Spool 实例，seq 从 0 开始）pending 仍按原顺序可见。
func TestReopenKeepsPending(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	for _, mt := range []string{"TYPE_ONE", "TYPE_TWO"} {
		if _, err := s.Append(&Envelope{MessageType: mt, Payload: json.RawMessage(`{}`)}); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}
	s2, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	items, err := s2.Pending()
	if err != nil {
		t.Fatalf("Pending: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("重启后 pending = %d, want 2", len(items))
	}
	if !strings.Contains(items[0].Name, "TYPE_ONE") || !strings.Contains(items[1].Name, "TYPE_TWO") {
		t.Errorf("重启后顺序变了: %s , %s", items[0].Name, items[1].Name)
	}
	if s2.Depth() != 2 {
		t.Errorf("Depth = %d, want 2", s2.Depth())
	}
}

func TestSanitizeType(t *testing.T) {
	// message_type 是外部输入且会进文件名：只留 [A-Z0-9_]，其余换成下划线。
	cases := map[string]string{
		"TYPE_NEW_POSTING":       "TYPE_NEW_POSTING",
		"../../ETC":              "______ETC",
		"a b":                    "___",
		"TYPE_1!":                "TYPE_1_",
		"":                       "UNKNOWN",
		strings.Repeat("A", 100): strings.Repeat("A", 64),
	}
	for in, want := range cases {
		if got := sanitizeType(in); got != want {
			t.Errorf("sanitizeType(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseName(t *testing.T) {
	n, seq, mt, ok := parseName("1730000000000123456-000007-TYPE_NEW_POSTING.json")
	if !ok {
		t.Fatal("parseName 失败")
	}
	if seq != 7 || mt != "TYPE_NEW_POSTING" {
		t.Errorf("seq=%d mt=%s", seq, mt)
	}
	if got := time.Unix(0, n).Nanosecond(); got != 123456 {
		t.Errorf("纳秒尾数 = %d", got)
	}
	if _, _, _, ok := parseName("garbage.json"); ok {
		t.Error("非法文件名应解析失败")
	}
}

func openTmp(t *testing.T) *Spool {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return s
}
