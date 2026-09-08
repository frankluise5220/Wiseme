package com.mmh.app.ui.funddetail

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.mmh.app.data.remote.dto.FundEntryDto
import com.mmh.app.data.remote.dto.FundPositionDto
import com.mmh.app.data.remote.dto.NavHistoryItem
import com.mmh.app.ui.theme.LocalDisplayPreferences
import com.mmh.app.ui.util.formatAmount
import com.mmh.app.ui.util.formatDate
import com.mmh.app.ui.util.formatPnl
import com.mmh.app.ui.util.formatRate
import com.patrykandpatrick.vico.compose.cartesian.CartesianChartHost
import com.patrykandpatrick.vico.compose.cartesian.axis.rememberBottom
import com.patrykandpatrick.vico.compose.cartesian.axis.rememberStart
import com.patrykandpatrick.vico.compose.cartesian.layer.rememberLineCartesianLayer
import com.patrykandpatrick.vico.compose.cartesian.layer.rememberLine
import com.patrykandpatrick.vico.compose.cartesian.marker.rememberDefaultCartesianMarker
import com.patrykandpatrick.vico.compose.cartesian.rememberCartesianChart
import com.patrykandpatrick.vico.compose.cartesian.rememberVicoScrollState
import com.patrykandpatrick.vico.compose.common.component.rememberLineComponent
import com.patrykandpatrick.vico.compose.common.component.rememberShapeComponent
import com.patrykandpatrick.vico.compose.common.component.rememberTextComponent
import com.patrykandpatrick.vico.compose.common.fill
import com.patrykandpatrick.vico.compose.common.insets
import com.patrykandpatrick.vico.compose.common.shape.rounded
import com.patrykandpatrick.vico.core.cartesian.axis.HorizontalAxis
import com.patrykandpatrick.vico.core.cartesian.axis.VerticalAxis
import com.patrykandpatrick.vico.core.cartesian.CartesianDrawingContext
import com.patrykandpatrick.vico.core.cartesian.CartesianMeasuringContext
import com.patrykandpatrick.vico.core.cartesian.data.CartesianChartModelProducer
import com.patrykandpatrick.vico.core.cartesian.data.CartesianLayerRangeProvider
import com.patrykandpatrick.vico.core.cartesian.data.CartesianChartModel
import com.patrykandpatrick.vico.core.cartesian.data.CartesianValueFormatter
import com.patrykandpatrick.vico.core.cartesian.data.lineSeries
import com.patrykandpatrick.vico.core.cartesian.marker.CartesianMarker
import com.patrykandpatrick.vico.core.cartesian.marker.DefaultCartesianMarker
import com.patrykandpatrick.vico.core.cartesian.layer.LineCartesianLayer
import com.patrykandpatrick.vico.core.cartesian.layer.CartesianLayerDimensions
import com.patrykandpatrick.vico.core.cartesian.layer.CartesianLayerMargins
import com.patrykandpatrick.vico.core.common.data.ExtraStore
import com.patrykandpatrick.vico.core.common.shape.CorneredShape
import java.time.LocalDate

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FundDetailScreen(
    accountId: String,
    fundCode: String,
    onBack: () -> Unit,
    onEntryEdit: (entryId: String) -> Unit = {},
    onBuyClick: (fundName: String) -> Unit = {},
    onSellClick: (fundName: String) -> Unit = {},
    onRegularInvestClick: () -> Unit = {},
    viewModel: FundDetailViewModel = hiltViewModel()
) {
    val uiState by viewModel.uiState.collectAsState()
    var showTopMenu by remember { mutableStateOf(false) }
    var showSettingsDialog by remember { mutableStateOf(false) }

    LaunchedEffect(accountId, fundCode) {
        viewModel.load(accountId, fundCode)
    }

    Scaffold(
        bottomBar = {
            if (uiState.position != null) {
                FundActionBar(
                    onSellClick = { onSellClick(uiState.fundName.ifEmpty { fundCode }) },
                    onRegularInvestClick = onRegularInvestClick,
                    onBuyClick = { onBuyClick(uiState.fundName.ifEmpty { fundCode }) }
                )
            }
        }
    ) { padding ->
        when {
            uiState.isLoading -> {
                Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }

            uiState.error != null && uiState.position == null -> {
                Column(
                    Modifier.fillMaxSize().padding(padding).padding(32.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center
                ) {
                    Text(uiState.error.orEmpty(), color = MaterialTheme.colorScheme.error)
                    Spacer(Modifier.height(8.dp))
                    TextButton(onClick = { viewModel.load(accountId, fundCode) }) { Text("重试") }
                }
            }

            else -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding)
                        .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.3f))
                ) {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(bottom = 10.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp)
                    ) {
                        uiState.position?.let { pos ->
                            if (pos.pendingCost > 0) {
                                item { PendingHintBanner(pos.pendingCost) }
                            }
                            item {
                                AssetDetailCard(
                                    pos = pos,
                                    fundName = uiState.fundName.ifEmpty { fundCode },
                                    fundCode = fundCode,
                                    latestNavDate = pos.navDate.orEmpty().ifBlank { uiState.navHistory.lastOrNull()?.date.orEmpty() }
                                )
                            }
                        }

                        item {
                            PaddedDetailSection {
                                TrendChartCard(
                                    history = uiState.navHistory,
                                    entries = uiState.entries,
                                    confirmDays = uiState.confirmDays,
                                    navHistoryMessage = uiState.navHistoryMessage
                                )
                            }
                        }

                        item {
                            PaddedDetailSection {
                                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    Text(
                                        "交易记录",
                                        style = MaterialTheme.typography.titleSmall.copy(fontSize = 15.sp),
                                        fontWeight = FontWeight.SemiBold
                                    )
                                    if (uiState.entries.isNotEmpty()) {
                                        TransactionTableHeader()
                                    } else {
                                        EmptyTransactionHint()
                                    }
                                }
                            }
                        }
                        items(uiState.entries, key = { it.id }) { entry ->
                            PaddedDetailSection {
                                EntryCard(entry = entry, onEdit = { onEntryEdit(entry.id) })
                            }
                        }

                        item { Spacer(Modifier.height(24.dp)) }
                    }
                    FundDetailOverlayActions(
                        showTopMenu = showTopMenu,
                        onBack = onBack,
                        onMenuOpen = { showTopMenu = true },
                        onMenuDismiss = { showTopMenu = false },
                        onSettingsClick = {
                            showTopMenu = false
                            showSettingsDialog = true
                        }
                    )
                }
            }
        }
    }

    if (showSettingsDialog) {
        FundSettingsDialog(
            fundName = uiState.fundName.ifEmpty { fundCode },
            fundCode = fundCode,
            confirmDays = uiState.confirmDays,
            feeRate = uiState.feeRate,
            isSaving = uiState.isSavingSettings,
            error = uiState.settingsError,
            onDismiss = { if (!uiState.isSavingSettings) showSettingsDialog = false },
            onSave = { days, rate ->
                viewModel.saveSettings(accountId, fundCode, days, rate) {
                    showSettingsDialog = false
                }
            }
        )
    }
}

