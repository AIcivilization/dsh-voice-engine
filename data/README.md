# voices.json — 讯飞音色目录

生成于 2026-11-02，由 `dsh-xfyun` 插件内置使用。

## 文件

| 文件 | 大小 | 用途 |
|---|---|---|
| `voices.json` | 65 KB | 紧凑版，**插件运行时读这个** |
| `voices.pretty.json` | 83 KB | 缩进版，人读/调试用，内容完全相同 |

## 数据规模

```
235 条音色
├── 100  both     能听能用（有编码 + 有免费样音）⭐ 默认展示
├──  58  use      仅能用（有编码，无样音）
├──  17  listen   仅能听（有样音，无编码）
└──  60  locked   需控制台开通（saas 角色音色）
```

语种：`zh` 168、`en` 32，其余 35 条覆盖 fr/de/it/ru/ja/ko/es/pt/pt-BR/ar/th/vi/hi/tr/nl/pl/ur/id/ms/he/el/fa/yue(粤语)/sc(四川话)/ug(维吾尔)/bo(藏语)/mn(蒙古语)。

## 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `code` | string | **主键**。有官方发音人编码时用编码（如 `x4_lingfeizhe_zl`），否则 `name:<归一化名称>` |
| `name` | string | 标准名（已去「讯飞」前缀和前后空格） |
| `aliases` | string[] | 别名，如 `["聆小琬"]` |
| `style` | string | 风格细分，来自官方目录（如「成年女声」「亲切男声」） |
| `gender` | enum | `male` / `female` / `child` / `unknown` |
| `scene` | string \| null | 场景，来自对照表分类。`null` 表示官方未标（多为 saas 角色音色） |
| `lang` | string | 语种码，`zh` 默认；`yue`=粤语、`sc`=四川话 等 |
| `sample` | string \| null | 免费样音 URL（CDN 静态 wav，不扣点数） |
| `availability` | enum | 见下表，**页面的核心筛选维度** |
| `py` / `pyi` | string | 名称全拼 / 首字母，**只由 `name` 生成** |
| `styleAlt` / `sceneAlt` | string? | 试听台的细分风格与场景，仅参考，不覆盖官方值 |
| `flags` | string[] | `no_code` / `missing_scene` |

### availability 取值

| 值 | 含义 | 数量 | 前端处理 |
|---|---|---|---|
| `both` | 能听能用 | 100 | 默认展示 |
| `use` | 仅能用（无样音） | 58 | 折叠，标注「需实测」 |
| `listen` | 仅能听（无编码） | 17 | 折叠，标注「仅试听」 |
| `locked` | 需控制台开通 | 60 | 折叠，标注「需开通」 |

## 使用示例

```js
import voices from './data/voices.json' with { type: 'json' }

// 默认展示黄金子集
const golden = voices.voices.filter(v => v.availability === 'both')

// 拼音/首字母/编码/中文 统一搜索
const q = input.trim().toLowerCase()
const hit = voices.voices.filter(v =>
  v.name.includes(q) || v.py.includes(q) || v.pyi.includes(q) || v.code.toLowerCase().includes(q)
)

// 按语种 + 性别筛
const zhFemale = voices.voices.filter(v => v.lang === 'zh' && v.gender === 'female')
```

## 与原始数据的关系

| 原始文件 | 作用 |
|---|---|
| `讯飞音色试听台.html`（121 条内联） | 提供 `sample`（免费样音地址）、`styleAlt`、`sceneAlt` |
| `音色对照表.csv`（235 行） | 提供骨架、`code`、`style`、`scene` |
| 官方目录 `tts_language_list`（158 条） | 提供权威 `code` |

合并时以 **`code` 为主键**，不按名称。名称是弱标识（有别名、有「讯飞」前缀、有前导空格），用它做键会漏匹配。

## conflicts 字段

3 条未合入 `voices` 的条目，全部已定性：

| 条目 | 情况 | 处理 |
|---|---|---|
| 聆小琬 | 试听台标「可爱女童/童声」，官方标「成年女声」；样音已归属 `x4_lingxiaowan_boy` | 声线以官方为准 |
| 七哥 | 样音 `qige.wav` 与已收录条目相同，仅场景标注不同 | 忽略 |
| 超哥 | 样音 `超哥4.wav` 与已收录的 `超哥.wav` 不同 | 重复标注，忽略 |

## 已知待办

- `scene` 为 `null` 的 60 条（saas 角色音色）需从 saas 页面描述补场景
- `use` 类 58 条无样音，需用免费试用包实测后补听感备注
- 样音 URL 直连 CDN，若讯飞加 Referer 白名单会集体失效 → 首次播放后落盘缓存
