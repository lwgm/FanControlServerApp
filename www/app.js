const { createApp, ref, computed, onMounted, onBeforeUnmount } = Vue

createApp({
  setup() {
    const APP_NAME = 'dockericonmod'
    // 响应式状态
    const folderMappings = ref([createMappingItem()])
    const uiLogMessage = ref('')
    let uiLogTimer = null
    const status = ref('idle') // 'idle' | 'running' | 'stopped'
    const themeMode = ref('auto')
    const isLoading = ref(false)
    const lastUpdate = ref(formatTime(new Date()))
    const iconItems = ref([])
    const listContainer = ref(null)
    const listScrollTop = ref(0)
    const listViewportHeight = ref(520)
    const listScrollHeight = ref(520)
    const isListScrolling = ref(false)
    let listScrollTimer = null
    const pageScrollTop = ref(0)
    const pageViewportHeight = ref(0)
    const pageScrollHeight = ref(0)
    const isPageScrolling = ref(false)
    let pageScrollTimer = null
    let colorSchemeMedia = null
    const rowHeight = 136
    const overscan = 3

    // 计算属性
    const isRunning = computed(() => status.value === 'running')

    const statusText = computed(() => {
      const texts = {
        idle: '待命',
        running: '运行中',
        stopped: '已停止'
      }
      return texts[status.value]
    })

    const statusClass = computed(() => status.value)
    const totalHeight = computed(() => 0)
    const startIndex = computed(() => Math.max(0, Math.floor(listScrollTop.value / rowHeight) - overscan))
    const visibleCount = computed(() => Math.ceil(listViewportHeight.value / rowHeight) + overscan * 2)
    const endIndex = computed(() => Math.min(iconItems.value.length, startIndex.value + visibleCount.value))
    const topPadding = computed(() => 0)
    const visibleItems = computed(() => iconItems.value)
    const showCustomScrollbar = computed(() => false)
    const scrollbarThumbHeight = computed(() => {
      if (!showCustomScrollbar.value) return 0
      const ratio = listViewportHeight.value / listScrollHeight.value
      return Math.max(26, Math.floor(listViewportHeight.value * ratio))
    })
    const scrollbarThumbTop = computed(() => {
      if (!showCustomScrollbar.value) return 0
      const maxScroll = listScrollHeight.value - listViewportHeight.value
      if (maxScroll <= 0) return 0
      const track = listViewportHeight.value - scrollbarThumbHeight.value
      return Math.floor((listScrollTop.value / maxScroll) * track)
    })
    const showPageScrollbar = computed(() => pageScrollHeight.value > pageViewportHeight.value + 1)
    const pageScrollbarThumbHeight = computed(() => {
      if (!showPageScrollbar.value) return 0
      const ratio = pageViewportHeight.value / pageScrollHeight.value
      return Math.max(26, Math.floor(pageViewportHeight.value * ratio))
    })
    const pageScrollbarThumbTop = computed(() => {
      if (!showPageScrollbar.value) return 0
      const maxScroll = pageScrollHeight.value - pageViewportHeight.value
      if (maxScroll <= 0) return 0
      const track = pageViewportHeight.value - pageScrollbarThumbHeight.value - 12
      return 6 + Math.floor((pageScrollTop.value / maxScroll) * Math.max(0, track))
    })
    // 计算 API 基础路径：优先使用模块位置（支持通过 index.cgi 加载的情况），
    // 其次回退到 window.location.pathname。若路径包含 index.cgi，则保留到该片段。
    const API_BASE = (function () {
      try {
        let basePath = "/";
        if (typeof import.meta !== 'undefined' && import.meta.url) {
          try {
            basePath = new URL('.', import.meta.url).pathname;
          } catch (e) {
            basePath = window.location.pathname || '/';
          }
        } else {
          basePath = window.location.pathname || '/';
        }
        // 如果路径中包含 index.cgi，确保保留到 index.cgi/ 前缀
        const idx = basePath.indexOf('index.cgi');
        if (idx >= 0) {
          return basePath.slice(0, idx + 'index.cgi'.length) + '/';
        }
        if (!basePath.endsWith('/')) {
          const last = basePath.lastIndexOf('/');
          basePath = last >= 0 ? basePath.slice(0, last + 1) : '/';
        }
        return basePath;
      } catch (e) {
        return '/';
      }
    })();

    const api = {
      async request(url, options = {}) {
        // Resolve relative urls like "api/tasks" against API_BASE
        const resolved = /^(https?:)?\/\//.test(url) || url.startsWith('/') ? url : (API_BASE + url.replace(/^\/+/, ''));
        // merge headers, but allow caller to override
        const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
        const response = await fetch(resolved, {
          ...options,
          headers,
        });
        const text = await response.text();
        let payload = null;
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch (err) {
            // keep raw text in payload for better diagnostics
            payload = { _raw: text };
          }
        }
        console.log("API response", { url: resolved, status: response.status, payload });
        if (!response.ok) {
          const rawMessage = (payload && (payload.error || payload._raw)) || response.statusText || `HTTP ${response.status}`;
          const friendly = rawMessage;
          console.error("API error", { url: resolved, status: response.status, payload });
          throw new Error(friendly);
        }
        return payload || {};
      },
      geticon() {
        return this.request("api/geticon");
      },
      changeicon(data) {
        return this.request("api/changeicon",
          {
            method: "POST",
            body: JSON.stringify(data)
          },
        );
      },
      getRemInfo() {
        return this.request("api/reminfo");
      },
      getStatus() {
        return this.request("api/status");
      },
      runcmd(data) {
        return this.request("api/runcmd",
          {
            method: "POST",
            body: JSON.stringify(data)
          },
        );
      },
      stopcmd() {
        return this.request("api/stopcmd");
      }
    }

    // ============================================================
    // 文件上传相关 - 隐藏的 file input + base64 读取
    // ============================================================
    let fileSelectResolve = null
    const fileInput = document.createElement('input')
    fileInput.type = 'file'
    fileInput.accept = 'image/png,image/jpeg,image/gif,image/svg+xml,image/webp'
    fileInput.style.display = 'none'
    fileInput.addEventListener('change', (e) => {
      if (fileSelectResolve) {
        fileSelectResolve(e.target.files[0] || null)
        fileSelectResolve = null
      }
      fileInput.value = ''
    })
    document.body.appendChild(fileInput)

    function selectImageFile() {
      return new Promise(resolve => {
        fileSelectResolve = resolve
        fileInput.click()
      })
    }

    function readFileAsBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          // 去掉 data:image/...;base64, 前缀，只保留纯 base64 数据
          const base64 = reader.result.replace(/^data:image\/\w+;base64,/, '')
          resolve(base64)
        }
        reader.onerror = () => reject(new Error('读取文件失败'))
        reader.readAsDataURL(file)
      })
    }
    // ============================================================

    // 格式化时间
    function formatTime(date) {
      return date.toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
    }

    // 更新时间
    function updateTime() {
      lastUpdate.value = formatTime(new Date())
    }

    function applyTheme(theme) {
      document.documentElement.setAttribute('data-theme', theme)
    }

    function onSystemThemeChanged(event) {
      if (themeMode.value !== 'auto') {
        return
      }
      applyTheme(event.matches ? 'dark' : 'light')
    }

    function setupThemeSync() {
      if (!window.matchMedia) {
        themeMode.value = 'light'
        applyTheme('light')
        return
      }
      colorSchemeMedia = window.matchMedia('(prefers-color-scheme: dark)')
      applyTheme(colorSchemeMedia.matches ? 'dark' : 'light')
      if (typeof colorSchemeMedia.addEventListener === 'function') {
        colorSchemeMedia.addEventListener('change', onSystemThemeChanged)
      } else if (typeof colorSchemeMedia.addListener === 'function') {
        colorSchemeMedia.addListener(onSystemThemeChanged)
      }
    }

    function cycleThemeMode() {
      if (themeMode.value === 'auto') {
        themeMode.value = 'light'
        applyTheme('light')
        return
      }
      if (themeMode.value === 'light') {
        themeMode.value = 'dark'
        applyTheme('dark')
        return
      }
      themeMode.value = 'auto'
      if (colorSchemeMedia) {
        applyTheme(colorSchemeMedia.matches ? 'dark' : 'light')
      } else {
        applyTheme('light')
      }
    }

    function themeLabel() {
      if (themeMode.value === 'auto') return '自动'
      return themeMode.value === 'dark' ? '深色' : '浅色'
    }

    function themeAriaLabel() {
      return '切换主题，当前：' + themeLabel()
    }

    function showUiLog(message) {
      const timeText = new Date().toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
      uiLogMessage.value = timeText + ' ' + message
      if (uiLogTimer) {
        clearTimeout(uiLogTimer)
      }
      uiLogTimer = setTimeout(() => {
        uiLogMessage.value = ''
        uiLogTimer = null
      }, 5000)
    }

    function toList(input) {
      const text = typeof input === 'string' ? input : ''
      const tokens = text
        .split(/[，,;；\n\r\t]+/)
        .map(item => item.trim())
        .filter(Boolean)

      const deduped = []
      const seen = new Set()
      for (const token of tokens) {
        const key = token.toLowerCase()
        if (seen.has(key)) {
          continue
        }
        seen.add(key)
        deduped.push(token)
      }
      return deduped
    }

    function listToText(list) {
      return Array.isArray(list) ? list.join(', ') : ''
    }

    function createMappingItem(raw = {}) {
      const rawExt = Array.isArray(raw.ignoreExtensions)
        ? raw.ignoreExtensions
        : (Array.isArray(raw.ignore_extensions) ? raw.ignore_extensions : toList(raw.ignoreExtensions || raw.ignore_extensions || ''))
      const rawFolders = Array.isArray(raw.ignoreFolders)
        ? raw.ignoreFolders
        : (Array.isArray(raw.ignore_folders) ? raw.ignore_folders : toList(raw.ignoreFolders || raw.ignore_folders || ''))

      const ignoreExtensionsList = toList(Array.isArray(rawExt) ? rawExt.join(',') : rawExt)
      const ignoreFoldersList = toList(Array.isArray(rawFolders) ? rawFolders.join(',') : rawFolders)

      return {
        source: raw.source || '',
        target: raw.target || '',
        ignoreExtensionsList,
        ignoreFoldersList,
        ignoreExtensionsInput: listToText(ignoreExtensionsList),
        ignoreFoldersInput: listToText(ignoreFoldersList)
      }
    }

    function syncIgnoreExtensions(index) {
      const item = folderMappings.value[index]
      if (!item) return
      item.ignoreExtensionsList = toList(item.ignoreExtensionsInput)
    }

    function syncIgnoreFolders(index) {
      const item = folderMappings.value[index]
      if (!item) return
      item.ignoreFoldersList = toList(item.ignoreFoldersInput)
    }

    function normalizeIgnoreExtensions(index) {
      const item = folderMappings.value[index]
      if (!item) return
      item.ignoreExtensionsList = toList(item.ignoreExtensionsInput)
      item.ignoreExtensionsInput = listToText(item.ignoreExtensionsList)
    }

    function normalizeIgnoreFolders(index) {
      const item = folderMappings.value[index]
      if (!item) return
      item.ignoreFoldersList = toList(item.ignoreFoldersInput)
      item.ignoreFoldersInput = listToText(item.ignoreFoldersList)
    }

    function addMappingRow() {
      folderMappings.value.push(createMappingItem())
    }

    function removeMappingRow(index) {
      if (folderMappings.value.length <= 1) {
        return
      }
      folderMappings.value.splice(index, 1)
    }

    function buildIconUrl(iconName, ts) {
      const name = encodeURIComponent(iconName || '')
      const base = iconName === 'mydefault.png'
        ? (API_BASE + 'iconsdefault/' + name)
        : (API_BASE + 'icons/' + name)
      if (ts) {
        return base + '?t=' + ts
      }
      return base
    }

    function normalizeIconItem(raw = {}) {
      const imageName = String(raw.imageName || raw.rawImage || '').trim()
      const iconName = String(raw.iconName || '').trim()
      if (!imageName || !iconName) {
        return null
      }
      return {
        imageName,
        iconName,
        iconUrl: buildIconUrl(iconName),
        imagePath: '',
        isSaving: false,
        errorMessage: ''
      }
    }

    function onListScroll(event) {
      listScrollTop.value = event.target.scrollTop || 0
      listScrollHeight.value = event.target.scrollHeight || listScrollHeight.value
      listViewportHeight.value = event.target.clientHeight || listViewportHeight.value
      isListScrolling.value = true
      if (listScrollTimer) {
        clearTimeout(listScrollTimer)
      }
      listScrollTimer = setTimeout(() => {
        isListScrolling.value = false
        listScrollTimer = null
      }, 1300)
    }

    function refreshListViewport() {
      if (!listContainer.value) return
      listViewportHeight.value = listContainer.value.clientHeight || 520
      listScrollHeight.value = listContainer.value.scrollHeight || listViewportHeight.value
    }

    function refreshPageScrollbarMetrics() {
      const doc = document.documentElement
      pageScrollTop.value = window.scrollY || doc.scrollTop || 0
      pageViewportHeight.value = window.innerHeight || doc.clientHeight || 0
      pageScrollHeight.value = Math.max(doc.scrollHeight || 0, document.body ? document.body.scrollHeight : 0)
    }

    function onPageScroll() {
      refreshPageScrollbarMetrics()
      isPageScrolling.value = true
      if (pageScrollTimer) {
        clearTimeout(pageScrollTimer)
      }
      pageScrollTimer = setTimeout(() => {
        isPageScrolling.value = false
        pageScrollTimer = null
      }, 1300)
    }

    async function loadIconList() {
      isLoading.value = true
      await api.geticon().then(res => {
        const list = Array.isArray(res) ? res : (Array.isArray(res.list) ? res.list : [])
        iconItems.value = list.map(item => normalizeIconItem(item)).filter(Boolean)
        showUiLog('图标列表加载完成')
        setTimeout(refreshListViewport, 0)
      }).catch(err => {
        console.error('获取图标列表失败', err)
        showUiLog('获取图标列表失败：' + err.message)
      })
      isLoading.value = false
    }

    async function handleChangeIcon(item) {
      if (!item || item.isSaving) return
      const imagePath = String(item.imagePath || '').trim()

      let payload = { imageName: item.imageName }

      if (imagePath) {
        // 有路径 → 走原逻辑
        payload.imagePath = imagePath
      } else {
        // 无路径 → 弹出文件选择窗口
        let file
        try {
          file = await selectImageFile()
        } catch (e) {
          // 用户取消或出错，不处理
          return
        }
        if (!file) return
        // 读取为 base64
        let base64
        try {
          base64 = await readFileAsBase64(file)
        } catch (e) {
          item.errorMessage = '读取文件失败'
          return
        }
        payload.imageBase64 = base64
      }

      item.errorMessage = ''
      item.isSaving = true
      await api.changeicon(payload).then(res => {
        const iconName = String(res.iconName || item.iconName)
        item.iconName = iconName
        item.iconUrl = buildIconUrl(iconName, Date.now())
        item.imagePath = ''
        showUiLog(item.imageName + ' 图标已更新')
      }).catch(err => {
        console.error('修改图标失败', err)
        item.errorMessage = err.message || '修改失败'
        showUiLog(item.imageName + ' 修改失败')
      })
      item.isSaving = false
    }

    // 处理运行/停止
    async function handleAction() {
      if (isLoading.value) return

      if (isRunning.value) {
        // 停止程序
        isLoading.value = true
        await api.stopcmd().then(res => {
          console.log("Stop command response", res)
        }).catch(err => {
          console.error("Stop command failed", err)
          showUiLog('停止失败：' + err.message)
        })
        status.value = 'stopped'
        isLoading.value = false
        showUiLog('程序已停止')
        updateTime()
      } else {
        isLoading.value = true
        const normalizedMappings = folderMappings.value.map(item => {
          const extList = toList(item.ignoreExtensionsInput)
          const folderList = toList(item.ignoreFoldersInput)
          item.ignoreExtensionsList = extList
          item.ignoreFoldersList = folderList
          item.ignoreExtensionsInput = listToText(extList)
          item.ignoreFoldersInput = listToText(folderList)
          return {
            source: item.source,
            target: item.target,
            ignoreExtensions: extList,
            ignoreFolders: folderList
          }
        })

        await api.runcmd({ foldermappings: normalizedMappings }).then(res => {
          console.log("Run command response", res)
        }).catch(err => {
          console.error("Run command failed", err)
          showUiLog('启动失败：' + err.message)
        })
        status.value = 'running'
        isLoading.value = false
        showUiLog('程序启动成功')
        updateTime()
      }
    }

    // 模拟延迟
    function simulateDelay(ms) {
      return new Promise(resolve => setTimeout(resolve, ms))
    }
    onMounted(async () => {
      console.log('Vue 实例已挂载，页面加载完成！')
      setupThemeSync()
      await loadIconList()
      window.addEventListener('resize', refreshListViewport)
      window.addEventListener('resize', refreshPageScrollbarMetrics)
      window.addEventListener('scroll', onPageScroll, { passive: true })
      refreshListViewport()
      refreshPageScrollbarMetrics()
      // 举例：页面一加载就更新一次时间
      // 举例：如果你想从服务器获取当前服务的状态
      // fetchStatusFromServer() 
    })

    onBeforeUnmount(() => {
      if (uiLogTimer) {
        clearTimeout(uiLogTimer)
        uiLogTimer = null
      }
      if (listScrollTimer) {
        clearTimeout(listScrollTimer)
        listScrollTimer = null
      }
      if (pageScrollTimer) {
        clearTimeout(pageScrollTimer)
        pageScrollTimer = null
      }
      if (colorSchemeMedia) {
        if (typeof colorSchemeMedia.removeEventListener === 'function') {
          colorSchemeMedia.removeEventListener('change', onSystemThemeChanged)
        } else if (typeof colorSchemeMedia.removeListener === 'function') {
          colorSchemeMedia.removeListener(onSystemThemeChanged)
        }
      }
      window.removeEventListener('resize', refreshListViewport)
      window.removeEventListener('resize', refreshPageScrollbarMetrics)
      window.removeEventListener('scroll', onPageScroll)
    })

    return {
      folderMappings,
      uiLogMessage,
      status,
      themeMode,
      isLoading,
      isRunning,
      statusText,
      statusClass,
      lastUpdate,
      iconItems,
      visibleItems,
      totalHeight,
      topPadding,
      listContainer,
      isListScrolling,
      showCustomScrollbar,
      scrollbarThumbHeight,
      scrollbarThumbTop,
      onListScroll,
      showPageScrollbar,
      pageScrollbarThumbHeight,
      pageScrollbarThumbTop,
      isPageScrolling,
      cycleThemeMode,
      themeLabel,
      themeAriaLabel,
      handleChangeIcon,
      handleAction,
      addMappingRow,
      removeMappingRow,
      syncIgnoreExtensions,
      syncIgnoreFolders,
      normalizeIgnoreExtensions,
      normalizeIgnoreFolders
    }
  }
}).mount('#app')