private enum class ChartMode {
    Profit,
    Nav
}

private enum class ChartRange {
    Month,
    HalfYear,
    OneYear,
    SincePurchase
}

private enum class ChartValueStyle {
    Money,
    Nav
}

private data class ChartPoint(
    val date: String,
    val value: Double,
    val nav: Double = 0.0,
    val units: Double = 0.0,
    val avgCost: Double = 0.0,
    val cost: Double = 0.0,
    val marketValue: Double = 0.0,
    val hasPosition: Boolean = false
)

private val ChartDateLabelsKey = ExtraStore.Key<Map<Float, String>>()
private val ChartPointsKey = ExtraStore.Key<Map<Float, ChartPoint>>()

@Composable
private fun FundDetailOverlayActions(
    showTopMenu: Boolean,
    onBack: () -> Unit,
    onMenuOpen: () -> Unit,
    onMenuDismiss: () -> Unit,
    onSettingsClick: () -> Unit
) {
    Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 8.dp)) {
        Surface(
            modifier = Modifier.align(Alignment.TopStart),
            shape = CircleShape,
            color = MaterialTheme.colorScheme.surface.copy(alpha = 0.9f),
            shadowElevation = 2.dp
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
            }
        }

        Box(modifier = Modifier.align(Alignment.TopEnd)) {
            Surface(
                shape = CircleShape,
                color = MaterialTheme.colorScheme.surface.copy(alpha = 0.9f),
                shadowElevation = 2.dp
            ) {
                IconButton(onClick = onMenuOpen) {
                    Icon(Icons.Default.MoreVert, contentDescription = "基金设置")
                }
            }
            DropdownMenu(expanded = showTopMenu, onDismissRequest = onMenuDismiss) {
                DropdownMenuItem(
                    text = { Text("确认/申购费设置") },
                    onClick = onSettingsClick
                )
            }
        }
    }
}

@Composable
private fun PaddedDetailSection(content: @Composable () -> Unit) {
    Box(modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
        content()
    }
}

@Composable
private fun PendingHintBanner(pendingCost: Double) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(0.dp),
        color = Color(0xFFFFF7E6)
    ) {
        Text(
            "有 ${formatAmount(pendingCost)} 待确认金额，确认后会计入持仓。",
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
            style = MaterialTheme.typography.bodySmall,
            color = Color(0xFFD97706)
        )
    }
}

