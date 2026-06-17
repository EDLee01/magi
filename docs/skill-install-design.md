# magi-native skill 安装：core / deferred 两层模型

状态：设计已定稿，待实现。
背景：当前 `src/skills/install.ts` 沿用 Claude Code 的假设——"安装一个 skill = 把它在仓库里的目录整个搬下来"。这在 `hugohe3/ppt-master` 上彻底失效：该 skill 目录有 12140 个文件（`templates/` 占 11841，`references/` 含 45MB AI 配图 PNG），远超 `DEFAULT_MAX_FILES = 400` 的硬上限，`--force` 也被拒绝。真正的核心（SKILL.md + scripts + workflows + requirements）只有约 150 个文件。

结论：不在 CC 的框架里打补丁，而是把"skill 安装"内化成 magi 自己的模型。

---

## 1. 核心转变

- CC 的假设：`skill = 把那个目录整个搬下来`
- magi 的假设：`skill = 一份安装清单(manifest) + 立即物化的核心(core) + 一组按需指针(deferred)`

安装动作从"clone 一个 CC 形状的目录"变成：
**解析源 → 分类 blob → 只下载 core → 写一份 magi 自己的 manifest 记录全部文件的 path/sha/size**。

资源不再是硬墙，而是 manifest 里的延迟指针。

### 天然切点

`install.ts` 当前拿到的是 GitHub trees API 的完整 blob 列表，每条带 `path / type / sha / size`——也就是说，安装时已经知道每个文件的路径、内容指纹(sha)、体积，但还没下载内容。下载只发生在逐个 `fetchBlob(sha)` 那一步。

因此分类发生在**拿到 tree 之后、fetchBlob 之前**：core 走 fetchBlob 立即物化，deferred 只把 path/sha/size 写进 manifest。

---

## 2. magi 安装清单：`.magi-skill.json`

放在 skill 目录根。和作者自带的 `SKILL.md` / `manifest.yaml` 区分开——那是作者的契约，这是 magi 的安装记录。

```json
{
  "source": {
    "owner": "hugohe3",
    "repo": "ppt-master",
    "ref": "main",
    "resolvedRef": "<commit-sha>",
    "subdir": "skills/ppt-master"
  },
  "installedAt": "2026-06-17T...",
  "core":     [ { "path": "SKILL.md", "sha": "...", "size": 50738 } ],
  "deferred": [ { "path": "templates/charts/area_chart.svg", "sha": "...", "size": 8123 } ],
  "stats": { "totalFiles": 12140, "coreFiles": 150, "coreBytes": 0, "deferredBytes": 0 }
}
```

关键点：**`resolvedRef` 钉死一个 commit sha**。deferred 文件后续按需拉取时，必须用 manifest 记录的同一个 sha 去取 blob，保证内容和当初 SKILL.md 所期望的一致，即使上游 `main` 已经动了。

---

## 3. core / deferred 分类策略：作者声明优先 + 启发式兜底

两个都做，A 优先。设计依据：优先用作者的成果，不丢细节；只有无声明的仓库才靠 magi 猜。

### A. skill 自带 manifest.yaml（如 nature-reader）

作者已声明加载契约。直接按声明分：
- `always_load` + `axes.*.values` 命中的文件 → core
- `references.on_demand[].path` → deferred
- 其余按 B 的启发式补充判定

这是最干净的路径：读作者声明的加载契约来决定安装足迹。

### B. 无 manifest（如 ppt-master）→ 启发式

- 必为 core：`SKILL.md`、`.magi-skill.json` 本身
- deferred：二进制（png/jpg/gif/pdf/字体/视频…），或单文件超过阈值（建议 256KB）
- 其余文本/代码 → core
- **不使用"目录文件数阈值"猜测**（见第 5 节）。若 core 文件数超出上限，**如实报告、交人决定**，不靠魔法数字替用户瘦身。

对 ppt-master 的实际效果（A 不适用，走 B）：
- core：`SKILL.md + scripts/(144) + workflows/(11) + requirements.txt` ≈ 150 文件，秒装、结构完整
- 但其文本型 `templates/`（11841 个 SVG）不会被二进制规则抓到，会令 core 超限 → 触发"如实报告"：提示该 skill 规模异常，要么 `--full` 全量装，要么上游应提供 manifest 声明按需项

