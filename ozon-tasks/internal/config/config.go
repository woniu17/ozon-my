// Package config 读 httpsrv 那一套 .env 方言：店铺凭据、分组、冷却期、飞书别名。
// 刻意不做成新格式——两个程序吃同一份 .env，改一处两边同时生效，切换期不会出现配置漂移。
package config

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"ozon-tasks/internal/cronx"
	"ozon-tasks/internal/durx"
)

const feishuWebhookBase = "https://open.feishu.cn/open-apis/bot/v2/hook/"

// DefaultAPIBaseURL 是 Ozon Seller API 官方根地址。放在 config 而不是 ozon：
// 配置校验要知道默认值，而 ozon 已经依赖 config，反过来依赖就成了循环。
const DefaultAPIBaseURL = "https://api-seller.ozon.ru"

// 飞书 webhook 末段的 UUID；FEISHU_BOT_<别名> 的值必须长这样，避免有人直接把整条 URL 塞进别名里
var feishuUUIDRe = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Shop 一家 Ozon 店铺。APIKey 是机密，任何日志/报错都不许直接打出它，取值一律走 MaskedAPIKey。
type Shop struct {
	Name     string
	ClientID string
	APIKey   string
}

func (s Shop) String() string {
	return fmt.Sprintf("Shop{%s client=%s key=%s}", s.Name, s.ClientID, MaskKey(s.APIKey))
}

// Group 一组调度配置。ShopNames 是引用，真正要用得等 ResolveGroups 查表展开。
type Group struct {
	Name          string
	ShopNames     []string
	Cooldown      time.Duration // 0 表示没配，回退全局冷却期
	Schedule      string        // cron 表达式或 @every 时长；空串表示回退
	FeishuWebhook string        // 空串表示回退全局
}

// ResolvedGroup 校验通过的分组：店铺已展开、排期/冷却/webhook 已回退到实际值。
type ResolvedGroup struct {
	Name          string
	Shops         []Shop
	Cooldown      time.Duration
	Schedule      string
	FeishuWebhook string
}

// GroupFallback 分组里没写的字段依次往这里回退。
type GroupFallback struct {
	Schedule string        // 全局排期；空则用 @every Cooldown
	Cooldown time.Duration // 只有 Schedule 也为空时才会被翻译成 @every
	Webhook  string
}

// ScheduleSpec 算出一组实际生效的排期表达式：分组 > 全局 > "@every 冷却期"。
//
// 保留冷却期这条回退路径是为了兼容：切换期两边吃同一份 .env，JS 侧只认 cooldown，
// 分组里没写 schedule 时必须得出与 JS 完全相同的节拍（每 cooldown 一次），
// 否则"配置没改、行为变了"会在对拍时伪装成 Go 实现的 bug。
func ScheduleSpec(groupSpec, globalSpec string, cooldown time.Duration) string {
	if s := strings.TrimSpace(groupSpec); s != "" {
		return s
	}
	if s := strings.TrimSpace(globalSpec); s != "" {
		return s
	}
	return "@every " + cooldown.String()
}

type Config struct {
	MachineName string

	Shops []Shop

	TimerGroups      []Group
	DeactivateGroups []Group

	TimerCooldown      time.Duration
	DeactivateCooldown time.Duration

	// 排期优先于冷却期：cron 是"固定时刻"，冷却期是"跑完再等"，前者不会让班次漂移。
	TimerSchedule      string
	DeactivateSchedule string

	// 跑一轮的资源护栏。都是按进程算的上限，实际限速再按店拆（见 ozon.Limiter）。
	TaskConcurrency int           // 同时在跑几家店
	APIRPS          float64       // 每店每秒请求数，0 = 不限速（JS 侧的行为）
	APIBurst        int           // 每店突发桶容量
	LeaseTTL        time.Duration // 租约时长：跑一轮超过它还没续租就会被别的进程接管
	RetryBackoff    time.Duration // 上一轮失败后两次执行的最小间隔

	OzonFeishuWebhook string

	APITimeout  time.Duration
	HTTPRetries int

	// APIBaseURL 是 Ozon Seller API 根地址。改它只为了演练：让本地假服务接管
	// 写请求，真实凭据也能全链路跑一遍而不动到店铺。
	APIBaseURL string

	DBPath string
}

