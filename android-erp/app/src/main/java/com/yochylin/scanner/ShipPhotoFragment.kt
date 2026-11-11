package com.yochylin.scanner

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.Typeface
import android.media.AudioManager
import android.media.ToneGenerator
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.MediaStore
import android.text.InputType
import android.util.Base64
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
import androidx.core.content.FileProvider
import androidx.fragment.app.Fragment
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import com.yochylin.scanner.api.Api
import com.yochylin.scanner.api.optBoolean
import com.yochylin.scanner.api.optString
import com.yochylin.scanner.model.PackageListResponse
import com.yochylin.scanner.model.Pkg
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors

/**
 * 拍照发运(2026-11-12,底部导航独立页):参考扫描入库的连扫模式。
 * 上半屏摄像头连扫,扫到货件后自动调起系统相机拍摄包装,拍完自动压缩上传,
 * 上传成功回到扫码界面继续扫下一件——扫码/拍照/上传全程连贯,不打断连扫。
 * 下半屏展示本次拍照发运记录,失败可重试,点击记录可跳订单详情查看照片。
 */
class ShipPhotoFragment : Fragment() {

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

    /** 拍照/上传防重:同一货件请求未返回前禁止重复触发(防连扫/重试叠加) */
    private val submittingPackageIds = ConcurrentHashMap.newKeySet<String>()

    private var paused = true
    private var torchOn = false
    private var dialogShowing = false

    private var successCount = 0
    private var pendingCount = 0
    private var failCount = 0

    private val records = mutableListOf<RecordEntry>()

    // ── 扫描日志上报(2026-11):扫码链路事件异步上报后端 op_order_log,方便排查 ──
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

    // ── 拍照发运:系统相机拍照后压缩上传包装照片 ──
    private var pendingPhotoPkg: Pkg? = null
    private var pendingPhotoFile: File? = null
    private var pendingRecord: RecordEntry? = null

