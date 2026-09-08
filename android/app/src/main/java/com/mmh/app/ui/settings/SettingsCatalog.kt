package com.mmh.app.ui.settings

import kotlinx.serialization.Serializable

@Serializable
data class SettingsCatalog(
    val schemaVersion: Int = 1,
    val id: String = "",
    val title: String = "系统设置",
    val description: String = "",
    val groups: List<SettingsCatalogGroup> = emptyList()
) {
    fun item(itemId: String): SettingsCatalogItem? =
        groups.asSequence()
            .flatMap { it.items.asSequence() }
            .firstOrNull { it.id == itemId }

    fun group(groupId: String): SettingsCatalogGroup? =
        groups.firstOrNull { it.id == groupId }
}

@Serializable
data class SettingsCatalogGroup(
    val id: String = "",
    val label: String = "",
    val description: String = "",
    val items: List<SettingsCatalogItem> = emptyList()
)

@Serializable
data class SettingsCatalogItem(
    val id: String = "",
    val label: String = "",
    val description: String = "",
    val icon: String = "",
    val surfaces: List<String> = emptyList(),
    val webHref: String? = null,
    val androidRoute: String? = null,
    val preferenceKeys: List<String> = emptyList(),
    val apiRefs: List<String> = emptyList()
)

fun fallbackSettingsCatalog() = SettingsCatalog(
    id = "mmh-settings-catalog-fallback",
    groups = listOf(
        SettingsCatalogGroup(
            id = "profile",
            label = "我的",
            items = listOf(
                SettingsCatalogItem(
                    id = "server",
                    label = "服务器设置",
                    description = "服务器地址、HTTPS、当前账簿和登录用户",
                    icon = "server",
                    surfaces = listOf("android"),
                    androidRoute = "server_settings"
                )
            )
        ),
        SettingsCatalogGroup(
            id = "display",
            label = "显示偏好",
            items = listOf(
                SettingsCatalogItem(
                    id = "color-scheme",
                    label = "涨跌颜色",
                    description = "红涨绿跌或绿涨红跌",
                    icon = "palette",
                    surfaces = listOf("android"),
                    preferenceKeys = listOf("colorScheme")
                )
            )
        )
    )
)