@Composable
private fun EmptyTransactionHint() {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surface
    ) {
        Text(
            "本地缓存里暂无这只基金的交易记录",
            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 14.dp),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center
        )
    }
}

@Composable
private fun AssetDetailCard(
    pos: FundPositionDto,
    fundName: String,
    fundCode: String,
    latestNavDate: String
) {
    val displayPreferences = LocalDisplayPreferences.current
    val holdingProfit = pos.marketValue - pos.cost
    val holdingProfitRate = if (pos.cost > 0) holdingProfit / pos.cost else pos.floatingPnLRate
    val profitColor = if (holdingProfit >= 0) displayPreferences.upColor else displayPreferences.downColor
    val navDateText = formatMonthDay(latestNavDate)
    val avgCost = if (pos.units > 0) pos.cost / pos.units else 0.0

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(bottomStart = 22.dp, bottomEnd = 22.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 18.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        fundName,
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                    Spacer(Modifier.height(2.dp))
                    Text(fundCode, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }

            Spacer(Modifier.height(18.dp))
            Surface(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.35f), modifier = Modifier.fillMaxWidth().height(1.dp)) {}
            Spacer(Modifier.height(18.dp))

            Box(modifier = Modifier.fillMaxWidth()) {
                Text(
                    "市值(元)",
                    modifier = Modifier.align(Alignment.Center),
                    textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                if (navDateText.isNotBlank()) {
                    Text(
                        "净值 $navDateText",
                        modifier = Modifier.align(Alignment.CenterEnd),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.68f)
                    )
                }
            }
            Text(
                formatAmount(pos.marketValue),
                modifier = Modifier.fillMaxWidth(),
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.displaySmall,
                fontWeight = FontWeight.Bold
            )

            Spacer(Modifier.height(18.dp))
            Row(Modifier.fillMaxWidth()) {
                AssetMetric("成本(元)", formatAmount(pos.cost), valueColor = MaterialTheme.colorScheme.onSurface, modifier = Modifier.weight(1f))
                AssetMetric("收益(元)", formatPnl(holdingProfit), valueColor = profitColor, modifier = Modifier.weight(1f))
                AssetMetric("收益率", holdingProfitRate?.let { formatRate(it) } ?: "-", valueColor = profitColor, modifier = Modifier.weight(1f))
            }

            Spacer(Modifier.height(16.dp))
            Surface(color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.45f), shape = RoundedCornerShape(12.dp)) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    DetailTile("均价", "%.4f".format(avgCost), Modifier.weight(1f))
                    DetailTile("份额", "%.2f".format(pos.units), Modifier.weight(1f))
                    DetailTile("净值", pos.nav?.let { "%.4f".format(it) } ?: "-", Modifier.weight(1f))
                    DetailTile("待确认", formatAmount(pos.pendingCost), Modifier.weight(1f))
                }
            }

        }
    }
}

@Composable
private fun AssetMetric(label: String, value: String, valueColor: Color, modifier: Modifier = Modifier) {
    Column(modifier = modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(4.dp))
        Text(value, style = MaterialTheme.typography.titleMedium, color = valueColor, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun DetailTile(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    caption: String = ""
) {
    Column(modifier = modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1
        )
        Spacer(Modifier.height(4.dp))
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.sp),
            fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1
        )
        if (caption.isNotBlank()) {
            Text(
                caption,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1
            )
        }
    }
}