// EnvFile 解析后的 .env 内容。os.Getenv 优先于文件值，方便 systemd/命令行注入临时覆盖。
type envSource struct {
	file map[string]string
}

func (e envSource) get(name string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return e.file[name]
}

func (e envSource) has(name string) bool {
	if _, ok := e.file[name]; ok {
		return true
	}
	_, ok := os.LookupEnv(name)
	return ok
}

// keys 汇总文件与环境变量两边的键名，供 OZON_SHOPS_1 这类编号分段扫描。
func (e envSource) keys() []string {
	seen := map[string]bool{}
	out := []string{}
	add := func(k string) {
		if k == "" || seen[k] {
			return
		}
		seen[k] = true
		out = append(out, k)
	}
	for k := range e.file {
		add(k)
	}
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		add(k)
	}
	return out
}

// Load 读 envPath（可为空，此时只依赖进程环境变量）。配置不合法就返回错误，让程序拒绝启动。
func Load(envPath string) (*Config, error) {
	src := envSource{file: map[string]string{}}
	if envPath != "" {
		values, err := readEnvFile(envPath)
		if err != nil {
			return nil, err
		}
		src.file = values
	}

	shops, err := parseShops(src)
	if err != nil {
		return nil, err
	}

	timerGroups, err := parseGroups(src, "OZON_TIMER_GROUPS")
	if err != nil {
		return nil, err
	}
	deactivateGroups, err := parseGroups(src, "OZON_ACTION_DEACTIVATE_GROUPS")
	if err != nil {
		return nil, err
	}

	timerCooldown, err := durx.Parse(orDefault(src.get("OZON_TIMER_COOLDOWN_MS"), "8h"))
	if err != nil {
		return nil, fmt.Errorf("OZON_TIMER_COOLDOWN_MS: %w", err)
	}
	deactivateCooldown, err := durx.Parse(orDefault(src.get("OZON_ACTION_DEACTIVATE_COOLDOWN_MS"), "1h"))
	if err != nil {
		return nil, fmt.Errorf("OZON_ACTION_DEACTIVATE_COOLDOWN_MS: %w", err)
	}

	timerSchedule := strings.TrimSpace(src.get("OZON_TIMER_SCHEDULE"))
	if err := validateSchedule("OZON_TIMER_SCHEDULE", timerSchedule); err != nil {
		return nil, err
	}
	deactivateSchedule := strings.TrimSpace(src.get("OZON_ACTION_DEACTIVATE_SCHEDULE"))
	if err := validateSchedule("OZON_ACTION_DEACTIVATE_SCHEDULE", deactivateSchedule); err != nil {
		return nil, err
	}
	// 没配排期就退回冷却期节拍。冷却期小于 1 分钟在这里是致命的：cronx 拒绝 @every 30s，
	// 而这种配置本身就说明有人把秒数当毫秒数填了（OZON_*_COOLDOWN_MS 这个名字的历史包袱）。
	if err := checkInterval("OZON_TIMER_COOLDOWN_MS", timerCooldown); err != nil {
		return nil, err
	}
	if err := checkInterval("OZON_ACTION_DEACTIVATE_COOLDOWN_MS", deactivateCooldown); err != nil {
		return nil, err
	}

	concurrency := 3
	if v := src.get("OZON_TASK_CONCURRENCY"); v != "" {
		n, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil || n < 1 {
			return nil, fmt.Errorf("OZON_TASK_CONCURRENCY 必须是 ≥1 的整数，当前 %q", v)
		}
		concurrency = n
	}
	apiRPS := 5.0
	if v := src.get("OZON_API_RPS"); v != "" {
		f, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		if err != nil || f < 0 {
			return nil, fmt.Errorf("OZON_API_RPS 必须是 ≥0 的小数（0 表示不限速），当前 %q", v)
		}
		apiRPS = f
	}
	apiBurst := 5
	if v := src.get("OZON_API_BURST"); v != "" {
		n, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil || n < 1 {
			return nil, fmt.Errorf("OZON_API_BURST 必须是 ≥1 的整数，当前 %q", v)
		}
		apiBurst = n
	}
	lease, err := durx.Parse(orDefault(src.get("OZON_TASK_LEASE"), "30m"))
	if err != nil {
		return nil, fmt.Errorf("OZON_TASK_LEASE: %w", err)
	}
	if lease < 10*time.Second {
		return nil, fmt.Errorf("OZON_TASK_LEASE 至少 10s（心跳按三分之一 TTL 续租，太短等于一直在抢写锁），当前 %v", lease)
	}
	retryBackoff, err := durx.Parse(orDefault(src.get("OZON_TASK_BACKOFF"), "10m"))
	if err != nil {
		return nil, fmt.Errorf("OZON_TASK_BACKOFF: %w", err)
	}

	feishuBots, err := collectFeishuBots(src)
	if err != nil {
		return nil, err
	}
	globalWebhook, err := resolveFeishuWebhook(feishuBots, src.get("FEISHU_WEBHOOK_URL"))
	if err != nil {
		return nil, fmt.Errorf("FEISHU_WEBHOOK_URL: %w", err)
	}
	// OZON_FEISHU_WEBHOOK_URL 缺省时回退通用 URL，与 JS 侧 config.js 的顺序一致
	ozonWebhook, err := resolveFeishuWebhook(feishuBots, src.get("OZON_FEISHU_WEBHOOK_URL"))
	if err != nil {
		return nil, fmt.Errorf("OZON_FEISHU_WEBHOOK_URL: %w", err)
	}
	if ozonWebhook == "" {
		ozonWebhook = globalWebhook
	}

	for i := range timerGroups {
		if timerGroups[i].FeishuWebhook, err = resolveFeishuWebhook(feishuBots, timerGroups[i].FeishuWebhook); err != nil {
			return nil, fmt.Errorf("OZON_TIMER_GROUPS[%s].feishuBot: %w", timerGroups[i].Name, err)
		}
	}
	for i := range deactivateGroups {
		if deactivateGroups[i].FeishuWebhook, err = resolveFeishuWebhook(feishuBots, deactivateGroups[i].FeishuWebhook); err != nil {
			return nil, fmt.Errorf("OZON_ACTION_DEACTIVATE_GROUPS[%s].feishuBot: %w", deactivateGroups[i].Name, err)
		}
	}

	timeout, err := durx.Parse(orDefault(src.get("OZON_API_TIMEOUT_MS"), "15s"))
	if err != nil {
		return nil, fmt.Errorf("OZON_API_TIMEOUT_MS: %w", err)
	}
	retries := 4
	if v := src.get("OZON_HTTP_RETRIES"); v != "" {
		n, err := strconv.Atoi(strings.TrimSpace(v))
		if err != nil || n < 0 {
			return nil, fmt.Errorf("OZON_HTTP_RETRIES 必须是非负整数，当前 %q", v)
		}
		retries = n
	}
	apiBaseURL, err := parseAPIBaseURL(src.get("OZON_API_BASE_URL"))
	if err != nil {
		return nil, err
	}

	return &Config{
		MachineName:        machineName(src),
		Shops:              shops,
		TimerGroups:        timerGroups,
		DeactivateGroups:   deactivateGroups,
		TimerCooldown:      timerCooldown,
		DeactivateCooldown: deactivateCooldown,
		TimerSchedule:      timerSchedule,
		DeactivateSchedule: deactivateSchedule,
		TaskConcurrency:    concurrency,
		APIRPS:             apiRPS,
		APIBurst:           apiBurst,
		LeaseTTL:           lease,
		RetryBackoff:       retryBackoff,
		OzonFeishuWebhook:  ozonWebhook,
		APITimeout:         timeout,
		HTTPRetries:        retries,
		APIBaseURL:         apiBaseURL,
		DBPath:             orDefault(src.get("OZON_DB_PATH"), "data/ozon-tasks.db"),
	}, nil
}