---

## 4. 按需获取：两条触发路径

deferred 文件没下载，manifest 只记了它在源仓库的位置和 sha。真正写盘有两个场景：

### 路径一（透明，access-time 惰性物化）

agent 通过 magi 的文件工具（FileRead / Skill）读一个磁盘上不存在、但在 manifest `deferred` 列表里的路径 → magi 按 sha 拉那一个 blob → 写盘 → 返回内容。

对"读参考文档 / 按名挑模板"天然好使，magi 全程在场，拦得住。

### 盲区

如果 skill 自己的脚本（`python scripts/x.py` 内 `open("templates/foo.svg")`）去读 deferred 文件，那是子进程的 fs 调用，**magi 不在那条读路径上**，惰性物化拦不到，脚本会拿到 file-not-found。

一句话：**magi 能拦住自己读文件，拦不住 skill 脚本读文件。**

### 路径二（显式，必需件）

提供 `skills materialize <name> [glob]` 命令 + 同名工具，让 agent 在跑脚本前，按 SKILL.md 的说明把脚本将要用到的资源先批量拉到磁盘：

```
skills materialize ppt-master 'templates/charts/*'
```

manifest 的 path→sha 映射同时服务这两条路径。

**ppt-master 真要跑起来（而非只装上），靠的是路径二**；路径一只解决"读文档/选模板名"。已确认：materialize 是这套设计的必需件，不是可选。

---

## 5. 为什么砍掉"目录文件数阈值"

ppt-master 的 11841 个 templates 是 SVG（文本，非二进制），扩展名规则抓不到。曾考虑加一条"目录子树文件数 > N（如 50）→ 整子树 deferred"来兜住这种"海量文本资源池"。

否决理由：
- N 取多少纯拍脑袋，无依据
- 会误伤——某 skill 核心逻辑真拆成 200 个小文本文件时会被错判
- 纯靠"数量"猜"性质"，很脆

替代方案：无作者 manifest 时不靠阈值瞎猜，二进制/超大单文件 → deferred（可靠信号），其余进 core；若 core 仍超上限，**明确停下报告**（提示 `--full` 或上游补 manifest），把判断交还给人。

代价：ppt-master 这种"无声明 + 海量文本资源"的仓库，magi 不替它自动瘦身，而是如实报告让用户选。考虑到 ppt-master 本就该有 manifest（CC 打包不规范），不为一个不规范仓库往安装器里塞一条会误伤规范仓库的猜测规则。

---

## 6. 边界与兼容

- `maxFiles` 语义改为只约束 **core 文件数**；deferred 不计入。硬失败基本消失。
- 保留 `--full`：强制全部进 core（即当前行为），给"我就是要全量"的场景。
- 旧的、无 `.magi-skill.json` 的已装 skill 照常工作（loader 只读 SKILL.md）；manifest 缺失时 materialize 不可用、但不报错。

---

## 7. 实现切口（待动手）

1. `src/skills/install.ts`：拿到 tree 后分类 blob（A 优先 + B 兜底），只 fetchBlob core，写 `.magi-skill.json`；`maxFiles` 改为只约束 core；新增 `--full`。
2. 新增 manifest 读写模块（type + 读 `.magi-skill.json`）。
3. 惰性物化：magi 文件读取路径上挂一层——目标不存在但 manifest deferred 命中时，按 resolvedRef + sha 拉 blob 写盘。
4. 新增 `skills materialize <name> [glob]` CLI 命令 + 工具。
5. 测试：分类逻辑（A/B 两种输入）、manifest 读写、materialize 的 path→sha 解析、core 超限报告路径。

## 8. 待拍板项状态

1. `.magi-skill.json` 放 skill 根目录 — ✅ 确认
2. 作者声明优先 + 启发式兜底，两个都做 — ✅ 确认
3. 加 `skills materialize` 命令（决定 ppt-master 能否真正跑脚本）— ✅ 确认
4. 砍掉文件数阈值，改"超规模如实报告、交人决定" — ✅ 确认
