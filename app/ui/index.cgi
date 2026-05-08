#!/bin/bash

# 脚本名称: index.cgi
# 　　版本: 1.0.0
# 　　作者: FNOSP/xieguanru
# 　协作者: FNOSP/MR_XIAOBO
# 创建日期: 2025-11-18
# 最后修改: 2025-11-19
# 　　描述: 这个脚本用于演示 Shell 脚本的各种注释方式
# 使用方式: 文件重命名，从 linux_shell_cgi_index.sh 改成 index.cgi,
# 　　　　　放置应用包 /ui 路径下，记得 chmod +x index.cgi 赋权
# 　许可证: MIT

# 【注意】修改你自己的静态文件根目录，以本应用为例：
BASE_PATH="/var/apps/FanControlServer/target/www"
APP_NAME="FanControlServer"
ICONS_DIR="/var/apps/${APP_NAME}/var/icons"
ICONSDEFAULT_DIR="/var/apps/${APP_NAME}/var/iconsdefault"
DEFAULT_ICON="mydefault.png"

# 1. 从 REQUEST_URI 里拿到 index.cgi 后面的路径
#    例如：/cgi/ThirdParty/App.Native.HelloFnosAppCenter/index.cgi/index.html?foo=bar
#    先去掉 ? 后面的 query string
URI_NO_QUERY="${REQUEST_URI%%\?*}"

# 默认值（如果没匹配到 index.cgi）
REL_PATH="/"

# 用 index.cgi 作为切割点，取后面的部分
case "$URI_NO_QUERY" in
    *index.cgi*)
        # 去掉前面所有直到 index.cgi 为止的内容，保留后面的
        # /cgi/ThirdParty/App.Native.HelloFnosAppCenter/index.cgi/index.html -> /index.html
        REL_PATH="${URI_NO_QUERY#*index.cgi}"
        ;;
esac

# 如果为空或只有 /，就默认 /index.html
if [ -z "$REL_PATH" ] || [ "$REL_PATH" = "/" ]; then
    REL_PATH="/index.html"
fi

# ============================================================
# 自定义路由逻辑：访问 /api/status 时触发
# ============================================================
if [ "$REL_PATH" = "/api/status" ]; then
    # 1. 设置 HTTP 响应头
    echo "Content-Type: application/json; charset=utf-8"
    echo "Cache-Control: no-cache"
    echo "" # 必须有一个空行，代表 Header 结束
    
    # 2. 执行你的逻辑，比如检查服务状态
    # 2. 检查服务状态（区分 运行中、已停止、不存在）
    # 先检查服务文件是否存在
    SERVICE_NAME="linkmfile1"
    SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

    # 1. 首先检查服务文件是否存在 (判断是否为 idle)
    if [ ! -f "$SERVICE_PATH" ]; then
        # 场景 A: 服务文件不存在，判定为 idle
        SERVICE_STATUS="idle"
    else
        # 2. 服务文件存在，再检查运行状态
        # 使用 is-active 检查，比 show 快得多
        if systemctl is-active --quiet "$SERVICE_NAME"; then
            # 场景 B: 服务文件存在且正在运行
            SERVICE_STATUS="running"
        else
            # 场景 C: 服务文件存在但已停止 (或者 crash 了)
            SERVICE_STATUS="stopped"
        fi
    fi

    CURRENT_TIME=$(date "+%H:%M:%S")

    # 3. 输出结果（这里以 JSON 为例，方便 Vue 接收）
    echo "{\"status\": \"$SERVICE_STATUS\", \"time\": \"$CURRENT_TIME\", \"message\": \"这是来自 Shell 的逻辑\"}"
    
    # 4. 重点：执行完逻辑必须 exit 0，否则脚本会继续往下走去读文件
    exit 0
fi
# ============================================================

