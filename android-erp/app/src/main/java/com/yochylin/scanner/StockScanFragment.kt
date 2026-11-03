package com.yochylin.scanner

import android.Manifest
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.text.InputType
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import coil.load
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import com.yochylin.scanner.api.Api
import com.yochylin.scanner.api.optBoolean
import com.yochylin.scanner.model.PackageListResponse
import com.yochylin.scanner.model.Pkg
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors

/**
 * 扫描入库(2026-10-27,底部导航独立页):摄像头常开连扫,上半屏相机视频,下半屏本次扫描入库记录。
 * 识别到待入库(awaiting_packaging)订单后自动向 Ozon 入库:
 *   单件商品 → 直接入库;多件商品 → 弹窗二次确认(展示商品明细)。
 * 处理完不退出,继续扫下一单(同一码 2 秒内去重,防连拍重复触发)。
 *
 * 2026-10-30 优化:
 *  - 默认关闭摄像头,点击视频区/「开始」按钮才启动,避免误开相机耗电
 *  - (2026-11)点击摄像头视频区切换 开始扫描/暂停扫码
 *  - 顶部统计(成功/待确认/失败)+ 手动输入/闪光灯/暂停/清空操作
 *  - 识别成功/失败增加提示音+震动反馈
 *  - 记录结构化(状态/单号/店铺/时间),点击跳订单详情,失败可重试
 *  - 多件确认弹窗期间暂停连扫,避免叠加触发下一单
 *  - 去重表定期清理,防止长时间使用内存增长
 *  - 入库记录展示订单商品首图缩略图
 *  - 同一订单刚入库成功又扫到(alreadyShipped):不再重复添加"已入库过"记录
 */
class StockScanFragment : Fragment() {

    private lateinit var previewView: PreviewView
    private lateinit var startOverlay: TextView
    private lateinit var hintOverlay: TextView
    private lateinit var statsText: TextView
    private lateinit var torchBtn: TextView
    private lateinit var pauseBtn: TextView
    private lateinit var recordScroll: ScrollView
    private lateinit var recordList: LinearLayout

    private var cameraProvider: ProcessCameraProvider? = null
    private var camera: Camera? = null

    private val scanExecutor = Executors.newSingleThreadExecutor()
    private val barcodeScanner = BarcodeScanning.getClient()

    /** 连扫去重:条码 → 最近处理时间,2 秒内同码跳过(防连续帧重复触发) */
    private val lastHandleAt = HashMap<String, Long>()
    private val DEBOUNCE_MS = 2000L

    /** 入库防重(2026-11):同一货件入库请求未返回前禁止重复提交(防连扫/重试/手动输入叠加触发) */
    private val submittingPackageIds = ConcurrentHashMap.newKeySet<String>()

    /** 国内快递单号格式预检:纯数字10-15位,或 1-3位字母前缀+9-15位数字(+0-2位字母后缀,如SF/JD/JT/EMS) */
    private val COURIER_NO_REGEX = Regex("^[0-9]{10,15}$|^[A-Za-z]{1,3}[0-9]{9,15}[A-Za-z]{0,2}$")

    private var paused = true
    private var torchOn = false
    private var dialogShowing = false

    private var successCount = 0
    private var pendingCount = 0
    private var failCount = 0

    private val records = mutableListOf<RecordEntry>()

    // ── 扫描日志上报(2026-11):扫码链路事件异步上报后端 op_order_log,方便排查 ──
    // 仅服务器侧落库;网络失败时进内存队列,下次触发补报(上限 100),不阻塞扫码主流程。
    private val pendingLogs = ConcurrentLinkedQueue<Map<String, Any?>>()

    private fun reportLog(
        action: String,
        message: String,
        code: String = "",
        packageId: String = "",
        postingNumber: String? = null,
        storeId: String? = null,
        result: String = "info",
        extra: Map<String, Any?>? = null
    ) {
        val detail = HashMap<String, Any?>()
        if (code.isNotBlank()) detail["code"] = code
        if (extra != null) detail.putAll(extra)
        pendingLogs.add(buildMap<String, Any?> {
            put("action", action)
            put("message", message)
            put("result", result)
            put("source", "android")
            if (packageId.isNotBlank()) put("packageId", packageId)
            if (!postingNumber.isNullOrBlank()) put("postingNumber", postingNumber)
            if (!storeId.isNullOrBlank()) put("storeId", storeId)
            if (detail.isNotEmpty()) put("detail", detail)
        })
        flushPendingLogs()
    }