@Composable
private fun TrendChartCard(
    history: List<NavHistoryItem>,
    entries: List<FundEntryDto>,
    confirmDays: Int,
    navHistoryMessage: String?
) {
    var mode by remember { mutableStateOf(ChartMode.Profit) }
    var range by remember { mutableStateOf(ChartRange.Month) }
    val firstPurchaseDate = remember(entries) { firstPurchaseDate(entries) }
    val availableRanges = remember(history, firstPurchaseDate) { availableChartRanges(history, firstPurchaseDate) }
    LaunchedEffect(availableRanges) {
        if (availableRanges.isNotEmpty() && range !in availableRanges) {
            range = ChartRange.Month.takeIf { it in availableRanges } ?: availableRanges.first()
        }
    }
    val activeRange = if (range in availableRanges) range else availableRanges.firstOrNull() ?: ChartRange.Month
    val filteredHistory = remember(history, activeRange, entries) {
        filterHistoryByRange(history, activeRange, entries)
    }
    val xRange = remember(filteredHistory, activeRange, entries) {
        chartXRange(filteredHistory, activeRange, entries)
    }
    val points = when (mode) {
        ChartMode.Nav -> filteredHistory.map { ChartPoint(date = it.date, value = it.nav, nav = it.nav) }
        ChartMode.Profit -> buildProfitAmountPoints(filteredHistory, entries, confirmDays)
    }
    val valueStyle = if (mode == ChartMode.Profit) ChartValueStyle.Money else ChartValueStyle.Nav
    val xLabelSpacing = chartLabelSpacing(activeRange, points)

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(Modifier.fillMaxWidth()) {
                ChartTab("收益走势", selected = mode == ChartMode.Profit, modifier = Modifier.weight(1f)) {
                    mode = ChartMode.Profit
                }
                ChartTab("净值走势", selected = mode == ChartMode.Nav, modifier = Modifier.weight(1f)) {
                    mode = ChartMode.Nav
                }
            }

            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                availableRanges.forEach { item ->
                    FilterChip(
                        selected = activeRange == item,
                        onClick = { range = item },
                        label = { Text(chartRangeLabel(item), fontSize = 12.sp) }
                    )
                }
            }
            unavailableRangeHint(history, firstPurchaseDate)?.let { hint ->
                Spacer(Modifier.height(6.dp))
                Text(
                    hint,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.75f)
                )
            }

            Spacer(Modifier.height(10.dp))
            if (points.size < 2) {
                EmptyChartHint(mode, navHistoryMessage)
            } else {
                VicoLineChart(points = points, valueStyle = valueStyle, xLabelSpacing = xLabelSpacing, xRange = xRange)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text(formatDate(points.first().date), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(formatDate(points.last().date), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun ChartTab(label: String, selected: Boolean, modifier: Modifier, onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = modifier) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                label,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                color = if (selected) Color(0xFF168AF2) else MaterialTheme.colorScheme.onSurface
            )
            Spacer(Modifier.height(6.dp))
            Surface(
                modifier = Modifier.fillMaxWidth().height(if (selected) 3.dp else 1.dp),
                color = if (selected) Color(0xFF168AF2) else MaterialTheme.colorScheme.outlineVariant
            ) {}
        }
    }
}