# ============================================================
# 自定义路由逻辑：访问 /api/geticon 时触发
# ============================================================
if [ "$REL_PATH" = "/api/geticon" ]; then
    echo "Content-Type: application/json; charset=utf-8"
    echo "Cache-Control: no-cache"
    echo ""
    first=1
    body="["

    while IFS= read -r raw_image; do
        [ -z "$raw_image" ] && continue

        image_name_only="${raw_image%:*}"
        ideal_icon_name="$(printf '%s' "$image_name_only" | tr '/' '_').png"

        if [ -f "${ICONS_DIR}/${ideal_icon_name}" ]; then
            final_icon="${ideal_icon_name}"
        else
            final_icon="$DEFAULT_ICON"
        fi

        image_esc="$(printf '%s' "$image_name_only" | sed 's/\\/\\\\/g; s/"/\\"/g')"
        icon_esc="$(printf '%s' "$final_icon" | sed 's/\\/\\\\/g; s/"/\\"/g')"

        if [ $first -eq 1 ]; then
            first=0
        else
            body="${body},"
        fi

        body="${body}{\"imageName\":\"${image_esc}\",\"rawImage\":\"${image_esc}\",\"iconName\":\"${icon_esc}\"}"
    done < <(docker ps -a --format "{{.Image}}" 2>/dev/null | LC_ALL=C sort -u)

    body="${body}]"
    echo "$body"
    exit 0
fi
# ============================================================

# ============================================================
# 自定义路由逻辑：访问 /api/changeicon 时触发
# ============================================================
if [ "$REL_PATH" = "/api/changeicon" ]; then
    echo "Content-Type: application/json; charset=utf-8"
    echo "Cache-Control: no-cache"
    echo ""

    if [ "$REQUEST_METHOD" != "POST" ]; then
        echo "{\"error\":\"Only POST is allowed\"}"
        exit 0
    fi

    if [ -z "$CONTENT_LENGTH" ] || [ "$CONTENT_LENGTH" -le 0 ] 2>/dev/null; then
        echo "{\"error\":\"request body is empty\"}"
        exit 0
    fi

    read -n "$CONTENT_LENGTH" POST_DATA
    image_name_betr=$(echo "$POST_DATA" | jq -r '.imageName' 2>/dev/null)
    image_path=$(echo "$POST_DATA" | jq -r '.imagePath' 2>/dev/null)
    image_base64=$(echo "$POST_DATA" | jq -r '.imageBase64' 2>/dev/null)
    # jq -r 在字段不存在时返回字符串 "null"，转为真正的空值
    [ "$image_path" = "null" ] && image_path=""
    [ "$image_base64" = "null" ] && image_base64=""
    image_name=$(echo "$image_name_betr" | tr '/' '_')
    TMP_FILE=""

    # imageName 必须存在
    if [ -z "$image_name" ]; then
        echo "{\"error\":\"imageName is required\"}"
        exit 0
    fi

    # 如果 imagePath 为空但有 imageBase64，则解码 base64
    if [ -z "$image_path" ] && [ -n "$image_base64" ] && [ "$image_base64" != "null" ]; then
        TMP_FILE=$(mktemp /tmp/dockericon_upload_XXXXXX 2>/dev/null)
        if [ -z "$TMP_FILE" ]; then
            echo "{\"error\":\"failed to create temp file\"}"
            exit 0
        fi
        # 解码 base64
        if ! echo "$image_base64" | base64 -d > "$TMP_FILE" 2>/dev/null; then
            rm -f "$TMP_FILE"
            echo "{\"error\":\"failed to decode image data\"}"
            exit 0
        fi
        # 用 file 命令检测图片类型
        detected_type=$(file -b --mime-type "$TMP_FILE" 2>/dev/null)
        case "$detected_type" in
            image/png)  src_ext="png"  ;;
            image/jpeg) src_ext="jpg"  ;;
            image/gif)  src_ext="gif"  ;;
            image/svg+xml) src_ext="svg" ;;
            image/webp) src_ext="webp" ;;
            *)
                rm -f "$TMP_FILE"
                echo "{\"error\":\"unsupported image type: $detected_type\"}"
                exit 0
                ;;
        esac
        image_path="$TMP_FILE"
    elif [ -z "$image_path" ]; then
        echo "{\"error\":\"imagePath or imageBase64 is required\"}"
        exit 0
    fi

    if ! printf '%s' "$image_name" | grep -qE '^[A-Za-z0-9._-]+$'; then
        [ -n "$TMP_FILE" ] && rm -f "$TMP_FILE"
        echo "{\"error\":\"invalid imageName\"}"
        exit 0
    fi

    if [ ! -d "$ICONS_DIR" ]; then
        [ -n "$TMP_FILE" ] && rm -f "$TMP_FILE"
        echo "{\"error\":\"icon directory does not exist\"}"
        exit 0
    fi

    if [ ! -f "$image_path" ]; then
        [ -n "$TMP_FILE" ] && rm -f "$TMP_FILE"
        echo "{\"error\":\"file does not exist\"}"
        exit 0
    fi

    # 如果是通过路径上传（非 base64），从路径名检测扩展名
    if [ -z "$TMP_FILE" ]; then
        src_ext="${image_path##*.}"
        src_ext="$(printf '%s' "$src_ext" | tr '[:upper:]' '[:lower:]')"
        case "$src_ext" in
            png|jpg|jpeg|gif|svg|webp)
                ;;
            *)
                echo "{\"error\":\"unsupported icon type\"}"
                exit 0
                ;;
        esac
    fi

    rm -f "${ICONS_DIR}/${image_name}.png" "${ICONS_DIR}/${image_name}.jpg" "${ICONS_DIR}/${image_name}.jpeg" "${ICONS_DIR}/${image_name}.gif" "${ICONS_DIR}/${image_name}.svg" "${ICONS_DIR}/${image_name}.webp"

    target_icon="${image_name}.${src_ext}"
    target_path="${ICONS_DIR}/${target_icon}"

    if ! cp -f "$image_path" "$target_path" 2>/dev/null; then
        [ -n "$TMP_FILE" ] && rm -f "$TMP_FILE"
        echo "{\"error\":\"failed to copy icon\"}"
        exit 0
    fi

    # 清理临时文件
    [ -n "$TMP_FILE" ] && rm -f "$TMP_FILE"

    chmod 644 "$target_path" 2>/dev/null
    echo "{\"ok\":true,\"imageName\":\"$image_name\",\"iconName\":\"$target_icon\"}"
    exit 0
