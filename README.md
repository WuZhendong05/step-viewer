# STEP 零件查看与加工特征高亮工作台

面向工程评审的浏览器工作台：查看 STEP / STL / 3MF / DXF / URDF / SRDF / SDF 模型，加载"报价版"加工特征识别 JSON 并在模型上高亮对应加工面；同时提供对外 HTTP 上传 API，供业务系统提交 STEP + 特征 JSON，换取一个可直接打开查看的浏览器 URL。

## 功能特性

- **模型查看**：在浏览器中打开 STEP/STL/3MF/DXF/URDF/SRDF/SDF 文件（Three.js 渲染）。
- **加工特征高亮**：加载 `特征识别 JSON`（报价版），按 `relatedEntityIds` 关联到 GLB 拓扑面并高亮。
- **GLB 惰性生成**：STEP 首次打开时由 `cadgen`（OCP/OpenCascade）后台构建 GLB 并缓存。
- **后台预热（默认开启）**：上传 API 落盘后立即在后台触发 GLB 构建 + 特征面 `stepEntityId` 注入，用户首次打开 URL 即秒开（预热失败自动回退懒加载）。可 `--no-prewarm` 关闭。
- **对外上传 API**（`server_py/api_server.py`，端口 8420）：鉴权、multipart 上传（`step` 文件 + `features` 文本）、异步任务、返回 **task 形态**（不含绝对路径）的 `viewerUrl`。
- **双 URL 形态**：
  - *path 模式*（本地/可信浏览）：`http://<host>:3245/D:/...?file=...`
  - *task 模式*（外部/上传 API 产出）：`http://<host>:3245/?task=<jobId>&file=...&features=...`

## 架构总览

```
业务系统 ──POST(step+features)──▶ 上传 API(:8420, API Key)
                                      │ 落盘 uploads/<jobId>/
                                      │ 返回 task 形态 viewerUrl
                                      ▼
用户浏览器 ──打开 viewerUrl──▶ 查看器(:3245)
                                │  SPA + /__cad/*（目录/读文件/GLB 构建/特征）
                                ▼
                            cadgen worker(OCP) 生成 GLB
```

- **8420 上传 API**：面向业务系统（程序），有鉴权，只负责"收文件、落盘、发 URL"。
- **3245 查看器**：面向最终用户（浏览器），无鉴权，渲染模型；两者通过共享 `uploads/` 目录衔接。
- 代码层：`viewer/` 是唯一应用目录；`server_py/` 为 Python 后端（http.server + cadgen 桥接），`src/` 为 React 前端。

## 目录结构

| 目录 | 内容 | 是否入库 |
|---|---|---|
| `viewer/` | 应用：前端 `src/`、后端 `server_py/`、构建 `dist/`、测试、`packages/cadgen` | ✅ 源码入库 |
| `tools/` | `step_feature_augment.py`（GLB 注入 stepEntityId）、`bench_step2glb.py` | ✅ 入库 |
| `samples/` | 示例 STEP 与特征识别结果（真实零件数据） | ❌ 不入库（本地） |
| `step/` | 批量零件 STEP（真实零件） | ❌ 不入库（本地） |
| `uploads/` | 运行时上传数据 | ❌ 不入库（本地） |
| `docs/` | 规范/对接文档（含敏感信息） | ❌ 不入库（本地） |
| `.workbuddy/` | agent 记忆、机器相关 | ❌ 不入库（本地） |

> 规则：**只提交源码**；CAD 零件数据、运行时数据、密钥、构建产物一律不入库（见 `.gitignore`）。

## 快速开始

环境搭建（CAD Python 环境等）见 **[SETUP.md](./SETUP.md)**。安装完成后：

```powershell
# 终端 1：启动查看器（用含 OCP 的 CAD 环境 Python）
cd viewer
set PYTHONPATH=%CD%
<CAD_PYTHON> -m server_py.server --host 0.0.0.0 --port 3245

# 终端 2：启动上传 API
cd viewer
set VIEWER_API_KEY=<你的密钥>
set PYTHONPATH=%CD%
rem --url-allow-hosts 是 stepUrl（服务端主动下载）的白名单；省略即禁用 URL 上传
python -m server_py.api_server --port 8420 --host 0.0.0.0 --viewer-host <本机IP> --viewer-port 3245 --url-allow-hosts "*.aliyuncs.com"
```

