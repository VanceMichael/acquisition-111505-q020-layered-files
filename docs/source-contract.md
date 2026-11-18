# 合作来源约定

## 资料边界

/image/manifest 给出 orderedLayers(digest,size,href)，每层为 gzip tar；支持 regular、directory、symlink、hardlink。.wh.name 删除同目录 name，.wh..wh..opq 屏蔽低层目录子项；删除标记本身不作为文件。层内硬链接引用该层或已有最终视图的根内路径，缺目标保留未决。绝对/越界成员拒绝。不要解包执行文件。摘要为 sha256，白名单配置/素材路径在 fixtures/selection.json。

## 本地服务

来源和收件端是两个独立 HTTP 监听器。来源 `/health` 报告运行状态，`/__state` 返回当前情景；仅本地使用的 `POST /__control` 可改变来源情景，不属于收件端的业务 API。具体情景字段在 `provider/scenario.mjs` 的 `initialState` 中定义，切换只影响后续来源响应，不会改写已有收件。探查入口为 `/image/manifest`，请求相对链接必须以实际来源地址解释。

## 已有归档约定

人工入口只接收人工确认过的结构化对象，并不验证自动来源完整性。`Archive.accept(source, identity, data, raw, related)` 把原始字节按摘要保存，并为同一来源与身份保留不同版本；`related` 是必须同时落盘的附属内容（层字节与最终文件内容）。`source` 和 `identity` 的选择必须与业务对象对应，正文摘要只用于原文复用，不代表两份业务记录相同。`src/transport.mjs` 只发一次请求并拒绝重定向，不包含自动分页或领域恢复策略。

## 领取端解释

`POST /api/collect` 先按清单校验全部层，再合并最终视图；任何一层缺失或校验失败都以失败结束，不归档部分结果。层只按顺序解释：后层覆盖同路径、目录与链接互换时旧内容失效，`.wh.name` 与 `.wh..wh..opq` 只影响低层。视图条目以 `layer`／`layerDigest` 标明最终提供者，被屏蔽内容只写入 `history`。链接仅用于解释交付内部关系，从不跟随；绝对路径、越界路径、跨主机或重定向的来源链接一律拒绝。