fi
# ============================================================

# ============================================================
# Go Backend API 代理路由
# ============================================================

# 后端 Go 服务地址（默认端口 19527，可通过 service_port 环境变量覆盖）
GO_BACKEND="http://127.0.0.1:${service_port:-19527}"

# ---------- 鉴权接口（无需认证）----------

if [ "$REL_PATH" = "/api/auth/status" ]; then
    echo "Content-Type: application/json; charset=utf-8"
    echo "Cache-Control: no-cache"
    echo ""
    curl -s "${GO_BACKEND}/api/auth/status"
    exit 0
fi

if [ "$REL_PATH" = "/api/auth/setup" ] && [ "$REQUEST_METHOD" = "GET" ]; then
    echo "Content-Type: application/json; charset=utf-8"
    echo "Cache-Control: no-cache"
    echo ""
    curl -s "${GO_BACKEND}/api/auth/setup"
    exit 0
fi

if [ "$REL_PATH" = "/api/auth/setup" ] && [ "$REQUEST_METHOD" = "POST" ]; then
    echo "Content-Type: application/json; charset=utf-8"
    echo "Cache-Control: no-cache"
    echo ""
    if [ -z "$CONTENT_LENGTH" ] || [ "$CONTENT_LENGTH" -le 0 ] 2>/dev/null; then
        echo "{\"error\":\"request body is empty\"}"
        exit 0
    fi
    curl -s -X POST -H "Content-Type: application/json" --data-binary @- "${GO_BACKEND}/api/auth/setup"
    exit 0
fi

if [ "$REL_PATH" = "/api/auth/reset" ] && [ "$REQUEST_METHOD" = "POST" ]; then
    echo "Content-Type: application/json; charset=utf-8"
    echo "Cache-Control: no-cache"
    echo ""
    if [ -z "$CONTENT_LENGTH" ] || [ "$CONTENT_LENGTH" -le 0 ] 2>/dev/null; then
        echo "{\"error\":\"request body is empty\"}"
        exit 0
    fi
    AUTH=""
    [ -n "$HTTP_AUTHORIZATION" ] && AUTH="-H 'Authorization: $HTTP_AUTHORIZATION'"
    eval curl -s -X POST -H "Content-Type: application/json" $AUTH --data-binary @- "${GO_BACKEND}/api/auth/reset"
    exit 0
fi

# ---------- 设备接口（需要认证）----------

if [ "$REL_PATH" = "/api/device/info" ]; then
    echo "Content-Type: application/json; charset=utf-8"
    echo "Cache-Control: no-cache"
    echo ""
    AUTH=""
    [ -n "$HTTP_AUTHORIZATION" ] && AUTH="-H 'Authorization: $HTTP_AUTHORIZATION'"
    eval curl -s $AUTH "${GO_BACKEND}/api/device/info"
    exit 0
