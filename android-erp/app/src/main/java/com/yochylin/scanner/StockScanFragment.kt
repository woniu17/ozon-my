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
import java.util.concurrent.Executors

/**
 * 扫描备货(2026-10-27,底部导航独立页):摄像头常开连扫,上半屏相机视频,下半屏本次扫描备货记录。
 * 识别到待备货(awaiting_packaging)订单后自动向 Ozon 备货:
 *   单件商品 → 直接备货;多件商品 → 弹窗二次确认(展示商品明细)。
 * 处理完不退出,继续扫下一单(同一码 2 秒内去重,防连拍重复触发)。
 *
 * 2026-10-30 优化:
 *  - 默认关闭摄像头,点击视频区/「开始」按钮才启动,避免误开相机耗电
 *  - 顶部统计(成功/待确认/失败)+ 手动输入/闪光灯/暂停/清空操作
 *  - 识别成功/失败增加提示音+震动反馈
 *  - 记录结构化(状态/单号/店铺/时间),点击跳订单详情,失败可重试
 *  - 多件确认弹窗期间暂停连扫,避免叠加触发下一单
 *  - 去重表定期清理,防止长时间使用内存增长
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

    /** 国内快递单号格式预检:纯数字10-15位,或 1-3位字母前缀+9-15位数字(+0-2位字母后缀,如SF/JD/JT/EMS) */
    private val COURIER_NO_REGEX = Regex("^[0-9]{10,15}$|^[A-Za-z]{1,3}[0-9]{9,15}[A-Za-z]{0,2}$")

    private var paused = true
    private var torchOn = false
    private var dialogShowing = false

    private var successCount = 0
    private var pendingCount = 0
    private var failCount = 0

    private val records = mutableListOf<RecordEntry>()

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
                addRecord(RecordEntry(RecordStatus.FAILED, "", message = "未获得相机权限,无法扫码备货"))
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
        startOverlay.setRoundedBg(0xCC000000.toInt(), 10f)
        startOverlay.setOnClickListener { startScanning() }
        previewView.setOnClickListener { if (paused) startScanning() }
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
                // 在订单页等其他页面扫码时也会误触发自动备货(2026-10-29)。
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
            }, ContextCompat.getMainExecutor(requireContext()))
        } catch (e: Throwable) {
            addRecord(RecordEntry(RecordStatus.FAILED, "", message = "相机启动失败:${e.message ?: e.javaClass.simpleName}"))
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

    /** 条码 → 格式预检 → 全局搜索 → 命中待备货订单则自动备货 */
    private fun handleCode(code: String) {
        // 快递单号格式预检:非快递单号直接在视频区提示,不请求接口也不进记录列表
        if (!COURIER_NO_REGEX.matches(code)) {
            showScanHint("❌ 非快递单号:$code", error = true)
            playFeedback(false)
            return
        }
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
                val stockPkg = resp.packages.firstOrNull {
                    it.ozonStatus == "awaiting_packaging" && it.id.isNotEmpty()
                }
                if (stockPkg == null) {
                    // 未命中待备货订单:只在视频区提示,不进记录列表
                    if (resp.packages.isEmpty()) {
                        showScanHint("❌ 未找到订单:$code", error = true)
                        playFeedback(false)
                    } else {
                        showScanHint("⏭ 无待备货订单:$code", error = false)
                    }
                    return@launch
                }
                val totalQty = (stockPkg.items?.sumOf { it.quantity ?: 0.0 } ?: 0.0).toLong()
                if (totalQty > 1) {
                    showMultiConfirm(stockPkg, code, totalQty)
                } else {
                    doShip(stockPkg.id, stockPkg.postingNumber, code)
                }
            } catch (e: Exception) {
                failCount++
                addRecord(RecordEntry(RecordStatus.FAILED, code, message = "查询失败:${e.message ?: e.javaClass.simpleName}"))
                playFeedback(false)
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

    /** 多件商品:弹窗二次确认,展示商品明细;弹窗期间暂停连扫防叠加触发 */
    private fun showMultiConfirm(pkg: Pkg, code: String, totalQty: Long) {
        if (!isAdded) return
        pendingCount++
        dialogShowing = true
        updateStats()
        addRecord(RecordEntry(RecordStatus.PENDING, code, pkg.id, pkg.postingNumber, "共 $totalQty 件,待确认"))

        val itemsText = pkg.items
            ?.joinToString("\n") { it ->
                val name = it.title ?: it.offerId ?: it.sku ?: "商品"
                "· $name ×${fmtQty(it.quantity ?: 0.0)}"
            }
            ?.takeIf { it.isNotBlank() }

        val message = buildString {
            append("货件 ${pkg.postingNumber}\n")
            if (!pkg.storeName.isNullOrBlank()) append("店铺:${pkg.storeName}\n")
            append("共 $totalQty 件商品")
            if (itemsText != null) append(":\n$itemsText")
            append("\n\n将向 Ozon 确认全部商品为一个货件(不拆分)。")
        }

        val dialog = AlertDialog.Builder(requireContext())
            .setTitle("备货确认")
            .setMessage(message)
            .setPositiveButton("确认备货") { _, _ ->
                doShip(pkg.id, pkg.postingNumber, code)
            }
            .setNegativeButton("取消", null)
            .create()
        dialog.setOnDismissListener {
            dialogShowing = false
            pendingCount = (pendingCount - 1).coerceAtLeast(0)
            updateStats()
        }
        dialog.show()
    }

    /** 调用备货接口并记录结果 */
    private fun doShip(packageId: String, postingNumber: String?, code: String) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = Api.post("/admin/api/order-process/ship", mapOf("packageId" to packageId)).asJsonObject
                val title = when {
                    r.optBoolean("alreadyShipped") -> "已备货过"
                    r.optBoolean("pending") -> "备货指令已提交"
                    else -> "备货成功"
                }
                successCount++
                addRecord(RecordEntry(RecordStatus.SUCCESS, code, packageId, postingNumber, title))
                playFeedback(true)
            } catch (e: Exception) {
                failCount++
                addRecord(RecordEntry(
                    RecordStatus.FAILED, code, packageId, postingNumber,
                    "备货失败:${e.message ?: e.javaClass.simpleName}"
                ))
                playFeedback(false)
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
            .setPositiveButton("备货") { _, _ ->
                val code = input.text.toString().trim()
                if (code.isNotEmpty()) handleCode(code)
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
        }
    }

    /** 点击视频区/开始按钮:启动相机开始连扫 */
    private fun startScanning() {
        if (!paused) return
        paused = false
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
        updateStats()
    }

    private fun updateStats() {
        statsText.text = "✅ 成功 $successCount · ⏳ 待确认 $pendingCount · ❌ 失败 $failCount"
    }

    // ── 扫码反馈(提示音 + 震动) ──

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
        runCatching {
            val tone = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 80)
            tone.startTone(
                if (success) ToneGenerator.TONE_PROP_BEEP else ToneGenerator.TONE_PROP_NACK,
                if (success) 120 else 300
            )
            // 延迟释放,避免提示音被截断
            Handler(Looper.getMainLooper()).postDelayed({ runCatching { tone.release() } }, 500)
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
                        doShip(record.packageId, record.postingNumber, record.code)
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
        // 仅当前可见且未暂停时才启动相机:已切到其他 tab 的备货页不应在后台重启相机连扫,
        // 否则在订单页等页面扫码时会误触发自动备货(2026-10-29)。
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
        val time: Long = System.currentTimeMillis()
    )

    private fun fmtQty(q: Double): String =
        if (q == q.toLong().toDouble()) q.toLong().toString() else q.toString()
}