@Composable
private fun EmptyChartHint(mode: ChartMode, message: String?) {
    val text = message ?: if (mode == ChartMode.Profit) "暂无可计算的收益走势" else "暂无净值走势"
    Box(modifier = Modifier.fillMaxWidth().height(164.dp), contentAlignment = Alignment.Center) {
        Text(text, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun VicoLineChart(
    points: List<ChartPoint>,
    valueStyle: ChartValueStyle,
    xLabelSpacing: Int,
    xRange: ClosedFloatingPointRange<Double>
) {
    val modelProducer = remember { CartesianChartModelProducer() }
    val xValues = remember(points) {
        points.mapIndexed { index, point ->
            parseLocalDateOrNull(point.date)?.toEpochDay()?.toFloat() ?: index.toFloat()
        }
    }
    val dateLabels = remember(points, xValues) {
        xValues.zip(points).associate { (x, point) -> x to point.date }
    }
    val chartPoints = remember(points, xValues) {
        xValues.zip(points).associate { (x, point) -> x to point }
    }
    val displayPreferences = LocalDisplayPreferences.current
    val lineColor = when {
        valueStyle == ChartValueStyle.Money && (points.lastOrNull()?.value ?: 0.0) < 0.0 -> displayPreferences.downColor
        valueStyle == ChartValueStyle.Money -> displayPreferences.upColor
        else -> Color(0xFF168AF2)
    }
    val axisLabel = rememberTextComponent(
        color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.72f),
        textSize = 9.sp
    )
    val lineProvider = LineCartesianLayer.LineProvider.series(
        LineCartesianLayer.rememberLine(
            fill = LineCartesianLayer.LineFill.single(fill(lineColor))
        )
    )
    val startAxisFormatter = remember(valueStyle) {
        CartesianValueFormatter { _, value, _ -> formatChartValue(value.toDouble(), valueStyle) }
    }
    val bottomAxisFormatter = remember {
        CartesianValueFormatter { context, value, _ ->
            val dateText = context.model.extraStore.getOrNull(ChartDateLabelsKey)?.get(value.toFloat())
            dateText?.let { formatMonthDay(it) } ?: value.toLong().let { LocalDate.ofEpochDay(it).let { date -> "${date.monthValue}/${date.dayOfMonth}" } }
        }
    }
    var markerVisible by remember { mutableStateOf(false) }
    val markerVisibleState = rememberUpdatedState(markerVisible)
    val marker = rememberFundChartMarker(valueStyle)
    val visibilityControlledMarker = remember(marker) {
        VisibilityControlledCartesianMarker(marker) { markerVisibleState.value }
    }
    val rangeProvider = remember(xRange) {
        CartesianLayerRangeProvider.fixed(minX = xRange.start, maxX = xRange.endInclusive)
    }
    val scrollState = rememberVicoScrollState(scrollEnabled = false)
    val bottomItemPlacer = remember(xLabelSpacing) {
        HorizontalAxis.ItemPlacer.aligned(
            spacing = { xLabelSpacing.coerceAtLeast(1) },
            addExtremeLabelPadding = true
        )
    }

    LaunchedEffect(points) {
        modelProducer.runTransaction {
            lineSeries {
                series(x = xValues, y = points.map { it.value })
            }
            extras { extraStore ->
                extraStore[ChartDateLabelsKey] = dateLabels
                extraStore[ChartPointsKey] = chartPoints
            }
        }
    }

    CartesianChartHost(
        chart = rememberCartesianChart(
            rememberLineCartesianLayer(lineProvider = lineProvider, rangeProvider = rangeProvider),
            startAxis = VerticalAxis.rememberStart(
                label = axisLabel,
                horizontalLabelPosition = VerticalAxis.HorizontalLabelPosition.Inside,
                valueFormatter = startAxisFormatter
            ),
            bottomAxis = HorizontalAxis.rememberBottom(
                valueFormatter = bottomAxisFormatter,
                itemPlacer = bottomItemPlacer
            ),
            marker = visibilityControlledMarker
        ),
        modelProducer = modelProducer,
        scrollState = scrollState,
        modifier = Modifier
            .fillMaxWidth()
            .height(184.dp)
            .pointerInput(Unit) {
                awaitPointerEventScope {
                    while (true) {
                        val event = awaitPointerEvent()
                        val position = event.changes.firstOrNull()?.position
                        val isInsideChart = position != null &&
                            position.x >= 0f &&
                            position.x <= size.width.toFloat() &&
                            position.y >= 0f &&
                            position.y <= size.height.toFloat()
                        markerVisible = when (event.type) {
                            PointerEventType.Press,
                            PointerEventType.Move,
                            PointerEventType.Enter -> isInsideChart
                            PointerEventType.Release,
                            PointerEventType.Exit -> false
                            else -> markerVisible && isInsideChart
                        }
                    }
                }
            }
    )
}

private class VisibilityControlledCartesianMarker(
    private val delegate: CartesianMarker,
    private val isVisible: () -> Boolean
) : CartesianMarker {
    override fun drawUnderLayers(context: CartesianDrawingContext, targets: List<CartesianMarker.Target>) {
        if (isVisible()) delegate.drawUnderLayers(context, targets)
    }

    override fun drawOverLayers(context: CartesianDrawingContext, targets: List<CartesianMarker.Target>) {
        if (isVisible()) delegate.drawOverLayers(context, targets)
    }

    override fun updateLayerMargins(
        context: CartesianMeasuringContext,
        layerMargins: CartesianLayerMargins,
        layerDimensions: CartesianLayerDimensions,
        model: CartesianChartModel
    ) {
        delegate.updateLayerMargins(context, layerMargins, layerDimensions, model)
    }
}

@Composable
private fun rememberFundChartMarker(valueStyle: ChartValueStyle): DefaultCartesianMarker {
    val labelBackground = rememberShapeComponent(
        fill = fill(MaterialTheme.colorScheme.inverseSurface),
        shape = CorneredShape.rounded(12.dp),
        strokeFill = fill(MaterialTheme.colorScheme.outlineVariant),
        strokeThickness = 1.dp
    )
    val label = rememberTextComponent(
        color = MaterialTheme.colorScheme.inverseOnSurface,
        textSize = 12.sp,
        padding = insets(horizontal = 10.dp, vertical = 8.dp),
        background = labelBackground
    )
    val guideline = rememberLineComponent(
        fill = fill(MaterialTheme.colorScheme.outline.copy(alpha = 0.58f)),
        thickness = 1.dp
    )
    val formatter = remember(valueStyle) {
        object : DefaultCartesianMarker.ValueFormatter {
            override fun format(context: CartesianDrawingContext, targets: List<CartesianMarker.Target>): CharSequence {
                val target = targets.firstOrNull() ?: return ""
                val point = context.model.extraStore.getOrNull(ChartPointsKey).nearestPoint(target.x.toFloat()) ?: return ""
                return buildString {
                    append(formatDate(point.date))
                    if (valueStyle == ChartValueStyle.Money) {
                        append("  收益 ")
                        append(formatChartValue(point.value, valueStyle))
                        append('\n')
                        append("净值 ")
                        append("%.4f".format(point.nav))
                        if (point.hasPosition) {
                            append("  份额 ")
                            append("%.2f".format(point.units))
                            append('\n')
                            append("成本 ")
                            append(formatAmount(point.cost))
                            append("  市值 ")
                            append(formatAmount(point.marketValue))
                        } else {
                            append('\n')
                            append("未确认持仓")
                        }
                    } else {
                        append("  净值 ")
                        append("%.4f".format(point.nav))
                    }
                }
            }
        }
    }
    return rememberDefaultCartesianMarker(
        label = label,
        valueFormatter = formatter,
        guideline = guideline
    )
}

@Composable
private fun TransactionTableHeader() {
    Row(modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("时间", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1.05f))
        Text("金额", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1.05f))
        Text("份额", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(0.85f))
        Spacer(Modifier.width(48.dp))
    }
}