    /** 逐个上报队列中的日志;失败则停止本轮,剩余留待下次触发(上限 100 防内存膨胀) */
    private fun flushPendingLogs() {
        if (pendingLogs.isEmpty() || !isAdded) return
        lifecycleScope.launch {
            while (pendingLogs.isNotEmpty()) {
                val entry = pendingLogs.peek() ?: break
                try {
                    Api.post("/admin/api/order-process/logs", entry)
                    pendingLogs.poll()
                } catch (e: Exception) {
                    while (pendingLogs.size > 100) pendingLogs.poll()
                    break
                }
            }
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var hintHideRunnable: Runnable? = null

    private val cameraPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                startCamera()
            } else {
                // 拒绝权限后恢复默认关闭状态
                paused = true
                startOverlay.visibility = View.VISIBLE
                pauseBtn.text = "▶ 开始"
                pauseBtn.setTextColor(0xFF165DFF.toInt())
                pauseBtn.setRoundedBg(0xFFE8F3FF.toInt(), 8f)
                addRecord(RecordEntry(RecordStatus.FAILED, "", message = "未获得相机权限,无法扫码入库"))
                reportLog("camera_permission_denied", "未获得相机权限,无法扫码入库", result = "failed")
            }
        }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        return inflater.inflate(R.layout.fragment_stock_scan, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        previewView = view.findViewById(R.id.previewView)
        statsText = view.findViewById(R.id.statsText)
        torchBtn = view.findViewById(R.id.torchBtn)
        pauseBtn = view.findViewById(R.id.pauseBtn)
        recordScroll = view.findViewById(R.id.recordScroll)
        recordList = view.findViewById(R.id.recordList)
        startOverlay = view.findViewById(R.id.startOverlay)
        hintOverlay = view.findViewById(R.id.scanHint)

        view.findViewById<TextView>(R.id.manualBtn).setOnClickListener { showManualInput() }
        view.findViewById<TextView>(R.id.clearBtn).setOnClickListener { clearRecords() }
        torchBtn.setOnClickListener { toggleTorch() }
        pauseBtn.setOnClickListener { togglePause() }

        // 统一按钮圆角样式
        listOf(torchBtn, pauseBtn,
            view.findViewById<TextView>(R.id.manualBtn),
            view.findViewById<TextView>(R.id.clearBtn)
        ).forEach {
            it.setRoundedBg(0xFFF2F3F5.toInt(), 8f)
            it.setTextColor(0xFF1D2129.toInt())
        }

        // 默认关闭摄像头:视频区显示遮罩,点击开始扫码;暂停按钮初始为"开始"
        // 2026-11:点击摄像头视频区切换 开始扫描/暂停扫码(暂停时显示遮罩点击开始,扫描中点击视频暂停)
        startOverlay.setRoundedBg(0xCC000000.toInt(), 10f)
        startOverlay.setOnClickListener { togglePause() }
        previewView.setOnClickListener { togglePause() }
        paused = true
        pauseBtn.text = "▶ 开始"
        pauseBtn.setTextColor(0xFF165DFF.toInt())
        pauseBtn.setRoundedBg(0xFFE8F3FF.toInt(), 8f)

        addRecord(RecordEntry(RecordStatus.SKIPPED, "", message = "📷 摄像头默认关闭,点击视频区开始扫码"))
        updateStats()
    }