fi

if [ "$REL_PATH" = "/api/device/scan" ]; then
    echo "Content-Type: application/json; charset=utf-8"
    echo "Cache-Control: no-cache"
    echo ""
    AUTH=""
    [ -n "$HTTP_AUTHORIZATION" ] && AUTH="-H 'Authorization: $HTTP_AUTHORIZATION'"
    eval curl -s $AUTH "${GO_BACKEND}/api/device/scan"
    exit 0
fi

# ---------- 风扇配置接口（需要认证）----------

if [ "$REL_PATH" = "/api/fan/config" ] && [ "$REQUEST_METHOD" = "GET" ]; then
    echo "Content-Type: application/json; charset=utf-8"
    echo "Cache-Control: no-cache"
    echo ""
    AUTH=""
    [ -n "$HTTP_AUTHORIZATION" ] && AUTH="-H 'Authorization: $HTTP_AUTHORIZATION'"
    eval curl -s $AUTH "${GO_BACKEND}/api/fan/config"
    exit 0
fi

if [ "$REL_PATH" = "/api/fan/config" ] && [ "$REQUEST_METHOD" = "POST" ]; then
    echo "Content-Type: application/json; charset=utf-8"
    echo "Cache-Control: no-cache"
    echo ""
    if [ -z "$CONTENT_LENGTH" ] || [ "$CONTENT_LENGTH" -le 0 ] 2>/dev/null; then
        echo "{\"error\":\"request body is empty\"}"
        exit 0
    fi
    AUTH=""
    [ -n "$HTTP_AUTHORIZATION" ] && AUTH="-H 'Authorization: $HTTP_AUTHORIZATION'"
    eval curl -s -X POST -H "Content-Type: application/json" $AUTH --data-binary @- "${GO_BACKEND}/api/fan/config"
    exit 0
fi

if [ "$REL_PATH" = "/api/fan/set" ] && [ "$REQUEST_METHOD" = "POST" ]; then
    echo "Content-Type: application/json; charset=utf-8"
    echo "Cache-Control: no-cache"
    echo ""
    if [ -z "$CONTENT_LENGTH" ] || [ "$CONTENT_LENGTH" -le 0 ] 2>/dev/null; then
        echo "{\"error\":\"request body is empty\"}"
        exit 0
    fi
    AUTH=""
    [ -n "$HTTP_AUTHORIZATION" ] && AUTH="-H 'Authorization: $HTTP_AUTHORIZATION'"
    eval curl -s -X POST -H "Content-Type: application/json" $AUTH --data-binary @- "${GO_BACKEND}/api/fan/set"
    exit 0
fi

if [ "$REL_PATH" = "/api/fan/mode" ] && [ "$REQUEST_METHOD" = "POST" ]; then
    echo "Content-Type: application/json; charset=utf-8"
    echo "Cache-Control: no-cache"
    echo ""
    if [ -z "$CONTENT_LENGTH" ] || [ "$CONTENT_LENGTH" -le 0 ] 2>/dev/null; then
        echo "{\"error\":\"request body is empty\"}"
        exit 0
    fi
    AUTH=""
    [ -n "$HTTP_AUTHORIZATION" ] && AUTH="-H 'Authorization: $HTTP_AUTHORIZATION'"
    eval curl -s -X POST -H "Content-Type: application/json" $AUTH --data-binary @- "${GO_BACKEND}/api/fan/mode"
    exit 0
fi

if [ "$REL_PATH" = "/api/fan/source" ] && [ "$REQUEST_METHOD" = "POST" ]; then
    echo "Content-Type: application/json; charset=utf-8"
    echo "Cache-Control: no-cache"
    echo ""
    if [ -z "$CONTENT_LENGTH" ] || [ "$CONTENT_LENGTH" -le 0 ] 2>/dev/null; then
        echo "{\"error\":\"request body is empty\"}"
        exit 0
    fi
    AUTH=""
    [ -n "$HTTP_AUTHORIZATION" ] && AUTH="-H 'Authorization: $HTTP_AUTHORIZATION'"
    eval curl -s -X POST -H "Content-Type: application/json" $AUTH --data-binary @- "${GO_BACKEND}/api/fan/source"
    exit 0
