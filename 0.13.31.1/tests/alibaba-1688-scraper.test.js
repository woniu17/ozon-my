const assert = require("assert");
const fs = require("fs");
const path = require("path");

function loadPlaywright() {
  try {
    return require("playwright");
  } catch {}

  return require(path.join(__dirname, "..", "..", "backend", "node_modules", "playwright"));
}

const { chromium } = loadPlaywright();

const scraperPath = path.join(__dirname, "..", "content", "alibaba-1688.js");
const pageDataHookPath = path.join(__dirname, "..", "content", "1688-page-data-hook.js");
const manifestPath = path.join(__dirname, "..", "manifest.json");

async function with1688Page(fn) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const captured = [];

  await page.route("https://detail.1688.com/offer/663133463590.html", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `
        <!doctype html>
        <html>
          <head>
            <title>多规格测试商品 - 阿里巴巴</title>
            <meta property="og:image" content="https://cbu01.alicdn.com/img/ibank/main-01.jpg_.webp">
            <script>
              window.__INIT_DATA__ = {
                product: {
                  offerId: "663133463590",
                  title: "多规格测试商品",
                  imageList: [
                    "https://cbu01.alicdn.com/img/ibank/main-01.jpg_.webp",
                    "https://cbu01.alicdn.com/img/ibank/main-02.jpg_.webp",
                    "https://cbu01.alicdn.com/img/ibank/detail-01.jpg_.webp",
                    "https://cbu01.alicdn.com/img/ibank/detail-02.jpg_.webp"
                  ],
                  videoUrl: "https://cloud.video.taobao.com/play/u/1/p/1/e/6/t/1/abc.mp4",
                  videoCover: "https://cbu01.alicdn.com/img/ibank/video-cover.jpg_.webp",
                  skuModel: {
                    skuProps: [
                      {
                        prop: "颜色",
                        value: [
                          { name: "红色", imageUrl: "https://cbu01.alicdn.com/img/ibank/red.jpg_.webp" },
                          { name: "蓝色", imageUrl: "https://cbu01.alicdn.com/img/ibank/blue.jpg_.webp" }
                        ]
                      },
                      {
                        prop: "尺码",
                        value: [
                          { name: "S" },
                          { name: "M" },
                          { name: "L" }
                        ]
                      }
                    ],
                    skuMap: {
                      "颜色:红色;尺码:S": { skuId: "sku-red-s", price: "11.10", stock: 2 },
                      "颜色:红色;尺码:M": { skuId: "sku-red-m", price: "12.20", stock: 3 },
                      "颜色:红色;尺码:L": { skuId: "sku-red-l", price: "13.30", stock: 4 },
                      "颜色:蓝色;尺码:S": { skuId: "sku-blue-s", price: "14.40", stock: 5 },
                      "颜色:蓝色;尺码:M": { skuId: "sku-blue-m", price: "15.50", stock: 6 },
                      "颜色:蓝色;尺码:L": { skuId: "sku-blue-l", price: "16.60", stock: 7 }
                    }
                  }
                }
              };
            </script>
          </head>
          <body>
            <div class="title-content">多规格测试商品</div>
            <div class="module-od-main-price">¥ 11.10</div>
            <div class="preview-list">
              <img src="https://cbu01.alicdn.com/img/ibank/main-01.jpg_.webp">
            </div>
            <div class="module-od-sku-selection">
              <div class="feature-item">
                <div class="feature-title">颜色</div>
                <div class="expand-view-list">
                  <div class="expand-view-item"><img src="https://cbu01.alicdn.com/img/ibank/red.jpg_.webp"><span>红色</span></div>
                  <div class="expand-view-item"><img src="https://cbu01.alicdn.com/img/ibank/blue.jpg_.webp"><span>蓝色</span></div>
                </div>
              </div>
              <div class="feature-item">
                <div class="feature-title">尺码</div>
                <div class="expand-view-list">
                  <div class="expand-view-item"><span>S</span></div>
                  <div class="expand-view-item"><span>M</span></div>
                  <div class="expand-view-item"><span>L</span></div>
                </div>
              </div>
            </div>
          </body>
        </html>
      `,
    });
  });

  await page.exposeFunction("__capture1688Message", (message) => {
    captured.push(message);
    return { ok: true, data: { result: { id: "collect-id", action: "created" } } };
  });

  await page.goto("https://detail.1688.com/offer/663133463590.html");
  await page.evaluate(() => {
    window.addEventListener("message", (event) => {
      const data = event.data || {};
      if (data.source !== "jzc-test-1688-capture") return;
      window.__capture1688Message(data.message);
    });
  });
  if (fs.existsSync(pageDataHookPath)) {
    await page.addScriptTag({ path: pageDataHookPath });
  }

  const client = await page.context().newCDPSession(page);
  const { frameTree } = await client.send("Page.getFrameTree");
  const frameId = frameTree.frame.id;
  const { executionContextId } = await client.send("Page.createIsolatedWorld", {
    frameId,
    worldName: "jzc-1688-test-isolated",
    grantUniveralAccess: true,
  });

  await client.send("Runtime.evaluate", {
    contextId: executionContextId,
    expression: `
    window.chrome = {
      runtime: {
        lastError: null,
        sendMessage(message, cb) {
          window.postMessage({ source: "jzc-test-1688-capture", message }, "*");
          cb({ ok: true, data: { result: { id: "collect-id", action: "created" } } });
        },
      },
    };
    `,
  });
  const scraperSource = fs.readFileSync(scraperPath, "utf8");
  await client.send("Runtime.evaluate", {
    contextId: executionContextId,
    expression: `${scraperSource}\n//# sourceURL=alibaba-1688-isolated.js`,
  });
  await page.waitForSelector('[data-action="collect-product"]');

  try {
    await fn(page, captured);
  } finally {
    await browser.close();
  }
}

