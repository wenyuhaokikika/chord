# 和弦助手 —— 实现说明（process.md）

本文记录这个 demo 的技术选型、算法细节与踩过的坑，方便你继续改。阅读前建议先看 `README.md` 了解功能。

---

## 1. 技术选型：为什么是「原生壳 + WebView」，而不是 Compose

需求的核心是「把和弦按法画在指板上」，本质是**二维矢量绘制 + 组合枚举**，没有传感器、后台、大量数据存储的需求。三条候选路线：

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| Kotlin + Jetpack Compose | 最"原生"、性能最好 | 画指板要写 `Canvas`/`Path` 手工计算；每改一次样式都要重编译；依赖一堆 AndroidX/Compose 库 | 不选（demo 阶段成本过高） |
| Flutter / React Native | 跨平台 | 引入整套运行时，APK 体积涨到几 MB~十几 MB，构建链更重 | 不选 |
| **原生壳（Java）+ WebView（HTML/CSS/JS + SVG）** | 指板/和弦图用 SVG 声明式描述，改一行刷新即见；代码可离线测试；APK 约 227.3 KB；零第三方依赖 | 依赖系统 WebView；音色/动画略逊于原生 | **选它** |

工程上的直接收益：

- **零依赖**：`app/build.gradle` 里没有任何 `dependencies`，所有代码只用到 Android framework 自身（`android.app.Activity` + `android.webkit.WebView`）。
- **不需要 AndroidX**：`MainActivity` 直接继承 `Activity`，`Theme.Material.NoActionBar` 就够了。
- **逻辑可测**：乐理与算法全是纯函数（`music.js` / `chord.js`），能脱离 Android 直接在浏览器里做断言测试（见第 9 节），这也是本次开发效率最高的一点。

代价与应对：WebView 版本差异 → 全部 JS 用 ES5 写法（`var` + `function`，不用箭头函数/模板字符串/`Set`/`Object.assign`），API 21 的老机器也能跑；界面用 CSS 变量 + `prefers-color-scheme` 自适应深浅色。

---

## 2. 架构与数据流

```
用户操作（点 chip / 卡片 / 按钮）
        │
        ▼
   app.js  state  ────────────────────────────┐
  （唯一状态源，见 §6）                        │
        │                                     │
        │ 1. 推导和弦：主调+级数+变音 -> 根音 pc │
        │             属性 id -> 音程集合      │
        ▼                                     │
  chord.js  searchVoicings(rootPc, quality, opts)
        │   穷举全部把位的合法指法（§4）
        ▼
   voicings[]  ──► render.js  neck()       ──► 指板 SVG（吸顶）
                ──► render.js  chordBox()   ──► 每张指法卡片
                ──► audio.js  playVoicing() ──► WebAudio 试听
```

分层与文件职责：

| 文件 | 职责 | 依赖 |
| --- | --- | --- |
| `js/music.js` | 音名、pitch class、音阶、级数→音高、罗马数字 | 无 |
| `js/chord.js` | 30 种和弦属性表 + 全把位指法穷举 + 横按/指法推断 | music.js |
| `js/render.js` | 和弦图 SVG、全指板 SVG（纯字符串拼接，不碰 DOM） | music.js / chord.js |
| `js/audio.js` | WebAudio 加法弦合成：6 种音色（钢弦/尼龙/电清音/过载/失真/爵士）+ 5 种技巧 + 试听 | music.js / chord.js |
| `js/pitch.js` | 基频检测（自相关）；频率→音名/音分/最近琴弦 | music.js |
| `js/tuner.js` | 麦克风采集、实时分析循环、读数平滑 | pitch.js |
| `js/patterns.js` | 鼓机节奏库（13 种节奏 + 校验） | 无 |
| `js/transport.js` | 鼓机与伴奏共用的时钟/总线（保证拍点一致） | 无 |
| `js/voices.js` | 已排期音源登记表：停止时掐掉它们 | 无 |
| `js/drums.js` | 鼓机合成音色、离线渲染 | patterns.js / transport.js |
| `js/backing.js` | 和弦伴奏：走向/节奏型库、演奏计划、指法与根音弦 | music.js / chord.js / audio.js / transport.js |
| `js/band.js` | 伴奏/即兴实例总控：共用 BPM、三路音量、普通伴奏与实例播放、启停 | transport.js / drums.js / backing.js / improv.js |
| `js/store.js` | 自建内容持久化（SQLite / localStorage 双后端） | 无 |
| `js/pager.js` | 列表的搜索 + 分页小部件 | 无 |
| `js/drumsui.js` | 鼓机界面：步进格子、摇摆、音量 | patterns.js / drums.js |
| `js/bandui.js` | 伴奏总控界面 + 子页签 + 迷你条 + 当前和弦大字 | band.js / transport.js |
| `js/backingui.js` | 伴奏界面：走向/节奏型列表与编辑器 | backing.js |
| `js/instances.js` | 伴奏实例：鼓+走向+节奏型+调式/速度快照，SQLite `kind=instance` | store.js / backing.js |
| `js/llm.js` | OpenAI 兼容客户端：厂商预设、配置持久化、原生/fetch 双通道、SSE 流式、测试连接 | store.js |
| `js/agentqueue.js` | 即兴任务队列：FIFO、排队/运行/完成/失败/取消、流式与步骤回调 | 无 |
| `js/improv.js` | 即兴内核：简谱模型、Bias 校验、四 agent 流水线、本地作曲、配和弦、六线谱、播放引擎 | music.js / chord.js / backing.js / audio.js / transport.js |
| `js/improvui.js` | 独立即兴页：提示词、推荐面板/Top5、实例选择、风格/长度/音色/音量、队列/流、谱面、双吉他、设置入口 | improv.js / llm.js / pager.js / instances.js / crafts.js |
| `js/crafts.js` | craft 模型、推荐 agent、本地情绪推荐、实例构建、会话改谱 | store.js / llm.js / backing.js / patterns.js |
| `js/craftui.js` | 作品详情页：推荐/选择、简谱、播放/停止、会话修改 | crafts.js / improv.js / band.js |
| `js/app.js` | 状态、控件生成、事件、懒加载渲染、页签、主题 | 以上全部 |

`render.js` 只输出 SVG **字符串**、不操作 DOM，这样它既能被页面用 `innerHTML` 插入，也能在测试里直接对字符串做断言（第 9 节的坐标校验就是这么做的）。

---

## 3. 乐理模型

### 3.1 音高用 pitch class 表示

所有音都用 `0–11` 的整数（pitch class, pc）表示，`C=0, C♯=1 … B=11`。指板上第 `s` 弦第 `f` 品的音：

```js
TUNING = [40, 45, 50, 55, 59, 64];        // E2 A2 D3 G3 B3 E4（MIDI 音高）
pcAt(s, f)  = (TUNING[s] + f) % 12        // 音名，用于音程判断
midiAt(s, f)= TUNING[s] + f               // 绝对音高，用于去重与发声频率
```

用 MIDI 音高而不是音名，是为了：
1. 去重时能区分"同一个音名的不同八度"（`x32010` 与十二品处的同型指法音高不同，是两个真实不同的指法，都要保留）；
2. 试听时直接 `440 * 2^((midi-69)/12)` 就能得到频率。

### 3.2 和弦 = 根音 + 音程集合 + **必需音**

和弦属性表（`chord.js` 的 `QUALITY_LIST`，共 30 项）每一项有三个关键字段：

```js
{ id:'m7', symbol:'m7', intervals:[0,3,7,10], required:[0,3,10], triad:'min', seventh:true }
```

- `intervals`：**允许**出现的音（相对根音的半音数）。指法上出现的任何音都必须落在这个集合里，否则就是"错音"。
- `required`：**必须**出现的特征音。这是保证结果"像这个和弦"的关键：
  - `maj` 要求 `{1,3}`（根音、三音），五音可选 → 这就是为什么 `C` 的指法里会出现不带 G 的按法，吉他上这是常规做法；
  - `m7` 要求 `{1,♭7,3}`，所以不会把"只有根音和三音"的按法当成小七和弦；
  - 延伸和弦用"特征音"表达最地道的按法：`13` 要求 `{1,3,♭7,13}`（9、11 可选），`11` 要求 `{1,♭7,11}`（三音往往省略，这也是爵士吉他上的常见处理）；
  - `dim7`、`m7b5` 要求全部四个音，避免和减三和弦混淆。

罗马数字的记法也在这里处理：`m7b5` 的三和弦性质会被改写成 `halfdim`，这样 vii 级显示为 `viiø7` 而不是误导性的 `vii°7`（后者是减七和弦）。七和弦标记单独用 `Music.seventhFigure()` 映射，**只有大七写 `maj7`**——否则 `I7` 会被误读成属七和弦。

### 3.3 级数 → 和弦根音，调内和弦自动定性质

主调 + 音阶 + 级数 + 变音 → 根音：`(keyPc + scale.steps[degree-1] + accidental) % 12`。

"调内和弦"一排不是写死的表，而是按音阶现场推导：取音阶第 `i`、`i+2`、`i+4` 级算出三度/五度音程，再反查性质：

```js
t = (third - root) % 12;  f = (fifth - root) % 12;
(t,f) = (4,7)->maj  (3,7)->min  (3,6)->dim  (4,8)->aug
```

七和弦再加 `i+6` 级。于是三种音阶都自动正确：

- C 大调三和弦 → `maj, min, min, maj, maj, min, dim`（I ii iii IV V vi vii°）
- A 自然小调 → 罗马数字自动带 ♭：`i, ii°, ♭III, iv, v, ♭VI, ♭VII`
- A 和声小调 → `V` 级自动变成属七、`♭III` 级自动变成增三和弦（`aug7`）

---

## 4. 核心算法：全把位指法穷举

目标：给定和弦（根音 + 音程集合 + 必需音），找出 0–`maxFret` 品之间**所有**合理的按法。

### 4.1 朴素做法的问题

如果直接对 6 根弦各取 25 种可能（闷弦 + 0–24 品），组合数是 `26^6 ≈ 3 亿`，不可行。必须剪枝，而且要去重——同一个按法不能因为枚举顺序不同被算两次。

### 4.2 关键设计一：以「最低按弦品」归一化

**每个指法只在自己的最低按弦品所在的"把位窗口"里被枚举一次**：

```js
for (base = 0; base <= maxFret; base++) {
    // 每根弦的候选品位（跨度 span 通过候选范围天然保证）：
    //   -1（闷弦）
    //    0（空弦，仅当该音在和弦音集合内）
    //    base .. base+span（按弦，仅当该音在和弦音集合内）
}
// 枚举到底时校验：最低按弦品必须等于 base（没有任何按弦时 base 必须为 0）
```

好处有两个：搜索空间从"每个指法被算 O(span) 次"降到一次；`span`（跨度）约束不需要额外判断——候选品的范围本身就限定了跨度。空弦是特例：它不属于任何把位，所以在任意窗口都作为候选，由"最低按弦品"来决定它归属于哪个窗口。所以 `x32010` 只在 `base=1` 出现一次，而"全空弦"这种退化情况由 `base=0` 单独处理。

### 4.3 关键设计二：深度优先 + 三条剪枝

弦按 6→1 依次决策（`si` 是当前弦下标），DFS 状态为：

| 状态 | 含义 | 用途 |
| --- | --- | --- |
| `sounding` | 已发声弦数 | 最少发声弦数剪枝 |
| `mask` | 已出现音名的位掩码（12 位） | 必需音剪枝，O(1) 判断 |
| `minPressed` | 目前最低按弦品 | 归一化校验 |
| `phase` | 0=前导闷弦 / 1=发声块内 / 2=发声块已结束 | 保证发声弦连续 |
| `innerMute` | 发声块被截断后重新发声的次数 | 控制"中间夹闷弦" |

三条剪枝（都能在常数时间判断）：

```js
if (sounding + (6 - si) < minSounding) return;                    // 弦数不够
if (requiredCount - popcount(mask & requiredMask) > (6 - si)) return;  // 必需音补不齐
// 声音块连续性：phase===2 时再发声 → innerMute+1，超过上限直接跳过
```

最后一条保证结果符合吉他手的直觉：`x3201x`（首尾可以闷弦）合法，`3x2010`（中间夹闷弦）默认被排除——除非用户显式打开"允许发声弦中间有闷弦"。

### 4.4 过滤、去重与排序

枚举到底后按顺序做四件事：

1. **必需音齐全**：`(mask & requiredMask) === requiredMask`；
2. **低音检查**：默认要求最低发声弦的音就是根音（即"原位"）。关掉这个选项就能看到转位指法（例如 `032010` 是 C/E）；
3. **两级去重**：先按品位数组去重（防御性），再按**实际发声音高**（`midiNotes.join('-')`）去重——这样"音高完全相同、只是按法写法不同"的情况只会留一个，而不同八度的同型指法（`x32010` 和十二品处的对应指法）会被保留；
4. **排序**：把位升序 → 发声弦数降序 → 跨度升序 → 品位和升序。所以每个把位里排第一的一定是"最饱满、最好按"的那个。

### 4.5 横按与指法推断

吉他和弦谱里横按要画成一根横条，指法数字也要合理。规则（`analyseFingering`）：

- **横按**：最低按弦品上有 ≥2 根弦，且横跨范围内每根弦的品位都 **不低于**该品 → 画横按条，横按品全部记食指（1）。
  后半句是容易写错的地方：一根手指横按过去时，被它压住的琴弦不可能还发出空弦音，所以"中间夹空弦"的按法（典型例子 `x10231`，B♭maj7）**不是**横按，它需要两个手指分别按 6 弦侧和 1 弦侧。同理，中间夹闷弦也不是横按。
- **其余手指**：把剩余的不同按品从小到大分配 2、3、4；
- 如果不同按品超过 4 个（需要同时用 5 根手指），就不标指法数字，只画圆点——避免给出错的手指建议。

这是**启发式**而非权威指法（真实指法还涉及手指伸展、闷音技巧等），所以 README 里明确写了"仅供参考"。

### 4.6 实测数据

| 项目 | 数值 |
| --- | --- |
| C 大三和弦（24 品、跨度 4、最少 4 弦、低音为根音） | **120** 个指法，覆盖 15 个把位（1,2,3,5,7,8,9,10,12,13,14,15,17,19,20），耗时 **2 ms** |
| Cmaj7 / C7 / Cm7 / Cdim7 | 322 / 182 / 111 / 93 个 |
| C13（特征音多、约束松） | 725 个 |
| C5 强力和弦 | 24 个 |
| 全量压测：12 个根音 × 30 种属性 = 360 次搜索 | 共 81073 个指法，总耗时 **260 ms**，单次最慢 **5 ms** |

也就是说，手机上每次改条件重算一次的开销是"一两毫秒"级别，不需要缓存，也不需要 Web Worker。

### 4.7 CAGED：把穷举结果折成五个可记忆的锚点

120 个合法指法对“能不能弹”有用，对“怎么记”没用。所以 UI 默认展示 CAGED 五个代表指型，
完整穷举折叠到「全部指法（高级）」里。实现不硬编码 30 种属性的和弦图，而是从当前合法指法里挑代表：

- 根音弦：C/A 型看 5 弦（代码索引 1），G/E 型看 6 弦（索引 0），D 型看 4 弦（索引 2）；
- 每个区域按“形状相似 + 把位接近 + 发声弦数”打分，C 型优先开放 C，其余优先闭合、少空弦；
- G 型根音在 0–2 品时自动用高八度位置（`root+12`），否则三个品位的跨度放不下；
- 输出固定按 C → A → G → E → D 排序，每张卡显示根音品位、当前把位和和弦图；
- 换调/换属性时重新分五组，不改变原有 `searchVoicings()` 的完整结果。

这样默认只给用户 5 个学习单元，但“高级”里仍能查到所有按法；CAGED 只是**视图**，不是新的指法库。

---

## 5. 渲染：两套 SVG

### 5.1 和弦图（指法卡片）

就是纸质和弦谱里的小方格图：6 条竖线（弦）、5 行（品）。

