# 层式软件交付的最终文件视图与来源领取

这是面向资料接收人员的 Node.js 服务。它在人工收件之外，按合作方交付的分层镜像给出**最终文件视图**：按清单顺序合并各层，正确解释后层覆盖、删除标记（`.wh.name`）和不透明目录（`.wh..wh..opq`），并可从最终视图领取配置与素材文件。本地来源独立提供合作方交互环境。

## 环境

支持 Node.js 22.22.1 及以上的 22.x 补丁版本；项目 Dockerfile 仍固定原有镜像摘要以保证可复现，正式 Linux 基线另外在 Node.js 22.23.4 验证。运行期没有第三方包及公网数据依赖。`npm ci --ignore-scripts --no-audit --no-fund` 安装锁定环境，`npm run build` 检查所有模块语法，`npm test` 验证归档、最终视图、HTTP 入口及来源行为。来源材料均为本地合成的业务样本，没有真实账号、个人材料或访问外部站点的要求。

`npm start` 同时启动收件服务 3200 和来源 4200；可分别通过 `PORT`、`SOURCE_PORT` 修改端口。`ARCHIVE_DIR` 指定收件目录，默认 `.local/archive`。`npm run demo` 使用临时目录和系统分配端口演示人工收件、自动领取、最终视图、文件领取、历史证据以及校验失败，结束即清理，通常只需数秒。

## 容器

`docker build -t layered-files:local .` 构建环境，`docker run --rm -p 3200:3200 -p 4200:4200 layered-files:local` 启动。环境准备后，`docker run --rm --network none layered-files:local sh -c 'npm run build && npm test && npm run demo'` 可离线检查现有功能。正式展示应从干净归档启动真实新增功能并展示当前输出，完整操作限时 90 秒；准备镜像不计入运行时间。

## 领取与最终视图

`POST /api/collect` 接收 `{"source": "http://来源地址"}`，取回 `/image/manifest` 与各层，按清单中的 SHA-256 与大小逐层校验后才合并视图。任一层缺失、大小或摘要不符、无法解压、tar 头校验失败时，请求以非 2xx 结束，**不会**归档或返回一份看似完整的最终视图。

- `GET /api/view` 给出当前最终视图 `entries` 和素材清单 `selection`。每个条目带 `layer` 与 `layerDigest`（该路径最终由哪层提供）；文件另有 `sha256`、`size`、`contentLayer`、`contentPath`（硬链接可追到实际提供内容的路径）。被后层覆盖、删除标记或不透明目录屏蔽的内容不在 `entries`／`selection` 中，只出现在 `history`；`events` 记录每个标记作用于哪个目录或路径。
- `GET /api/evidence` 只返回这些失效条目的历史证据，并附说明，不与当前素材清单混用。
- `GET /api/file?path=…` 只领取 `selection` 中的普通文件，返回原始字节以及 `x-content-sha256`、`x-content-layer`、`x-content-path`。链接不会被跟随读取，因此既读不到宿主机文件，也不会访问远程地址。
- `GET /api/records` 查询全部版本。自动交付的业务身份为来源地址与镜像；同一交付重复领取复用版本，内容变化保留旧版本。
- 可用 `?source=http://…` 指定来源，缺省取最近一次已领取的交付。

合并规则：

1. 按 `orderedLayers` 顺序应用；同一层内按归档顺序，后出现的成员决定最终内容。
2. 后层同路径的文件、目录、链接互相替换：旧文件被换成目录时不再提供旧内容，旧目录被换成文件时其子项一起失效。
3. `.wh.name` 只屏蔽低层同路径；`.wh..wh..opq` 只屏蔽低层该目录下的子项。两者本身不作为文件出现在视图里。
4. 硬链接按最终视图中的目标解析内容，可跨层；目标不存在或指向链接时保持未决（`pending`），既不计入素材清单，也不伪装成完整文件。
5. 符号链接只记录目标、是否指向交付内部（`linkInternal`）以及按路径词法解析出的位置（`linkResolved`），从不读取其目标。

## 边界

- 服务只解析字节，不把交付解包到磁盘或指定根目录，也不执行其中的任何文件。
- 成员路径为绝对路径或越出交付根时拒绝整个视图。来源清单与层链接必须解析到实际来源地址，跨主机、协议相对、非 HTTP 或需要重定向的引用一律拒绝。
- 归档目录按摘要保存 blobs、按业务身份保存 receipts；只有最终视图中仍可见的文件内容会归档，失效内容仅作为历史证据保留在版本记录里。

## 接口与目录

`POST /api/manual` 接收 `fixtures/manual.json` 同形的业务对象，人工记录身份字段为 image, path, layer，同一身份与相同原文重复提交复用版本，内容变化保留旧版本。`GET /health` 检查进程。

`src/` 为收件、传输与视图合并（`delivery.mjs`、`layer.mjs`、`tar.mjs`、`layers.mjs`），`provider/` 为独立来源服务，`fixtures/` 保留来源字节、素材白名单（`selection.json`）与人工记录，`test/` 验证现有行为。协议范围与局部身份约定见 `docs/source-contract.md`。