// validateSchedule 空串表示"没配"，由调用方回退冷却期；非空就必须能解析。
// 拼错的表达式在启动时报错，比等到凌晨三点发现"任务从来没跑过"好得多。
func validateSchedule(key, spec string) error {
	if spec == "" {
		return nil
	}
	if _, err := cronx.Parse(spec); err != nil {
		return fmt.Errorf("%s: %w", key, err)
	}
	return nil
}

// parseAPIBaseURL 校验 OZON_API_BASE_URL，空值即官方地址。
// 宁可拦得严一点：这个开关能把"写真实店铺"整个挪到别处，地址配错却照样"执行成功"，
// 比拒绝启动糟得多——要么生产被指到了 localhost（悄悄白跑），要么演练以为在打假服务
// 其实打的是 Ozon（真实改价）。
func parseAPIBaseURL(v string) (string, error) {
	const key = "OZON_API_BASE_URL"
	v = strings.TrimSpace(v)
	if v == "" {
		return DefaultAPIBaseURL, nil
	}
	u, err := url.Parse(v)
	if err != nil {
		return "", fmt.Errorf("%s 不是合法 URL: %w", key, err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("%s 只接受 http/https，当前 %q", key, v)
	}
	if u.Host == "" {
		return "", fmt.Errorf("%s 缺少主机名: %q", key, v)
	}
	// 带在 URL 里的凭据会跟着请求地址一起被打进日志，等于把密钥抄在明面上
	if u.User != nil {
		return "", fmt.Errorf("%s 不要在 URL 里带用户名密码: %q", key, v)
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("%s 只能是根地址，不要带查询串或锚点: %q", key, v)
	}
	return strings.TrimRight(u.String(), "/"), nil
}

func checkInterval(key string, d time.Duration) error {
	if d < time.Minute {
		return fmt.Errorf("%s 至少 1 分钟（当前 %v；这个间隔跑不完一轮店铺轮询）", key, d)
	}
	return nil
}

func machineName(src envSource) string {
	if v := strings.TrimSpace(src.get("MACHINE_NAME")); v != "" {
		return v
	}
	h, err := os.Hostname()
	if err != nil || h == "" {
		return "unknown-host"
	}
	return h
}

func orDefault(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return v
}

// readEnvFile 逐行读 KEY=VALUE。
// 真实的 nuc .env 里有一行不带 # 的中文注释（"后端服务端口"），所以遇到不含 '=' 的行只能跳过而不是报错——
// 这份文件同时被 httpsrv 用 dotenv 读，dotenv 也是同样宽容。
func readEnvFile(path string) (map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("读取环境文件失败 %s: %w", path, err)
	}
	defer f.Close()

	values := map[string]string{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024) // 店铺列表单行可能很长
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key = strings.TrimSpace(key)
		if key == "" {
			continue
		}
		values[key] = unquote(strings.TrimSpace(val))
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("解析环境文件失败 %s: %w", path, err)
	}
	return values, nil
}