- **起始品**：如果最高按弦品 ≤ 5，就从琴枕开始画（第 1 行加粗成琴枕）；否则从最低按弦品开始画，并在左侧标出 `5fr` 这样的起始品号；
- **空弦/闷弦**：弦上方画 `○` / `×`；
- **按弦点**：半径 9 的圆，里面按设置显示指法数字、音名或什么都不显示；
- **横按**：把横跨的圆点连成一根圆角胶囊；
- **弦名**：底部标注 `E A D G B E` 便于和指板对照。

### 5.2 全指板图

横放整条琴颈（弦是横线、品是竖线），坐标全部由一个 `NECK_METRICS` 常量表驱动（`fretW=42, rowH=30, leftPad=46, topPad=26`），`app.js` 计算滚动位置时也读这张表，避免两处硬编码不同步：

```
y(弦 s) = topPad + (5 - s) * rowH      // s=0 是 6 弦（最粗），画在最下面
x(品丝 f) = leftPad + f * fretW
x(按弦点 f) = leftPad + (f - 0.5) * fretW   // 按弦点落在品格中间
x(空弦/闷弦) = leftPad - 17             // 琴枕左侧
```

因为 24 品 × 42px ≈ 1087px 宽，超出一屏，所以指板容器横向滚动，并在选中新指法时自动把该把位滚到视野中央（`scrollLeft = x(把位) - clientWidth/2`）。

绘制内容（按 z 序）：琴颈底色 → 把位高亮窗口（半透明框住该指法的按弦范围）→ 品记点（3/5/7/9/15/17/19/21 单点，12/24 双点）→ （可选）全指板和弦音淡色底图 → 品丝 → 琴枕 → 6 根粗细递减的弦 → 品号 → 弦名 → 当前指法的圆点/空弦圈/闷弦×/横按条，圆点里直接写**音名**。

颜色不写在 SVG 里，而是给元素挂 class（`.nk-dot`、`.cb-open` …），由 CSS 变量统一着色，于是深/浅色主题自动跟随系统，不用改一行 JS。

### 5.3 指板图 vs 和弦图的取舍

卡片用"和弦图"（竖排 5 品窗口）是因为这是吉他手最熟悉的读图方式；指板用"整条琴颈"是因为用户要的正是"这个和弦在指板上是什么形状、分布在哪些位置"。两者联动：点卡片 → 指板跳到该把位并高亮。

---

## 6. 交互层

### 6.1 单一状态源 + 全量重绘

`app.js` 顶部一个 `state` 对象是唯一状态源（主调、音阶、级数、变音、属性、最大品、跨度、最少发声弦数、低音是否根音、展示方式、标注方式、品域过滤、当前选中下标…）。任何操作都走同一条路径：

```
改 state → searchVoicings() → 重建控件高亮 → 渲染页头 → 渲染结果列表 → 渲染指板
```

没有虚拟 DOM、没有 diff，纯函数式重绘。因为搜索只要 1–2 ms、单次 DOM 重建量可控，这个"笨办法"反而最不容易出错。

两处必要的优化：

- **保留横向滚动位置**：控件 chip 行重建前记录 `scrollLeft`，重建后写回（`rebuild()`），否则点最右边的 chip 会导致行首回弹；
- **控件重建 vs 局部更新**：只有依赖根音的部分（属性 chip 的文案要显示实际和弦名，如 `Cmaj7`）才重建，其余用 `syncChips()` 只切 `.on` 类。

### 6.2 结果列表懒加载

极端情况下（如 `C13`）单次查询有 700+ 个指法。一次性插入 700 个 SVG（每个约 60 个节点）≈ 4 万个节点，手机上首屏布局会明显卡顿。

处理方式：所有**把位分组标题**立即渲染（用户马上看到"有哪几个把位、各多少个"），而每个分组里的**卡片**用 `IntersectionObserver`（`rootMargin: 700px`）在滚动到附近时才生成，并用 `.cards.lazy { min-height: 196px }` 先占住高度避免滚动跳动。首屏额外强制渲染前两组，保证一打开就有内容。`IntersectionObserver` 不可用时退化为全部立即渲染。

### 6.3 移动端布局：为什么做成底部抽屉

第一版把查询条件放在页面顶部，手机上一屏（390×844）里指板被挤到屏幕外了——对一个"查和弦"的工具来说这是致命的。改成：

- 顶部：和弦名与组成音（是"结果"不是"输入"）；
- 其下：吸顶的指板工具条 + 指板图 + 一行指法信息（弦数 · 谱记法 · 各音级数）；
- 条件是**从底部升起的抽屉**，高度取 `min(58vh, calc(100vh - 460px))`，并设 `min-height: 200px`。这里的关键是那个 `calc`：它保证抽屉顶端始终落在"页头 + 工具条 + 指板"之下，选条件时能实时看到指板变化；打开抽屉时还会 `scrollTo(0,0)`，避免吸顶把页头顶出屏幕；
- 抽屉打开时锁背景滚动，点遮罩或"完成"关闭；从"调内和弦"一键选定后自动收起（这时用户的目标已经达成）。

矮屏（高度 < 700px，如 320×568 的老机型）上还有两道自适应：页头压缩（隐藏副标题、和弦名从 38px 降到 30px），以及指板的弦距从 30px 收到 24px（`NECK_METRICS.smallRowH`）。这样在 320×568 上，指板仍然完整地露在抽屉上方。指板行高的选择放在 `render.js` 内部按 `window.innerHeight` 决定，测试里则显式传 `rowH` 以保证断言确定性——这是一个刻意的取舍：**渲染可参数化，测试就不该依赖环境**。

指板右侧的品记点画在 G 弦与 D 弦之间（琴颈正中），和真实指板一致；12、24 品是上下成对的双点。

---

## 7. 试听：用 WebAudio 现场合成

没有音频素材，每个音都是现场合成的拨弦模型：

```
三角波（基频）+ 锯齿波（2 倍频，增益 0.16）→ 低通滤波 → 指数衰减包络
                                        ↘ 拨片噪声瞬态（30ms 高通噪声包络）
```

低通截止频率从 `f*9` 指数滑向 `f*2.2`，模拟拨弦后高频快速衰减；再叠一层 30ms 的滤波噪声当"拨片声"。六个音按 32ms 间隔依次触发模拟下扫，低音弦增益略大。

UI 侧注意两点：`AudioContext` 必须在用户手势里创建/`resume()`（手机上不允许自动播放），所以是点 ♪ 时才懒创建；WebView 侧配了 `setMediaPlaybackRequiresUserGesture(false)` 减少限制。

---

## 8. Android 外壳

`MainActivity.java` 只做五件事：

1. **承载 WebView**：`loadUrl("file:///android_asset/www/index.html")`，JS/DOM Storage 打开、允许读 assets、关闭缩放与长按选中，`OVER_SCROLL_NEVER` 去掉边缘发光——让它像一个 App 而不是网页。
2. **系统栏配色**：按 `uiMode` 判断深浅色，状态栏/导航栏/窗口底色与网页主题一致（`values/colors.xml` 与 `values-night/colors.xml`），避免启动瞬间"白闪"或上下割裂。
3. **窗口配置**：`AndroidManifest` 里声明 `configChanges="orientation|screenSize|...|uiMode"`，这样旋转屏幕不会重建 Activity（WebView 状态保留）；配合 CSS 的 `env(safe-area-inset-*)` 处理刘海屏。
4. **系统能力桥接**：
   - `RECORD_AUDIO`：网页调 `getUserMedia` 时先拿系统权限，再把 `PermissionRequest` 授权给 WebView；
   - `NativeStore`（`StoreDb.Bridge`）：SQLite 读写；
   - `NativeHttp`（`HttpBridge`）：异步 POST，供「即兴」调用用户自己配置的模型 API；
   - `onShowFileChooser` / `onActivityResult`：网页的 `<input type="file">` 走系统文件选择器，把图片 Uri 交回 WebView。
5. **容错**：极少数设备没有可用的 WebView 内核，`new WebView()` 会抛异常，此时降级成一段文字提示而不是崩溃；`onPageFinished` 后回读一次 DOM 关键状态打进 logcat，白屏时能一眼定位。

权限：`RECORD_AUDIO`（调音，点了“开始收音”才申请）+ `INTERNET`
（只有即兴调用用户自己的 API 时才用）。和弦、调音、鼓机、伴奏、谱库全部离线。
`INTERNET` 是普通权限，安装时不会弹窗；真正发不发请求由用户有没有配置 API 决定。

`HttpBridge` 的关键点：

- `addJavascriptInterface` 的方法在 **JavaBridge 线程**执行，JS 调用会同步等待，所以不能在里面直接发网络请求；
  方法立刻返回一个 id，请求在 2 线程池里跑，完成后 `webView.post → evaluateJavascript("window.__httpDone(id, json)")`；
- 连接超时 15s、读超时 90s、响应上限 2 MB；只允许 http/https，Headers 用 JSON 传入（`Authorization` 在这里加）；
- **流式**：`streamPost()` 用 `BufferedReader` 逐行读 SSE，回调 `window.__httpChunk(id, line)`，结束后
  再 `__httpDone`；`cancel(id)` 会断开活动连接。前端 llm.js 负责把 `delta.reasoning_content/content`
  交给任务队列，任务队列再整理成“思考过程”；
- 页面在 `file://` 下直接 `fetch` 会撞 CORS（Origin 是 null），原生桥就是为绕开它存在的；
- `llm.js` 在桌面浏览器里回退到 `fetch`，方便本地开发；但桌面 `file://` 预览仍可能被拦截，
  所以 README 里写清楚“桌面上先试本地试写，AI 用真机”。

文件选择器只在 API 21+ 使用（minSdk 21），`FileChooserParams.createIntent()` 直接拉起系统选择器；
用户取消时回传 `null`，网页的 `change` 不会触发，不会把“取消”当成错误。

图标：Android 8+ 用矢量自适应图标（`mipmap-anydpi-v26/` + `drawable/ic_launcher_foreground.xml`，画的是"迷你和弦图"）；Android 5–7 用 PNG 兜底，PNG 由 `tools/make_icons.py` 用纯 Python（zlib 手写 PNG，不依赖 Pillow）逐像素生成 5 种密度、方形/圆形各一套。

---

## 9. 构建与签名

### 9.1 两条构建路径

**路径 A：Gradle / Android Studio（日常开发）**

```
settings.gradle + build.gradle + app/build.gradle + gradle/wrapper（自带 Wrapper）
AGP 8.4.2 / Gradle 8.7 / compileSdk 34 / minSdk 21 / targetSdk 34
```

`compileOptions` 用 Java 8 源码与目标级别（AGP 走 D8 脱糖，兼容老设备）。实测：

```
./gradlew assembleDebug     BUILD SUCCESSFUL in 11s   → app-debug.apk    约 211 KB
./gradlew assembleRelease   BUILD SUCCESSFUL in 55s   → app-release.apk  约 211 KB
```

踩到的坑：`local.properties` 里的 `sdk.dir` **必须用正斜杠或双反斜杠**——
`D:\workplace\chord\.toolchain\android-sdk` 会因为 `\t` 被 properties 语法解释成制表符，
报出让人一头雾水的 `IOException: 文件名、目录名或卷标语法不正确`。

**路径 B：只依赖 Android SDK 直接打包（本项目也用它做了交叉验证）**

`tools/build_apk.py`，流程与 AGP 内部一致，不下载 AGP、不建 Gradle 缓存，离线环境也能用：

```
aapt2 compile --dir res -o res.zip
aapt2 link -o unsigned.apk -I android.jar --manifest ... -R res.zip -A assets --java gen
javac -source 8 -target 8 -classpath android.jar -d classes $(R.java + sources)
d8 --release --min-api 21 --lib android.jar --output dex classes/**/*.class
把 classes.dex 合进 APK  →  zipalign -p -f 4  →  apksigner sign
```

实际踩到的两个坑，都记在脚本注释里了：

1. **aapt2 强制要求 manifest 里有 `package` 属性，而 AGP 8 恰恰禁止它**（要求用 `namespace` 注入）。解法：脚本在 `build/manual/` 下生成一份临时 manifest 副本补上 `package="com.chord.helper"`，源代码保持 AGP 兼容。
2. **zipalign 必须在 apksigner 之前**，因为 v2/v3 签名覆盖整个文件，签名后再对齐会破坏签名。

签名用 `keytool` 生成的一次性 debug keystore（`android/android`），release 也复用它，所以产物"点开就能装"。上架请换成自己的签名。

### 9.2 产物校验

构建脚本每次都会自检：

```
package: name='com.chord.helper' versionCode='8' versionName='1.3.0'
sdkVersion:'21'  targetSdkVersion:'34'
application-label:'和弦助手'
launchable-activity: name='com.chord.helper.MainActivity'
uses-permission: RECORD_AUDIO / INTERNET
```

另外用 Python 的 `zipfile` 逐字节比对 APK 内的全部 assets 文件与源文件（MD5 一致），并用 `dexdump -f` 校验 `classes.dex` 头部（`dex\n035`）有效。当前 APK **约 227.3 KB**、**27 个 assets**（界面代码 + 图标 PNG + dex 全部加起来的压缩体积）；`run_tests.py --apk` 会检查权限集合，出现预期外的权限会直接失败。

这个"逐字节比对"的校验还真抓到过一次问题：改完界面后手工构建的 APK 是旧的，比对立刻报出 5 个文件不一致——如果只跑 `aapt2 dump badging` 是看不出来的。所以每次改完界面都要重新打包（或者干脆用 `--dump-dom` + 断言先验证行为）。

两条路径产出的 APK 内容一致，可以互相验证：`dist/ChordHelper-1.3.0.apk` 由 `tools/build_apk.py` 构建，和 `./gradlew assembleRelease` 的产物 assets 逐字节相同（MD5 一致，Gradle 产物因为压缩了资源名而小约 1 KB）。

---

## 10. 测试方法（没有设备也能验证）

分两层：**网页层**用无头浏览器跑断言（快、可重复），**原生层**用模拟器跑真机流程（慢、但只有这里能发现 WebView/主题/字体的问题）。

### 10.1 网页层：把逻辑变成可断言的数据

核心思路：**把纯逻辑与渲染都做成可断言的字符串/数据，用无头浏览器跑断言**。三个测试页放在 `tools/`：

- `selftest.html`（引擎自检）：
  - 乐理：级数→音高、♭/♯ 变音、罗马数字（含 `vii°`、`♭III`、`Imaj7`、`viiø7`）、三种音阶的调内和弦性质；
  - 算法：先从已知答案验证（C 大三和弦必须能找到 `x32010`、`x35553`、`8 10 10 9 8 8`），再对**全部 120 个指法逐条做合法性校验**——每个音必须在和弦音集合内、必需音齐全、发声弦数达标、低音是根音、跨度 ≤ 4、发声弦连续、把位标注正确，任何一条不满足就打 FAIL 并打印该指法；
  - 反例校验：`032010`（C/E 转位）在"低音必须是根音"下必须**找不到**，关掉该选项后必须**能找到**；
  - 渲染：断言指板 SVG 的每个坐标——例如 `x32010` 的 B 弦 1 品按弦点必须在 `(67, 56)`、音名标注为 `C`，G 弦空弦圈在 `(29, 86)`，6 弦闷弦 × 在 `y=180.5`，把位窗口矩形是 `x=46 width=126`（覆盖 0–3 品）；
  - 性能：12 根音 × 30 属性全量跑一遍并断言总耗时上限。
- `improvtest.html`（即兴自检，150 条）：简谱记号解析/规范化、走向网格、三档 Bias 的允许音集合、
  本地作曲（Bias 0 时逐音断言必须是和弦音）、延音时值、文本导入/图片识别结果转换、简谱→和弦
  （C–F–G–C 旋律必须配出 C F G C）、六线谱、双库保存/删除、JSON 提取、离线电吉他渲染；
  agent 部分把 `LLM.chat` 换成 **mock**，覆盖四 agent 正常、主控失败降级、填音失败、衔接失败兜底、
  润色失败保留初稿、token 统计与 5 步日志，**不需要真实 Key、不花钱**。
