package com.yochylin.scanner

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors

/**
 * 相机扫码：CameraX 预览 + ML Kit 离线条码识别。
 * 识别到条码后通过 setResult 返回原始内容，由主界面自动发起搜索。
 */
class ScanActivity : ComponentActivity() {

    private lateinit var previewView: PreviewView

    private val scanExecutor = Executors.newSingleThreadExecutor()
    private val barcodeScanner = BarcodeScanning.getClient()
    // 扫码线程与 ML Kit 回调线程都会读写，需保证可见性（评审 P2）
    @Volatile
    private var alreadyScanned = false

    private val cameraPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startCamera() else finish()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_scan)

        previewView = findViewById(R.id.previewView)
        findViewById<TextView>(R.id.closeBtn).setOnClickListener { finish() }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED
        ) {
            startCamera()
        } else {
            cameraPermission.launch(Manifest.permission.CAMERA)
        }
    }

    private fun startCamera() {
        try {
            val providerFuture = ProcessCameraProvider.getInstance(this)
            providerFuture.addListener({
                val provider = providerFuture.get()
                val preview = Preview.Builder().build().also {
                    it.setSurfaceProvider(previewView.surfaceProvider)
                }
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                analysis.setAnalyzer(scanExecutor) { imageProxy -> processImage(imageProxy) }

                provider.unbindAll()
                provider.bindToLifecycle(
                    this,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    analysis
                )
            }, ContextCompat.getMainExecutor(this))
        } catch (e: Throwable) {
            finish()
        }
    }

    private fun processImage(imageProxy: ImageProxy) {
        if (alreadyScanned) {
            imageProxy.close()
            return
        }
        val mediaImage = imageProxy.image
        if (mediaImage != null) {
            val inputImage = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
            try {
                barcodeScanner.process(inputImage)
                    .addOnSuccessListener { barcodes ->
                        barcodes.firstOrNull()?.let { b ->
                            val raw = (b.rawValue ?: b.displayValue ?: "").trim()
                            if (raw.isNotEmpty() && !alreadyScanned) {
                                alreadyScanned = true
                                setResult(RESULT_OK, Intent().putExtra("code", raw))
                                finish()
                            }
                        }
                    }
                    .addOnCompleteListener {
                        // 正常/异常完成都释放帧，防止 ImageAnalysis 停止（评审 P2）
                        imageProxy.close()
                    }
            } catch (e: Exception) {
                // process 同步异常（如输入图无效）时也必须释放帧，避免泄漏（评审 P2）
                imageProxy.close()
            }
        } else {
            imageProxy.close()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        // 注意：barcodeScanner 是 ML Kit 共享单例，Activity 重建后再次 getClient() 会拿到已关闭实例，
        // 因此不在此关闭，交由进程生命周期统一释放（评审 P2）
        scanExecutor.shutdown()
    }
}