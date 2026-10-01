// 配置解析单测：重点盯住"和 httpsrv 吃同一份 .env"这件事——
// 编号分段顺序、不带 = 的注释行、时长字符串的严格性，这几处两边行为不一致就会静默跑偏。
package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeFile(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("写临时 env 失败: %v", err)
	}
	return path
}

func TestReadEnvFileToleratesRealWorldLines(t *testing.T) {
	path := writeFile(t, strings.Join([]string{
		"# 注释行",
		"",
		"后端服务端口", // nuc 线上真实存在的裸中文注释（不带 =），dotenv 同样跳过
		"export FOO=bar",
		`QUOTED="双引号 值"`,
		"SINGLE='单引号'",
		"EMPTY=",
		"  SPACED =  两端留白  ",
		"WITH_EQUALS=a=b",
	}, "\n"))

	values, err := readEnvFile(path)
	if err != nil {
		t.Fatalf("readEnvFile 报错: %v", err)
	}
	want := map[string]string{
		"FOO":         "bar",
		"QUOTED":      "双引号 值",
		"SINGLE":      "单引号",
		"EMPTY":       "",
		"SPACED":      "两端留白",
		"WITH_EQUALS": "a=b",
	}
	for k, v := range want {
		if values[k] != v {
			t.Errorf("%s = %q，期望 %q", k, values[k], v)
		}
	}
	if _, ok := values["后端服务端口"]; ok {
		t.Error("不带 = 的注释行不该被当成键")
	}
	if _, ok := values["# 注释行"]; ok {
		t.Error("# 注释行不该被当成键")
	}
}

func TestLoadMergesNumberedShopSegmentsInAscendingOrder(t *testing.T) {
	// _10 必须排在 _2 之后：按字符串排会得到 1,10,2，线上十几段店铺就会乱序
	path := writeFile(t, strings.Join([]string{
		"OZON_SHOPS=A:1001:keyA",
		"OZON_SHOPS_2=C:1003:keyC",
		"OZON_SHOPS_10=D:1010:keyD",
		"OZON_SHOPS_1=B:1002:keyB",
	}, "\n"))
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load 报错: %v", err)
	}
	var names []string
	for _, s := range cfg.Shops {
		names = append(names, s.Name)
	}
	want := []string{"A", "B", "C", "D"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Errorf("店铺顺序 = %v，期望 %v", names, want)
	}
}

func TestParseShopsDropsIncompleteEntries(t *testing.T) {
	path := writeFile(t, "OZON_SHOPS=完整:1:k,只有两段:2,缺密钥::,白名单:3:k3")
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load 报错: %v", err)
	}
	if len(cfg.Shops) != 2 {
		t.Fatalf("期望 2 家有效店铺，实际 %d: %+v", len(cfg.Shops), cfg.Shops)
	}
	if cfg.Shops[0].Name != "完整" || cfg.Shops[1].Name != "白名单" {
		t.Errorf("店铺解析错位: %+v", cfg.Shops)
	}
}

func TestParseShopsRejectsDuplicateNames(t *testing.T) {
	path := writeFile(t, "OZON_SHOPS=同店:1:k1,同店:2:k2")
	if _, err := Load(path); err == nil {
		t.Fatal("重复店铺名应当拒绝启动：分组引用名字时无法确定指向哪家")
	} else if !strings.Contains(err.Error(), "重复") {
		t.Errorf("报错信息不明确: %v", err)
	}
}

func TestProcessEnvOverridesFile(t *testing.T) {
	path := writeFile(t, "OZON_SHOPS=文件店:1:k1")
	t.Setenv("OZON_SHOPS", "环境店:2:k2")
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load 报错: %v", err)
	}
	if len(cfg.Shops) != 1 || cfg.Shops[0].Name != "环境店" {
		t.Errorf("进程环境变量应优先于文件值，实际: %+v", cfg.Shops)
	}
}

