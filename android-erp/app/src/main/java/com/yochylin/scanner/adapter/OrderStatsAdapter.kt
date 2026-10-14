package com.yochylin.scanner.adapter

import android.content.Context
import android.graphics.Color
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import com.yochylin.scanner.R
import com.yochylin.scanner.model.CountAmount
import com.yochylin.scanner.model.StoreStats

private const val S_COLOR_MUTE = "#86909c"
private const val S_COLOR_TEXT = "#1f2329"
private const val S_COLOR_PRIMARY = "#165dff"

/** 订单统计：按店铺指标列表适配器 */
class OrderStatsAdapter : RecyclerView.Adapter<OrderStatsAdapter.VH>() {

    private val list = mutableListOf<StoreStats>()

    fun setList(items: List<StoreStats>) {
        list.clear()
        list.addAll(items)
        notifyDataSetChanged()
    }

    override fun getItemCount(): Int = list.size

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context).inflate(R.layout.item_store_stats, parent, false)
        return VH(v)
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        holder.bind(list[position])
    }

    inner class VH(view: View) : RecyclerView.ViewHolder(view) {
        private val context: Context = view.context
        private val sStore: TextView = view.findViewById(R.id.sStore)
        private val sGrid: LinearLayout = view.findViewById(R.id.sGrid)

        fun bind(store: StoreStats) {
            sStore.text = store.storeName ?: store.storeId ?: "—"
            sGrid.removeAllViews()
            addRow(sGrid, "新订单", store.new, true)
            addRow(sGrid, "揽收", store.pickup, false)
            addRow(sGrid, "签收", store.delivered, false)
            addRow(sGrid, "退货", store.returned, false)
        }

        private fun addRow(container: LinearLayout, label: String, ca: CountAmount?, showValid: Boolean) {
            val row = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = 4 }
            }
            val key = TextView(context).apply {
                text = label
                setTextColor(Color.parseColor(S_COLOR_MUTE))
                textSize = 11f
                layoutParams = LinearLayout.LayoutParams(90, ViewGroup.LayoutParams.WRAP_CONTENT)
            }
            row.addView(key)

            val value = TextView(context).apply {
                text = buildString {
                    append(ca?.count ?: 0).append(" 单 · ¥")
                    append(fmtMoney(ca?.amount))
                }
                setTextColor(Color.parseColor(S_COLOR_TEXT))
                textSize = 11f
                layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            }
            row.addView(value)

            if (showValid && ca?.validAmount != null) {
                val valid = TextView(context).apply {
                    text = "剔除取消 ¥${fmtMoney(ca.validAmount)}"
                    setTextColor(Color.parseColor(S_COLOR_PRIMARY))
                    textSize = 10f
                    layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
                        leftMargin = 8
                    }
                }
                row.addView(valid)
            }

            container.addView(row)
        }
    }
}