- `uitest.html`（界面自检）：把 `index.html` 装进 iframe，`dispatchEvent` 模拟真实点击（切主调/级数/变音/属性、点调内和弦、点指法卡片、◀▶、开关、品域过滤…），断言页面上的文案与 DOM 状态随之改变，并对 30 种属性各渲染一遍做冒烟测试；即兴部分覆盖独立顶部页、提示词→本地推荐→可改鼓/节奏/走向→推荐速度/Top5/数字输入→确认生成 craft、作品独立 tab 与详情页（返回作品库、和弦图/节奏预览、双吉他指板、三声部音量、分页版本表格、版本预览/最终标记、对话版本链接）、调音 dialog 与设置主题、伴奏实例保存/搜索/选择、7 风格/6 音色下拉、试听音色、1/2/3 loop、三路音量、队列/流、整段可选指型、双指板音名、逐音音名/当前音/小节高亮、高把位、保存双库、63 条走向搜索、谱库播放按钮与来源走向/实例标注。

命令行跑法（Windows 下 Chrome 的 `--headless=new` 可以直接把 JS 执行完的 DOM 导出来）：

```bash
chrome --headless=new --dump-dom file:///.../tools/selftest.html
chrome --headless=new --dump-dom file:///.../tools/improvtest.html
chrome --headless=new --allow-file-access-from-files --dump-dom file:///.../tools/uitest.html
# 输出里出现 ALL_TESTS_PASSED / IMPROV_TESTS_PASSED / UI_TESTS_PASSED 就是全绿
```

真实 API 不放进自动测试（会花钱、也不该把 Key 写进仓库）。联调办法是：在 App 里填自己的
厂商/模型/Key，点「测试连接」；再点一次「生成即兴（AI）」，看 agent 日志里四次请求是否都成功。
本项目在开发时用 DeepSeek 实测过完整四 agent 流程：4 小节、19 个音、休止 8、延音 5、技巧 1–2、
约 3760 tokens、6–7 秒完成；从顶部「开始」自动触发时也验证过会立即播放。
这次请求用的 Key 只在本地，仓库与 APK 中都不存在。

顺带一提，用这套办法排掉了不少真 bug，其中几个是肉眼看截图很难发现的：

| 问题 | 怎么发现的 |
| --- | --- |
| `minSounding` 被错误钳制，导致三和弦永远无法要求"6 弦全发声" | 自检里对"最少 6 弦"的结果数做断言，发现和不设限时完全一样 |
| 七和弦的罗马数字把大七写成 `I7`（会被读成属七）；半减七写成 `vii°7`（那是减七） | 罗马数字的单元断言 |
| 指板工具条标题过长把右侧按钮挤出屏幕 | 布局体检：断言工具条内每个按钮的 `getBoundingClientRect().right ≤ 视口宽` |
| 条件抽屉在小屏上盖住指板下半部分 | 同一套断言在 320×568 / 360×640 / 390×844 / 412×915 四种视口下跑 |
| 品记点画在了 B/G 弦之间（应在 G/D 弦之间，即琴颈正中） | 指板 SVG 的坐标断言 |
| 新加的"指法信息行"在窄屏被压缩截断 | 把信息从工具条移到指板下方整行，并断言 `scrollHeight` 只有一行 |
| 横按误判：`x10231` 这种"中间夹空弦"的按法被画成横按条（物理上做不到） | 横按判定的正反用例：`133211` 必须是全横按、`x10231` 必须不是 |
| 品域筛选点了之后 chip 高亮不跟随（只重绘了结果） | 补断言"点击后 chip 带 on 类" |
| 直达链接传了非法值（`#acc=x`）会在界面上显示出 `undefined` | 用非法 hash 跑一遍页面并断言输出里不含 `undefined`/`NaN` |

最后一个值得单独讲：指板的九处坐标断言（按弦点、空弦圈、闷弦 ×、横按条、把位窗口、品记）都是"算出期望值再和 SVG 字符串比对"，所以像"音名标错一根弦"这种错误不可能蒙混过关——我第一次看截图误以为高音 e 弦标成了 E，正是靠这套断言确认它其实是正确的 F#（8.6px 的小字在缩略图里很难分辨）。

### 10.3 原生层：在模拟器上真跑一遍

网页层全绿不代表装进 APK 就能看——WebView 的版本、系统主题、系统字体、窗口配置都可能出问题。
`tools/run_on_emulator.py` 把这一层也自动化了：建 AVD → 启动（无窗口 + 硬件加速）→ 安装 → 启动 App
→ 等 App 自己报告页面加载完成 → 截图 → 收集 logcat。实测：

| 环境 | 结果 |
| --- | --- |
| Android 14（API 34，WebView 113） | 冷启动约 2s 出内容；指板/卡片/交互全部正常；日志无异常 |
| Android 5.0（API 21，出厂 WebView 37） | 逻辑完全正常（120 个指法、DOM 结构正确、无 JS 错误），样式按预期降级 |

真机上抓到的问题（都不是网页层能发现的）：

| 问题 | 原因与修复 |
| --- | --- |
| 顶部一条浅色状态栏、下面却是深色界面 | App 用的是 `Theme.Material`（深色系），WebView 据此把 `prefers-color-scheme` 判成 dark 渲染深色；而系统是浅色，原生窗口底色按 `uiMode` 取了浅色。改成 `values/` 用 `Theme.Material.Light`、`values-night/` 用深色主题，两边就都跟随系统了 |
| 切换系统深浅色后原生栏颜色不更新 | manifest 声明了 `configChanges="uiMode"`，Activity 不重建，于是颜色只在 `onCreate` 设了一次。补 `onConfigurationChanged` 重新上色 |
| API 21/22 上状态栏文字看不见 | `SYSTEM_UI_FLAG_LIGHT_STATUS_BAR` 是 API 23 才有的，老版本上无效。这两版改为把状态栏压深、配白色图标 |
| API 21 上 ⚙ 图标显示成方框 | 2014 年的系统字体没有 U+2699 字形。改用内联 SVG 画图标，不再依赖字体 |
| API 21 上整个界面变成黑白骨架 | 出厂 WebView 是 Chrome 37，不支持 CSS 变量，`var()` 声明被整条丢弃。加了一层 `@supports not (color: var(--x))` 降级样式（固定色 + 行内居中 + 用 margin 代替 flex gap），并在检测到老引擎时插入提示条引导更新 WebView |

顺带说一个调试技巧：**让 App 自己把关键状态打进日志**。`MainActivity` 在 `onPageFinished` 里用
`evaluateJavascript` 回读一次 DOM（标题、卡片数、页面底色、`window.__err`）并 `Log.i` 出来。
第一次跑模拟器时截图是全白的，但日志显示 `dom={"cards":14,"chord":"C","err":null}`——
一眼就知道页面其实渲染好了，是截图时机/合成的问题，而不是页面出错；否则很容易往错误方向排查。
页面侧也加了 `window.onerror` 兜底，出错时会在页面顶部弹一条红条并把错误写进 `window.__err`。

### 10.4 两个环境上的坑

- **headless Chrome 在 Windows 上会把窗口宽度钳到约 500px**：用
  `--screenshot --window-size=390,844` 截图时，页面其实是按 500px 排版的，图片只截了左边 390px，
  看起来像“右侧被切掉”。要截手机版式，用 `tools/uitest.html?w=390&h=844` 这种 iframe 方式，
  或者干脆在模拟器/真机上截（本项目 `build/emulator/` 里的截图都是真机分辨率）。
- **同一个页面在无头浏览器与真机上的差异**主要是三类：WebView 版本（CSS 变量）、
  系统输入（`input tap` 是屏幕坐标而 `getBoundingClientRect` 是视口坐标）、以及音频设备。
  所以「音频能不能真响」只能在真机上确认，「时刻对不对」用离线渲染测。

### 10.5 一条命令

```bash
python tools/run_tests.py        # 引擎 + 即兴 + 界面（4 视口）+ APK 校验
python tools/run_tests.py --improv   # 只跑即兴：mock 四 agent + 本地作曲 + 离线音频
python tools/run_on_emulator.py  # 真机（模拟器）跑一遍并截图、收日志
```

---

## 11. 调音功能（麦克风测频 + 调式级数标注）

### 11.1 为什么用自相关，而不是 FFT

最直接的想法是做 FFT 找峰值，但频率分辨率 = 采样率 / 窗长：48kHz、4096 点只有 **11.7Hz** 一格。
吉他 6 弦空弦 E2 = 82.4Hz，一格就相当于 **240 音分**——完全没法调音。
自相关（autocorrelation）在时域找周期，配抛物线插值能做到远好于 1 个采样点，音分误差 ±1 以内。

为了能在手机上实时跑，做了三层优化（`pitch.js`）：

1. **降采样**：吉他基频最高约 1.3kHz，把 48kHz 降到 ~16kHz（两抽头平均当简易抗混叠）。
   相关运算量 O(lag × 窗长)，采样率降 3 倍、lag 范围和窗长各降 3 倍，总运算量降到 1/9；
2. **固定相关窗口** W = len − maxLag：每个 lag 的运算量一致，归一化后的相关值才可比；
3. **粗到细两遍搜索**：先步长 2 扫全部 lag，再在峰值附近 ±2 用步长 1 细算。

判定基频用**「第一个达到峰值 90% 的峰」**，而不是直接取最大值：琴弦泛音很强时，
2 倍周期的相关值可能比 1 倍周期还高，直接取最大值会把音判低一个八度（这是单音测频最常见的 bug）。

读数侧再用**最近 5 次的中位数**平滑，并且 0.2 秒内测不到就清空——所以手机上的数字是稳的、松弦也不会乱跳。

实测（`tools/selftest.html` 的“基频检测”一组断言）：

| 项目 | 结果 |
| --- | --- |
| 六根空弦（E2 82.4 → E4 329.6）+ A4 + D5 + E6（1 弦 24 品） | 正弦与带 2/3 次谐波的波形都测到 **±0.5Hz** 内 |
| 音分精度 | A4 故意升 5 音分 → 读出 5 音分 |
| 44.1kHz 采样率 | 同样准（手机常见） |
| 全静音 / 极低幅度噪声 | 返回 null（**不瞎猜**） |
| 单次检测耗时 | 约 **0.9ms**（台式机），手机上留够余量 |
| 基准音 A4=432 | 频率→音名的换算跟着变 |

### 11.2 级数与音名：两套规则要分清

调音界面要同时显示「第几级」和「音名」，这两件事的算法并不一样：

**音名用字母规则拼**（`Music.spellNote`）：级数决定用哪个字母，变音只加升降号。
主调降 E 的第 3 级必须以 **G** 开头（G♭），而不是 D♯——否则同一份谱子里会出现 F♯♯ 这种写法
（当然，如果用户把主调按升号拼写成 D♯，那 D♯ 大调就该是 D♯ E♯ F♯♯ G♯ A♯ B♯ C♯♯，自洽即可）。

**级数标记按“与同主音大调相比的改动量”**：这正是教会调式特征音的说法（也是用户给的那张表的写法）。
于是 C 多利亚的第 7 个音是 `♭7 / B♭`；而 C 多利亚里弹 B 自然音是 `7 / B`（+ 调外音标记）——
因为相对同主音大调它是“还原的 7 级”，不是「♯7」那样往上再加半音。

**变化音（调外音）落在两级正中间时**怎么命名？逐级比较无法同时满足这两种惯例：

| 落在哪两级之间 | 惯例写法 | 规则 |
| --- | --- | --- |
| 1、2 之间 | ♭2（不是 ♯1） | 取上一级的降号 |
| 2、3 之间 | ♭3 | 取上一级的降号 |
| 3、4 之间 | ♯3 | 取下一级的升号 |
| 4、5 之间 | ♯4（不是 ♭5） | 取下一级的升号 |
| 5、6 之间 | ♭6 | 取上一级的降号 |
| 6、7 之间 | ♭7（不是 ♯6） | 取上一级的降号 |
| **7、1 之间**（首尾相接） | ♯7（导音） | 取下一级（7 级）的升号 |

所以规则是「成对看**较低那一级**」：3、4、7 级取升号；1、2、5、6 级取降号。
注意 7 与 1 是首尾相接的一对，此时“较低级”是 7 —— 一开始我写成「6、7 取降号、4、5 取升号」的
逐级判断，结果 C 多利亚的导音 B 被标成了 ♭1（因为它的候选是 1 级降半音），端到端测试才暴露出来。

### 11.3 麦克风权限：两段式授权

WebView 里调 `getUserMedia` 会经过两道门，缺一不可：

```
网页 getUserMedia()
  └─ WebView 内部检查 → 没有授权就回调 WebChromeClient.onPermissionRequest
       └─ 原生 MainActivity：
            ├─ 已有系统 RECORD_AUDIO 权限？ → 直接 request.grant(AUDIO_CAPTURE)
            └─ 没有 → requestPermissions() 弹系统对话框
                 └─ onRequestPermissionsResult 里再 grant 给 WebView（否则 getUserMedia 一直挂起）
```

要点：

- `AndroidManifest.xml` 只声明 `RECORD_AUDIO` 一个权限，`uses-feature microphone required=false`（没麦克风的设备也能装）；
- API 21/22 是安装即授权，API 23+ 才需要运行时申请，代码里分两条路；
- **只有处理音频**：`onPermissionRequest` 里其它资源一律 `deny()`；
- 拒绝时给用户一句可操作的提示（`Toast` + 页面里的红字说明），和弦功能完全不受影响；
- 真机日志能看到整条链路：
  `[tuner] 请求麦克风权限…` → `onPermissionRequest: [AUDIO_CAPTURE]` → `onRequestPermissionsResult RECORD_AUDIO granted=true`。

### 11.4 怎么在没有真麦克风的情况下测

调音依赖实时音频，而无头浏览器的 `--virtual-time-budget` 会把时钟快进、音频却按真实时间产生样本，
两者冲突（结果是永远等不到读数，只能看到页面停在初始状态）。所以做了两件事：

1. **给音频源留一个可注入的插口**：`Tuner.attachSource(node, ...)` 接受任意音频节点，
   生产路径（`Tuner.start`）在 getUserMedia 成功后也走它。测试就往页面里塞一个
   `window.__TUNER_TEST_SOURCE`（已知频率的锯齿波振荡器），于是
   「音频节点 → AnalyserNode → 自相关 → 中位数平滑 → 音名/级数/弦 → 指板高亮 → 界面文字」
   整条链路真跑一遍，而且完全确定（不用担心环境噪声、设备差异）。
2. **结果自己回传**：页面用 `navigator.sendBeacon` 把结论发给 `tools/run_tuner_test.py`
   起的本地 HTTP 服务——无头浏览器没法把控制台结果带出来，`--dump-dom` 又会在测试跑完前就 dump。

另外还支持 `--mic` 模式：Chrome 的
`--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=tools/test-tone.wav`
把一段已知音高的 WAV 当麦克风输入，走真实 `getUserMedia` 路径（波形：G3 4 秒 + B3 4 秒，带泛音）。

真机上（模拟器）则靠 App 自己的调试插口：

```bash
adb shell "am start -n com.chord.helper/.MainActivity --es hash \"tab=tuner&debug=1\""
adb logcat -s ChordHelper:I ChordHelper/console:I
```

`debug=1` 会把关键元素的 `getBoundingClientRect()` 与 `document.elementFromPoint()` 结果、
以及每次点击的落点和目标元素写进 logcat。

### 11.5 真机上踩到的坑

| 问题 | 原因与修复 |
| --- | --- |
| 测到音了，但指板上的高亮圈从不出现 | `Music.annotateNote()` 的返回值里忘了带 `pc`，导致 `state.scanPc` 被设成 undefined，重绘时按“无高亮”处理。单元测试查的是音名/级数，没查“有没有高亮”，端到端一跑就现形 |
| C 多利亚的导音 B 被标成 ♭1 | 变化音命名用逐级判断无法区分 (6,7) 与 (7,1) 两对，改成「成对看较低级」，见 12.2 |
| 自动化点「开始收音」没反应 | `adb shell input tap` 用**屏幕**坐标，而 `getBoundingClientRect()` 是**视口**坐标，两者差一个状态栏高度。用 `debug=1` 输出的坐标 + `elementFromPoint` 才定位到 |
| 网页里的 `console.log` 在 logcat 里看不到 | WebView 默认不转发；实现 `WebChromeClient.onConsoleMessage` 转发到 `ChordHelper/console` 标签 |
| `adb shell ... --es hash "a&b"` 参数被截断 | `adb shell` 会在设备端再解析一次命令行，`&` 被当成分隔符；要用 `adb shell "am start ... --es hash \"a&b\""` 的双层引号 |