func TestLoadGroupsCooldownAndFeishuAlias(t *testing.T) {
	path := writeFile(t, strings.Join([]string{
		"OZON_SHOPS=店一:1:k1,店二:2:k2",
		`OZON_TIMER_GROUPS=[{"name":"组A","shops":["店一","店二"],"cooldown":"2h","feishuBot":"OPS"}]`,
		`OZON_ACTION_DEACTIVATE_GROUPS=[{"name":"移除组","shops":["店一"]}]`,
		"FEISHU_BOT_OPS=11111111-2222-3333-4444-555555555555",
		"OZON_TIMER_COOLDOWN_MS=8h",
	}, "\n"))
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load 报错: %v", err)
	}
	if len(cfg.TimerGroups) != 1 {
		t.Fatalf("分组数不对: %+v", cfg.TimerGroups)
	}
	g := cfg.TimerGroups[0]
	if g.Cooldown != 2*time.Hour {
		t.Errorf("cooldown = %v，期望 2h", g.Cooldown)
	}
	if g.FeishuWebhook != feishuWebhookBase+"11111111-2222-3333-4444-555555555555" {
		t.Errorf("别名没展开成 webhook URL: %q", g.FeishuWebhook)
	}
	if len(cfg.DeactivateGroups) != 1 || cfg.DeactivateGroups[0].Cooldown != 0 {
		t.Errorf("未配 cooldown 的分组应留 0 由调用方回退，实际: %+v", cfg.DeactivateGroups)
	}

	resolved, warns := cfg.ResolveGroups(cfg.TimerGroups, GroupFallback{
		Schedule: cfg.TimerSchedule, Cooldown: cfg.TimerCooldown, Webhook: cfg.OzonFeishuWebhook,
	})
	if len(warns) != 0 {
		t.Errorf("不该有警告: %v", warns)
	}
	if len(resolved) != 1 || len(resolved[0].Shops) != 2 {
		t.Fatalf("分组展开失败: %+v", resolved)
	}

	dg, _ := cfg.ResolveGroups(cfg.DeactivateGroups, GroupFallback{Cooldown: cfg.DeactivateCooldown})
	if dg[0].Cooldown != time.Hour {
		t.Errorf("回退冷却期 = %v，期望 1h（OZON_ACTION_DEACTIVATE_COOLDOWN_MS 默认值）", dg[0].Cooldown)
	}
	if dg[0].Schedule != "@every 1h0m0s" {
		t.Errorf("没配排期的分组应退回冷却期节拍，实际 %q", dg[0].Schedule)
	}
}

func TestScheduleFallbackOrder(t *testing.T) {
	// 分组 > 全局 > "@every 冷却期"：切换期 .env 里没写 schedule 时必须得出与 JS 相同的节拍
	if got := ScheduleSpec("30 4 * * *", "0 */6 * * *", 8*time.Hour); got != "30 4 * * *" {
		t.Errorf("分组排期应最优先，实际 %q", got)
	}
	if got := ScheduleSpec("", "0 */6 * * *", 8*time.Hour); got != "0 */6 * * *" {
		t.Errorf("应回退到全局排期，实际 %q", got)
	}
	if got := ScheduleSpec("  ", " ", 90*time.Minute); got != "@every 1h30m0s" {
		t.Errorf("应回退成 @every 冷却期，实际 %q", got)
	}

	cfg := &Config{Shops: []Shop{{Name: "店一", ClientID: "1", APIKey: "k1"}}}
	resolved, _ := cfg.ResolveGroups([]Group{
		{Name: "有排期", ShopNames: []string{"店一"}, Schedule: "@daily"},
		{Name: "跟随全局", ShopNames: []string{"店一"}},
	}, GroupFallback{Schedule: "0 3 * * *", Cooldown: 8 * time.Hour})
	if len(resolved) != 2 {
		t.Fatalf("展开失败: %+v", resolved)
	}
	if resolved[0].Schedule != "@daily" {
		t.Errorf("分组排期被覆盖: %+v", resolved[0])
	}
	if resolved[1].Schedule != "0 3 * * *" {
		t.Errorf("全局排期没生效: %+v", resolved[1])
	}
}

func TestLoadRejectsBadSchedule(t *testing.T) {
	for _, tc := range []struct{ label, env string }{
		{"全局排期拼错", "OZON_TIMER_SCHEDULE=0 0 * *"},
		{"分组排期拼错", `OZON_TIMER_GROUPS=[{"name":"组A","shops":["店一"],"schedule":"每天一点"}]`},
	} {
		path := writeFile(t, strings.Join([]string{"OZON_SHOPS=店一:1:k1", tc.env}, "\n"))
		if _, err := Load(path); err == nil {
			t.Errorf("%s 应拒绝启动：等到凌晨才发现任务没跑就太晚了", tc.label)
		}
	}
}

func TestLoadRejectsSubMinuteInterval(t *testing.T) {
	// 名字带 _MS 是 JS 侧历史包袱，这里必须挡住"把秒当毫秒填"的配置
	path := writeFile(t, "OZON_SHOPS=店一:1:k1\nOZON_TIMER_COOLDOWN_MS=30s")
	if _, err := Load(path); err == nil {
		t.Fatal("冷却期小于 1 分钟应报错（@every 30s 会被 cronx 拒绝，且根本跑不完一轮）")
	}
}

