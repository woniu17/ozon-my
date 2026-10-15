package com.yochylin.scanner

import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import com.yochylin.scanner.api.Api
import kotlinx.coroutines.launch

class LoginActivity : ComponentActivity() {

    private lateinit var phoneInput: EditText
    private lateinit var passwordInput: EditText
    private lateinit var loginBtn: Button
    private lateinit var intranetCheck: CheckBox

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Session.init(this)

        // 已登录直接进入主界面
        if (Session.isLoggedIn) {
            goMain()
            return
        }

        setContentView(R.layout.activity_login)
        phoneInput = findViewById(R.id.phoneInput)
        passwordInput = findViewById(R.id.passwordInput)
        loginBtn = findViewById(R.id.loginBtn)
        intranetCheck = findViewById(R.id.intranetCheck)

        phoneInput.setText(Session.phone ?: "")

        // 内网模式：勾选后请求走内网地址
        intranetCheck.isChecked = Session.useIntranet
        intranetCheck.setOnCheckedChangeListener { _, isChecked ->
            Session.useIntranet = isChecked
        }

        loginBtn.setOnClickListener { doLogin() }

        // 启动时自动探测内网：可达则静默切换为内网模式（登录请求走内网）
        lifecycleScope.launch {
            NetworkDetector.autoDetectAndApply()
        }
    }

    private fun doLogin() {
        val phone = phoneInput.text.toString().trim()
        val pwd = passwordInput.text.toString().trim()
        if (phone.isEmpty() || pwd.isEmpty()) {
            toast("请输入手机号和密码")
            return
        }
        loginBtn.isEnabled = false
        lifecycleScope.launch {
            try {
                val root = Api.post(
                    "/auth/login-password",
                    mapOf("phoneNumber" to phone, "password" to pwd)
                ).asJsonObject
                val token = root.get("accessToken")?.asString
                if (token.isNullOrBlank()) {
                    toast("登录失败:响应缺少 accessToken")
                    return@launch
                }
                Session.saveLogin(token, phone)
                goMain()
            } catch (e: Exception) {
                toast(e.message ?: "登录失败")
            } finally {
                loginBtn.isEnabled = true
            }
        }
    }

    private fun goMain() {
        startActivity(Intent(this, MainShellActivity::class.java))
        finish()
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
    }
}