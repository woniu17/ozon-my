package com.yochylin.scanner

import android.graphics.Color
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import coil.load
import com.google.gson.JsonObject
import com.yochylin.scanner.api.Api
import java.util.Locale
import kotlinx.coroutines.launch

/**
 * 消息推送序列表（2026-10-18 用户要求）。
 * 展示后端 /admin/api/push/logs 的通知推送日志：
 * 类型/店铺/货件号/金额/时间 + 商品图（相对路径拼接 Api.BASE_URL，内网公网自适应），
 * 无图条目标注"无图"，便于排查通知图片问题。
 */
class PushLogActivity : ComponentActivity() {

    private lateinit var recyclerView: RecyclerView
    private lateinit var emptyView: TextView
    private val adapter = LogAdapter()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_push_log)

        findViewById<TextView>(R.id.pushLogBackBtn).setOnClickListener { finish() }
        findViewById<TextView>(R.id.pushLogRefreshBtn).setOnClickListener { loadLogs() }

        emptyView = findViewById(R.id.pushLogEmpty)
        recyclerView = findViewById(R.id.pushLogList)
        recyclerView.layoutManager = LinearLayoutManager(this)
        recyclerView.adapter = adapter

        loadLogs()
    }

    private fun loadLogs() {
        lifecycleScope.launch {
            try {
                val arr = Api.get("/admin/api/push/logs", mapOf("limit" to "200"))
                    .asJsonObject
                    .getAsJsonArray("logs")
                val list = mutableListOf<JsonObject>()
                for (el in arr) {
                    if (el.isJsonObject) list.add(el.asJsonObject)
                }
                adapter.setData(list)
                emptyView.visibility = if (list.isEmpty()) View.VISIBLE else View.GONE
            } catch (_: Exception) {
                emptyView.text = "加载失败，点击刷新重试"
                emptyView.visibility = View.VISIBLE
            }
        }
    }

    private class LogAdapter : RecyclerView.Adapter<LogAdapter.VH>() {
        private val data = mutableListOf<JsonObject>()

        fun setData(list: List<JsonObject>) {
            data.clear()
            data.addAll(list)
            notifyDataSetChanged()
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
            val v = LayoutInflater.from(parent.context).inflate(R.layout.item_push_log, parent, false)
            return VH(v)
        }

        override fun getItemCount(): Int = data.size

        override fun onBindViewHolder(holder: VH, position: Int) {
            holder.bind(data[position])
        }

        class VH(itemView: View) : RecyclerView.ViewHolder(itemView) {
            private val typeTv: TextView = itemView.findViewById(R.id.logType)
            private val storeTv: TextView = itemView.findViewById(R.id.logStore)
            private val timeTv: TextView = itemView.findViewById(R.id.logTime)
            private val postingTv: TextView = itemView.findViewById(R.id.logPosting)
            private val amountTv: TextView = itemView.findViewById(R.id.logAmount)
            private val imgStatusTv: TextView = itemView.findViewById(R.id.logImgStatus)
            private val thumbIv: ImageView = itemView.findViewById(R.id.logThumb)

            fun bind(o: JsonObject) {
                val type = str(o, "type")
                val store = str(o, "store_name")
                val posting = str(o, "posting_number")
                val time = str(o, "created_at")
                val imgUrl = str(o, "product_image_url")
                val amount = o.get("amount")?.takeIf { !it.isJsonNull }?.asDouble ?: 0.0
                val itemCount = o.get("item_count")?.takeIf { !it.isJsonNull }?.asInt ?: 0

                typeTv.text = TYPE_LABELS[type] ?: type.ifBlank { "-" }
                typeTv.setBackgroundColor(Color.parseColor(TYPE_COLORS[type] ?: "#165dff"))
                storeTv.text = store
                timeTv.text = time
                postingTv.text = posting.ifBlank { "-" }
                amountTv.text = formatAmount(itemCount, amount)

                if (imgUrl.isBlank()) {
                    imgStatusTv.text = "无图"
                    imgStatusTv.visibility = View.VISIBLE
                    thumbIv.setImageDrawable(null)
                    thumbIv.setBackgroundColor(Color.parseColor("#f2f3f5"))
                } else {
                    imgStatusTv.visibility = View.GONE
                    val absolute = if (imgUrl.startsWith("/")) Api.BASE_URL + imgUrl else imgUrl
                    thumbIv.load(absolute) {
                        crossfade(true)
                    }
                }
            }

            private fun str(o: JsonObject, key: String): String =
                o.get(key)?.takeIf { !it.isJsonNull }?.asString ?: ""
        }
    }

    private companion object {
        val TYPE_LABELS = mapOf(
            "NEW_ORDER" to "新订单",
            "ORDER_CANCELLED" to "订单取消",
            "STATE_CHANGED" to "状态变更",
            "PICKED_UP" to "已揽收"
        )
        val TYPE_COLORS = mapOf(
            "NEW_ORDER" to "#165dff",
            "ORDER_CANCELLED" to "#f53f3f",
            "STATE_CHANGED" to "#d97706",
            "PICKED_UP" to "#00b42a"
        )

        fun formatAmount(itemCount: Int, amount: Double): String {
            val countText = if (itemCount > 0) "x$itemCount " else ""
            return "$countText￥${String.format(Locale.US, "%.1f", amount)}"
        }
    }
}