func TestLoadRateLimitAndLeaseDefaults(t *testing.T) {
	cfg, err := Load(writeFile(t, strings.Join([]string{
		"OZON_SHOPS=店一:1:k1",
		"OZON_TASK_CONCURRENCY=5",
		"OZON_API_RPS=2.5",
		"OZON_API_BURST=4",
		"OZON_TASK_LEASE=45m",
		"OZON_TASK_BACKOFF=15m",
	}, "\n")))
	if err != nil {
		t.Fatalf("Load 报错: %v", err)
	}
	if cfg.TaskConcurrency != 5 || cfg.APIRPS != 2.5 || cfg.APIBurst != 4 {
		t.Errorf("并发/限速没读进来: %+v", cfg)
	}
	if cfg.LeaseTTL != 45*time.Minute || cfg.RetryBackoff != 15*time.Minute {
		t.Errorf("租约/退避没读进来: lease=%v backoff=%v", cfg.LeaseTTL, cfg.RetryBackoff)
	}

	def, err := Load(writeFile(t, "OZON_SHOPS=店一:1:k1"))
	if err != nil {
		t.Fatalf("Load 报错: %v", err)
	}
	if def.TaskConcurrency != 3 || def.APIRPS != 5 || def.APIBurst != 5 {
		t.Errorf("默认并发/限速不对: concurrency=%d rps=%v burst=%d", def.TaskConcurrency, def.APIRPS, def.APIBurst)
	}
	if def.LeaseTTL != 30*time.Minute || def.RetryBackoff != 10*time.Minute {
		t.Errorf("默认租约/退避不对: lease=%v backoff=%v", def.LeaseTTL, def.RetryBackoff)
	}
	if def.TimerSchedule != "" || def.DeactivateSchedule != "" {
		t.Errorf("默认应无排期（退回冷却期节拍），实际 timer=%q deact=%q", def.TimerSchedule, def.DeactivateSchedule)
	}

	bad := writeFile(t, "OZON_SHOPS=店一:1:k1\nOZON_TASK_CONCURRENCY=0")
	if _, err := Load(bad); err == nil {
		t.Fatal("并发数 0 应报错")
	}
	bad2 := writeFile(t, "OZON_SHOPS=店一:1:k1\nOZON_API_RPS=-1")
	if _, err := Load(bad2); err == nil {
		t.Fatal("负限速应报错")
	}
}

func TestLoadRejectsBareNumberCooldown(t *testing.T) {
	path := writeFile(t, strings.Join([]string{
		"OZON_SHOPS=店一:1:k1",
		`OZON_TIMER_GROUPS=[{"name":"组A","shops":["店一"],"cooldown":14400000}]`,
	}, "\n"))
	_, err := Load(path)
	if err == nil {
		t.Fatal("裸数字 cooldown 应当报错：把毫秒当秒写是冷却期最常见的配错方式")
	}
	if !strings.Contains(err.Error(), "不接受裸数字") {
		t.Errorf("报错信息应点明裸数字，实际: %v", err)
	}
}

func TestLoadSkipsBadJsonSegmentButKeepsOthers(t *testing.T) {
	path := writeFile(t, strings.Join([]string{
		"OZON_SHOPS=店一:1:k1",
		"OZON_TIMER_GROUPS=[坏 JSON",
		`OZON_TIMER_GROUPS_1=[{"name":"组B","shops":["店一"]}]`,
	}, "\n"))
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("单段 JSON 坏了不该让整个配置加载失败: %v", err)
	}
	if len(cfg.TimerGroups) != 1 || cfg.TimerGroups[0].Name != "组B" {
		t.Errorf("好的那一段应被保留: %+v", cfg.TimerGroups)
	}
}

func TestLoadRejectsUnknownFeishuAlias(t *testing.T) {
	path := writeFile(t, strings.Join([]string{
		"OZON_SHOPS=店一:1:k1",
		`OZON_TIMER_GROUPS=[{"name":"组A","shops":["店一"],"feishuBot":"OPS"}]`,
	}, "\n"))
	if _, err := Load(path); err == nil {
		t.Fatal("引用了未配置的别名应报错，静默忽略等于悄悄关掉通知")
	}

	path2 := writeFile(t, "FEISHU_WEBHOOK_URL=拼错的别名")
	if _, err := Load(path2); err == nil {
		t.Fatal("全局 webhook 引用未配置别名应报错")
	}
}