@Composable
private fun EntryCard(entry: FundEntryDto, onEdit: () -> Unit) {
    var showMenu by remember { mutableStateOf(false) }
    val isBuy = entry.fundSubtype == "buy" || entry.fundSubtype == "regular_invest"
    val amountColor = if (isBuy) LocalDisplayPreferences.current.upColor else LocalDisplayPreferences.current.downColor
    val prefix = if (isBuy) "-" else "+"

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(10.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(start = 12.dp, top = 8.dp, bottom = 8.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(formatDate(entry.date), style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1.05f))
            Text("$prefix${formatAmount(entry.amount)}", style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp), fontWeight = FontWeight.SemiBold, color = amountColor, modifier = Modifier.weight(1.05f))
            Text(entry.unitsText(), style = MaterialTheme.typography.bodySmall.copy(fontSize = 13.sp), color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.weight(0.85f))
            Box {
                IconButton(onClick = { showMenu = true }) {
                    Icon(Icons.Default.MoreVert, contentDescription = "编辑")
                }
                DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }) {
                    DropdownMenuItem(
                        text = { Text("编辑") },
                        onClick = {
                            showMenu = false
                            onEdit()
                        }
                    )
                }
            }
        }
    }
}

@Composable
private fun FundActionBar(
    onSellClick: () -> Unit,
    onRegularInvestClick: () -> Unit,
    onBuyClick: () -> Unit
) {
    Surface(shadowElevation = 10.dp, color = MaterialTheme.colorScheme.surface) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            OutlinedButton(onClick = {}, enabled = false, modifier = Modifier.weight(1f), shape = RoundedCornerShape(28.dp)) {
                Text("转换")
            }
            OutlinedButton(onClick = onSellClick, modifier = Modifier.weight(1f), shape = RoundedCornerShape(28.dp)) {
                Text("卖出")
            }
            Button(onClick = onRegularInvestClick, modifier = Modifier.weight(1f), shape = RoundedCornerShape(28.dp)) {
                Text("定投")
            }
            Button(onClick = onBuyClick, modifier = Modifier.weight(1f), shape = RoundedCornerShape(28.dp)) {
                Text("买入")
            }
        }
    }
}

@Composable
private fun FundSettingsDialog(
    fundName: String,
    fundCode: String,
    confirmDays: Int,
    feeRate: Double,
    isSaving: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onSave: (Int, Double) -> Unit
) {
    var confirmDaysText by remember(fundCode, confirmDays) { mutableStateOf(confirmDays.coerceAtLeast(0).toString()) }
    var feeRateText by remember(fundCode, feeRate) { mutableStateOf("%.2f".format(feeRate)) }
    var localError by remember { mutableStateOf<String?>(null) }

    val parsedDays = confirmDaysText.toIntOrNull()?.takeIf { it >= 0 }
    val parsedRate = feeRateText.toDoubleOrNull()?.takeIf { it >= 0.0 }
    val canSave = parsedDays != null && parsedRate != null && !isSaving

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("$fundName 设置") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(
                    value = confirmDaysText,
                    onValueChange = {
                        localError = null
                        confirmDaysText = it.filter { ch -> ch.isDigit() }
                    },
                    label = { Text("确认 T+天数") },
                    singleLine = true,
                    enabled = !isSaving,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number)
                )
                OutlinedTextField(
                    value = feeRateText,
                    onValueChange = {
                        localError = null
                        feeRateText = it.filter { ch -> ch.isDigit() || ch == '.' }
                    },
                    label = { Text("申购费率 (%)") },
                    singleLine = true,
                    enabled = !isSaving,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal)
                )
                if (!error.isNullOrBlank()) Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall)
                if (!localError.isNullOrBlank()) Text(localError.orEmpty(), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall)
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    val days = parsedDays
                    val rate = parsedRate
                    if (days == null || rate == null) {
                        localError = "请输入有效的数值"
                    } else {
                        onSave(days, rate)
                    }
                },
                enabled = canSave
            ) {
                if (isSaving) CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp) else Text("保存")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !isSaving) { Text("取消") }
        }
    )
}