顺带一句：**同一套页面在真机上会暴露网页测试查不到的问题**——这一节的 5 条里有 2 条（高亮、
命名）是逻辑 bug，在无头浏览器里其实也能复现，只是当时的断言没覆盖到；另外 3 条是“真机交互/日志”
层面的坑。这也是为什么最后补上了端到端那套测试：它跑的是**用户真实会走的那条路**。

---

---

## 12. 伴奏：鼓机与和弦伴奏（合成音色 + 精确调度）

### 12.1 声部合成

全部现场合成，没有任何音频素材（`drums.js`）：

| 声部 | 做法 |
| --- | --- |
| 底鼓 kick | 正弦波 + 频率包络（150Hz 快速滑到 45Hz，90ms）+ 一段 900Hz 低通噪声当“打点” |
| 军鼓 snare | 噪声经带通 1.8kHz（Q 0.7）+ 200→150Hz 三角波鼓身 |
| 闭镲 / 开镲 | 噪声经高通 7.5kHz，衰减分别是 50ms / 300ms |
| 吊镲 crash | 噪声经高通 5kHz + 9kHz 峰值提升，1.2 秒长衰减 |
| 节拍器 click | 1.1kHz（重音 1.6kHz）方波短促衰减 |

主输出串一个 `DynamicsCompressor`（阈值 -10dB、4:1），避免多个声部同时敲时削波。

### 12.2 调度：为什么不用 setInterval 直接发声

`setInterval` 的抖动在手机上是几十毫秒级，直接用它触发发声会明显不稳。
这里用的是「前瞻式调度」（A Tale of Two Clocks 的经典做法）：

```
每 25ms 醒一次：
   while (下一小节开始时间 < 音频时钟 + 150ms) {
       把这一小节里所有敲击按「音频时钟的绝对时刻」排进 WebAudio 时间轴；
       下一小节开始时间 += 小节时长；
   }
```

发声时刻由音频时钟决定，主线程偶尔卡一下也不影响节奏。小节时长：

```
一格 = 60/BPM × beats / steps        （beats 是该节奏一小节算几拍）
```

所以同一套计算能同时支持 4/4（16 格）、3/4（12 格）、6/8（12 格、按八分算拍）三种网格。

**摇摆（swing）**：把「反拍八分」往后推。16 格网格里反拍八分是 `step % 4 === 2` 那几格，
推后量 = `(2s - 1)` 格，其中 s 是摇摆比例：`s = 0.5` 是直的（推后 0），
`s = 2/3` 就是三连音摇摆（推后 1/3 格）。正拍和十六分位置完全不动。

**音画同步**：调度时顺手把「哪一格、什么时刻」压进一个队列，界面每帧从队列里取
「已经真的发声」的格子来高亮——所以看到绿框走到哪，声音一定就在那一格，而不是“看起来差不多”。

### 12.3 怎么验证节奏对

鼓机是“自己发声”的，光测数据结构说明不了它敲得对不对。所以用
`OfflineAudioContext` 把节奏渲染成一段真实音频，再从波形里找敲击时刻：

```
Drums.renderOffline(pattern, {bpm, swing, sampleRate}, seconds) -> Promise<Float32Array>
```

测试侧（`tools/drumtest.html`）：

1. 算 20ms 一格的短窗 RMS 包络；
2. 取「越过阈值（`max(下限, 峰值×25%)`）的那一刻」当起音点，并加 30ms 的不应期；
3. 拿这些时刻去核对：120BPM 的基础摇滚必须是底鼓在 0/1/2/3 秒、军鼓在 0.5/1.5/2.5/3.5 秒（±30ms）；
   60BPM 的节拍器必须每 1 秒一下；摇摆版的**反拍**必须比直拍晚 42ms（1/3 格）而正拍不动。

另外还断言：13 个节奏都能渲染出声音、都不严重削波；格子全清空后必须是静音；
`Patterns.clone()` 是深拷贝（改副本不能污染内置节奏）。

### 12.4 多个引擎共用一套时钟（为什么拍点一定对齐）

需求是「鼓机和和弦伴奏可以同时响，而且拍子要一样」，后来即兴旋律也加进同一套时钟。
如果每个引擎各用一套定时器，
任何抖动都会让它们慢慢错开——所以抽了一层 `transport.js`：

- 共用同一个 `AudioContext` 与总输出（音量、压缩器一处搞定）；
- 共用同一个 25ms 前瞻定时器，每个引擎只是一个「被这个定时器驱动的调度函数」；
- `start()` 时把所有启用的引擎的下一次排期时间**对齐到同一个 startTime**，
  之后各自按自己的小节长度推进。因为都是 `60/BPM` 的整数倍，拍点永远重合。

引擎的接口就三个方法：`enabled()` / `barSeconds(bpm)` / `scheduleBar(ctx, out, startTime, bpm)`。
鼓机、伴奏、即兴旋律都实现它，于是「一起响」这件事是结构上保证的，而不是靠事后对齐。
自检里有一条断言专门盯这个：两个小节长度不同的假引擎，第一小节必须从同一时刻开始。

### 12.5 和弦伴奏：走向 + 节奏型怎么变成声音

三层，每层都能单独测：

**第一层：数据 → 演奏计划（纯函数）**
`Backing.buildPlan(走向, 节奏型, 主调, 调式)` 把走向展开成事件列表：

```
每个和弦按它自己的「走几拍」占据拍数；
节奏型的每一格落在该和弦区间内的哪一拍上（和弦比节奏型长就重复，短就截断）；
每个事件记住：第几拍、第几个和弦、和弦（根音 + 属性）、弹什么（R / 1~6 / D / U / X / -）。
```

因为是纯函数，`selftest.html` 可以直接断言：`I–V–vi–IV` 在 C 大调是 `C G Am F`、在 G 大调是 `G D Em C`、
在 A 小调是 `Am Em F Dm`；八个格子的拍点是 0、0.5、1、1.5…；和弦走 8 拍时节奏型重复两遍。

**第二层：和弦 → 指法 → 根音弦**
走向里的和弦先是「根音 + 属性」，演奏时要变具体按法：

- 指法挑选不能只看「发声弦最多」——那样会选中 `5-0-2-2-1-0` 这种（六弦五品的 A 音当低音）不常规的按法。
  这里按「开弦多、品位低、跨度小、发声弦够多」打分取最高分，于是 C 会选 `x32010`、G 选 `320003`、D 选 `xx0232`、
  Am 选 `x02210` —— 和吉他手的第一反应一致；
- **根音 R** 再按指法去找：取「发声的最低那根弦里音高等于根音」的一根。于是 C 的根音在 5 弦、
  G 在 6 弦、D 在 4 弦、Am 在 5 弦——这正是指弹里「根音要跟着和弦换弦」的道理，
  也是为什么节奏型里要写「根音」而不是写死弦号。自检里对这四个和弦逐一断言。

**第三层：事件 → 声音**
`A.pluck()` 是参数化的拨弦（上下文和输出节点都由调用方给），所以同一套音色既能实时播放，
也能在 `OfflineAudioContext` 里离线渲染给测试用。扫弦是把和弦的发声弦按 11ms 间隔依次拨（下扫低到高、上扫反过来）；
切音 `X` 是一声短促的闷音（噪声过低通 + 70ms 衰减）。

### 12.6 界面：两个子页签、实例与两个编辑器

- **总控**（`bandui.js`）：速度、鼓机/伴奏启用开关、开始/停止、迷你播放条、子页签切换；
- **鼓机**（`drumsui.js`）：节奏列表 + 步进格子 + 摇摆 + 音量；
- **伴奏**（`backingui.js`）：调式行、走向列表、节奏型列表，以及两个编辑器；
- **伴奏实例**：总控下面的实例面板，保存当前鼓机/走向/节奏型/调式/速度；即兴页读取它；
- **即兴** 已移到顶部独立页签（见第 13 节），不再占用伴奏子页签。

编辑器都遵循「新建 → 填 → 保存并启用」的模式：

| 编辑器 | 编辑内容 |
| --- | --- |
| 和弦走向 | 每个和弦一行：级数（1–7）→ 变音（♭/♮/♯）→ 和弦属性（含“自然”= 该调式在这一级的本调和弦）→ 走几拍；可加/删行 |
| 节奏型 | 类型（分解/扫弦）→ 几拍（2/3/4/6）→ 每拍几格（1/2/4）→ 逐格点选；改拍数会自动重建序列长度 |

播放位置的高亮走同一个通道：Transport 每帧吐出「已经真的到点」的事件（带 `source` 标记），
`bandui` 分给鼓机点亮格子、分给伴奏点亮和弦与格子——所以看到哪一格亮了，声音就一定在那一格。

**页头与迷你条上的「当前和弦」大字**用的是同一个事件流：伴奏事件里带着 `chordIdx` 与和弦对象，
`bandui` 记下最后一个到点的事件并渲染大字 + 第几个和弦 + 组成音。因为数据源是"已经发声的事件"，
换和弦的时刻天然和听到的一致；停止时清空、切回伴奏页签时立刻恢复（`BandUI.setNowChord`）。

另外 `Transport.push` 是**按时间插入**而不是追加到末尾：`drainAll` 依赖队列有序，
追加会让排在后面的新事件被前面的未到点事件挡住（写测试时注入事件就踩过这个）。

### 12.7 列表变长之后：统一的搜索 + 分页

和弦走向、节奏型、鼓机节奏、调式表这四类内容都会越积越多（尤其自建的那些），所以抽了一个
`pager.js` 统一处理——四个列表只提供「数据 + 关键字 + 怎么渲染一条」：

```js
Pager.mount('backing.rhythms', {
  hostId: 'rhythmTable', placeholder: '搜索节奏型…', pageSize: 6,
  items: allRhythms, keywords: function (p) { ... }, render: function (list, slice) { ... }
});
Pager.refresh('backing.rhythms');   // 数据变了刷一下
```

两个实现细节值得记：

- **搜索框只创建一次**，刷新只重画「列表 + 分页条」。否则每敲一个字都重建 input，输入框会丢焦点——
  这类"看起来能用、一打字就跳"的问题在真机上最难查。
- 保存自建内容后要让它"跳出来"：`Pager.showItem(id, 匹配函数)` 会清空搜索、算出它所在的页再翻过去；
  选中某条内容（比如从直达链接进来）时也用它，否则用户会以为"保存没生效"（其实在第二页）。

### 12.8 自建内容怎么存（SQLite + 浏览器回退）

自建的和弦走向/节奏型、鼓机格子的改动、以及少量偏好，都要在重启后还在。这里没有用「Vue/React 之外
再塞一套原生存储」的重方案，而是加了一层薄薄的 `store.js`，**两套后端、一套接口**：

| 环境 | 后端 | 位置 |
| --- | --- | --- |
| 安卓壳里 | 原生 SQLite（`StoreDb.java`） | `chord.db`，通过 `addJavascriptInterface` 注入的 `window.NativeStore` 读写 |
| 桌面浏览器预览 / 自动化测试 | `localStorage` | 同一个页面代码原样运行，只是不落 SQLite |

这样做的好处是：**网页层的全部测试和桌面预览都不需要模拟原生环境**，而真机上走的又是真正的数据库。

表结构（`StoreDb`）：

```sql
CREATE TABLE items (kind TEXT NOT NULL, id TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER,
                    PRIMARY KEY (kind, id));
-- kind: progression | rhythm | drums | instance | jianpu | tablature
CREATE TABLE settings (k TEXT PRIMARY KEY, v TEXT);
```

`json` 存的是该条内容的完整定义。**为什么不全拆成关系表**：这些数据整体读写、整体替换，
拆表会让每次改动都要跨表同步；而 `kind/id/updated_at` 仍是真正可查询的列，
需要统计（比如"最常用的走向"）时再加索引字段即可。`android_metadata` 是 SQLiteOpenHelper 自动建的，正常。

从「即兴」开始，`items` 多了三个 kind：`instance`（伴奏实例）、`jianpu`（简谱）与 `tablature`（六线谱）。
界面上它们是两个独立的库（各自的搜索、分页、删除），底层仍是一个表；保存简谱会同时写两条，
删除时按 `tab-<id>` 级联。`settings` 里还存 `improv.lastScore`，用于重启恢复谱面。

原生桥的几个注意点：

- `addJavascriptInterface` 暴露的方法是在 **JavaBridge 线程**上执行的，不在 UI 线程，
  所以方法里直接访问数据库是安全的（不会卡界面）；反过来说，**不要在桥方法里碰 UI**；
- 桥方法返回字符串（`loadAll()` 一次性把所有内容读成 JSON），网页侧只在启动时读一次，
  之后维护内存镜像、写的时候写穿——这样界面交互是同步的，不需要到处 `await`；
- 权限上不需要任何额外声明：数据库在应用自己的数据目录里。

`store.js` 里有两个曾经踩过的坑，都留了注释：

1. `localStorage` 可能不可用（隐私模式、某些环境禁止 `file://` 访问），所以每次访问都 `try/catch`
   兜底——存不了也不影响使用，只是不落盘；
2. 偏好设置一开始多加了一层缓存对象，在 `__settings` 还不存在时缓存了个**游离的空对象**，
   之后写进的是另一个对象、读永远读不到。现在读写都用同一个桶。

真机上验证持久化的办法（不依赖点屏幕坐标）：`#debug=1` 启动时会往存储里写一条时间戳再读回来，
日志里会打印 `读回=一致` 与 `chord.db{...}` 的条数；另有 `#mkprog=1` / `#mkrhythm=1` 会**走正常保存路径**
造一条自建内容，用来验证"写库 → 重启 → 恢复选中项"整条链路。

### 12.9 「停止」为什么要额外掐音源

前瞻式调度把未来的音**提前排进了 WebAudio 的时间轴**：鼓机一次排一小节，和弦伴奏**一次只排一个和弦**
（早期版本一次排整个走向，手机上会瞬间创建过多振荡器，出现哑音/丢音）。所以「停止」如果只做"清定时器、不再排新的"，
已经排进去的音会照响完——点了停止还在响，就是这么来的。

修法是把音源登记下来、停止时统一掐掉（`voices.js`）：

- 每个合成函数创建振荡器/噪声源时 `Voices.track(node, ctx)`；
- `Transport.stop()` → `Voices.killAll()`（`stop(0)` + `disconnect()`），
  再给主输出做 20ms 淡出以免咔哒声；`start()` 时把主输出音量恢复；
- 只登记**实时**上下文的音源（离线渲染传进来的 ctx 会被跳过），所以测试渲染不会污染登记表；
- 登记表按时间顺序，超过 8 秒的老条目在下次登记时丢掉，长时间播放不会堆积。

真机上验证：点停止的日志会打印 `[transport] 停止：掐掉 230 个已排期音源`——
这个数字正好说明"之前有多少声音已经排好队在等着响"。同时 `UItest` 里成对断言
「播放时登记数 > 0 / 停止后 = 0」，以及停止后格子上的播放高亮要清掉（否则会停在最后一格）。

### 12.10 这一步踩到的坑

