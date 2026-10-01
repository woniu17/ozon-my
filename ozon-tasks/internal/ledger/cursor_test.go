// 断点游标的核心风险是"续跑了一个陈旧游标，前面那段商品再也没人扫过"。
// 所以过期即作废这条规则必须有测试兜着。
package ledger

import (
	"path/filepath"
	"testing"
	"time"
)

func TestCursorRoundTrip(t *testing.T) {
	d := openDB(t)

	if _, found, err := d.LoadCursor("timer:YQL01", time.Hour, base); err != nil || found {
		t.Fatalf("首次运行不该有游标: found=%v err=%v", found, err)
	}

	if err := d.SaveCursor("timer:YQL01", "987654", 3000, "nuc", base); err != nil {
		t.Fatal(err)
	}
	c, found, err := d.LoadCursor("timer:YQL01", time.Hour, base.Add(5*time.Minute))
	if err != nil || !found {
		t.Fatalf("新鲜游标应可续用: found=%v err=%v", found, err)
	}
	if c.Value != "987654" || c.Processed != 3000 || c.Owner != "nuc" || c.Finished {
		t.Errorf("游标内容不对: %+v", c)
	}

	// 超过 maxAge：宁可重扫，也不带着昨天的游标继续
	if _, found, _ := d.LoadCursor("timer:YQL01", time.Hour, base.Add(2*time.Hour)); found {
		t.Error("过期游标必须作废")
	}

	// 新一轮写回要把 finished 标记清掉，否则续跑判定会一直判"已完成"
	if err := d.FinishCursor("timer:YQL01", 5000, base.Add(10*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, found, _ := d.LoadCursor("timer:YQL01", time.Hour, base.Add(11*time.Minute)); found {
		t.Error("已跑完的游标不该再被续用")
	}
	if err := d.SaveCursor("timer:YQL01", "111", 10, "nuc", base.Add(20*time.Minute)); err != nil {
		t.Fatal(err)
	}
	c, found, _ = d.LoadCursor("timer:YQL01", time.Hour, base.Add(25*time.Minute))
	if !found || c.Value != "111" {
		t.Errorf("新一轮游标应重新可用: found=%v %+v", found, c)
	}
}

func TestFinishCursorWithoutPriorSave(t *testing.T) {
	d := openDB(t)
	// 空店铺一整轮都没写过快照，也要留下"已完成"，否则 status 上看不出它跑过
	if err := d.FinishCursor("timer:EMPTY", 0, base); err != nil {
		t.Fatal(err)
	}
	all, err := d.AllCursors()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 1 || !all[0].Finished || all[0].Scope != "timer:EMPTY" {
		t.Fatalf("应有一条已完成记录: %+v", all)
	}
}

func TestAllCursorsSorted(t *testing.T) {
	d := openDB(t)
	for _, scope := range []string{"timer:B", "timer:A"} {
		if err := d.SaveCursor(scope, "x", 1, "nuc", base); err != nil {
			t.Fatal(err)
		}
	}
	all, err := d.AllCursors()
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 || all[0].Scope != "timer:A" {
		t.Fatalf("应按 scope 排序: %+v", all)
	}
}

func TestCursorSurvivesReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cursor.db")
	d, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := d.SaveCursor("timer:YQL01", "42", 1000, "nuc", base); err != nil {
		t.Fatal(err)
	}
	d.Close()

	d2, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer d2.Close()
	c, found, err := d2.LoadCursor("timer:YQL01", time.Hour, base.Add(time.Minute))
	if err != nil || !found || c.Value != "42" {
		t.Fatalf("游标必须落盘可续: found=%v c=%+v err=%v", found, c, err)
	}
}