async function testStructuredSkuMapIsCollectedAsCombinations() {
  await with1688Page(async (page, captured) => {
    await page.click('[data-action="collect-product"]');
    await page.waitForFunction(() => document.querySelector('[data-action="collect-product"]')?.disabled === false);

    const message = captured.find((m) => m.action === "pushSourceCollect");
    assert(message, "expected pushSourceCollect message");
    const raw = message.raw;

    assert.strictEqual(raw.variants.length, 6);
    assert.deepStrictEqual(
      raw.variants.map((v) => v.sku),
      ["sku-red-s", "sku-red-m", "sku-red-l", "sku-blue-s", "sku-blue-m", "sku-blue-l"],
    );
    assert.deepStrictEqual(raw.variants[0].aspectValues, { 颜色: "红色", 尺码: "S" });
    assert.strictEqual(raw.variants[5].price, "16.60");
    assert.strictEqual(raw.variants[5].stock, 7);
    assert.ok(raw.variants[3].image.includes("blue.jpg"));

    assert.strictEqual(raw.mainImages.length, 6);
    assert.ok(raw.mainImages.some((url) => url.includes("detail-02.jpg")));
    assert.strictEqual(raw.videoUrl, "https://cloud.video.taobao.com/play/u/1/p/1/e/6/t/1/abc.mp4");
    assert.ok(raw.videoCover.includes("video-cover.jpg"));
  });
}

function testManifestInjectsPageDataHookInMainWorld() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const scripts = manifest.content_scripts || [];
  const hookIndex = scripts.findIndex((entry) => (entry.js || []).includes("content/1688-page-data-hook.js"));
  const scraperIndex = scripts.findIndex((entry) => (entry.js || []).includes("content/alibaba-1688.js"));

  assert(hookIndex >= 0, "expected manifest to inject 1688 page data hook");
  assert(scraperIndex >= 0, "expected manifest to inject 1688 scraper");
  assert.strictEqual(scripts[hookIndex].world, "MAIN");
  assert(hookIndex < scraperIndex, "page data hook should be declared before isolated scraper");
}

(async () => {
  testManifestInjectsPageDataHookInMainWorld();
  await testStructuredSkuMapIsCollectedAsCombinations();
  console.log("alibaba-1688 scraper tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