func unquote(s string) string {
	if len(s) >= 2 {
		if (s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'') {
			return s[1 : len(s)-1]
		}
	}
	return s
}

// collectNumbered 取 BASE、BASE_1、BASE_2 ... 的值并按数字升序拼接。
// 线上 .env 把店铺列表拆成了十几段（单行太长不好维护），这一步漏了就会只读到第一段。
func collectNumbered(src envSource, base string) []string {
	var parts []string
	if v := src.get(base); v != "" {
		parts = append(parts, v)
	}
	type indexed struct {
		n int
		v string
	}
	var idx []indexed
	re := regexp.MustCompile(`^` + regexp.QuoteMeta(base) + `_(\d+)$`)
	for _, k := range src.keys() {
		m := re.FindStringSubmatch(k)
		if m == nil {
			continue
		}
		v := src.get(k)
		if v == "" {
			continue
		}
		n, _ := strconv.Atoi(m[1])
		idx = append(idx, indexed{n, v})
	}
	sort.Slice(idx, func(i, j int) bool { return idx[i].n < idx[j].n })
	for _, it := range idx {
		parts = append(parts, it.v)
	}
	return parts
}

// parseShops 解析 name:clientId:apiKey 列表；字段不全的条目静默丢弃（与 JS 版一致，避免半条凭据发出请求）
func parseShops(src envSource) ([]Shop, error) {
	parts := collectNumbered(src, "OZON_SHOPS")
	if len(parts) == 0 {
		return nil, nil
	}
	raw := strings.Join(parts, ",")
	var shops []Shop
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		fields := strings.Split(item, ":")
		if len(fields) < 3 {
			continue
		}
		name, clientID, apiKey := strings.TrimSpace(fields[0]), strings.TrimSpace(fields[1]), strings.TrimSpace(fields[2])
		if name == "" || clientID == "" || apiKey == "" {
			continue
		}
		shops = append(shops, Shop{Name: name, ClientID: clientID, APIKey: apiKey})
	}
	seen := map[string]int{}
	for _, s := range shops {
		seen[s.Name]++
	}
	for name, n := range seen {
		if n > 1 {
			return nil, fmt.Errorf("OZON_SHOPS 里店铺名重复: %s（出现 %d 次），分组将无法确定指向哪家", name, n)
		}
	}
	return shops, nil
}