自检：

```powershell
curl http://127.0.0.1:3245/__cad/server    # 查看器
curl http://127.0.0.1:8420/healthz          # 上传 API
```

提交并拿 URL（task 形态）：

```bash
curl -X POST http://<host>:8420/api/v1/jobs \
  -H "Authorization: Bearer <API_KEY>" \
  -F "step=@part.STEP" \
  -F 'features={"code":200,"partType":"rectangular_part"}'
# → {"jobId":"...","status":"received"}，轮询 /api/v1/jobs/<jobId> 拿 result.viewerUrl
```

### 双时序：features 可随上传给，也可事后 attach

`GET /api/v1/jobs/{jobId}` 始终返回 `features` 状态（`none` / `done` / `failed` + `featuresError`）。
两种用法终点一致（同一 viewerUrl 形态），业务系统按 features 是否已就绪自行选择：

```bash
# 时序一：JSON 已就绪 → 随上传一起给（URL 打开即有特征树）
curl -X POST .../api/v1/jobs -F "step=@part.STEP" -F 'features={...}'

# 时序二：JSON 还没好 → 先只传 STEP（~1.5s 返回纯模型 URL，可先看图）
curl -X POST .../api/v1/jobs -F "step=@part.STEP"
#    特征识别完成后，attach 原始 JSON 文本（幂等覆盖；失败 400 + features=failed）
curl -X POST .../api/v1/jobs/<jobId>/features \
  -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" \
  --data-binary "@特征识别.json"
# → {"jobId":"...","features":"done","viewerUrl":"http://.../?task=...&file=...&features=..."}
```

约束：`relatedEntityIds` 是**该 STEP 文件**的实体编号，attach 的 JSON 必须与该 job
的 STEP 配对（跨零件 attach 语义错误）。解析失败不影响看图——主路径（模型 URL）
永远不依赖特征路径。

## 常用命令

```bash
cd viewer
npm install          # 前端依赖
npm run build        # 生产构建（产出 dist/，查看器 serve 模式需要）
npm run dev          # Vite 开发模式（HMR，127.0.0.1:3245）
npm run test         # JS 测试（node run-tests.mjs）
npm run serve        # 低层 Python 后端直启
npm run serve:api    # 上传 API 直启（需 VIEWER_API_KEY）
```

Python 后端测试：

```powershell
set PYTHONPATH=<项目根>\viewer\packages\cadgen\src
python -m pytest viewer\server_py\tests
```

## 接口文档索引

完整的对外接口契约（`POST /api/v1/jobs`、`GET /api/v1/jobs/{jobId}`、`/healthz`、错误码、安全部署）在**本地** `docs/业务系统对接接口文档.md`（该目录不入库；需要时向维护者索取或按需重建）。

## 协作约定

- 分支：`main`；功能开发可开短命分支 + PR 评审。
- 提交信息：`feat(api): ...` / `fix(server): ...` / `chore: ...` 前缀。
- **红线**：不要提交 `samples/`、`step/`、`uploads/`、`__cadgen__/`、`.env`、密钥文件、`docs/`；不要 `git add -f` 绕过 `.gitignore`。
- 机器专属路径不入库：用环境变量/占位符（如 `$CAD_PYTHON`、`$VIEWER_API_KEY`）。

## 安全与部署

- 查看器 3245 **无鉴权**、按 URL 路径读文件——**只限可信内网**，或置于带鉴权的反向代理之后；绑定非回环地址时服务会打印警告。
- 上传 API 8420 用 Bearer API Key；密钥用 `--api-key-file` 或 `$VIEWER_API_KEY_FILE` 从文件读取，勿写进命令行/仓库。
- `--debug` 仅开发/联调开启（会向调用方返回完整错误详情）。
- 详细安全清单见本地 `docs/业务系统对接接口文档.md` 第 11 章。