private fun buildProfitAmountPoints(history: List<NavHistoryItem>, entries: List<FundEntryDto>, confirmDays: Int): List<ChartPoint> {
    if (entries.isEmpty()) return emptyList()
    val sortedEntries = entries
        .mapNotNull { entry ->
            val effectiveDate = entry.effectiveFundDate(confirmDays) ?: return@mapNotNull null
            effectiveDate to entry
        }
        .sortedBy { it.first }

    var entryIndex = 0
    var units = 0.0
    var cost = 0.0
    val points = mutableListOf<ChartPoint>()

    history.forEach { item ->
        val navDate = parseLocalDateOrNull(item.date) ?: return@forEach
        while (entryIndex < sortedEntries.size && !sortedEntries[entryIndex].first.isAfter(navDate)) {
            val entry = sortedEntries[entryIndex].second
            val entryUnits = entry.unitsValue()
            val entryAmount = kotlin.math.abs(entry.amount)
            val entryFee = entry.fundFee ?: entry.fee ?: 0.0
            when (entry.fundSubtype) {
                "redeem", "switch_out" -> {
                    val reducingUnits = if (entryUnits > 0) entryUnits else 0.0
                    val avgCost = if (units > 0) cost / units else 0.0
                    units = (units - reducingUnits).coerceAtLeast(0.0)
                    cost = (cost - avgCost * reducingUnits).coerceAtLeast(0.0)
                }
                "dividend_cash" -> Unit
                else -> {
                    if (entryUnits > 0) {
                        units += entryUnits
                        cost += entryAmount + entryFee
                    }
                }
            }
            entryIndex++
        }

        val hasPosition = units > 0
        val avgCost = if (hasPosition) cost / units else 0.0
        val marketValue = if (hasPosition) item.nav * units else 0.0
        val profit = if (hasPosition) marketValue - cost else 0.0
        points += ChartPoint(
            date = item.date,
            value = profit,
            nav = item.nav,
            units = if (hasPosition) units else 0.0,
            avgCost = avgCost,
            cost = if (hasPosition) cost else 0.0,
            marketValue = marketValue,
            hasPosition = hasPosition
        )
    }
    return points
}

private fun firstPurchaseDate(entries: List<FundEntryDto>): LocalDate? {
    return entries.filter { it.isBuyLikeEntry() }
        .mapNotNull { parseLocalDateOrNull(it.date) }
        .minOrNull()
}

private fun FundEntryDto.isBuyLikeEntry(): Boolean {
    return fundSubtype.isBlank() || fundSubtype == "buy" || fundSubtype == "regular_invest" || fundSubtype == "dividend_reinvest" || fundSubtype == "switch_in"
}

private fun FundEntryDto.unitsText(): String = (fundUnits ?: shares)?.let { "%.2f".format(it) } ?: "-"

private fun FundEntryDto.unitsValue(): Double = fundUnits ?: shares ?: 0.0

private fun FundEntryDto.effectiveFundDate(confirmDays: Int): LocalDate? {
    val explicitConfirmDate = parseLocalDateOrNull(fundConfirmDate)
    if (explicitConfirmDate != null) return explicitConfirmDate
    val baseDate = parseLocalDateOrNull(date) ?: return null
    return if (isBuyLikeEntry()) {
        baseDate.plusDays(confirmDays.coerceAtLeast(0).toLong())
    } else {
        baseDate
    }
}

private fun filterHistoryByRange(history: List<NavHistoryItem>, range: ChartRange, entries: List<FundEntryDto>): List<NavHistoryItem> {
    if (history.isEmpty()) return history
    val latestDate = parseLocalDateOrNull(history.last().date) ?: LocalDate.now()
    val startDate = when (range) {
        ChartRange.Month -> latestDate.withDayOfMonth(1)
        ChartRange.HalfYear -> latestDate.minusDays(180)
        ChartRange.OneYear -> latestDate.minusDays(365)
        ChartRange.SincePurchase -> entries.mapNotNull { parseLocalDateOrNull(it.date) }.minOrNull() ?: LocalDate.MIN
    }
    return history.filter { item ->
        val date = parseLocalDateOrNull(item.date)
        date == null || !date.isBefore(startDate)
    }
}