func TestLoadRejectsNonUUIDFeishuAliasValue(t *testing.T) {
	path := writeFile(t, "FEISHU_BOT_OPS=https://open.feishu.cn/open-apis/bot/v2/hook/11111111-2222-3333-4444-555555555555")
	if _, err := Load(path); err == nil {
		t.Fatal("别名值填整条 URL 应报错，只允许填末段 UUID")
	}
}

func TestResolveGroupsWarnings(t *testing.T) {
	cfg := &Config{
		Shops:         []Shop{{Name: "店一", ClientID: "1", APIKey: "k1"}},
		TimerCooldown: 8 * time.Hour,
	}
	groups := []Group{
		{Name: "重复", ShopNames: []string{"店一"}},
		{Name: "重复", ShopNames: []string{"店一"}},
		{Name: "有未定义店铺", ShopNames: []string{"店一", "不存在"}},
	}
	resolved, warns := cfg.ResolveGroups(groups, GroupFallback{Cooldown: cfg.TimerCooldown, Webhook: "https://hook"})
	if len(resolved) != 1 || resolved[0].Name != "重复" {
		t.Errorf("期望只保留首个同名牌: %+v", resolved)
	}
	if len(warns) != 2 {
		t.Fatalf("期望 2 条警告，实际 %d: %v", len(warns), warns)
	}
	if resolved[0].Cooldown != 8*time.Hour || resolved[0].FeishuWebhook != "https://hook" {
		t.Errorf("缺省项没回退到全局: %+v", resolved[0])
	}
}

func TestLoadDefaultsAndMissingEnvFile(t *testing.T) {
	cfg, err := Load(writeFile(t, "OZON_SHOPS=店一:1:k1"))
	if err != nil {
		t.Fatalf("Load 报错: %v", err)
	}
	if cfg.TimerCooldown != 8*time.Hour {
		t.Errorf("默认定时器冷却应为 8h，实际 %v", cfg.TimerCooldown)
	}
	if cfg.DeactivateCooldown != time.Hour {
		t.Errorf("默认移除冷却应为 1h，实际 %v", cfg.DeactivateCooldown)
	}
	if cfg.APITimeout != 15*time.Second {
		t.Errorf("默认超时应为 15s，实际 %v", cfg.APITimeout)
	}
	if cfg.HTTPRetries != 4 {
		t.Errorf("默认重试次数应为 4，实际 %d", cfg.HTTPRetries)
	}
	if cfg.DBPath != "data/ozon-tasks.db" {
		t.Errorf("默认库路径异常: %q", cfg.DBPath)
	}
	if cfg.MachineName == "" {
		t.Error("MachineName 应回退到主机名")
	}

	if _, err := Load(filepath.Join(t.TempDir(), "不存在.env")); err == nil {
		t.Error("指定的 env 文件不存在时应报错，避免拿着空配置静默不干活")
	}
}

func TestMaskKeyHidesSecrets(t *testing.T) {
	if got := MaskKey("短"); got != "***" {
		t.Errorf("短串应全打码，实际 %q", got)
	}
	got := MaskKey("abcdefghijklmnop")
	if strings.Contains(got, "efgh") {
		t.Errorf("中间内容没打码: %q", got)
	}
	if !strings.HasPrefix(got, "abcd") || !strings.HasSuffix(got, "mnop") {
		t.Errorf("期望保留头尾各 4 位，实际 %q", got)
	}
	// 报错信息里绝不能带出完整密钥
	cfg := &Config{Shops: []Shop{{Name: "店一", ClientID: "1", APIKey: "abcdefghijklmnop"}}}
	if strings.Contains(cfg.Shops[0].String(), "abcdefghijklmnop") {
		t.Error("Shop.String() 泄露了完整密钥")
	}
}

