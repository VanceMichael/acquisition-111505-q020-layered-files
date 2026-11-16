# 合作来源约定

## 资料边界

/image/manifest 给出 orderedLayers(digest,size,href)，每层为 gzip tar；支持 regular、directory、symlink、hardlink。.wh.name 删除同目录 name，.wh..wh..opq 屏蔽低层目录子项；删除标记本身不作为文件。层内硬链接引用该层或已有最终视图的根内路径，缺目标保留未决。绝对/越界成员拒绝。不要解包执行文件。摘要为 sha256，白名单配置/素材路径在 fixtures/selection.json。

## 收件端领取

`POST /api/collect` 接收 `{"source": "http://…"}`，按清单顺序从上到下逐层取回、核对 size 与 sha256、解析后才合成最终视图：

- 后层同名成员覆盖前层；上层删除标记和不透明目录只影响低层，标记本身不进入视图。
- 同名路径从文件变为目录或链接时，前层内容退出视图，不得沿用；上层目录可在旧链接同名处建立，旧链接只保留在 history。
- 链接只按交付根内的相对关系解释；绝对、越界、远程目标不跟随，只作为元数据。链接不落地，不读取宿主或远程内容。
- 任一层的获取、大小、摘要或解析失败会整体失败，返回 502（响应带 `code`, `stage`, `complete:false`），不写收件、不产出部分视图。
- 成功后返回 `layers`、`view`（最终文件视图）、`claims`（白名单内当前文件，含 `sha256`、`layerIndex`、`layerDigest`、`href`）、`links`、`pending`、`history`（失效内容仅作历史证据）。`GET /api/blobs/<sha256>` 取回已归档字节。

`GET /api/records` 同时列出人工收件与 `source: "image"` 的领取记录；重复领取同一交付复用同一版本。

## 解包

`src/extract.mjs` 的 `extractFinalView(composition, root)` 只写当前视图（默认仅白名单文件），根目录必须是绝对路径且不能是符号链接；逐段检查已存在组件，拒绝经过任何符号链接写入，也不创建链接。创始人可执行位被丢弃，只保留资料内容。

## 本地服务

来源和收件端是两个独立 HTTP 监听器。来源 `/health` 报告运行状态，`/__state` 返回当前情景；仅本地使用的 `POST /__control` 可改变来源情景，不属于收件端的业务 API。具体情景字段在 `provider/scenario.mjs` 的 `initialState` 中定义，切换只影响后续来源响应，不会改写已有收件。探查入口为 `/image/manifest`，请求相对链接必须以实际来源地址解释。

## 已有归档约定

人工入口只接收人工确认过的结构化对象，并不验证自动来源完整性。`Archive.accept(source, identity, data, raw)` 把原始字节按摘要保存，并为同一来源与身份保留不同版本。`source` 和 `identity` 的选择必须与业务对象对应，正文摘要只用于原文复用，不代表两份业务记录相同。`src/transport.mjs` 仅提供一次请求，不包含自动分页、协议解释或领域恢复策略。