fi

if [ "$REL_PATH" = "/api/fan/algorithm" ] && [ "$REQUEST_METHOD" = "POST" ]; then
    echo "Content-Type: application/json; charset=utf-8"
    echo "Cache-Control: no-cache"
    echo ""
    if [ -z "$CONTENT_LENGTH" ] || [ "$CONTENT_LENGTH" -le 0 ] 2>/dev/null; then
        echo "{\"error\":\"request body is empty\"}"
        exit 0
    fi
    AUTH=""
    [ -n "$HTTP_AUTHORIZATION" ] && AUTH="-H 'Authorization: $HTTP_AUTHORIZATION'"
    eval curl -s -X POST -H "Content-Type: application/json" $AUTH --data-binary @- "${GO_BACKEND}/api/fan/algorithm"
    exit 0
fi

if [ "$REL_PATH" = "/api/fan/curve" ] && [ "$REQUEST_METHOD" = "POST" ]; then
    echo "Content-Type: application/json; charset=utf-8"
    echo "Cache-Control: no-cache"
    echo ""
    if [ -z "$CONTENT_LENGTH" ] || [ "$CONTENT_LENGTH" -le 0 ] 2>/dev/null; then
        echo "{\"error\":\"request body is empty\"}"
        exit 0
    fi
    AUTH=""
    [ -n "$HTTP_AUTHORIZATION" ] && AUTH="-H 'Authorization: $HTTP_AUTHORIZATION'"
    eval curl -s -X POST -H "Content-Type: application/json" $AUTH --data-binary @- "${GO_BACKEND}/api/fan/curve"
    exit 0
fi

if [ "$REL_PATH" = "/api/fan/remove" ] && [ "$REQUEST_METHOD" = "POST" ]; then
    echo "Content-Type: application/json; charset=utf-8"
    echo "Cache-Control: no-cache"
    echo ""
    if [ -z "$CONTENT_LENGTH" ] || [ "$CONTENT_LENGTH" -le 0 ] 2>/dev/null; then
        echo "{\"error\":\"request body is empty\"}"
        exit 0
    fi
    AUTH=""
    [ -n "$HTTP_AUTHORIZATION" ] && AUTH="-H 'Authorization: $HTTP_AUTHORIZATION'"
    eval curl -s -X POST -H "Content-Type: application/json" $AUTH --data-binary @- "${GO_BACKEND}/api/fan/remove"
    exit 0
fi

if [ "$REL_PATH" = "/api/global/config" ] && [ "$REQUEST_METHOD" = "POST" ]; then
    echo "Content-Type: application/json; charset=utf-8"
    echo "Cache-Control: no-cache"
    echo ""
    if [ -z "$CONTENT_LENGTH" ] || [ "$CONTENT_LENGTH" -le 0 ] 2>/dev/null; then
        echo "{\"error\":\"request body is empty\"}"
        exit 0
    fi
    AUTH=""
    [ -n "$HTTP_AUTHORIZATION" ] && AUTH="-H 'Authorization: $HTTP_AUTHORIZATION'"
    eval curl -s -X POST -H "Content-Type: application/json" $AUTH --data-binary @- "${GO_BACKEND}/api/global/config"
    exit 0
fi
# ============================================================

# ============================================================
# 自定义路由逻辑：访问图标静态资源时触发
# ============================================================
if [ -n "$URI_NO_QUERY" ] && [[ "$URI_NO_QUERY" == "/apps/${APP_NAME}/icons/"* ]]; then
    icon_name="${URI_NO_QUERY#/apps/${APP_NAME}/icons/}"
    if printf '%s' "$icon_name" | grep -qE '(^$|\.\.|/)'; then
        echo "Status: 400 Bad Request"
        echo "Content-Type: text/plain; charset=utf-8"
        echo ""
        echo "Bad Request"
        exit 0
    fi

    icon_file="${ICONS_DIR}/${icon_name}"
    if [ ! -f "$icon_file" ]; then
        echo "Status: 404 Not Found"
        echo "Content-Type: text/plain; charset=utf-8"
        echo ""
        echo "404 Not Found"
        exit 0
    fi

    ext="${icon_file##*.}"
    case "$ext" in
        jpg|jpeg)
            mime="image/jpeg"
            ;;
        png)
            mime="image/png"
            ;;
        gif)
            mime="image/gif"
            ;;
        svg)
            mime="image/svg+xml"
            ;;
        webp)
            mime="image/webp"
            ;;
        *)
            mime="application/octet-stream"
            ;;
    esac

    echo "Content-Type: $mime"
    echo ""
    cat "$icon_file"
    exit 0