| 问题 | 原因与修复 |
| --- | --- |
| 点速函数 `tap(0)` 返回离谱速度 | `nowMs \|\| Date.now()` —— 时间戳 0 是假值被当成“没传参”。改成显式判 `undefined/null`（点速随后移到了 band.js，因为它管 BPM） |
| 根音选错弦（D 变成 1 弦、Am 变成 6 弦） | 指法挑选只看发声弦数，选中了六弦五品那种不常规按法。改成「开弦多、品位低、跨度小」打分 |
| 小调走向里 ♭VI 变成 E（而不是 F） | 走向的变音是「相对同主音大调」的写法，而自然小调音阶的第 6 级本来就是 ♭6，再加 -1 就双重降号了。内置的小调走向改成不带变音 |
| 离线测试里伴奏的起音检测一会多一会少 | 4ms 的 RMS 窗盖不住低音弦的半个周期，包络会随相位抖动；多音同时响又有拍频。最后不再较劲通用检测器，改成直接判「该响的时刻有起音、半拍处没有」 |
| WebView 里的 `console.log` 看不到 / 自动化点击点不中 | 见第 11 节的同类记录：console 要自己转发，`input tap` 用的是屏幕坐标而 `getBoundingClientRect` 是视口坐标 |
| 加了持久化后页面直接白屏（只有页头是静态的） | 节奏型列表的删除按钮里我写了不存在的变量 `r`（该作用域形参是 `p`），`ReferenceError` 打断了 init。教训：**验证"页面是不是好的"要连错误横幅和各个区块一起看**，不能只看渲染出来的那一两块 |
| 偏好的 BPM 明明设过却读不到 | `getSetting` 里多加了一层缓存对象，在 `__settings` 不存在时缓存了个游离空对象，之后写入的是另一个对象 |
| **点「停止」停不下来**（声音继续响十几秒） | 前瞻调度已经把未来的音排进了时间轴，"停止"只停了"排期"没停"已排期的音"。加了音源登记表，停止时统一掐掉 + 主输出淡出 |
| 停止后鼓机格子停在最后一格的绿框上 | 停止时没有清播放位置高亮；补 `clearHighlight()`，并在状态变化时调用 |

## 13. 即兴：多 agent 写简谱（不嵌 Python、不用 LangGraph）

需求原话是「简单程序无法创造出来即兴，需要写 agent」，并且明确说不要 LangGraph。
这一步的取舍是：**不引入任何运行时**，agent 编排用页面里的 ES5 + Promise 手写，
联网只通过安卓壳的原生 HTTP 桥（`HttpBridge.java`）绕开 `file://` 的 CORS。

### 13.1 为什么不需要嵌入 Python

| 方案 | APK / 依赖 | 问题 |
| --- | --- | --- |
| 嵌 Python + LangGraph | 几十 MB 运行时 + 三方依赖 | 冷启动慢、老 WebView 兼容差、Chrome/CPython 两套生命周期，调试成本高 |
| 本地起服务再让页面调 | 需要常驻进程 / 端口 | 手机上后台进程容易被杀，权限与网络安全配置更复杂 |
| **页面 JS 编排 + 原生 HTTP** | 0 额外依赖，仅 `HttpBridge` | 需要自己写 JSON 契约、重试与降级（本文就是这些） |

agent 的本质是「带结构化输出的提示词 + 控制流」，不需要框架。四个 agent 的交接物都是 JSON，
所以每一步都能单独 mock、单独断言；控制流（失败继续/失败中止）只有几十行，自己写反而更可控。

### 13.2 数据模型：Score / Bar / Token / Tech

```js
Score = {
  id, title, keyPc, scaleId, styleId, bias, bpm, preferFlat,
  bars: [ { slots: [8 个字符串], tech: { slot: tech } } ],
  barChords: ['C', 'G', …] | null,   // 导入/识别时自带的和弦标记
  progression: { items:[…] } | null, // 生成时的走向快照（用于显示与校验）
  source: 'ai' | 'local' | 'text' | 'image',
  createdAt
}
```

- 每小节固定 8 格，一格 = 半拍（4/4 拍下就是八分音符）；
- 记号：`0` 休止、`-` 延音、`[b#]{0,2}[1-7]` 音符，后缀 `'` 升八度、`,` 降八度；
- 技巧单独放在 `tech`，只允许 `slide / bend / hammer / pull / vib`；
- `normalizeBar()` 会把 4 个四分音符自动展开成 8 格（音 + 延音），把不足 8 格补 `0`、多了截断；
- 第一格如果是延音，改成休止（前面没有音可延）。

**导入的谱不按 Bias 改音**：`repairScore()` 只在 `source` 是 `ai/local` 且存在和弦网格时才做音高修补。
图片/文本导入要尽量保持原谱，不能拿五声音阶去改人家的旋律；这个 bug 是在 improvtest 里
「识别出的 b3 原样保留」这条断言上暴露的。

### 13.3 和弦网格：拍点 → 和弦

`progressionGrid(prog, keyPc, scaleId)` 把走向摊开：

```
items: [{start: 0, beats: 4, chord: C}, {start: 4, beats: 4, chord: G}, …]
totalBeats: 16
bars: ceil(totalBeats / 4) = 4
```

`chordAtSlot(grid, bar, slot)` 用 `bar*4 + slot*0.5` 去查当前和弦；走向比谱面短时按总拍数循环。
界面每小节的标题取该小节第 1/3/5/7 格出现过的和弦去重（所以一小节里换和弦也能显示 `C · G`）。
播放仍然是每小节 4 拍，`Transport` 的 `barSeconds = 4*60/bpm`，和伴奏引擎的拍点天然对齐。

### 13.4 四 agent 流水线

`runAgents(opts, onStep)` 是一条 Promise 链，每一步都向 `onStep` 发 `{index,name,status,detail,ms}`：

**① 主控 Agent（结构规划，900 tokens）**

输入：调名/调式、BPM、小节数、风格、Bias 规则、每小节和弦与和弦音。
输出：

```json
{"structure":"起承转合","motif":"2 小节动机（节奏+音区+轮廓）",
 "phrases":[{"bars":"1-2","role":"call"},{"bars":"3-4","role":"response"}],
 "density":"每小节几个音","contour":"先上行再回落",
 "barTargets":[{"bar":1,"idea":"落在 C 的和弦音"}]}
```

**② 填音 Agent（2600 tokens）**

把主控的规划用 `JSON.stringify` 截断到 1200 字附在提示里，要求：

```
{"bars":[{"slots":["5","-","3","0","5","b7","5","3"]}, …]}
```

- 必须正好 N 小节、每小节 8 个字符串；
- 第 1、5 格（每小节第 1、3 拍）必须落在当前和弦音上；
- 前 2 小节建立 3–5 个音的动机，第 3 小节起重复/模进/回应；
- 每小节 2–4 个音为佳，至少 2 个 `0` 或 `-`；不要连续 3 个相同音、不要连续 4 个以上级进；
- 不写技巧（交给下一步）。

提示词里带一个 4 小节的**范例**（只学动机、呼吸与和弦落点，不照抄音高）；
范例和“必须正好 N 小节”同时出现，是为了防止模型写成连续音阶练习。

**③ 衔接 Agent（900 tokens）**

把已写好的谱面按「第 N 小节 [和弦]：格子…」发过去，要求只标在小节第 1 格，
每小节最多 1 个，输出：

```json
{"transitions":[{"bar":2,"slot":1,"tech":"slide","reason":"上一小节末音接下一小节首音"}]}
```

`bar/slot` 从 1 开始；如果模型整段用 0 开始（检测到 `bar===0`），代码会自动按 0-based 解释。
只接受目标格是音符、且该小节还没标过技巧的位置；最多应用 6 处。
**滑音/推弦/击弦/勾弦还要求前一个位置是实际音符**（同一小节前一格，或上一小节最后一格）；
如果上一小节以延音 `-` 或休止 `0` 结尾，`applyTransitions` 会直接拒绝，
`addAutoTechs` 也不会生成这类技巧——避免“手指还在延音上，下一小节却要求滑过去”的假动作。

**④ 润色 Agent（2600 tokens）**

把初稿、和弦网格、已标技巧一起发过去，要求它**不要整段推翻**，只做必要修改：

- 保留动机，后面用重复/模进/回应；
- 每小节留 2 个以上 `0`/`-`，句尾呼吸；
- 不要连续 3 个相同音、不要连续 4 个以上级进、少用超过 5 度的大跳；
- 强拍必须和弦音，句尾落和弦音/主音；
- 保持风格与 Bias，不新增半音；
- 技巧只放在小节交界的目标音。

输出完整 `bars` + `transitions`。如果润色结果音符太少、JSON 不合法或请求失败，
就**保留初稿**（日志标 `warn`），不会把已经能听的东西弄丢。这一步是“太粗糙”反馈后的主要改进：
它把初稿里无意义的重复、过长跑句和没有呼吸的地方再压一遍。

**⑤ 本地校验器（确定性，不发请求）**

见 13.5。

调用与容错：

| 环节 | 策略 |
| --- | --- |
| HTTP | `LLM.chat` 统一走 `/chat/completions`，`response_format: json_object`，`stream:false` |
| 超时 | JS 侧 125s；原生连接 15s / 读 90s |
| JSON | 先剥 ```json 围栏，再取第一个 `{` 到最后一个 `}`；容忍中文引号和尾随逗号 |
| 重试 | **只对“解析失败”重试一次**（HTTP 401/403/429 重试没意义，直接报中文提示） |
| 主控失败 | 日志标 `warn`，用默认结构继续填音 |
| 衔接失败 | 日志标 `warn`，`addAutoTechs()` 用音程启发式补技巧 |
| 润色失败 | 日志标 `warn`，保留初稿与已标技巧 |
| 填音失败 | 整条失败（没有音符就没有谱），界面提示可以用本地试写 |

真实 DeepSeek 联调（本地临时代理，不写进仓库）的两次结果：4 小节、19 个音、休止 8、延音 5、技巧 1–2、
音域 C4–A4、**4 次请求共约 3760 tokens、6–7 秒**，本地校验器修正 5 处；
两次生成的第一小节不同（`5 0 3 - 5 3 0 5` / `3 0 5 - 5 5 0 3`），说明不是把范例原样背下来。
从顶部「开始」直接触发时也验证过：生成完成后 `playing=true`、`live.cursor=1`、`Voices.count()=132`，
即 solo 和已启用的伴奏/鼓机一起排进了 Transport。

### 13.4.1 任务队列与流式通道

一次即兴 = 4 次模型请求 + 校验，几秒到十几秒；直接在点击事件里跑会让界面没法显示进度，
用户连点还会并发请求。因此加了两层：

**① `agentqueue.js`：内存 FIFO 任务队列**

```js
{ id, kind:'improv', title, mode:'ai'|'local', autoPlay,
  status:'queued'|'running'|'done'|'failed'|'cancelled',
  opts, steps[], stream, result, error }
```

- 同时只跑一个，后面排队；`pump()` 完成后自动取下一个；
- 每次状态变化/步骤/流片段都通知界面，界面只重画必要的部分；
- 队列支持取消排队、重试失败、载入已完成结果；
- 本地规则任务返回**同步结果**，`AgentQueue` 直接完成（避免 UI 测试被迫异步）；
- 顶部「开始」在即兴页没有谱时创建任务并设 `autoPlay=true`；已有任务则把它的 `autoPlay` 置真，
  不再重复发请求；生成按钮也可以连续点，任务会排队。

注意：队列是内存 FIFO，应用进程重启后不会恢复；已完成/失败结果可以通过“载入”查看，
真正需要跨重启的任务队列需要把 `opts` 与状态写入 SQLite（当前未做，见 14 节限制）。

**② 流式：原生 SSE + 前端整理**

- `HttpBridge.streamPost()` 逐行读 `data: {...}`，回调 `window.__httpChunk`，结束后 `__httpDone`；
- `LLM.streamChat()` 解析 `delta.reasoning_content` / `delta.content`，把片段交给 `runAgents` 的
  `onStream`；桌面浏览器用 `fetch + ReadableStream`，不支持时回退整段 `chat()`；
- `runAgents` 的每个 agent 带标签（主控/填音/衔接/润色），片段先进入任务 `stream`；
- 界面不会把 JSON 原样铺出来：`prettyStream()` 从流里抽 `thinking / structure / motif / density /
  contour / review / reason / idea`，按 agent 分段显示成“结构 / 动机 / 走向 / 落点 / 思路 / 润色意见”；
- 生成期间简谱区显示“任务运行中，完成后会显示新的简谱”，**完成才渲染谱面**；
- 完成后 `onScoreReady` 自动启用即兴；如果任务带 `autoPlay`，立刻 `Band.start()`。

流式请求失败（例如某些兼容服务不支持 `stream+response_format`）会自动回退非流式 `chat()`，
任务结果不受影响；界面的流式面板会写清楚“已回退整段返回”。

**③ 逐音显示与高亮**

- 每个音符格渲染成“级数 + 音名”（`5` / `G4`），休止/延音也有明确样式；
- `Transport.push({source:'improv', bar, slot, midi, tech})` 到点后，`ImprovUI.highlight()`：
  - 当前格加 `.now`（绿框）；
  - 当前小节加 `.playing`（描边）；
  - `#nowNote` 显示“第 N 小节 · 第 M 格 · 音名 · 级数 · 技巧”；
  - 迷你条显示 `SOLO D4`；
  - 当前小节自动横向滚到视野中央；
- 停止时清掉格/小节高亮、隐藏 `SOLO`、`nowNote` 复位。

### 13.4.2 页面拆分、伴奏实例与双吉他指板

**① 页面拆分**

即兴从伴奏页的第三个子页签搬到顶部独立页签：

- 顶部 `#tabs`：和弦查询 / 调音·音阶 / 伴奏 / **即兴**；
- 伴奏页只剩「鼓机 / 伴奏」两个子页签，加一个「伴奏实例」面板；
- 即兴页 `#viewImprov` 自己有一套 `applyTab` 分支与页头（大字显示“即兴”，副标题是实例/播放状态）；
- 原 `.mode-row` 的样式名和调式表行冲突（`querySelectorAll('.mode-row')` 多算元素），新页用 `.solo-mode-row`；
- 四个顶部页签在 390px 下会挤压换行，加 `white-space: nowrap` + 小屏字号，避免页头变高把指板顶到抽屉下面。

**② 伴奏实例**

```js
Instance = {
  id, name, createdAt, keyPc, scaleId, bpm,
  progression,      // 和弦走向快照
  rhythm,           // 节奏型快照
  drum,             // 鼓机 pattern（含 hits/accents 格子改动）
  swing, register   // 摇摆与节奏把位
}
```

- 伴奏页「保存当前为实例」/ 即兴页「用当前伴奏新建」都调 `Instances.captureCurrent()`：
  从 `BackingUI.currentProgression/currentRhythm`、`DrumsUI.currentPattern()`、`CHORD_STATE`、`Band.state.bpm`
  深拷贝一份，写 `items(kind='instance', id, json)`；名称 dialog 只负责输入名字。
- 实例是**快照**：之后改伴奏页的走向/格子不会改已保存实例；要更新就再保存一个。
- 即兴页的实例选择由 `#instanceSearch` + `#instanceSelect` 组成：
  `renderInstanceSelects()` 按名字/调式/走向/节奏/BPM 过滤 `Instances.list()`，
  只把匹配项填进下拉；搜索无结果时放一个占位项，但**不清掉当前已选实例**。
  切换实例会清掉未保存的谱面，防止“旧 solo 配新伴奏”。
- 播放时 `Band.startInstance(instance, score, {tone})`：
  - `Drums.configure(instance.drum, {swing, volume})`；
  - `Backing.configure(instance.progression, instance.rhythm, keyPc, scaleId, instance.register)`；
  - `Improv.setScore/ setTone / setEnabled`；
  - 三路音量 `applyMix()` 后 `Transport.start(instance.bpm)`。
- 普通伴奏播放走原来的 `Band.start()`，会清掉实例模式并让即兴引擎静音；从即兴页回到伴奏页时
  `applyTab` 会重新 `DrumsUI.pushToEngine()` + `BackingUI.pushToEngine()`，恢复伴奏页自己的选择。

**③ 长度 / 风格 / 音色 / 音量**

- 长度是 `1 / 2 / 3 loop`，`buildOpts()` 的 `bars = loopBars * loops`；
  `progressionGrid` 仍以实例的一圈为总拍数，`chordAtSlot` 自动循环，因此 2/3 loop 的和弦网格正确。