private fun chartXRange(
    history: List<NavHistoryItem>,
    range: ChartRange,
    entries: List<FundEntryDto>
): ClosedFloatingPointRange<Double> {
    val latestDate = history.mapNotNull { parseLocalDateOrNull(it.date) }.maxOrNull() ?: LocalDate.now()
    val startDate = when (range) {
        ChartRange.Month -> latestDate.withDayOfMonth(1)
        ChartRange.HalfYear -> latestDate.minusDays(180)
        ChartRange.OneYear -> latestDate.minusDays(365)
        ChartRange.SincePurchase -> entries.mapNotNull { parseLocalDateOrNull(it.date) }.minOrNull()
            ?: history.mapNotNull { parseLocalDateOrNull(it.date) }.minOrNull()
            ?: latestDate
    }
    val start = startDate.toEpochDay().toDouble()
    val end = latestDate.toEpochDay().toDouble()
    return if (end > start) start..end else start..(start + 1.0)
}

private fun availableChartRanges(history: List<NavHistoryItem>, firstPurchaseDate: LocalDate?): List<ChartRange> {
    val latestDate = history.mapNotNull { parseLocalDateOrNull(it.date) }.maxOrNull() ?: LocalDate.now()
    val earliestHistoryDate = history.mapNotNull { parseLocalDateOrNull(it.date) }.minOrNull()
    val ranges = mutableListOf(ChartRange.Month)
    if (earliestHistoryDate == null || !earliestHistoryDate.isAfter(latestDate.minusDays(180))) {
        ranges += ChartRange.HalfYear
    }
    if (earliestHistoryDate == null || !earliestHistoryDate.isAfter(latestDate.minusDays(365))) {
        ranges += ChartRange.OneYear
    }
    if (firstPurchaseDate != null) {
        ranges += ChartRange.SincePurchase
    }
    return ranges.distinct()
}

private fun unavailableRangeHint(history: List<NavHistoryItem>, firstPurchaseDate: LocalDate?): String? {
    val latestDate = history.mapNotNull { parseLocalDateOrNull(it.date) }.maxOrNull() ?: return null
    val earliestHistoryDate = history.mapNotNull { parseLocalDateOrNull(it.date) }.minOrNull() ?: return null
    val months = java.time.temporal.ChronoUnit.MONTHS.between(earliestHistoryDate.withDayOfMonth(1), latestDate.withDayOfMonth(1))
    return when {
        months < 6 -> "历史净值不足半年，已隐藏半年和一年范围。"
        months < 12 -> "历史净值不足一年，已隐藏一年范围。"
        else -> null
    }
}

private fun chartRangeLabel(range: ChartRange): String = when (range) {
    ChartRange.Month -> "本月"
    ChartRange.HalfYear -> "半年"
    ChartRange.OneYear -> "一年"
    ChartRange.SincePurchase -> "购买以来"
}

private fun chartLabelSpacing(range: ChartRange, points: List<ChartPoint>): Int {
    return when (range) {
        ChartRange.Month -> 7
        ChartRange.HalfYear -> 30
        ChartRange.OneYear -> 60
        ChartRange.SincePurchase -> {
            val first = points.firstOrNull()?.date?.let { parseLocalDateOrNull(it) }
            val last = points.lastOrNull()?.date?.let { parseLocalDateOrNull(it) }
            val days = if (first != null && last != null) {
                java.time.temporal.ChronoUnit.DAYS.between(first, last).toInt().coerceAtLeast(1)
            } else {
                points.size.coerceAtLeast(1)
            }
            (days / 4).coerceAtLeast(7)
        }
    }
}

private fun parseLocalDateOrNull(value: String?): LocalDate? {
    if (value.isNullOrBlank()) return null
    return try {
        LocalDate.parse(value.substringBefore("T"))
    } catch (e: Exception) {
        null
    }
}

private fun formatChartValue(value: Double): String {
    return formatChartValue(value, ChartValueStyle.Nav)
}

private fun formatChartValue(value: Double, valueStyle: ChartValueStyle): String {
    return when (valueStyle) {
        ChartValueStyle.Money -> formatPnl(value)
        ChartValueStyle.Nav -> if (kotlin.math.abs(value) >= 100) "%.2f".format(value) else "%.4f".format(value)
    }
}

private fun Map<Float, ChartPoint>?.nearestPoint(x: Float): ChartPoint? {
    if (this.isNullOrEmpty()) return null
    return minByOrNull { (pointX, _) -> kotlin.math.abs(pointX - x) }?.value
}

private fun formatMonthDay(value: String): String {
    if (value.isBlank()) return ""
    val date = value.substringBefore("T")
    return when {
        Regex("""\d{4}-\d{2}-\d{2}""").matches(date) -> "${date.substring(5, 7)}-${date.substring(8, 10)}"
        Regex("""\d{2}-\d{2}""").matches(date) -> date
        Regex("""\d{2}\.\d{2}""").matches(date) -> date.replace(".", "-")
        else -> ""
    }
}