    private val cameraPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                startCamera()
            } else {
                paused = true
                startOverlay.visibility = View.VISIBLE
                pauseBtn.text = "▶ 开始"
                pauseBtn.setTextColor(0xFF165DFF.toInt())
                pauseBtn.setRoundedBg(0xFFE8F3FF.toInt(), 8f)
                addRecord(RecordEntry(RecordStatus.FAILED, "", message = "未获得相机权限,无法扫码拍照"))
                reportLog("camera_permission_denied", "未获得相机权限,无法扫码拍照", result = "failed")
            }
        }

    private val cameraLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val pkg = pendingPhotoPkg ?: return@registerForActivityResult
        pendingPhotoPkg = null
        val file = pendingPhotoFile ?: return@registerForActivityResult
        pendingPhotoFile = null
        val rec = pendingRecord
        pendingRecord = null
        if (result.resultCode == Activity.RESULT_OK && file.exists()) {
            uploadShipPhoto(pkg, file, rec)
        } else {
            // 取消拍照:该货件未拍,解除防重并更新记录
            submittingPackageIds.remove(pkg.id)
            pendingCount = (pendingCount - 1).coerceAtLeast(0)
            if (rec != null) {
                replaceRecord(rec.copy(status = RecordStatus.SKIPPED, message = "已取消拍照"))
            }
            playFeedback(false)
            reportLog(
                "photo_capture_cancel", "用户取消拍照",
                code = rec?.code ?: "", packageId = pkg.id, postingNumber = pkg.postingNumber, storeId = pkg.storeId,
                result = "warning"
            )
            updateStats()
        }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        return inflater.inflate(R.layout.fragment_ship_photo, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        previewView = view.findViewById(R.id.shipPhotoPreviewView)
        statsText = view.findViewById(R.id.shipPhotoStatsText)
        torchBtn = view.findViewById(R.id.shipPhotoTorchBtn)
        pauseBtn = view.findViewById(R.id.shipPhotoPauseBtn)
        recordScroll = view.findViewById(R.id.shipPhotoRecordScroll)
        recordList = view.findViewById(R.id.shipPhotoRecordList)
        startOverlay = view.findViewById(R.id.shipPhotoStartOverlay)
        hintOverlay = view.findViewById(R.id.shipPhotoScanHint)

        view.findViewById<TextView>(R.id.shipPhotoManualBtn).setOnClickListener { showManualInput() }
        view.findViewById<TextView>(R.id.shipPhotoClearBtn).setOnClickListener { clearRecords() }
        torchBtn.setOnClickListener { toggleTorch() }
        pauseBtn.setOnClickListener { togglePause() }

        listOf(torchBtn, pauseBtn,
            view.findViewById<TextView>(R.id.shipPhotoManualBtn),
            view.findViewById<TextView>(R.id.shipPhotoClearBtn)
        ).forEach {
            it.setRoundedBg(0xFFF2F3F5.toInt(), 8f)
            it.setTextColor(0xFF1D2129.toInt())
        }

        // 默认关闭摄像头:视频区显示遮罩,点击开始扫码;暂停按钮初始为"开始"
        startOverlay.setRoundedBg(0xCC000000.toInt(), 10f)
        startOverlay.setOnClickListener { togglePause() }
        previewView.setOnClickListener { togglePause() }
        paused = true
        pauseBtn.text = "▶ 开始"
        pauseBtn.setTextColor(0xFF165DFF.toInt())
        pauseBtn.setRoundedBg(0xFFE8F3FF.toInt(), 8f)

        addRecord(RecordEntry(RecordStatus.SKIPPED, "", message = "📷 摄像头默认关闭,点击视频区开始扫码拍照"))
        updateStats()
    }

    // ── 相机 ──

    private fun hasCameraPermission(): Boolean =
        ContextCompat.checkSelfPermission(requireContext(), Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun startCamera() {
        try {
            val providerFuture = ProcessCameraProvider.getInstance(requireContext())
            providerFuture.addListener({
                val provider = providerFuture.get()
                cameraProvider = provider
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
                startOverlay.visibility = View.GONE
                if (torchOn) runCatching { camera?.cameraControl?.enableTorch(true) }
                reportLog("camera_start", "相机已启动,开始连扫拍照")
            }, ContextCompat.getMainExecutor(requireContext()))
        } catch (e: Throwable) {
            addRecord(RecordEntry(RecordStatus.FAILED, "", message = "相机启动失败:${e.message ?: e.javaClass.simpleName}"))
            reportLog("camera_failed", "相机启动失败:${e.message ?: e.javaClass.simpleName}", result = "failed")
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

    private fun pruneDebounce() {
        if (lastHandleAt.size > 100) {
            val cutoff = System.currentTimeMillis() - 10_000
            val it = lastHandleAt.entries.iterator()
            while (it.hasNext()) {
                if (it.next().value < cutoff) it.remove()
            }
        }
    }

    /** 视频区临时提示:2 秒后自动消失,用于未找到货件等不写记录列表的场景 */
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

    // ── 核心流程:扫码 → 命中货件 → 自动调相机 → 上传 → 继续扫下一件 ──

    private fun handleCode(code: String) {
        reportLog("scan_search_start", "搜索货件", code = code)
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
                val hitPkgs = resp.packages.filter { it.id.isNotEmpty() }
                if (hitPkgs.isNotEmpty()) {
                    playFeedback(true)
                    reportLog("scan_hit", "命中 ${hitPkgs.size} 个货件", code = code, result = "success")
                    if (hitPkgs.size > 1) {
                        showPkgPicker(hitPkgs, code)
                    } else {
                        startPhotoFlow(hitPkgs[0], code)
                    }
                } else {
                    showScanHint("❌ 未找到货件:$code", error = true)
                    playFeedback(false)
                    reportLog("scan_not_found", "未找到货件", code = code, result = "failed")
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

    /** 同一码命中多个货件:弹窗列出,选择要拍照的货件 */
    private fun showPkgPicker(pkgs: List<Pkg>, code: String) {
        if (!isAdded) return
        dialogShowing = true
        val lines = pkgs.map { pkg ->
            val items = pkg.items ?: emptyList()
            val names = items.mapNotNull { it.title }.distinct().take(2)
            val qty = items.sumOf { it.quantity ?: 0.0 }.toLong()
            buildString {
                append(pkg.postingNumber ?: pkg.id)
                append("  [${pkg.storeName ?: ""}]")
                if (names.isNotEmpty()) append("\n${names.joinToString(" / ")}")
                append(" · $qty 件")
            }
        }.toTypedArray()
        AlertDialog.Builder(requireContext())
            .setTitle("命中 ${pkgs.size} 个货件,选择要拍照的")
            .setItems(lines) { _, which ->
                dialogShowing = false
                startPhotoFlow(pkgs[which], code)
            }
            .setNegativeButton("取消") { _, _ -> dialogShowing = false }
            .setOnDismissListener { dialogShowing = false }
            .show()
    }

    /** 进入拍照流程:记录待拍照 → 调起系统相机 */
    private fun startPhotoFlow(pkg: Pkg, code: String) {
        if (!isAdded) return
        if (!submittingPackageIds.add(pkg.id)) {
            showScanHint("⏳ 该货件正在处理中:${pkg.postingNumber}", error = false)
            playProcessing()
            return
        }
        pendingCount++
        val rec = RecordEntry(
            RecordStatus.PENDING, code, pkg.id, pkg.postingNumber,
            "等待拍照…", pkg.storeName, pkg.storeId
        )
        addRecord(rec)
        reportLog(
            "photo_flow_start", "扫码命中,调起相机拍照",
            code = code, packageId = pkg.id, postingNumber = pkg.postingNumber, storeId = pkg.storeId,
            result = "pending"
        )

        val dir = File(requireContext().cacheDir, "ship_photos").apply { mkdirs() }
        val file = File(dir, "ship_${System.currentTimeMillis()}.jpg")
        val uri = FileProvider.getUriForFile(requireContext(), "${requireContext().packageName}.fileprovider", file)
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
            putExtra(MediaStore.EXTRA_OUTPUT, uri)
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        if (intent.resolveActivity(requireContext().packageManager) != null) {
            pendingPhotoPkg = pkg
            pendingPhotoFile = file
            pendingRecord = rec
            cameraLauncher.launch(intent)
        } else {
            submittingPackageIds.remove(pkg.id)
            pendingCount = (pendingCount - 1).coerceAtLeast(0)
            failCount++
            replaceRecord(rec.copy(status = RecordStatus.FAILED, message = "未找到相机应用"))
            playFeedback(false)
            updateStats()
        }
    }

    /** 压缩上传包装照片;成功/失败更新记录并解除防重 */
    private fun uploadShipPhoto(pkg: Pkg, file: File, rec: RecordEntry?) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                if (rec != null) replaceRecord(rec.copy(status = RecordStatus.PENDING, message = "正在上传照片…"))
                val b64 = withContext(Dispatchers.IO) { compressAndEncodePhoto(file) }
                val resp = Api.post(
                    "/admin/api/order-process/photo-upload",
                    mapOf(
                        "storeId" to (pkg.storeId ?: ""),
                        "packageId" to pkg.id,
                        "postingNumber" to (pkg.postingNumber ?: ""),
                        "imageBase64" to b64
                    )
                )
                val url = resp.asJsonObject.optString("photoUrl")
                pendingCount = (pendingCount - 1).coerceAtLeast(0)
                successCount++
                if (rec != null) {
                    replaceRecord(rec.copy(status = RecordStatus.SUCCESS, message = "包装照片上传成功"))
                }
                playFeedback(true)
                reportLog(
                    "photo_upload_success", "包装照片上传成功",
                    code = rec?.code ?: "", packageId = pkg.id, postingNumber = pkg.postingNumber, storeId = pkg.storeId,
                    result = "success", extra = mapOf("photoUrl" to url)
                )
            } catch (e: Exception) {
                pendingCount = (pendingCount - 1).coerceAtLeast(0)
                failCount++
                if (rec != null) {
                    replaceRecord(rec.copy(
                        status = RecordStatus.FAILED,
                        message = "上传失败:${e.message ?: e.javaClass.simpleName}",
                        filePath = file.absolutePath
                    ))
                }
                playFeedback(false)
                reportLog(
                    "photo_upload_failed", "上传失败:${e.message ?: e.javaClass.simpleName}",
                    code = rec?.code ?: "", packageId = pkg.id, postingNumber = pkg.postingNumber, storeId = pkg.storeId,
                    result = "failed"
                )
            } finally {
                submittingPackageIds.remove(pkg.id)
                updateStats()
            }
        }
    }

    /** 上传失败后点击"重试":文件还在则直接重新上传,否则重新拍照 */
    private fun retryUpload(rec: RecordEntry) {
        val file = rec.filePath?.let { File(it) }
        val pkg = Pkg(id = rec.packageId, postingNumber = rec.postingNumber, storeId = rec.storeId)
        if (file != null && file.exists()) {
            uploadShipPhoto(pkg, file, rec)
        } else {
            startPhotoFlow(pkg, rec.code)
        }
    }

    /** 解码 → 等比压缩到最长边 1600px → JPEG 85 → base64(裸编码,后端兼容) */
    private fun compressAndEncodePhoto(file: File): String {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(file.absolutePath, bounds)
        var sample = 1
        val maxDim = 1600
        while ((bounds.outWidth / sample) > maxDim || (bounds.outHeight / sample) > maxDim) {
            sample *= 2
        }
        val bmp = BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: throw IllegalStateException("图片解码失败")
        val w = bmp.width
        val h = bmp.height
        val scale = if (w >= h) maxDim.toFloat() / w else maxDim.toFloat() / h
        val out = if (scale < 1f) Bitmap.createScaledBitmap(bmp, (w * scale).toInt(), (h * scale).toInt(), true) else bmp
        val baos = ByteArrayOutputStream()
        out.compress(Bitmap.CompressFormat.JPEG, 85, baos)
        if (out !== bmp) out.recycle()
        bmp.recycle()
        return Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
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
            .setPositiveButton("拍照") { _, _ ->
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

    private fun startScanning() {
        if (!paused) return
        paused = false
        reportLog("scan_resume", "开始扫码拍照")
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
        reportLog("records_clear", "清空本次拍照记录")
        updateStats()
    }

    private fun updateStats() {
        statsText.text = "📷 已拍 $successCount · ⏳ 待确认 $pendingCount · ❌ 失败 $failCount"
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
                vibrator.vibrate(longArrayOf(0L, if (success) 60 else 200), -1)
            }
        }
        if (success) {
            playTone(ToneGenerator.TONE_PROP_BEEP, 120)
            Handler(Looper.getMainLooper()).postDelayed(
                { playTone(ToneGenerator.TONE_PROP_BEEP, 180) },
                130
            )
        } else {
            playTone(ToneGenerator.TONE_PROP_NACK, 300)
        }
    }

    private fun playProcessing() {
        runCatching {
            val vibrator = requireContext().getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
            if (Build.VERSION.SDK_INT >= 26) {
                vibrator.vibrate(VibrationEffect.createOneShot(30, VibrationEffect.DEFAULT_AMPLITUDE))
            } else {
                vibrator.vibrate(longArrayOf(0L, 30), -1)
            }
        }
        playTone(ToneGenerator.TONE_PROP_BEEP2, 150)
    }

    private fun playTone(toneType: Int, durationMs: Int) {
        runCatching {
            val tone = ToneGenerator(AudioManager.STREAM_MUSIC, 100)
            tone.startTone(toneType, durationMs)
            Handler(Looper.getMainLooper()).postDelayed({ runCatching { tone.release() } }, durationMs + 200L)
        }
    }

    // ── 记录列表 ──

    private fun addRecord(record: RecordEntry) {
        records.add(0, record)
        view?.post { renderAllRecords() }
    }

    /** 更新已存在记录(拍照流程中状态流转)后整体重绘 */
    private fun replaceRecord(updated: RecordEntry) {
        val idx = records.indexOfFirst { it.packageId == updated.packageId && it.time == updated.time }
        if (idx >= 0) {
            records[idx] = updated
            view?.post { renderAllRecords() }
        }
    }

    private fun renderAllRecords() {
        if (view == null) return
        recordList.removeAllViews()
        for (record in records) renderRecord(record)
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

        val subLine = buildString {
            append(record.message)
            if (!record.storeName.isNullOrBlank()) append(" · ${record.storeName}")
            append(" · $timeText")
        }

        val textCol = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            addView(mainTv)
            if (mainText != null) {
                addView(TextView(ctx).apply {
                    text = subLine
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
                    setOnClickListener { retryUpload(record) }
                }, LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { leftMargin = dp(8) })
            }
            if (record.packageId.isNotBlank() && record.status == RecordStatus.SUCCESS) {
                setOnClickListener {
                    startActivity(Intent(requireContext(), OrderDetailActivity::class.java)
                        .putExtra("packageId", record.packageId))
                }
            }
        }

        val divider = View(ctx).apply {
            setBackgroundColor(0xFFF2F3F5.toInt())
        }

        recordList.addView(row)
        recordList.addView(divider, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            dp(1)
        ))
        recordScroll.post { recordScroll.smoothScrollTo(0, 0) }
    }

    // ── 生命周期(防后台误扫) ──

    override fun onResume() {
        super.onResume()
        // 拍照返回后自动恢复连扫:仅当前可见且未暂停时启动相机
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
        scanExecutor.shutdown()
    }

    // ── 记录模型 ──

    private enum class RecordStatus(val emoji: String, val color: Int) {
        SUCCESS("✅", 0xFF00B42A.toInt()),
        FAILED("❌", 0xFFF53F3F.toInt()),
        PENDING("⏳", 0xFFD97706.toInt()),
        SKIPPED("⏭", 0xFF86909C.toInt())
    }

    private data class RecordEntry(
        val status: RecordStatus,
        val code: String,
        val packageId: String = "",
        val postingNumber: String? = null,
        val message: String,
        val storeName: String? = null,
        val storeId: String? = null,
        val filePath: String? = null, // 上传失败后重试直接重传
        val time: Long = System.currentTimeMillis()
    )
}