- 风格从 3 种扩到 7 种：五声、布鲁斯、蓝调、大调、自然小调、多利亚、混合利底亚；
  音色从 4 种扩到 6 种：钢弦、尼龙、电清音、**电过载**、电失真、爵士空心；
  每种有独立泛音配比/衰减/琴体/拨片参数，过载/失真走 `WaveShaper(tanh)` + 箱体低通。
  音色旁有「试听音色」；`Audio_.previewTone()` 直接弹 C–E–G–C，不等生成。
- 这三个设置都是 `<select>`；三路音量是滑杆，存 `mix.drums/backing/solo`，由 `Band.setMix()` 统一应用。
- API 厂商/Key 全部搬进 `#apiDialog`（modal），页面上只留「API 设置」按钮和模式条。

**④ 旋律指型（整段固定、用户可选）**

1.2.4 把原来的“每 2 小节重新选一次指型”改掉了：那会导致 1 级音突然跳到 6 品、只用 1–3 弦。
现在 `Improv.fingeringPlan(score, {shapeId})` **整段只生成一个 phrase**：

- 五种指型按低音 E 弦上的起始音定义：
  Mi=3 级（C 调 E）、La=6 级（A）、Si=7 级（B）、Re=2 级（D）、Sol=5 级（G）；
- `shapeWindow()` 把该音在 6 弦上的品位作为窗口起点：
  - C 调 Mi 开放把位 `0–6 品`（base=0，size=7）；
  - La `5–8 品`、Si `7–10 品`、Re `10–13 品`、Sol `3–6 品`（size=4）；
  - 其它调整体平移，select 的选项文字直接写当前调的品格范围；
- `shapeOptions()` 返回「自动 + 五种指型」；默认 `auto` 会**按整段所有音**计算覆盖数／越界数，
  选一个总覆盖最好的指型，并保留 Mi/La 的优先加分，不再逐段换把；
- 每个音在窗口里找弦/品，代价 = 与前一个品的距离 + 换弦 1.2 + 离窗口中心距离 + 弦号轻微偏好
  （优先粗弦，避免全挤在 1–3 弦）；
- 放不下的音不再藏起来：`nearestPosition()` 给它在另一根弦/另一个把位找可弹位置，标 `outside`，
  UI 把显示窗口扩展到这些位置（主指型与换把位同板显示），换把音用虚线/琥珀色圈标出；
- `plan.warnings` 只用于提示：`{name, suggestions}`；界面写“N 个音超出 La，已换把显示；也可换 Mi/Sol 型”，
  不会自动把整段主指型切走；所有指型都放不下（低于吉他最低音）才提示改八度；
- 指板圆圈显示**音名**：旋律板的用音圈内是该音的音名（C/E/G…），当前音另用实心点 + 带八度的
  `F4`；节奏和弦板的所有按弦点也改为音名，不再显示 1–4 的手指编号；
- 指型下拉 `#shapeSelect` 的选项由 `Improv.shapeOptions(keyPc, scaleId)` 动态生成，
  选择存 `improv.shape`；切换后只重算指板，不重新生成旋律；
- 右边节奏吉他仍用 `Backing.voicingFor(chord, register)` 选低/中/高把位（中 4–10、高 8–14，
  优先封闭指法），播放时跟随当前小节和弦；这个 register 也传给伴奏引擎，所以听到的分解/扫弦
  与右板指法一致。

**⑤ 逐音高亮的数据流**

`Transport.push({source:'improv', bar, slot, midi, tech})` → `BandUI.tick()` → `ImprovUI.highlight(ev)`：

- 谱面：当前格 `.now`、当前小节 `.playing`、自动横向滚动；
- 左板：`phrase.map[bar:slot]` 找到弦/品，画当前实心点和音名；用音圈内也带音名；
- 右板：重新取当前小节和弦 + register，更新节奏指法；按弦点内显示实际音名（不是手指编号）；
- 顶部 `#nowNote` 与迷你条 `SOLO` 同步；
- 停止/取消时清掉当前点，保留用到的音和指型。

**⑥ 谱库播放与来源标注**

- 谱库行从「载入 / 删除」扩成「播放 / 载入 / 删除」。
  `ImprovUI.loadScore(id, autoPlay)` 是统一入口：
  - `autoPlay=true` 时先 `selectInstance(score.instanceId, true)`（保留刚载入的谱），
    再走正常的 `Band.startInstance()`，所以鼓机/伴奏/solo 的启动路径与生成后播放完全一致；
  - 找不到关联实例（老谱或文本/图片导入）时走 `Band.startSolo(score, {tone})`：
    停旧 Transport、`Drums.setEnabled(false)`、`Backing.setEnabled(false)`、
    只开即兴引擎，BPM 取谱面的 BPM。这样谱库里的任何一条谱都有声音，
    又不会拿当前页面另一条实例的伴奏硬配；
  - 实例播放仍走 `startInstance()`，`instanceMode` 的播放条/页头逻辑不变。
- `score` 新增 `progressionName / instanceName / progressText`：
  - 生成时 `buildOpts()` 从实例的 `progression.zh` 与 `name` 写入；
  - `normalizeScore()` 负责兜底（旧谱从 `score.progression.zh` 取名字）；
  - 本地/填音/润色三条路径都显式透传，避免润色后丢来源；
  - 谱库行显示 `走向：… · 实例：…`；`Improv.detailText()` 和任务标题也带走向名。
- **没有用实例 id 去反查名称**：实例可以改名/删除，来源必须是保存当时的快照，
  所以名称跟 `progression` 快照一起存进 `jianpu` 行。

**⑦ 63 条内置走向**

- `backing.js` 里加了 `songProg(id, zh, pattern, origin, tag)` 的紧凑写法：
  `"6 4 1 5 3"` 是 vi–IV–I–V–iii，默认每和弦 4 拍；后缀覆盖属性
  （`3maj` 大三、`5:7` 属七、`4maj7` 大七、`2m7` 小七）。
- 共 63 条：9 条原有经典 + 46 条图片里的歌曲/情绪走向 + 8 条扩展
  （4536251、4536、15634145、2516、爵士 4536251、安达卢西亚终止、
  摇滚 I–♭VII–IV、小调史诗）。
- 所有歌曲走向仍用**级数**存储，所以按当前主调整体移调；说明里保留
  「原调 C：Am–F–C–G–Em」这样的原和弦，用户想听原调就把主调设成对应调。
- 行内用 `tag` 标「歌曲 / 扩展」，自建仍标「自建」；搜索关键字除了名字/说明，
  还会实时计算**当前调下的和弦名**，所以可以搜 `Am F C`、`4536251`、`清新`。
- 引擎测试逐条调用 `validateProgression`，并对「清新干净 / 复古浪漫 / 追梦挣扎 /
  轻松惬意 / 4536251 / R&B 2516 / 摇滚 I–♭VII–IV」断言实际和弦。

**⑧ 验证**

- 桌面 UI 测试：保存实例 → 切独立即兴页 → 2 loop 本地生成 8 小节 → 双指板/当前音/三路音量/
  高把位/保存双库全部断言；谱库播放按钮、来源走向/实例、63 条走向搜索也纳入 UI 测试；
- 真实 DeepSeek：新页面 + 实例 + API dialog 走完四 agent，4 小节 / 20 音 / 4220 tokens / 8 秒，
  队列流 1025 字符、左板 11 个音位、右板 3 个和弦点、实例播放 `playing=true cursor=1 voices=132`；
- 模拟器：保存实例后 SQLite 出现 `instance|inst…|808`，即兴页局部生成/播放/双指板截图正常。

### 13.5 校验器与 Bias：不信任模型的自律

模型经常“答应得很好，写出来不是那样”。所以提示词里的规则只是**建议**，最后一定要跑确定性校验：

```js
bias ≤ 20   → 所有格只允许和弦音
bias ≤ 65   → 强拍（偶数格）只允许和弦音；弱拍允许 和弦音 ∪ 风格音阶
bias > 65   → 不限制（半音经过音都行）
```

风格音阶（相对主音的半音）：

| 风格 | offsets |
| --- | --- |
| 五声音阶 | `[0,3,5,7,10]` |
| 布鲁斯 | `[0,3,5,6,7,10]` |
| 蓝调 | `[0,2,3,4,5,6,7,9,10]` |

`repairScore()` 做四件事：

1. **越界音搬到最近允许音**：`nearestPc()` 在音级圈上找距离最近的允许 pc，保留原八度/音区，
   再用 `scaleDegreeOf` 反写成调式内的简谱记号（所以 C 大调里的 E♭ 会写成 `b3`）；
2. **孤儿延音**改成休止、第一格延音改成休止；
3. **空小节**补一个和弦根音（没有和弦时补主音），保证每小节有内容；
4. **技巧清理**：只保留落在音符上的合法技巧，删掉落在休止/延音上的。

最后 `validateScore()` 再检查一遍：8 格、记号规范、调式/BPM/Bias 范围、技巧合法且落在音符上。
日志里的“修正 N 处”是真实计数，不是虚的。

**音域 Bias（0–1）**：

- `noteRange(keyPc, rangeBias)`：以主音所在八度为基准，0 约 12 个半音、1 约 30 个半音；
- 本地作曲 `pickPitch()` 在范围里枚举 `oct=-2..2`，前两小节目标偏低音区（20%）、
  后两小节偏高音区（80%）；音域越大，跳进惩罚越低、目标音区吸力越强；
- `contextText()` 把目标 MIDI 音域写进 planner/filler/polish 三个提示词；
- **音域只作为提示词约束**：目标音域写进 planner/filler/polish 三个提示词，AI 输出不再被程序事后
  移八度改写；本地作曲用同一 `noteRange()` 自己保证跨度。这样模型写的旋律/动机不会被改形。
- 音域 Bias 存进 `score.rangeBias`，重启/载入时显示原值；
- 指型规划会在新音域上重新选窗口；窗口装不下仍走 warnings，不会偷偷换把。

### 13.6 本地作曲：没有 API 也能听

`composeLocal(opts)` 用同一套乐理写一段，不联网：

1. 从 15 个节奏模板里按 Bias 选密度（Bias 低 4 个音/小节，高 6–7 个），不会再出现每拍固定一个音；
2. 每个音在允许音集合里按「离上一个音近、和弦音加分、强拍加分、目标音区（音域 Bias）、重复音扣分」打分，
   加一点带种子的随机；乐句尾强制落在和弦音；
3. `addAutoTechs()` 只在**前一个位置是实际音符**时补技巧：小节交界要上一小节最后一格是音符；
   小节内相邻音则按上行/下行补击弦/勾弦，跨度大一点补滑音（每小节最多 1 个），
   不再只有小节交界才可能出现技巧；
4. 再走一遍 `repairScore()` 保证合规。

它是 AI 失败时的兜底，也是“没有 Key 也想试听”的入口；听感比大模型单调，这是预期内的。
随机数用 mulberry32 + 显式 seed，测试可以复现。

### 13.7 简谱 → 和弦

`suggestChords(score)` 是确定性的，不调用模型：

- 候选：当前调式的 7 个自然三和弦；布鲁斯/蓝调风格再加 I/IV/V 的属七；
- 每小节给音符加权：强拍 1.6、弱拍 1、首尾再 +1；
- 和弦音命中加分（根音再乘 1.25），非和弦音扣分；根音完全没出现再扣 1.3；
- 上一小节同一个和弦 +1.5（平滑），下行五度 +0.5（功能进行），首小节 I、末小节 I 加分，减和弦扣分；
- 取总分最高，输出 `{name, roman, notes, degree, quality}` 与一条可用的走向。

界面上的「应用为当前走向」会把它存成 `progression` 自建项并调用 `BackingUI.selectProgression()`，
所以配完和弦直接回「伴奏」就能听；谱面标题也会改用新走向。

### 13.8 简谱 → 六线谱

`scoreToTab(score)` 是“旋律单音六线谱”，不是完整编曲：

- 每个音的 MIDI 在 6 根弦上找 0–15 品的候选；
- 代价 = `|品位 - 上一个品位| + 换弦 0.8 + 品位*0.05`，取最小（尽量留在相近把位）；
- 每格固定 3 个字符（`-5-` / `12-`），每 8 格插一个 `|`；延音格留空；
- 超过 15 品时退到 24 品以内再找一次；
- 结果文本存 `tablature` 库，键是 `tab-<简谱 id>`，保存简谱时自动生成。

### 13.9 播放：音色、技巧与共享时钟

旋律引擎也注册进 `Transport`：

```
enabled()      = live.enabled && score && Band.state.improvOn
barSeconds()   = 4 * 60 / bpm
scheduleBar()  = 展开当前小节的音（延音算时值）→ A.pluck(..., {tone, tech})
```

- **延音**：`barNotes()` 把连续的 `-` 并进前一个音的 `len`，播放时只拨一次、包络拉长；
- **技巧**：滑音/推弦从低 2 个半音滑上来，击/勾弦前面加 45ms 的装饰音，揉弦是延迟 0.12s 起的 LFO；
- **音色（1.2.4 重写）**：`audio.js` 不再是“换波形”的 3 振荡器方案，而是每种音色一套
  **加法弦模型**：
  - 6–8 个泛音，每个泛音有自己的衰减时间（高次谐波先死），并加一点非谐性（高把位不呆板）；
  - 每种音色有独立低通起点/终点、Q、琴体 `peaking` 共振、拨片带通噪声和低频“琴体咚”；
  - 电清音/过载有轻微失谐副音；过载/失真走带直流偏置的 `WaveShaper`（产生偶次谐波，
    不是纯对称 tanh 的闷声）+ 2.3/2.8kHz presence + 4.2/4.5kHz 箱体低通，失真延音更长；
  - solo 音符的包络至少约 0.38s、长音按 1.5 倍时值衰减，避免每个音都变成短促的“du”；
    solo 总线提升到 1.6 倍，有 solo 时伴奏降到 75%；
  - 钢弦用 180Hz/3.4kHz 双 peaking + 更强拨片，电清音用 700Hz 中频凹陷 + 2.5kHz presence
    和更长延音，二者不再只是低通不同；爵士/尼龙也有各自的 EQ 和衰减；
  - 连续扫弦时按音高/时刻错开极短的起振相位，避免余音把新起音抵消；噪声用固定种子的
    伪随机，音色可复现，测试也不因随机数偶发失败；
  - 每条输出末端有软限幅；`Transport` 主输出也加了一级 `tanh` 软削波，避免多音叠加爆音；
  - `playVoicing` / `previewTone` 走不带压缩器延迟的试听总线；「试听音色」按钮调用
    `Audio_.previewTone(tone)`，立即弹 C–E–G–C。
  同一套 `pluck()` 也用于和弦试听和伴奏；即兴默认**电吉他清音**，和木吉他伴奏区分开；
- **solo 总线**：solo 不直接接主输出，而是走一条 `peaking 1800Hz +4.5dB → 压缩 → 1.6 倍` 的支路，
  单音在扫弦里更靠前；有 solo 时 `Band` 把伴奏音量自动降到 75%，solo 停止/关闭后恢复；
- **人性化**：布鲁斯/蓝调把反拍推后（swing），每个音有 ±6ms 抖动、强拍重音、弱拍稍轻，
  避免机械的十六分音符感；这些时间也写进 `Transport.push`，所以谱面高亮与听到的同步；
- **音量不是烘焙进每个音**：Backing / Drums / Solo 各有一条持续 gain 总线，`setVolume` 直接改这条总线；
  以前音量是在排期时乘进每个音符的 amp，而且伴奏一次排完整条走向（5 小节），
  所以拖动滑杆要等十几秒才生效，听感上就是“音量失灵”；现在伴奏改成**一次只排一个和弦**，
  并且已排期的音源也经过持续 gain，拖动立即生效；
  0 音量真的静音，solo 下限也从 40% 放开到 0%；