// groupJSON 分组的线上格式
type groupJSON struct {
	Name      string          `json:"name"`
	Shops     []string        `json:"shops"`
	Cooldown  json.RawMessage `json:"cooldown"`
	Schedule  string          `json:"schedule"`
	FeishuBot string          `json:"feishuBot"`
}

func parseGroups(src envSource, envKey string) ([]Group, error) {
	parts := collectNumbered(src, envKey)
	if len(parts) == 0 {
		return nil, nil
	}
	var merged []groupJSON
	for i, part := range parts {
		var arr []groupJSON
		if err := json.Unmarshal([]byte(part), &arr); err != nil {
			// 单段解析失败跳过：JS 版就是这段坏了不拖累其他段
			fmt.Fprintf(os.Stderr, "警告: %s 第 %d 段不是合法 JSON 数组，已跳过: %v\n", envKey, i+1, err)
			continue
		}
		merged = append(merged, arr...)
	}

	var groups []Group
	for _, g := range merged {
		name := strings.TrimSpace(g.Name)
		var shopNames []string
		for _, s := range g.Shops {
			if s = strings.TrimSpace(s); s != "" {
				shopNames = append(shopNames, s)
			}
		}
		if name == "" || len(shopNames) == 0 {
			continue
		}
		var cooldown time.Duration
		if len(g.Cooldown) > 0 && string(g.Cooldown) != "null" {
			var s string
			if err := json.Unmarshal(g.Cooldown, &s); err != nil {
				return nil, fmt.Errorf("%s 分组 %s 的 cooldown 必须是 \"8h\" 这类时长字符串（不接受裸数字）", envKey, name)
			}
			d, err := durx.Parse(s)
			if err != nil {
				return nil, fmt.Errorf("%s 分组 %s 的 cooldown: %w", envKey, name, err)
			}
			if err := checkInterval(envKey+" 分组 "+name+" 的 cooldown", d); err != nil {
				return nil, err
			}
			cooldown = d
		}
		schedule := strings.TrimSpace(g.Schedule)
		if err := validateSchedule(fmt.Sprintf("%s 分组 %s 的 schedule", envKey, name), schedule); err != nil {
			return nil, err
		}
		groups = append(groups, Group{
			Name:          name,
			ShopNames:     shopNames,
			Cooldown:      cooldown,
			Schedule:      schedule,
			FeishuWebhook: strings.TrimSpace(g.FeishuBot),
		})
	}
	return groups, nil
}