func TestLoadAPIBaseURL(t *testing.T) {
	// 环境变量优先于文件值：外部 export 过 OZON_API_BASE_URL 会让默认分支永远测不到
	t.Setenv("OZON_API_BASE_URL", "")
	def, err := Load(writeFile(t, "OZON_SHOPS=店一:1:k1"))
	if err != nil {
		t.Fatalf("默认配置不该报错: %v", err)
	}
	if def.APIBaseURL != DefaultAPIBaseURL {
		t.Errorf("没配时应为官方地址，实际 %q", def.APIBaseURL)
	}

	// 尾斜杠必须去掉：拼出来就成了 //v3/product/list，反向代理会当成另一个路径
	got, err := Load(writeFile(t, strings.Join([]string{
		"OZON_SHOPS=店一:1:k1",
		"OZON_API_BASE_URL=http://127.0.0.1:8081///",
	}, "\n")))
	if err != nil {
		t.Fatalf("Load 报错: %v", err)
	}
	if got.APIBaseURL != "http://127.0.0.1:8081" {
		t.Errorf("尾斜杠没去掉: %q", got.APIBaseURL)
	}

	// 带路径前缀是合法场景（挂在 nginx 反代后面），只去尾斜杠
	prefixed, err := Load(writeFile(t, strings.Join([]string{
		"OZON_SHOPS=店一:1:k1",
		"OZON_API_BASE_URL=https://proxy.internal/ozon",
	}, "\n")))
	if err != nil {
		t.Fatalf("带前缀的地址应被接受: %v", err)
	}
	if prefixed.APIBaseURL != "https://proxy.internal/ozon" {
		t.Errorf("前缀被吃掉了: %q", prefixed.APIBaseURL)
	}

	// 这些写法都会让"演练"悄悄变成"打生产"或者"整轮白跑"，必须拒绝启动
	for _, bad := range []string{
		"api-seller.ozon.ru",          // 漏了协议
		"ftp://api-seller.ozon.ru",    // 协议不对
		"http://u:p@api.ozon.ru",      // 凭据混在地址里会被打进日志
		"http://127.0.0.1:8081?dry=1", // 查询串不属于根地址
		"notaurl",                     // 根本不是 URL
	} {
		if _, err := Load(writeFile(t, "OZON_SHOPS=店一:1:k1\nOZON_API_BASE_URL="+bad)); err == nil {
			t.Errorf("非法地址 %q 应当拒绝启动", bad)
		}
	}
}

// 总开关的方言必须和 httpsrv 逐字一致，而且两个键的缺省方向刻意相反：
//   - OZON_TIMER_ENABLED：JS 用 `=== 'true'`，默认关。这里松一寸，就会出现
//     "JS 侧已经关了、Go 侧照跑"，而两侧没有共享锁，那是最坏的双写状态。
//   - OZON_ACTION_DEACTIVATE_ENABLED：JS 原本根本没这个开关（一直启用），
//     缺省写成"关"就等于部署这段代码时把生产在跑的任务静默停掉。
func TestEnabledSwitchDialectAndDefaults(t *testing.T) {
	cases := []struct {
		name           string
		env            string
		wantTimer      bool
		wantDeactivate bool
	}{
		{"两个键都没配", "OZON_SHOPS=店一:1:k1", false, true},
		{"显式 true", "OZON_TIMER_ENABLED=true\nOZON_ACTION_DEACTIVATE_ENABLED=true", true, true},
		{"显式 false", "OZON_TIMER_ENABLED=true\nOZON_ACTION_DEACTIVATE_ENABLED=false", true, false},
		{"TRUE 与 1 在 JS 方言里都不算开", "OZON_TIMER_ENABLED=TRUE\nOZON_ACTION_DEACTIVATE_ENABLED=1", false, true},
		{"FALSE 不等于 false，仍算开", "OZON_ACTION_DEACTIVATE_ENABLED=FALSE", false, true},
		{"两端留白算开", "OZON_TIMER_ENABLED= true ", true, true},
	}
	for _, c := range cases {
		cfg, err := Load(writeFile(t, c.env))
		if err != nil {
			t.Fatalf("%s: Load 报错: %v", c.name, err)
		}
		if cfg.TimerEnabled != c.wantTimer || cfg.DeactivateEnabled != c.wantDeactivate {
			t.Errorf("%s: 定时器=%v 活动移除=%v，期望 %v / %v",
				c.name, cfg.TimerEnabled, cfg.DeactivateEnabled, c.wantTimer, c.wantDeactivate)
		}
	}
}

// 命令行/环境注入要能压过文件值：这是关掉总开关后临时手工跑一班的唯一出口，
// 不该为了放行一次而改生产 .env。
func TestEnabledSwitchOverriddenByProcessEnv(t *testing.T) {
	t.Setenv("OZON_TIMER_ENABLED", "true")
	path := writeFile(t, "OZON_SHOPS=店一:1:k1\nOZON_TIMER_ENABLED=false\nOZON_ACTION_DEACTIVATE_ENABLED=false")
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load 报错: %v", err)
	}
	if !cfg.TimerEnabled {
		t.Error("环境变量里的 true 应压过文件里的 false")
	}
	// 没被环境变量覆盖的键仍取文件值
	if cfg.DeactivateEnabled {
		t.Error("OZON_ACTION_DEACTIVATE_ENABLED 只写在文件里，应按文件的 false 关掉")
	}
}