- **solo 音量**：0%–220% 滑杆（默认 120%），保存在设置里；被伴奏盖住可以直接调大；
- **当前音**：`ImprovUI.highlight` 把 `SOLO E4` 写进迷你条，停止时隐藏，方便确认旋律真的在响；
- **对齐**：鼓机、伴奏、即兴共用同一个 `Transport.startTime`，都是 60/BPM 的整数倍，拍点不会漂；
- **停止**：沿用 `voices.js` 的登记表，`Transport.stop()` 会把已排期的振荡器/噪声全部 `stop(0)`，
  再给主输出 20ms 淡出；
- **只开即兴**：`Band.start()` 的守卫从“鼓机或伴奏至少一个”改成“至少一个已启用且真的有内容”，
  所以关掉鼓机/伴奏、只留即兴也能启动；如果即兴开了但没有谱，则不会启动一个空传输层。

即兴页不再依赖伴奏页的启用开关：
- 点「生成」= 创建任务（有提示词先跑推荐；选完鼓/节奏/走向和 BPM 后，再点确认生成）；任务完成后 `onScoreReady` 渲染谱面、
  自动保存 craft，再调 `Band.startInstance(instance, score, {tone})` 把鼓机 + 伴奏 + solo 一起启动；
- 作品详情页的「播放作品」= 已有谱面时用作品里的实例快照重新启动；
- 作品详情页的「停止」/ 全局迷你条 = `Band.stop()`，会把 Transport 和已排期的音源一起停掉；
- 伴奏页自己的「开始」仍然是普通伴奏模式，会清掉实例模式、让即兴引擎静音；两个页面通过同一个 Transport
  互斥播放，避免两套配置同时响。

**LLM / 本地区分**：即兴页顶部有 `modeBanner`，橙色=`本地 solo`、绿色=`LLM solo · 模型名`；
谱面 `scoreMeta` 与库里也记录 `source`（ai/local/image/text）。没有 Key 时不会静默假装是 LLM。
生成任务在队列里保存 `instanceId`，保存简谱后可从谱库载入并自动选回对应实例。

### 13.10 存储：实例 / 简谱 / 六线谱 + 上次谱面

`saveScore(score)`：

1. 没有 id 就生成 `jp<时间戳><随机>`；
2. 写入 `items(kind='jianpu', id, json)`（json 里带 `instanceId`、`progression` 快照、
   `progressionName`、`instanceName`、`progressText`、每个音的技巧）；
3. 生成六线谱文本，写入 `items(kind='tablature', id='tab-'+id)`；
4. `settings['improv.lastScore'] = id`；
5. 更新内存里的 `state.score`。

删除简谱会同时删掉 `tab-<id>`，并清掉 `lastScore`；启动时 `ImprovUI.init()` 读 `lastScore`
自动恢复上次的谱面（所以重启后 `improvOn` 为 true 时不会出现“开着即兴但没有谱”的状态）。

底层仍然是 `chord.db` 一个文件，`kind` 分命名空间；没有拆成多个数据库文件，因为：
两个库都按“整条 JSON 读/写”，拆文件只会增加连接与迁移成本，而搜索/分页在网页层做。
数据库里能直接看到 `instance`、`jianpu`、`tablature` 三类行，逻辑上就是三个库；
简谱里的 `instanceId` 指回生成它的伴奏实例。

### 13.11 图片识别与文件选择器

- 网页 `<input type="file" accept="image/*">` 在 WebView 里触发 `onShowFileChooser`；
  原生用 `FileChooserParams.createIntent()` 拉起系统选择器，`onActivityResult` 回传 Uri；
- JS 用 `FileReader.readAsDataURL()` 读成 data URL，拼成 OpenAI 多模态消息：
  `[{type:'text'},{type:'image_url',image_url:{url:dataUrl}}]`；
- 提示词要求输出 `{title,key,mode,bpm,bars:[{chord,slots}]}`；`scoreFromRecognition()` 解析调名/调式，
  归一化格子，**不做 Bias 改音**；
- 识别成功后**自动写入简谱库 + 六线谱库**（需求原话是“识别出来并写到数据库”）；
- DeepSeek 聊天模型不支持图片，界面在选图前就会提示改用 OpenAI / 自定义多模态或文本导入；
- 地址只支持 https（Android 默认拦截明文 HTTP）；原生桥也只接受 http/https。

### 13.12 验证记录

| 验证 | 结果 |
| --- | --- |
| `improvtest.html` | 150 条断言全过：mock 四 agent、流式回调、任务队列 FIFO/异步/取消、主控/衔接/润色降级、Bias、音域 Bias、音符密度/跨拍延音、重复音修正、延音、配和弦、六线谱、双库、来源走向、整段固定指型/越界换把显示、延音后禁止滑音、小节内连奏、离线电吉他、音色参数透传、本地推荐/推荐 JSON 校验、craft 持久化/版本追加/会话改谱、八度点渲染 |
| `uitest.html` | 357 条 × 4 视口全过；含 CAGED 五卡默认展示/全部指法折叠/点卡切换指型、调音入口在设置左侧并以 dialog 打开/关闭、四个顶部页签且作品在即兴右边、作品库移出即兴页、推荐三项可选+推荐速度/Top5/数字 BPM 只记录、确认后生成 craft、详情页（返回作品库、和弦图/节奏预览、双吉他指板/指型把位、三声部音量、分页版本表格/预览/最终标记/对话版本链接）、按拍浅色分组、页签/页脚/迷你条隐藏、伴奏按拍分块、伴奏实例保存/搜索/选择、7 风格/6 音色下拉、试听音色、音域 Bias、1/2/3 loop、三路音量（含已排期 gain）、设置 dialog 与主题、任务队列/流式、整段可选指型、双指板音名、逐音音名/当前音/小节高亮、高把位、保存双库、63 条走向搜索、谱库播放按钮与来源标注、无实例只播 solo |
| 真实 DeepSeek（新即兴页 + 实例 + 设置 dialog） | 4 小节 / 20 音 / 4220 tokens / 8 秒；队列流 1025 字符、左板 11 个音位、右板 3 个和弦点；实例播放 `playing=true`、`cursor=1`、132 个音源 |
| APK | 227.3 KB，权限 2 条（录音 + 网络），27 个 assets 与源码逐字节一致 |
| 模拟器（API 34） | 提示词 `sadautumn` → 本地推荐（ballad / strum_ballad / song_tender / 58–74 BPM）→ 只选速度不生成 → 确认后生成 5 小节/22 音/10 延音/1 技巧并自动播放；作品库出现 craft；详情页显示和弦图+节奏预览、三声部音量、v1 版本；注入 v2 会话修改后对话出现预览按钮、v2 标最终；页签、页脚、迷你播放器隐藏；八度低点可见 |
| 真机停止 | 只开即兴时开始 → `Voices.count()>0`，停止 → 0，Transport 停住 |

### 13.13 这一步踩到的坑

| 问题 | 原因与修复 |
| --- | --- |
| 流水线成功却报 `fn(...).then is not a function` | 最后一步“本地校验器”是同步函数，`runStep` 直接 `fn().then(...)`。改成 `Promise.resolve().then(fn)` 统一包装 |
| **顶部开始只听到伴奏** | 开始按钮只调 `Band.start()`，没有谱时即兴引擎没内容；而且用户可能没配置 API，听到的本地规则 solo 被误认为“没有 solo”。现在即兴页开始会先确保有谱（AI/本地），再渲染并播放；顶部有绿色/橙色模式条，谱面标 `LLM solo`/`本地 solo` |
| **solo 被伴奏盖住** | 单音旋律和整串扫弦同音量时很容易被掩蔽。增加 solo 专用总线（中高频 +4.5dB、压缩、1.6 倍）、默认电吉他清音、有 solo 时伴奏自动降到 75%，并加 0%–220% 的 solo 音量滑杆 |
| 不知道 solo 到底有没有响 | 迷你条增加 `SOLO E4` 当前音指示，谱面格子同步高亮；停止时隐藏 |
| 识别/导入的旋律被“修正”成了五声音阶 | `repairScore` 一开始对所有谱都按 Bias 修音。导入的谱应保留原样，现在只在 `source` 为 `ai/local` 且有和弦网格时修 |
| 衔接日志写“2 处”却列了 3 个技巧 | 之前列的是模型原始数组，不是真正应用成功的列表。`applyTransitions` 改为返回已应用数组 |
| 谱面信息里“4 小节”出现两次 | `detailText` 先拼了小节数，`statsText` 里又拼了一次；去掉前缀 |
| 高 Bias 时每小节都是 8 个音、没有留白 | 密度模板池里满足 ≥6 个音的只有 `nnnnnnnn`。补了几条 6 音模板 |
| 切换厂商后仍用着上一家的 Base URL | 切到预设厂商时清空 `llm.base/model`，让 `effective()` 回落到厂商默认；自定义才保留手填值 |
| 连点两次“生成六线谱”出现两条重复 | `saveTab` 之前用 `score.id || randId()`，谱面没保存时每次新 id。现在 `saveTab` 先给谱面补 id，重复保存会覆盖 |
| 桌面预览里“测试连接”失败 | `file://` 下 fetch 跨域被拦，原生桥只在 APK 里。README 已注明桌面先用本地试写，AI 用真机 |
| 生成后重启，即兴开关是开的但没有谱 | 只持久化了 `on.improv`，没恢复谱面。增加 `improv.lastScore` 并在启动时载入 |
| **点顶部「开始」只响伴奏** | 开始按钮只调了 `Band.start()`，没有谱时即兴引擎自然不响。现在即兴页的开始会先确保有谱（AI/本地），渲染简谱后再起 Transport |
| 普通点「生成即兴」/「本地试写」也会自动播放 | `addEventListener('click', generate)` 把事件对象当成了 `autoPlay` 参数（真值）。改成包一层 `function(){ generate(false); }`，参数严格判 `=== true` |
| 流式请求一发出就报 `JSONException Value undefined ...` | `NativeHttp.streamPost(url, headers, body)` 的 headers 必须是 **JSON 字符串**，前端传了对象。改成 `JSON.stringify(headers)` |
| 流式请求全部失败但任务还能完成 | 这是有意的降级：`streamChat` 失败会回退非流式 `chat()`，所以任务不失败，但流式面板会写“已回退整段返回”。修复 headers 后模拟器上 4 次请求都是 `http stream` |
| 即兴页的 `.mode-row` 把调式表分页断言弄挂 | 新样式类名和调式表行冲突，`querySelectorAll('.mode-row')` 多算了一个隐藏元素。改成 `.solo-mode-row` |
| 顶部第四个页签把页头挤高，抽屉遮住指板 | 390px 下四个 tab 文字换行；小屏改成 `white-space:nowrap` + 12.5px/更小 padding |
| 高把位和弦总是选回开放把位 | `searchVoicings(maxResults:240)` 在低把位就用完了配额，后面 8–14 品的指法根本没枚举到；提高到 3000 再按 position 过滤 |
| 中/高把位仍带空弦，右板看起来不像那个把位 | 中/高把位过滤掉 `hasOpen` 的指法（没有封闭指法才回退） |
| 切实例后还拿旧 solo 配新伴奏 | `selectInstance()` 检测到 id 变化就 `clearScoreView()`，并停止正在播放的实例 |
| 改了节奏把位，重启又变回低把位 | register 既存 settings，也写回实例 JSON（`Instances.save`），选择实例时读回 |
| 新页面拿不到旧的 `.mode-row` 测试断言 | 新页面用 `.solo-mode-row`；测试计数改回两个伴奏子页签 |
| 实例播放与普通伴奏互相干扰 | 普通 `Band.start()` 清实例模式并静音即兴；`Band.startInstance()` 先停旧的 Transport，再从实例重配 Drums/Backing/Improv |
| 双指板的当前音不跟着走 | `highlight()` 除了格子，还调 `renderGuitars(bar,slot,ev)`；右板按当前小节重新取和弦和 register |
| 队列测试放在离线音频测试前面会卡住 | Chrome 的 `--virtual-time-budget` 下，异步任务 + 后面的 `OfflineAudioContext` 组合会不稳定；把队列测试挪到音频/引擎测试之后 |
| 本地任务也异步时 UI 测试全要改成异步 | 本地规则作曲本身是同步的，`AgentQueue` 支持 runner 返回普通对象；AI 返回 Promise 才走异步 |
| 新生成的 solo 仍有连续三个相同音 | 提示词与润色 agent 会漏；`repairScore()` 对连续 3 个同音做确定性换音（在允许音里找最近的，不改节奏） |

### 13.14 1.3.0：提示词 → 推荐 agent → craft 作品

这一版把“生成一段 solo”改成了一个**可复盘的创作流程**，而不是一次性出谱：

```
提示词（可选）
  │
  ├─ 空 → 用当前伴奏实例直接生成
  │
  └─ 非空 → 推荐 agent（LLM / 本地规则）
              ↓
        鼓机 + 节奏型 + 走向 + Top5 BPM
              ↓ 用户可改鼓/节奏/走向，点一个 BPM 只记录选择
        再点「用这些选择生成」/ 主「生成」才确认
              ↓
        冻结成临时伴奏实例
              ↓
        四 agent 写 solo → 连音润色 → 校验器
              ↓
        自动保存 craft（提示词/推荐/选择/实例/谱面/会话/版本）
              ↓
        我的作品 → 独立详情页 → 和弦图+节奏预览 / 三声部音量
                    → 版本记录 / 对话预览 / 会话修改
```

**① 数据模型**

`crafts.js` 把一条作品作为一个 JSON 存进现有的 `items(kind='craft', id, json)`，不新增表：

```js
{
  id, title, prompt,
  recommendation: { source, drumId, rhythmId, progressionId, bpm, bpmTop5, reason, raw },
  chosen: { bpm, drumId, drumName, rhythmId, rhythmName, progressionId, progressionName },
  instance: { name, keyPc, scaleId, bpm, progression, rhythm, drum },
  tone, styleId,
  score: { keyPc, scaleId, bpm, bars, progression, progressionName, ... },
  versions: [{ id, no, label, note, settings, score, createdAt, source }],
  finalVersionId,
  messages: [{ role: 'user'|'assistant', text, at, versionId? }],
  createdAt, updatedAt
}
```

`versions` 是追加式的：初版是 v1，每次会话修改或手动保存产生新谱面时追加 v2/v3；
`finalVersionId` 指向最终版本，`score` 始终等于最终版本。旧 craft 没有 `versions` 时，
`Crafts.ensureVersions()` 把当前谱面补成 v1，不丢老数据。

不拆成多张表的原因：craft 是一个**不可变快照**，它的推荐、实例和谱面必须一起读、一起迁移；
放进一条 JSON 比新建 5 张关联表更不容易出现“实例改了、作品里的谱面还是旧的”这种半更新状态。
SQLite 仍然负责持久化，`Store` 在浏览器里自动回退 localStorage。

**② 推荐 agent**

`Crafts.recommend()` 只做一件事：把候选 id 列表交给模型，要求输出固定 JSON。
- 候选来自 `Patterns.LIST`、`Backing.RHYTHMS`、`Backing.PROGRESSIONS`，模型不能编造 id；
- 返回值走 `normalizeRec()`：id 做白名单回退，BPM 去重/升序/补足 5 个并限制 40–240；
- 模型失败或 JSON 不合法时返回 `source:'local'` + 错误说明，不阻塞生成；
- 本地规则按关键词匹配情绪（凄凉/秋/落叶/老人 → ballad + strum_ballad + song_tender，66 BPM 附近）；
- 推荐结果既包含一个 `bpm`（单独推荐速度），也包含 `bpmTop5`（快捷备选）；两者都存进 craft，详情页能还原“推荐了什么、用户选了什么”；
- 推荐面板把鼓机/节奏型/走向做成三个 `<select>`（内置 + 自建），BPM 做成 5 个 chip；
  **点 chip 或输入数字只写 `state.recDraft.bpm`，不发请求**，避免用户改配置前就触发一次生成。
- 数字框 `#recBpmInput` 允许 40–240 的任意值；`#btnUseRecBpm` 填入单独的推荐速度；校验失败时确认按钮禁用。

**③ 两个按钮的状态机**

页面只剩 `#btnImprovGen`（生成）和 `#btnSaveScore`（保存）。`ImprovUI` 用这些状态区分：