fi

if [[ "$REL_PATH" == /icons/* ]]; then
    icon_name="${REL_PATH#/icons/}"
    if printf '%s' "$icon_name" | grep -qE '(^$|\.\.|/)'; then
        echo "Status: 400 Bad Request"
        echo "Content-Type: text/plain; charset=utf-8"
        echo ""
        echo "Bad Request"
        exit 0
    fi

    icon_file="${ICONS_DIR}/${icon_name}"
    if [ ! -f "$icon_file" ]; then
        echo "Status: 404 Not Found"
        echo "Content-Type: text/plain; charset=utf-8"
        echo ""
        echo "404 Not Found"
        exit 0
    fi

    ext="${icon_file##*.}"
    case "$ext" in
        jpg|jpeg)
            mime="image/jpeg"
            ;;
        png)
            mime="image/png"
            ;;
        gif)
            mime="image/gif"
            ;;
        svg)
            mime="image/svg+xml"
            ;;
        webp)
            mime="image/webp"
            ;;
        *)
            mime="application/octet-stream"
            ;;
    esac

    echo "Content-Type: $mime"
    echo ""
    cat "$icon_file"
    exit 0
fi

if [[ "$REL_PATH" == /iconsdefault/* ]]; then
    icon_name="${REL_PATH#/iconsdefault/}"
    if printf '%s' "$icon_name" | grep -qE '(^$|\.\.|/)'; then
        echo "Status: 400 Bad Request"
        echo "Content-Type: text/plain; charset=utf-8"
        echo ""
        echo "Bad Request"
        exit 0
    fi

    icon_file="${ICONSDEFAULT_DIR}/${icon_name}"
    if [ ! -f "$icon_file" ]; then
        echo "Status: 404 Not Found"
        echo "Content-Type: text/plain; charset=utf-8"
        echo ""
        echo "404 Not Found"
        exit 0
    fi

    ext="${icon_file##*.}"
    case "$ext" in
        jpg|jpeg)
            mime="image/jpeg"
            ;;
        png)
            mime="image/png"
            ;;
        gif)
            mime="image/gif"
            ;;
        svg)
            mime="image/svg+xml"
            ;;
        webp)
            mime="image/webp"
            ;;
        *)
            mime="application/octet-stream"
            ;;
    esac

    echo "Content-Type: $mime"
    echo ""
    cat "$icon_file"
    exit 0
fi
# ============================================================

# 拼出真实文件路径：basePath + /ui + index.cgi 后面的路径
TARGET_FILE="${BASE_PATH}${REL_PATH}"

# 简单防御：禁止 .. 越级访问
if echo "$TARGET_FILE" | grep -q '\.\.'; then
    echo "Status: 400 Bad Request"
    echo "Content-Type: text/plain; charset=utf-8"
    echo ""
    echo "Bad Request"
    exit 0
fi

# 2. 判断文件是否存在
if [ ! -f "$TARGET_FILE" ]; then
    echo "Status: 404 Not Found"
    echo "Content-Type: text/plain; charset=utf-8"
    echo ""
    echo "404 Not Found: ${REL_PATH}"
    exit 0
fi

# 3. 根据扩展名简单判断 Content-Type
ext="${TARGET_FILE##*.}"
case "$ext" in
    html|htm)
        mime="text/html; charset=utf-8"
        ;;
    css)
        mime="text/css; charset=utf-8"
        ;;
    js)
        mime="application/javascript; charset=utf-8"
        ;;
    jpg|jpeg)
        mime="image/jpeg"
        ;;
    png)
        mime="image/png"
        ;;
    gif)
        mime="image/gif"
        ;;
    svg)
        mime="image/svg+xml"
        ;;
    txt|log)
        mime="text/plain; charset=utf-8"
        ;;
    *)
        mime="application/octet-stream"
        ;;
esac

# 4. 输出头 + 文件内容
echo "Content-Type: $mime"
echo ""

cat "$TARGET_FILE"