    private fun hasCameraPermission(): Boolean =
        ContextCompat.checkSelfPermission(requireContext(), Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun startCamera() {
        try {
            val providerFuture = ProcessCameraProvider.getInstance(requireContext())
            providerFuture.addListener({
                val provider = providerFuture.get()
                cameraProvider = provider
                // 竞态保护:getInstance 是异步的,若回调完成前用户已切走 tab(Fragment 被 hide),
                // 或宿主已 onPause/onDestroyView,则禁止绑定相机——否则相机在后台持续连扫,
                // 在订单页等其他页面扫码时也会误触发自动入库(2026-10-29)。
                if (!isAdded || isHidden || view == null ||
                    !viewLifecycleOwner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
                ) {
                    return@addListener
                }
                val preview = Preview.Builder().build().also {
                    it.setSurfaceProvider(previewView.surfaceProvider)
                }
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                analysis.setAnalyzer(scanExecutor) { imageProxy -> processImage(imageProxy) }

                provider.unbindAll()
                camera = provider.bindToLifecycle(
                    viewLifecycleOwner,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    analysis
                )
                // 相机已启动,隐藏"点击开始"遮罩
                startOverlay.visibility = View.GONE
                // 暂停后恢复扫描时,保持用户之前的闪光灯设置
                if (torchOn) runCatching { camera?.cameraControl?.enableTorch(true) }
                reportLog("camera_start", "相机已启动,开始连扫")
            }, ContextCompat.getMainExecutor(requireContext()))
        } catch (e: Throwable) {
            addRecord(RecordEntry(RecordStatus.FAILED, "", message = "相机启动失败:${e.message ?: e.javaClass.simpleName}"))
            reportLog("camera_failed", "相机启动失败:${e.message ?: e.javaClass.simpleName}", result = "failed")
            // 启动失败恢复为默认关闭状态
            paused = true
            startOverlay.visibility = View.VISIBLE
            pauseBtn.text = "▶ 开始"
            pauseBtn.setTextColor(0xFF165DFF.toInt())
            pauseBtn.setRoundedBg(0xFFE8F3FF.toInt(), 8f)
        }
    }

    private fun processImage(imageProxy: ImageProxy) {
        val mediaImage = imageProxy.image
        if (mediaImage != null) {
            val inputImage = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
            try {
                barcodeScanner.process(inputImage)
                    .addOnSuccessListener { barcodes ->
                        barcodes.firstOrNull()?.let { b ->
                            val raw = (b.rawValue ?: b.displayValue ?: "").trim()
                            if (raw.isNotEmpty()) {
                                val now = System.currentTimeMillis()
                                val last = lastHandleAt[raw]
                                if (last == null || now - last > DEBOUNCE_MS) {
                                    // 无论是否处理都记录时间戳:弹窗/暂停期间扫到的码,
                                    // 关闭后 2 秒内不会重复触发,避免弹窗消失瞬间立刻再次弹窗
                                    lastHandleAt[raw] = now
                                    pruneDebounce()
                                    if (!paused && !dialogShowing) {
                                        reportLog("scan_received", "识别到条码", code = raw)
                                        handleCode(raw)
                                    }
                                }
                            }
                        }
                    }
                    .addOnCompleteListener {
                        imageProxy.close()
                    }
            } catch (e: Exception) {
                imageProxy.close()
            }
        } else {
            imageProxy.close()
        }
    }

    /** 去重表防内存膨胀:超过 100 条时清理 10 秒前的旧条目 */
    private fun pruneDebounce() {
        if (lastHandleAt.size > 100) {
            val cutoff = System.currentTimeMillis() - 10_000
            val it = lastHandleAt.entries.iterator()
            while (it.hasNext()) {
                if (it.next().value < cutoff) it.remove()
            }
        }
    }

    /** 条码 → 格式预检 → 全局搜索 → 命中待入库订单则自动入库 */
    private fun handleCode(code: String) {
        // 快递单号格式预检:非快递单号直接在视频区提示,不请求接口也不进记录列表
        if (!COURIER_NO_REGEX.matches(code)) {
            showScanHint("❌ 非快递单号:$code", error = true)
            playFeedback(false)
            reportLog("scan_invalid_format", "非快递单号,不处理", code = code, result = "warning")
            return
        }
        reportLog("scan_search_start", "全局搜索订单", code = code)
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val data = Api.get(
                    "/admin/api/order-process/list",
                    mapOf(
                        "tab" to "all",
                        "globalKeyword" to code,
                        "globalMode" to "ss",
                        "page" to 1,
                        "pageSize" to 50
                    )
                )
                val resp = Api.parse<PackageListResponse>(data)
                // 2026-11-08:同一采购快递单号可关联多个待入库订单,收集全部待入库订单
                // (而非只取第一个),多个时弹窗确认后一次性全部入库,避免漏入。
                val pendingPkgs = resp.packages.filter {
                    it.ozonStatus == "awaiting_packaging" && it.id.isNotEmpty()
                }
                if (pendingPkgs.isEmpty()) {
                    // 未命中待入库订单:只在视频区提示,不进记录列表
                    if (resp.packages.isEmpty()) {
                        showScanHint("❌ 未找到订单:$code", error = true)
                        playFeedback(false)
                        reportLog("scan_not_found", "未找到订单", code = code, result = "failed")
                    } else {
                        // 找到订单但不在待入库状态:明确提示原因(而非笼统"无待入库订单")。
                        // 例如已入库(Ozon awaiting_registration/awaiting_deliver 等)提示"已入库",
                        // 其它状态提示具体状态,方便用户判断是否误扫/需人工处理。
                        val hit = resp.packages.firstOrNull { it.id.isNotEmpty() }
                        val status = hit?.ozonStatus.orEmpty()
                        val pn = hit?.postingNumber ?: ""
                        val shippedStates = setOf(
                            "awaiting_registration", "awaiting_deliver",
                            "driver_pickup", "delivering", "delivered"
                        )
                        if (status in shippedStates) {
                            showScanHint("✅ 该订单已入库:${pn.ifBlank { code }}", error = false)
                            playFeedback(true)
                            reportLog(
                                "scan_status_skipped", "该订单已入库,不重复入库",
                                code = code, postingNumber = pn.ifBlank { null },
                                storeId = hit?.storeId,
                                result = "warning", extra = mapOf("status" to status)
                            )
                        } else {
                            // 有订单但当前状态不可入库:识别成功(有单),播放成功音提示
                            showScanHint(
                                "⏭ 订单状态[${status.ifBlank { "未知" }}]不可入库:${pn.ifBlank { code }}",
                                error = false
                            )
                            playFeedback(true)
                            reportLog(
                                "scan_status_skipped", "订单状态 ${status.ifBlank { "未知" }} 不可入库",
                                code = code, postingNumber = pn.ifBlank { null },
                                storeId = hit?.storeId,
                                result = "warning", extra = mapOf("status" to status)
                            )
                        }
                    }
                    return@launch
                }
                // 多个待入库订单(同一采购单拆成多单):弹窗列出全部,确认后批量入库
                if (pendingPkgs.size > 1) {
                    showMultiPackageConfirm(pendingPkgs, code)
                    return@launch
                }
                val stockPkg = pendingPkgs[0]
                val totalQty = (stockPkg.items?.sumOf { it.quantity ?: 0.0 } ?: 0.0).toLong()
                // 订单商品首图(入库记录展示,取第一个商品图片)
                val imageUrl = stockPkg.items?.firstOrNull()?.picUrl
                if (totalQty > 1) {
                    showMultiConfirm(stockPkg, code, totalQty, imageUrl)
                } else {
                    doShip(stockPkg.id, stockPkg.postingNumber, code, imageUrl, stockPkg.storeId)
                }
            } catch (e: Exception) {
                failCount++
                addRecord(RecordEntry(RecordStatus.FAILED, code, message = "查询失败:${e.message ?: e.javaClass.simpleName}"))
                playFeedback(false)
                reportLog("scan_search_failed", "查询失败:${e.message ?: e.javaClass.simpleName}", code = code, result = "failed")
                updateStats()
            }
        }
    }

    /** 视频区临时提示:2 秒后自动消失,用于非快递单号/未找到订单等不写记录列表的场景 */
    private fun showScanHint(text: String, error: Boolean) {
        if (view == null) return
        hintOverlay.text = text
        hintOverlay.setTextColor(Color.WHITE)
        hintOverlay.setRoundedBg(if (error) 0xD93026CC.toInt() else 0x99000000.toInt(), 10f)
        hintOverlay.visibility = View.VISIBLE
        hintHideRunnable?.let { mainHandler.removeCallbacks(it) }
        val r = Runnable { hintOverlay.visibility = View.GONE }
        hintHideRunnable = r
        mainHandler.postDelayed(r, 2000)
    }

    /** 多件商品:弹窗二次确认,展示商品图片/明细 + OGL 拆单建议;弹窗期间暂停连扫防叠加触发 */
    private fun showMultiConfirm(pkg: Pkg, code: String, totalQty: Long, imageUrl: String? = null) {
        if (!isAdded) return
        pendingCount++
        dialogShowing = true
        updateStats()
        addRecord(RecordEntry(RecordStatus.PENDING, code, pkg.id, pkg.postingNumber, "共 $totalQty 件,待确认", imageUrl))
        reportLog(
            "multi_confirm_show", "多件商品弹窗二次确认",
            code = code, packageId = pkg.id, postingNumber = pkg.postingNumber, storeId = pkg.storeId,
            result = "pending", extra = mapOf("totalQty" to totalQty)
        )

        var confirmed = false
        val dialog = requireContext().buildMultiItemConfirmDialog(
            pkg = pkg,
            confirmText = "确认入库",
            onConfirm = {
                confirmed = true
                doShip(pkg.id, pkg.postingNumber, code, imageUrl, pkg.storeId)
            }
        )
        dialog.setOnDismissListener {
            dialogShowing = false
            pendingCount = (pendingCount - 1).coerceAtLeast(0)
            if (!confirmed) {
                reportLog(
                    "multi_confirm_cancel", "用户取消多件入库确认",
                    code = code, packageId = pkg.id, postingNumber = pkg.postingNumber, storeId = pkg.storeId,
                    result = "warning"
                )
            }
            updateStats()
        }
        dialog.show()
    }

    /** 同一采购单关联多个待入库订单:弹窗列出全部订单,确认后一次性全部入库(2026-11-08) */
    private fun showMultiPackageConfirm(pkgs: List<Pkg>, code: String) {
        if (!isAdded) return
        pendingCount++
        dialogShowing = true
        updateStats()
        val first = pkgs.first()
        val postingNumbers = pkgs.map { it.postingNumber ?: it.id }
        addRecord(
            RecordEntry(
                RecordStatus.PENDING, code, first.id, first.postingNumber,
                "关联 ${pkgs.size} 个待入库订单,待确认", first.items?.firstOrNull()?.picUrl
            )
        )
        reportLog(
            "multi_package_confirm_show", "同一快递单关联多个待入库订单,弹窗确认",
            code = code, packageId = first.id, postingNumber = first.postingNumber, storeId = first.storeId,
            result = "pending", extra = mapOf("count" to pkgs.size, "postingNumbers" to postingNumbers)
        )

        val message = buildString {
            append("该快递单关联 ${pkgs.size} 个待入库订单:\n")
            for (pkg in pkgs) {
                val qty = pkg.items?.sumOf { it.quantity ?: 0.0 }?.toLong() ?: 0
                append("· ${pkg.postingNumber ?: pkg.id}")
                if (!pkg.storeName.isNullOrBlank()) append(" (${pkg.storeName})")
                append(" 共 $qty 件\n")
            }
            append("\n将向 Ozon 确认全部订单为一个货件(不拆分),是否全部入库?")
        }

        var confirmed = false
        val dialog = AlertDialog.Builder(requireContext())
            .setTitle("批量入库确认")
            .setMessage(message)
            .setPositiveButton("全部入库") { _, _ ->
                confirmed = true
                reportLog(
                    "multi_package_confirm_confirm", "确认批量入库 ${pkgs.size} 个订单",
                    code = code, packageId = first.id, postingNumber = first.postingNumber, storeId = first.storeId,
                    result = "info", extra = mapOf("count" to pkgs.size, "postingNumbers" to postingNumbers)
                )
                for (pkg in pkgs) {
                    doShip(pkg.id, pkg.postingNumber, code, pkg.items?.firstOrNull()?.picUrl, pkg.storeId)
                }
            }
            .setNegativeButton("取消", null)
            .create()
        dialog.setOnDismissListener {
            dialogShowing = false
            pendingCount = (pendingCount - 1).coerceAtLeast(0)
            if (!confirmed) {
                reportLog(
                    "multi_package_confirm_cancel", "用户取消批量入库确认",
                    code = code, packageId = first.id, postingNumber = first.postingNumber, storeId = first.storeId,
                    result = "warning"
                )
            }
            updateStats()
        }
        dialog.show()
    }

    /** 调用入库接口并记录结果 */
    private fun doShip(packageId: String, postingNumber: String?, code: String, imageUrl: String? = null, storeId: String? = null) {
        // 防重(2026-11):同一货件入库请求未返回时,忽略重复扫码/重复点击,避免叠加触发两次入库
        if (!submittingPackageIds.add(packageId)) {
            showScanHint("⏳ 该订单正在入库处理中:$postingNumber", error = false)
            reportLog(
                "ship_duplicate_ignored", "入库请求处理中,忽略重复提交",
                code = code, packageId = packageId, postingNumber = postingNumber, storeId = storeId,
                result = "warning"
            )
            return
        }
        reportLog("ship_submit", "提交入库", code = code, packageId = packageId, postingNumber = postingNumber, storeId = storeId, result = "pending")
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = Api.post("/admin/api/order-process/ship", mapOf("packageId" to packageId)).asJsonObject
                if (r.optBoolean("alreadyShipped")) {
                    // 该订单已入库过:若记录列表中最新一条就是本订单(刚入库成功又扫到),
                    // 不再重复添加"已入库过"记录,仅视频区提示,避免连扫/弹窗后重复刷记录。
                    val latest = records.firstOrNull()
                    if (latest?.packageId == packageId) {
                        showScanHint("✅ 已入库过:$postingNumber", error = false)
                        playFeedback(true)
                    } else {
                        successCount++
                        addRecord(RecordEntry(RecordStatus.SUCCESS, code, packageId, postingNumber, "已入库过", imageUrl))
                        playFeedback(true)
                        reportLog("ship_already", "该订单已入库过", code = code, packageId = packageId, postingNumber = postingNumber, storeId = storeId, result = "warning")
                    }
                } else {
                    val title = if (r.optBoolean("pending")) "入库指令已提交" else "入库成功"
                    successCount++
                    addRecord(RecordEntry(RecordStatus.SUCCESS, code, packageId, postingNumber, title, imageUrl))
                    playFeedback(true)
                    reportLog(
                        if (r.optBoolean("pending")) "ship_pending" else "ship_success",
                        title, code = code, packageId = packageId, postingNumber = postingNumber, storeId = storeId,
                        result = if (r.optBoolean("pending")) "pending" else "success"
                    )
                }
            } catch (e: Exception) {
                failCount++
                addRecord(RecordEntry(
                    RecordStatus.FAILED, code, packageId, postingNumber,
                    "入库失败:${e.message ?: e.javaClass.simpleName}",
                    imageUrl
                ))
                playFeedback(false)
                reportLog("ship_failed", "入库失败:${e.message ?: e.javaClass.simpleName}", code = code, packageId = packageId, postingNumber = postingNumber, storeId = storeId, result = "failed")
            } finally {
                // 无论成功/失败都解除防重,允许用户重新扫码重试
                submittingPackageIds.remove(packageId)
            }
            updateStats()
        }
    }

    // ── 顶部操作 ──

    private fun showManualInput() {
        val input = EditText(requireContext()).apply {
            hint = "输入货件号 / 条码"
            inputType = InputType.TYPE_CLASS_TEXT
            textSize = 14f
        }
        AlertDialog.Builder(requireContext())
            .setTitle("手动输入条码")
            .setView(input)
            .setPositiveButton("入库") { _, _ ->
                val code = input.text.toString().trim()
                if (code.isNotEmpty()) {
                    reportLog("manual_input", "手动输入条码", code = code)
                    handleCode(code)
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    private fun toggleTorch() {
        val cam = camera ?: return
        torchOn = !torchOn
        runCatching { cam.cameraControl.enableTorch(torchOn) }
        torchBtn.text = if (torchOn) "🔦 关灯" else "🔦 开灯"
        torchBtn.setTextColor(if (torchOn) 0xFF165DFF.toInt() else 0xFF1D2129.toInt())
        torchBtn.setRoundedBg(if (torchOn) 0xFFE8F3FF.toInt() else 0xFFF2F3F5.toInt(), 8f)
    }

    private fun togglePause() {
        if (paused) {
            startScanning()
        } else {
            // 暂停时释放相机,省电且闪光灯熄灭
            paused = true
            cameraProvider?.unbindAll()
            camera = null
            torchOn = false
            torchBtn.text = "🔦 开灯"
            torchBtn.setTextColor(0xFF1D2129.toInt())
            torchBtn.setRoundedBg(0xFFF2F3F5.toInt(), 8f)
            pauseBtn.text = "▶ 开始"
            pauseBtn.setTextColor(0xFF165DFF.toInt())
            pauseBtn.setRoundedBg(0xFFE8F3FF.toInt(), 8f)
            startOverlay.visibility = View.VISIBLE
            reportLog("scan_pause", "暂停扫码")
        }
    }

    /** 点击视频区/开始按钮:启动相机开始连扫 */
    private fun startScanning() {
        if (!paused) return
        paused = false
        reportLog("scan_resume", "开始扫码")
        pauseBtn.text = "⏸ 暂停"
        pauseBtn.setTextColor(0xFF1D2129.toInt())
        pauseBtn.setRoundedBg(0xFFF2F3F5.toInt(), 8f)
        if (hasCameraPermission()) {
            startCamera()
        } else {
            cameraPermission.launch(Manifest.permission.CAMERA)
        }
    }

    private fun clearRecords() {
        records.clear()
        recordList.removeAllViews()
        successCount = 0
        pendingCount = 0
        failCount = 0
        reportLog("records_clear", "清空本次扫描记录")
        updateStats()
    }

    private fun updateStats() {
        statsText.text = "✅ 成功 $successCount · ⏳ 待确认 $pendingCount · ❌ 失败 $failCount"
    }

    // ── 扫码反馈(提示音 + 震动) ──
    // 2026-11-08:成功=双响 beep(清晰可辨),失败=NACK 低频错误音;有订单(待入库/已入库/不可入库)统一成功音,
    // 没有订单/非快递单号/查询失败/入库失败统一错误音。

    private fun playFeedback(success: Boolean) {
        runCatching {
            val vibrator = requireContext().getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            if (Build.VERSION.SDK_INT >= 26) {
                vibrator.vibrate(
                    VibrationEffect.createOneShot(
                        if (success) 60 else 200,
                        VibrationEffect.DEFAULT_AMPLITUDE
                    )
                )
            } else {
                // API 24-25 无 VibrationEffect,使用单次震动模式
                vibrator.vibrate(longArrayOf(0L, if (success) 60 else 200), -1)
            }
        }
        if (success) {
            // 双响成功音:beep → 短暂间隔 → 再 beep(更易与错误音区分)
            playTone(ToneGenerator.TONE_PROP_BEEP, 120)
            Handler(Looper.getMainLooper()).postDelayed(
                { playTone(ToneGenerator.TONE_PROP_BEEP, 180) },
                130
            )
        } else {
            // 错误音:低频 NACK 长鸣
            playTone(ToneGenerator.TONE_PROP_NACK, 300)
        }
    }

    private fun playTone(toneType: Int, durationMs: Int) {
        runCatching {
            // 2026-11-08:改用媒体流+最大音量,扫码提示音明显加大;且通知静音时仍可响(只要媒体音量>0)
            val tone = ToneGenerator(AudioManager.STREAM_MUSIC, 100)
            tone.startTone(toneType, durationMs)
            // 延迟释放,避免提示音被截断
            Handler(Looper.getMainLooper()).postDelayed({ runCatching { tone.release() } }, durationMs + 200L)
        }
    }

    // ── 记录列表 ──

    private fun addRecord(record: RecordEntry) {
        records.add(0, record)
        view?.post { renderRecord(record) }
    }

    private fun renderRecord(record: RecordEntry) {
        if (view == null) return
        val density = resources.displayMetrics.density
        fun dp(v: Int) = (v * density + 0.5f).toInt()
        val ctx = requireContext()

        val mainText = record.postingNumber?.takeIf { it.isNotBlank() }
            ?: record.code.takeIf { it.isNotBlank() }
        val timeText = SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(record.time))

        val mainTv = TextView(ctx).apply {
            text = mainText ?: record.message
            textSize = if (mainText != null) 14f else 13f
            setTextColor(if (mainText != null) 0xFF1D2129.toInt() else record.status.color)
            setTypeface(null, if (mainText != null) Typeface.BOLD else Typeface.NORMAL)
            setMaxLines(1)
            ellipsize = android.text.TextUtils.TruncateAt.MIDDLE
        }

        val textCol = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            addView(mainTv)
            if (mainText != null) {
                addView(TextView(ctx).apply {
                    text = "${record.message} · $timeText"
                    textSize = 12f
                    setTextColor(record.status.color)
                    setMaxLines(2)
                }, LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(2) })
            }
        }

        val row = LinearLayout(ctx).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(8), 0, dp(8))
            // 商品缩略图(入库记录展示订单商品图片,无图记录不占位)
            if (!record.imageUrl.isNullOrBlank()) {
                addView(ImageView(ctx).apply {
                    layoutParams = LinearLayout.LayoutParams(dp(52), dp(52)).apply {
                        rightMargin = dp(8)
                    }
                    scaleType = ImageView.ScaleType.CENTER_CROP
                    background = android.graphics.drawable.GradientDrawable().apply {
                        cornerRadius = dp(6).toFloat()
                        setColor(0xFFF2F3F5.toInt())
                    }
                    clipToOutline = true
                    load(record.imageUrl)
                })
            }
            addView(TextView(ctx).apply {
                text = record.status.emoji
                textSize = 16f
            }, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { rightMargin = dp(8) })
            addView(textCol, LinearLayout.LayoutParams(
                0,
                LinearLayout.LayoutParams.WRAP_CONTENT,
                1f
            ))
            if (record.status == RecordStatus.FAILED && record.packageId.isNotBlank()) {
                addView(TextView(ctx).apply {
                    text = "重试"
                    textSize = 12f
                    setTextColor(Color.WHITE)
                    setTypeface(null, Typeface.BOLD)
                    setPadding(dp(12), dp(5), dp(12), dp(5))
                    setRoundedBg(0xFF165DFF.toInt(), 8f)
                    setOnClickListener {
                        doShip(record.packageId, record.postingNumber, record.code, record.imageUrl)
                    }
                }, LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { leftMargin = dp(8) })
            }
            if (record.packageId.isNotBlank()) {
                setOnClickListener {
                    startActivity(Intent(requireContext(), OrderDetailActivity::class.java)
                        .putExtra("packageId", record.packageId))
                }
            }
        }

        val divider = View(ctx).apply {
            setBackgroundColor(0xFFF2F3F5.toInt())
        }

        recordList.addView(row, 0)
        recordList.addView(divider, 1, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            dp(1)
        ))
        recordScroll.post { recordScroll.smoothScrollTo(0, 0) }
    }

    // ── 生命周期(防后台误扫) ──

    override fun onResume() {
        super.onResume()
        // 仅当前可见且未暂停时才启动相机:已切到其他 tab 的入库页不应在后台重启相机连扫,
        // 否则在订单页等页面扫码时会误触发自动入库(2026-10-29)。
        if (!isHidden && !paused && hasCameraPermission()) startCamera()
    }

    override fun onPause() {
        super.onPause()
        cameraProvider?.unbindAll()
        camera = null
    }

    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (hidden) {
            cameraProvider?.unbindAll()
            camera = null
        } else if (isResumed && !paused) {
            if (hasCameraPermission()) startCamera()
            else cameraPermission.launch(Manifest.permission.CAMERA)
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        hintHideRunnable?.let { mainHandler.removeCallbacks(it) }
        hintHideRunnable = null
        cameraProvider?.unbindAll()
        camera = null
        cameraProvider = null
    }

    override fun onDestroy() {
        super.onDestroy()
        // barcodeScanner 是 ML Kit 共享单例,不在此关闭,交由进程生命周期统一释放
        scanExecutor.shutdown()
    }

    // ── 记录模型 ──

    private enum class RecordStatus(val emoji: String, val color: Int) {
        SUCCESS("✅", 0xFF00B42A.toInt()),
        FAILED("❌", 0xFFF53F3F.toInt()),
        PENDING("⏸", 0xFFD97706.toInt()),
        SKIPPED("⏭", 0xFF86909C.toInt()),
        NOT_FOUND("❓", 0xFF86909C.toInt())
    }

    private data class RecordEntry(
        val status: RecordStatus,
        val code: String,
        val packageId: String = "",
        val postingNumber: String? = null,
        val message: String,
        val imageUrl: String? = null, // 订单商品首图(入库记录展示用)
        val time: Long = System.currentTimeMillis()
    )

    private fun fmtQty(q: Double): String =
        if (q == q.toLong().toDouble()) q.toLong().toString() else q.toString()
}