- `state.recommendation`：当前推荐结果；为空表示还没推荐；
- `state.recDraft`：用户在推荐面板里选的 `drumId/rhythmId/progressionId/bpm`；BPM 初始为 0；
- `state.recPrompt` / `recSeq`：推荐对应的提示词与请求序号，改提示词会让旧请求作废；
- `state.pendingCraft`：用户确认选择、正在生成的作品草稿；
- `state.currentCraft`：已经落库、当前页面正在编辑的作品；
- `state.instance`：临时实例（确认推荐后由 `buildInstance()` 建立）。

`generate()` 在提示词非空且已有推荐时调用 `confirmRecommendation()`；否则重新请求推荐。
`confirmRecommendation()` 要求 `recDraft.bpm` 已选，否则只提示并滚到 Top5，不生成；
确认后才把三个下拉框的值和 BPM 一起交给 `buildInstance()`。
`onScoreReady()` 如果发现 `pendingCraft`，立即 `saveFromScore()` 并清空 pending，避免用户忘记保存；
「保存」按钮则更新 `currentCraft` 或补建一条。这样“生成即保存”和“手动保存”不会重复插入。

**④ 作品详情页：预览、版本、三声部音量**

`#viewCraft` 是独立的 SPA 视图，不占顶部页签。`app.js` 用 `document.body.classList.add('craft-view')`，
CSS 在 `body.craft-view` 下隐藏 `#tabs`、`.app-footer` 和 `#miniPlayer`；
详情页自己的播放/停止按钮足够用，隐藏全局迷你条后，会话输入框不会被固定条挡住。

- **和弦图+节奏预览**：`CraftUI.renderBandPreview()` 用实例快照里的走向/节奏型，
  逐和弦调 `Backing.voicingFor()` + `Render.chordBox()` 生成真实指法图（音名标注），
  下面复用 `rhythm-slot` 渲染节奏格子；`BandUI.tick()` 把 backing/improv 事件也转给
  `CraftUI.highlight()`，播放时高亮当前和弦、节奏格和当前音。
- **双吉他指板**：`CraftUI.renderCraftGuitars()` 复用 `Improv.fingeringPlan()` 和
  `ImprovUI.fretWindowSvg()`，显示推荐旋律指型/品格窗口、当前音、节奏和弦与推荐把位；
  `craftShapeSelect` / `craftRegisterSelect` 可以手动改，播放时按当前音更新。
- **三声部音量**：详情页的 `#craftMixDrums/Backing/Solo` 直接调用 `Band.setMix()`，
  与即兴页共用同一套持久化设置和 gain 总线。
- **版本记录**：`Crafts.addVersion()` 追加版本并设置 `finalVersionId`，每个版本带 `settings`（BPM/鼓/节奏型/走向/调式/把位）与修改提示词 `note`；`CraftUI` 用 `previewVersionId` 表示“正在看旧版本”。表格每页 5 条，列为版本/速度/鼓机/节奏型/和弦走向/修改提示词/时间/操作；助手消息里存 `versionId`，因此对话里能点「预览 vN」，最终版本有绿色标记。
- **会话改谱**：`CraftUI.send()` 先把用户消息 `addMessage()` 落库，再调 `Crafts.editScore()`；
  成功后 `addVersion()` 追加版本，并用带 `versionId` 的助手消息记录预览入口。
  `editScore()` 要求模型返回 `{reply,bars}`，bars 数量必须等于原作品，随后走
  `normalizeScore()` + `repairScore()` + `validateScore()`，并保留原调、BPM、走向；
  校验不过就拒绝写入，避免一次聊天把作品改坏。

**④b 简谱八度点、按拍分组与连音**

- 简谱每两格包成 `.jp-beat`，四拍用 `--beat-a/--beat-b` 浅色背景交替；
  不再只是一排同样的格子，能直接分辨音属于哪一拍。
- `cellHtml()` 的八度点仍输出在数字旁，配合 64px 格子与绝对定位显示。

- 八度点原来只是 `jp-oct` 的小字符，参与 flex 排版，容易被数字盖住。现在把它绝对定位：
  高八度 `top:2px`、低八度 `bottom:9px`，用 `•`（U+2022）而不是小号 `·`，格子高度加到 64px；
  数字居中，音名在底部，三类信息互不重叠。
- `Improv.addLegato()` 在本地作曲和 AI 最终校验前各跑一次：把句尾空拍延长成 `-`，
  再把一部分反拍相邻音并进前一个音；每小节至少留 1 个延音，AI 提示词要求每小节至少 2 个，
  但保留至少 4–5 个起音，避免把旋律掏空。
- 延音在播放时由 `barNotes()` 合并为一个长音，不重复拨弦；技巧只允许落在实际起音上。

**④c 伴奏失声/发哑的调度修复**

- 原实现“一次排完一个和弦”在 4 拍扫弦时会一次创建 8 次 × 6 弦 × 5–8 泛音 + chorus 的节点，
  手机音频线程容易过载，表现为哑音、丢音、尾音消失。
- 现在 `Backing.engine` **一次只排 1 拍**：按 `beatCursor` 找当前和弦，只调度
  `[beat, beat+1)` 内的事件，`barSeconds` 返回这一拍的长度，Transport 下一轮继续排。
  节点数降一个数量级，和弦切换仍严格落在拍点。
- 伴奏走 `A.pluck(..., {lite:true})`：最多 5 个泛音、关闭 chorus；扫弦/分解的振幅也下调，
  给主压缩器留 headroom。Master 压缩从 -10dB/4:1 放宽到 -7dB/3:1，solo 总线从
  -14dB/4:1 放宽到 -11dB/3:1，减少“压扁/发闷”。

**⑤b 顶部导航：作品 tab 与调音 dialog**

- 顶部只保留四个主动页签：`chord / band / improv / works`；`works` 在 `improv` 右边。
  作品库/简谱库/六线谱库从即兴页的 `.improv-tools` 移到 `#viewWorks`，即兴页只留工具。
  `applyTab('works')` 会调用 `ImprovUI.renderLibrary()`；`CraftUI.back()` 也回到 `works`。
- 调音不再占页签：顶部 `#btnTunerOpen` 紧挨在 `#btnAppSettings` 左边。
  点击后 `applyTab('tuner')` 把 `#viewTuner` 变成 `position:fixed` 的全屏 dialog，
  `body.tuner-dialog` 隐藏页签/页脚/迷你条；`#btnTunerClose` 停止麦克风并回到打开前的页签
  （从作品详情打开时会重新打开原 craft）。
- 作品详情顶部有 sticky 的 `← 返回作品库`，滚动到任何位置都能返回。

**⑤ 设置与主题**

设置复用原来的 `#apiDialog`，但入口改成右上角齿轮；主题单独放在 `themeSelect`：
- `auto` 移除 `data-theme`，交给 `prefers-color-scheme`；
- `light` / `dark` 在 `<html>` 上写 `data-theme`，CSS 用 `:root[data-theme="light"]` / `:root[data-theme="dark"]` 两套变量；
- 选择存 `ui.theme`，启动时 `applyTheme()` 恢复。老 WebView 不支持 `prefers-color-scheme` 时，显式主题仍然可用。

**⑥ 这一版踩到的坑**

| 问题 | 原因与修复 |
| --- | --- |
| 作品详情页上方先出现全局页脚/使用说明 | `#viewCraft` 插在 `<footer>` 之后，DOM 顺序导致它排在最下面。改用 `body.craft-view` 隐藏页脚、页签和迷你条，详情页成为真正的一屏 |
| 推荐 Top5 第五个 BPM 被裁掉 | `#recBpmRow` 原来是不换行的横向滚动条。加 `wrap` 类 + `flex-wrap:wrap; overflow:visible`，320px 宽也能全部看到 |
| 点生成后推荐面板在屏幕外 | 面板在提示词下方，页面不会自动滚。`renderRecommendation()` 在布局完成后 `scrollIntoView({block:'center'})`，并把面板本身做成“生成后马上能看到 Top5” |
| 作品详情页的“简谱”竖排 | 长元数据把 flex 里的 label 压到 2 字宽。给 `#viewCraft .label-row > label` 加 `flex:0 0 auto; white-space:nowrap` |
| 会话修改后重新打开，消息丢了 | `CraftUI` 原先直接改内存对象。统一走 `Crafts.addMessage()` / `save()`，每条消息都写 SQLite |
| 生成后“保存”又插一条重复作品 | 生成完成已自动落库，保存按钮只更新 `currentCraft`；`pendingCraft` 在 `onScoreReady` 后清空 |
| 点速度就自动生成，用户还没改完 | 原 `chooseRecommendedBpm()` 直接建实例并入队。现在点 BPM 只写 `recDraft`，必须 `confirmRecommendation()`（面板按钮或主生成按钮）才生成 |
| 推荐面板的“鼓机/节奏型/和弦走向”竖排 | flex 里的 label 被 select 压缩到单字宽；给 `.rec-choice-grid label` 加 `white-space:nowrap` |
| 八度点看不见/被数字盖住 | 小号 `·` + flex 排版会重叠。改绝对定位 + 64px 格子 + `•`，高点在数字上、低点在数字下 |
| 最终版本也被标成“正在预览” | 预览标记原来用“当前显示版本”判断，最终版也会命中。改成只看 `previewVersionId`，最终版只显示「最终版本」 |
| 一键扫弦时出现哑音/丢音 | 伴奏一次排整和弦，节点数过大。改成一拍一调度 + 伴奏 5 泛音/无 chorus + 振幅下调/压缩器放宽 |

---

## 14. 已知限制与可扩展方向

**限制**

- 只有标准调弦（`chord.js` 顶部 `TUNING` 可改，但界面没做入口）；
- 指法是"规则穷举"的结果，不含推弦/闷音/点弦等技巧，指法数字是启发式推断；
- 音色仍是合成模型（加法弦 + 滤波/削波），不是真实采样；6 种音色已有独立的泛音、衰减和琴体差异，但和顶级采样音源仍有差距；
- 依赖系统 WebView（Android 5.0 的老机器上 WebView 版本很旧，已按 ES5 写法 + 降级样式规避，并在 API 21 模拟器上实测过）；
- 调音的基频检测针对单音（一根弦/一个音），同时按多根弦时会测到混合音；真机实测建议一次拨一根弦；
- 调音没有做“自动识别在调哪根弦并给出目标音”的完整流程（只提示最接近的琴弦），也没有做指针式的模拟表盘；
- 鼓机的音色是合成的，目标是节拍稳、好跟，不是仿真实鼓组；节奏是固定 1 小节的循环（没有做多小节编排、过门、渐快渐慢）；
- 鼓机与调音共用一台手机的音频链路：同时开会有串音，需要用户自己错开（应用里有提示）；
- 和弦伴奏的走向是「一小节循环一段」，没有做多段编排（主歌/副歌切换）、渐快渐慢、或者按拍号自动换鼓机；
- 伴奏的和弦只挑一个指法（最低把位），没有做「同一和弦换把位弹」的变化；
- 存储是"每次改动整体覆盖一条 JSON"，没有做版本迁移（`onUpgrade` 里只留了日志钩子）与云同步；
- 自建内容只能编辑/删除，还不能导入导出（想做的话 `items` 表导成 JSON 文件即可）。
- **伴奏实例是快照**：保存后再改伴奏页的走向/格子不会同步到实例；要更新就再保存一个。
- **双吉他指板是“建议指型”**：指型规划只决定显示/选弦，音色仍由 MIDI 合成，弦/品不会改变音高；
  5 品窗口是视觉窗口，不是真实左手按弦模拟，也没有指法编号。
- **整段固定一个主指型**：避免 solo 中途整体跳把；个别超出主窗口的音会自动换把位并显示（虚线圈），
  不再隐藏。音域特别宽时指板窗口会变宽，这是为了让每个音都能看到；用户仍可换一个覆盖更多音的主指型。
- **风格/音色虽扩到 7/6 种，仍是固定枚举**；自定义音阶/音色需要改 `improv.js` / `audio.js`。
- **长度只支持 1/2/3 loop**，没有任意小节数/奇数 loop；BPM 来自实例，即兴页没有单独改速。
- **实例列表在内存/Store 中同步**：删除实例不会自动删除引用它的旧简谱；载入旧谱时若实例已删，播放会提示或需要重新选实例。
- **即兴的质量依赖模型**：同样的提示词不同厂商/模型差异很大；`temperature` 固定 0.75，
  没有做多候选挑选（比如生成 3 条让用户听）。
- **即兴是固定 4/4、每小节 8 个八分格**：没有 3/4、6/8、三连音、跨小节延音；也没有力度/推弦音分等表情参数。
- **简谱还不能逐个音符编辑**：只能整段重新生成；没有撤销、没有局部重写（“只重写第 3 小节”）。
- **作品的会话修改需要 API**：没有配置模型时只能播放/查看已有会话，不能离线改谱；
  修改失败的消息也会写进 craft，方便配好 Key 后接着改。
- **推荐流程是一次性的**：agent 不会反问澄清，提示词太模糊时会按本地情绪规则落一个默认方案；
  用户可以改提示词重新生成，或直接输入任意 40–240 的 BPM。
- **craft 之间不共享修改**：在详情页改的是这一条作品自己的谱面，不会反写回原伴奏实例或其它作品。
- **主题只做了 auto/light/dark 三档**：没有自定义配色或按页面单独设主题。
- **伴奏与即兴的走向是快照关系**：生成后再改「伴奏」里的走向，谱面不会自动跟着变；
  要用新走向得重新生成（或者用“根据简谱配和弦”反过来定走向）。
- **图片识别只支持多模态模型**，且识别质量取决于图片清晰度；没有做谱面矫正/去噪。
- **六线谱只导出旋律单音**，不含和弦、节奏记号、推弦标记；也没有做六线谱图片识别。
- **API Key 是明文保存在本机**（SQLite / localStorage），没有做系统密钥库加密；不要共用设备。
- **任务队列是内存 FIFO**：重启应用后排队/运行中的任务不会恢复（已完成结果仍可从谱库载入）；
  跨重启持久化需要把 `opts/status` 写进 SQLite。
- **运行中的“取消”是软取消**：任务标记取消后不再渲染结果，但已经发出的 HTTP 请求不会被强制中断
  （`NativeHttp.cancel` 已具备，runner 还没接上 `ctx.setAbort`）；排队中的任务取消是即时的。
- **思考过程是整理后的**：只抽取 `thinking/structure/motif/review/reason/idea` 等字段；
  模型输出其他自由文本或未知字段不会显示，原始 JSON 也不单独展示。
- **流式依赖 SSE**：少数兼容服务不支持 `stream + response_format` 时会自动回退整段返回；
  这时队列/步骤仍然正常，只是没有逐字效果。
- **AI 联网依赖系统 TLS**：Android 5 的旧 TLS 栈可能连不上部分模型服务（本地试写与其它功能不受影响），
  建议 Android 7+ 使用联网功能。

**容易加的**

- **变调夹（Capo）**：就是在结果上加一个偏移量——指法不变，只是显示的实际和弦名变调；
- **自定义调弦 / 左手模式**：改 `TUNING` 数组、翻转 `STRINGS` 顺序即可；
- **和弦进行**：把多个查询结果串起来做"换和弦练习"；
- **加入常用指法库**：在 `chord.js` 里加一张"人工校验过的标准指法表"，和穷举结果合并后优先展示，兼顾权威性与完整性；
- **音阶模式**：`render.js` 的指板渲染已经很通用，把"和弦音集合"换成"音阶音集合"就是一个音阶练习器（调音页已经有一版）；
- **逐音编辑 / 局部重写**：在谱面格子上点选改音，或者只让填音 agent 重写某一小节；
- **多候选**：一次生成 2–3 条不同动机的谱，并排试听；
- **流式输出**：把 `stream:true` 接到原生桥，边生成边显示，缩短等待；
- **简谱 / 六线谱导入导出**：现在只有文本简谱导入与文本六线谱生成，可以再加 MusicXML / MIDI 导出；
- **按风格内置 lick 库**：把常见的布鲁斯/五声乐句作为 few-shot 示例塞进提示词，比单纯规则更“像人弹的”。
