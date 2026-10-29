package com.yochylin.scanner

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
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
import java.util.concurrent.Executors

/**
 * 扫描备货(2026-10-27,底部导航独立页):摄像头常开连扫,上半屏相机视频,下半屏本次扫描备货记录。
 * 识别到待备货(awaiting_packaging)订单后自动向 Ozon 备货:
 *   单件商品 → 直接备货;多件商品 → 弹窗二次确认。
 * 处理完不退出,继续扫下一单(同一码 2 秒内去重,防连拍重复触发)。
 */
class StockScanFragment : Fragment() {

    private lateinit var previewView: PreviewView
    private lateinit var recordScroll: ScrollView
    private lateinit var recordList: LinearLayout

    private var cameraProvider: ProcessCameraProvider? = null

    private val scanExecutor = Executors.newSingleThreadExecutor()
    private val barcodeScanner = BarcodeScanning.getClient()

    /** 连扫去重:条码 → 最近处理时间,2 秒内同码跳过(防连续帧重复触发) */
    private val lastHandleAt = HashMap<String, Long>()
    private val DEBOUNCE_MS = 2000L

    private val cameraPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startCamera()
            else appendRecord("❌ 未获得相机权限,无法扫码备货", isError = true)
        }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View? {
        return inflater.inflate(R.layout.fragment_stock_scan, container, false)
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        previewView = view.findViewById(R.id.previewView)
        recordScroll = view.findViewById(R.id.recordScroll)
        recordList = view.findViewById(R.id.recordList)

        appendRecord("📷 摄像头已开启,等待扫码…")

        if (hasCameraPermission()) startCamera()
        else cameraPermission.launch(Manifest.permission.CAMERA)
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
                provider.bindToLifecycle(
                    viewLifecycleOwner,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    analysis
                )
            }, ContextCompat.getMainExecutor(requireContext()))
        } catch (e: Throwable) {
            appendRecord("❌ 相机启动失败:${e.message ?: e.javaClass.simpleName}", isError = true)
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
                                    handleCode(raw)
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

    /** 条码 → 全局搜索 → 命中待备货订单则自动备货 */
    private fun handleCode(code: String) {
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
                    if (resp.packages.isEmpty()) {
                        appendRecord("❌ $code 未找到订单", isError = true)
                    } else {
                        appendRecord("⏭ $code 无待备货订单(可能已备货/已发货)", isMuted = true)
                    }
                    return@launch
                }
                val totalQty = (stockPkg.items?.sumOf { it.quantity ?: 0.0 } ?: 0.0).toLong()
                if (totalQty > 1) {
                    // 多件商品:弹窗二次确认(与扫描发货备货同口径)
                    val pkg = stockPkg
                    appendRecord("⏸ ${pkg.postingNumber} 共 $totalQty 件,待确认")
                    android.app.AlertDialog.Builder(requireContext())
                        .setTitle("备货确认")
                        .setMessage("货件 ${pkg.postingNumber}\n共 $totalQty 件商品,将向 Ozon 确认全部商品为一个货件(不拆分)。")
                        .setPositiveButton("确认备货") { _, _ -> doShip(pkg, code) }
                        .setNegativeButton("取消", null)
                        .show()
                } else {
                    doShip(stockPkg, code)
                }
            } catch (e: Exception) {
                appendRecord("❌ $code 查询失败:${e.message ?: e.javaClass.simpleName}", isError = true)
            }
        }
    }

    /** 调用备货接口并记录结果 */
    private fun doShip(pkg: Pkg, code: String) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = Api.post("/admin/api/order-process/ship", mapOf("packageId" to pkg.id)).asJsonObject
                val title = when {
                    r.optBoolean("alreadyShipped") -> "已备货过"
                    r.optBoolean("pending") -> "备货指令已提交"
                    else -> "备货成功"
                }
                appendRecord("✅ ${pkg.postingNumber} $title")
            } catch (e: Exception) {
                appendRecord("❌ ${pkg.postingNumber} 备货失败:${e.message ?: e.javaClass.simpleName}", isError = true)
            }
        }
    }

    /** 向底部记录列表追加一条结果,并自动滚动到底部 */
    private fun appendRecord(text: String, isError: Boolean = false, isMuted: Boolean = false) {
        view?.post {
            val color = when {
                isError -> Color.parseColor("#d93026")
                isMuted -> Color.parseColor("#86909c")
                else -> Color.parseColor("#1d2129")
            }
            val tv = TextView(requireContext()).apply {
                this.text = text
                setTextColor(color)
                textSize = 13f
                setPadding(0, 6, 0, 6)
            }
            recordList.addView(tv)
            recordScroll.post { recordScroll.fullScroll(View.FOCUS_DOWN) }
        }
    }

    override fun onResume() {
        super.onResume()
        // 仅当前可见时才启动相机:已切到其他 tab 的备货页不应在后台重启相机连扫,
        // 否则在订单页等页面扫码时会误触发自动备货(2026-10-29)。
        if (!isHidden && hasCameraPermission()) startCamera()
    }

    override fun onPause() {
        super.onPause()
        cameraProvider?.unbindAll()
    }

    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (hidden) {
            cameraProvider?.unbindAll()
        } else if (isResumed) {
            if (hasCameraPermission()) startCamera()
            else cameraPermission.launch(Manifest.permission.CAMERA)
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        cameraProvider?.unbindAll()
        cameraProvider = null
    }

    override fun onDestroy() {
        super.onDestroy()
        // barcodeScanner 是 ML Kit 共享单例,不在此关闭,交由进程生命周期统一释放
        scanExecutor.shutdown()
    }
}