func collectFeishuBots(src envSource) (map[string]string, error) {
	const prefix = "FEISHU_BOT_"
	bots := map[string]string{}
	for _, k := range src.keys() {
		if !strings.HasPrefix(k, prefix) {
			continue
		}
		alias := strings.TrimPrefix(k, prefix)
		if alias == "" {
			continue
		}
		raw := strings.TrimSpace(src.get(k))
		if raw == "" {
			continue
		}
		if !feishuUUIDRe.MatchString(raw) {
			return nil, fmt.Errorf("%s 的值不是合法 UUID 密钥（只填 webhook 末段，不要填整条 URL）", k)
		}
		bots[alias] = feishuWebhookBase + raw
	}
	return bots, nil
}

// resolveFeishuWebhook 只认别名。传空串得到空串（由调用方决定回退），传不认识的值直接报错——
// 静默忽略拼错的别名等于悄悄关掉通知，出问题时最难查。
func resolveFeishuWebhook(bots map[string]string, val string) (string, error) {
	s := strings.TrimSpace(val)
	if s == "" {
		return "", nil
	}
	if url, ok := bots[s]; ok {
		return url, nil
	}
	return "", fmt.Errorf("无效的飞书 webhook 别名 %q（先在 .env 里配置 FEISHU_BOT_%s）", s, s)
}

// GetShop 按店铺名查配置
func (c *Config) GetShop(name string) (Shop, bool) {
	for _, s := range c.Shops {
		if s.Name == name {
			return s, true
		}
	}
	return Shop{}, false
}

// ResolveGroups 校验分组：组名重复只留首个；引用了未定义店铺的整组跳过并回一条警告。
// 返回的 warnings 由调用方打日志——启动阶段不该把问题吞掉。
func (c *Config) ResolveGroups(groups []Group, fb GroupFallback) ([]ResolvedGroup, []string) {
	var out []ResolvedGroup
	var warns []string
	seen := map[string]bool{}
	for _, g := range groups {
		if seen[g.Name] {
			warns = append(warns, fmt.Sprintf("重复的分组名 %s，已跳过", g.Name))
			continue
		}
		var shops []Shop
		bad := false
		for _, name := range g.ShopNames {
			s, ok := c.GetShop(name)
			if !ok {
				warns = append(warns, fmt.Sprintf("分组 %s 引用了未定义的店铺 %s，整组跳过", g.Name, name))
				bad = true
				break
			}
			shops = append(shops, s)
		}
		if bad {
			continue
		}
		seen[g.Name] = true

		cooldown := g.Cooldown
		if cooldown <= 0 {
			cooldown = fb.Cooldown
		}
		webhook := g.FeishuWebhook
		if webhook == "" {
			webhook = fb.Webhook
		}
		out = append(out, ResolvedGroup{
			Name:          g.Name,
			Shops:         shops,
			Cooldown:      cooldown,
			Schedule:      ScheduleSpec(g.Schedule, fb.Schedule, cooldown),
			FeishuWebhook: webhook,
		})
	}
	return out, warns
}

// MaskKey 日志脱敏：只留头尾各 4 位，短串全打码。
func MaskKey(s string) string {
	if len(s) <= 8 {
		return "***"
	}
	return s[:4] + "…" + s[len(s)-4:]
}
