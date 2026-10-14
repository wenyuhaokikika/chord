# 和弦助手 Chord Helper

一个可以装在安卓手机上的**吉他和弦查询**小工具（demo）。选主调、选级数、选和弦属性，立刻看到这个和弦在**整条指板上的全部按法**，按把位分组列出来，点任意一个指法就能在指板上高亮它，还能试听声音。

- 完全**离线**运行，APK 里不含任何需要联网的东西，也**不申请任何权限**。
- APK 体积约 **60 KB**（界面是矢量 SVG 画的，没有图片素材）。
- 支持 Android 5.0（API 21）及以上。

---

## 一、它到底能做什么

| 能力 | 说明 |
| --- | --- |
| 主调（Key） | 12 个调，点一下切换；和弦名自动用惯用的升/降号拼写（如 F 调用 B♭，D 调用 F♯） |
| 音阶 / 级数 | 大调、自然小调、和声小调三种音阶；级数 1–7，可加 ♭/♮/♯ 变音 |
| 和弦属性 | 30 种：大三、小三、减三、增三、强力和弦、挂二/挂四/7sus4、大六、小六、6/9、add9、m(add9)、属七、大七、小七、小大七、半减七、减七、7♯5、9、maj9、m9、11、m11、13、m13、7♭9、7♯9、7♯11 |
| 调内和弦 | 当前调的自然三和弦 / 七和弦一览（I ii iii IV V vi vii°），点一下直接查 |
| 全把位指法 | 穷举 0–24 品里**所有**合法指法，按把位分组展示（默认 24 品，可改成 12/15/17/19/21/22） |
| 指板高亮 | 横放整条琴颈，显示品号、品记点、每个音的音名；当前指法用彩色圆点标出，空弦是绿圈、闷弦是 ×，横按画成一根横条 |
| 指法筛选 | 最大跨度（3/4/5 品）、最少发声弦数（3–6）、是否要求低音为根音、是否允许中间夹闷弦 |
| 试听 | 点 ♪ 用 WebAudio 实时合成拨弦音色扫一遍当前指法（不需要音频文件） |
| 直达链接 | 支持 `#key=7&degree=5&q=maj9&maxFret=17` 这样的参数，可把你查到的和弦记成一条链接 |

指法卡片里的记谱和真实和弦谱一致：
`x` 表示闷弦，`0` 表示空弦，数字表示品位；圆点里的数字是建议指法（1=食指，2=中指，3=无名指，4=小指）。
卡片下方一行 `1 · 3 · 5` 是这根弦上各音在和弦里扮演的角色（根音/三音/五音…）。

---

## 二、怎么跑起来

### 方式 1：直接安装 APK（最快）

已经编译好的 APK 在：

```
dist/ChordHelper-1.0.0.apk
```

传进手机（微信/AI 助手/数据线/USB 都行），点击安装，允许「安装未知来源应用」即可。
安装包用的是 debug 签名，仅供自己试用；要上架应用商店请换成你自己的签名。

### 方式 2：用 Android Studio 打开（改代码用这个）

1. Android Studio 打开本目录（`File ▸ Open`，选到 `chord` 这一层，不是里面的 `app`）；
2. 等 Gradle Sync 完成（会自动下载 AGP 8.4.2 与 SDK 34）；
3. 点运行按钮装到手机/模拟器，或 `Build ▸ Build APK(s)`。

工程是标准 Gradle 结构，并自带 Gradle Wrapper，命令行也能直接编译：

```bash
./gradlew assembleDebug      # 产物 app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease    # 产物 app/build/outputs/apk/release/app-release.apk
```

`app/src/main/assets/www` 下就是全部界面代码。如果换电脑后 Sync 报 SDK 路径错，删掉 `local.properties` 让 Android Studio 重新生成即可。

### 方式 3：直接在浏览器里看（改界面用这个）

界面本身是纯静态网页，双击打开就能用，改 JS/CSS 刷新即可见效，不用编译：

```
app/src/main/assets/www/index.html
```

> 注意：`file://` 下 WebAudio 试听在部分浏览器会被拦截，用手机装 APK 后试听正常。

### 方式 4：不用 Android Studio 也能编译出 APK

本仓库自带一个只依赖 Android SDK（不需要 Gradle / AGP）的打包脚本，走的是 AGP 内部同样的流程
（`aapt2 compile/link → javac → d8 → zipalign → apksigner`）：

```bash
python tools/build_apk.py            # 产物在 dist/ChordHelper-1.0.0.apk
```

脚本会自动寻找 JDK 和 Android SDK（也可用环境变量 `JAVA_HOME` / `ANDROID_SDK` 指定）。
重新生成图标（纯 Python 画 PNG，不依赖 Pillow）：

```bash
python tools/make_icons.py
```

> 两条路径都能用，产出的 APK 内容一致（`dist/` 里这个包由 `tools/build_apk.py` 构建，
> 和 `./gradlew assembleRelease` 的产物逐字节同源，已交叉验证）。
> 装机时注意：Gradle 的 `assembleDebug` 产物包名是 `com.chord.helper.debug`，可以和 release 包共存。

---

## 三、界面怎么用

```
┌──────────────────────────────┐
│ 🎸 和弦助手          ♯/♭ 按钮 │   ← 顶部：当前调式/级数 + 和弦名 + 组成音
│ C   I 级 · 大三               │
│     C(1) E(3) G(5)           │
├──────────────────────────────┤
│ ⚙  ◀  第 1 把位 · 含空弦  ▶ ♪ │   ← 指板工具条（吸顶常驻）
│   ┌────────────────────────┐ │
│ e │○                           │   指板图：横向整条琴颈，
│ B │  ●C                        │   圆点里是音名，
│ G │○                           │   左边 ○ 是空弦、× 是闷弦
│ … │                            │
│      5 弦 · x 3 2 0 1 0 · 1 3 5│   ← 指板下方一行：弦数 · 谱记法 · 各音级数
├──────────────────────────────┤
│ 全部指法           120 个      │   ← 按把位分组的所有指法卡片，
│ [全部][0-4品][5-9品][…]        │   点击任意卡片→上方指板高亮
│ 第 1 把位 · 含空弦  8 个指法    │
│ ┌───┐┌───┐┌───┐  ← 横向滑动    │
│ │x32010││x32013││…           │
└──────────────────────────────┘
        ⚙ 点这里弹出「查询条件」抽屉（从底部升起，
          最多约 58vh，并且始终保证整块指板露在上方，
          边选边看效果）
```

1. 点顶部 **⚙** 打开查询条件面板（底部抽屉）；
2. 依次选 **主调 → 级数（可加升降号）→ 和弦属性**；也可以在「调内和弦」那一排直接点某个级数一键选定；
3. 收起面板，下面就是**按把位分组**的全部指法；
4. 点任意一张指法卡片 → 上方指板立刻高亮该指法，指板会自动滚到对应把位；
5. **◀ / ▶** 在全部指法之间逐个切换，**♪** 试听当前指法。

几个好用的细节：

- 顶部 **♯/♭** 按钮可以手动切换和弦名的升降号写法（例如 G♭ ⇄ F♯）。
- 指板下方一行显示当前指法的**发声弦数、谱记法、以及每个音的级数**（`1`=根音、`3`=三音、`♭7`=小七…）。
- 高级设置里可以：改最大品、放宽/收紧跨度、要求 6 根弦全发声、关掉「低音必须是根音」来看**转位**指法、打开「指板上显示全部和弦音」看整条琴颈的和弦音分布、把指法卡片从「指法数字」切换成「音名」。
- 窄屏手机会自动压缩页头、收紧指板弦距，保证条件面板打开时指板依然完整可见；横屏/平板上面板会居中显示。
- 找不到指法时页面会给出可操作的建议（放宽跨度 / 允许转位 / 降低发声弦数），而不是空白。

---

## 四、直达链接参数

在浏览器或 WebView 里可以用 hash 直接指定状态，方便收藏某一次查询：

| 参数 | 取值 | 例子 |
| --- | --- | --- |
| `key` | 0–11（C=0, C♯=1, …） | `key=7` → G 调 |
| `scale` | `major` / `minor` / `harmonic` | `scale=minor` |
| `degree` | 1–7 | `degree=5` |
| `acc` | -1 / 0 / 1 | `acc=-1` → ♭级 |
| `q` | 属性 id，如 `maj` `m` `7` `maj7` `m7` `sus4` `dim` `9` … | `q=maj9` |
| `maxFret` | 12 / 15 / 17 / 19 / 21 / 22 / 24 | `maxFret=17` |
| `span` / `minSounding` | 3–5 / 2–6 | `span=5` |
| `bass` | `any` 表示低音不限（看转位） | `bass=any` |
| `flat` | 1 / 0，用降号还是升号拼写 | `flat=1` |
| `sheet` | 1 表示加载后直接展开条件面板 | `sheet=1` |

例：`index.html#key=9&scale=minor&degree=4&q=m7&maxFret=17` = A 自然小调 iv 级小七和弦、指板到 17 品。

---

## 五、在 Windows 上怎么测试

按"花时间最少"排序，三种方式都可以，推荐前两种配合用：

### 方式 A：浏览器里试（10 秒，改界面用这个）

双击 [app/src/main/assets/www/index.html](app/src/main/assets/www/index.html) 就能打开，功能全部可用（查和弦、看指板、点卡片、试听）。
按 `F12` 打开开发者工具，再按 `Ctrl+Shift+M` 切到手机模拟视图（选 iPhone/Android 尺寸），看到的就是手机上的布局。

```bash
python tools/run_tests.py --keep-open    # 跑完自检后自动用浏览器打开界面
```

注意：`file://` 下部分浏览器会拦截音频自动播放，点一下 ♪ 按钮即可（需要用户手势）。

### 方式 B：装到真手机（最真实，1 分钟）

**最省事**：把 [dist/ChordHelper-1.0.0.apk](dist/ChordHelper-1.0.0.apk) 用微信/数据线/网盘传进手机，点击安装（首次需要允许"安装未知来源应用"）。

**想用数据线自动装**（需要手机开启 USB 调试）：

```bash
python tools/install_to_phone.py --run
```

脚本会自动找 adb（项目内 SDK → 系统 PATH → 手机助手自带的 adb，比如 vivo PC 套件的
`D:\program\vivo\pcsuite\adb\adb.exe`），装完顺便启动 App。也可以用手机助手类工具
（互传/手机管家/投屏）把 APK 推过去安装，还能在电脑上看手机画面。

手机没开 USB 调试时脚本会打印开启步骤。

### 方式 C：电脑上跑安卓模拟器（不插手机，5 分钟）

本项目已经装好了模拟器，可以直接跑：

```bash
python tools/run_on_emulator.py                 # Android 14（API 34），无窗口，自动截图
python tools/run_on_emulator.py --window        # 显示模拟器窗口，自己点着玩
python tools/run_on_emulator.py --api 21        # 换成 Android 5.0 验证最低版本
python tools/run_on_emulator.py --keep          # 跑完不关闭，方便继续手动测
```

它会自动建 AVD、启动模拟器、安装 APK、启动 App、截图到 `build/emulator/`，并把
`logcat` 里的应用/WebView 日志存成 `build/emulator/logcat.txt`（排查白屏、崩溃很有用）。

> 前置条件：Windows 需要开启硬件加速（Hyper-V / WHPX）。用 `emulator -accel-check` 可查看，
> 输出 `WHPX ... is installed and usable` 就没问题。这台机器已验证可用。
> 想用自己的 Android Studio 模拟器也可以，直接在 Android Studio 里选设备运行即可。

### 一条命令跑完所有自检

```bash
python tools/run_tests.py
```

会依次跑：引擎自检（60 条断言）→ 界面自检（4 种视口 × 61 条断言）→ APK 校验（包名/权限/签名/资源一致性），
全部通过时退出码为 0，可以直接接到 CI 上。加 `-v` 看细节。

---

## 六、目录结构

```
chord/
├── README.md                 本文件：怎么用
├── process.md                技术细节：怎么实现的
├── settings.gradle           标准 Gradle 工程（Android Studio 直接打开）
├── build.gradle
├── gradle.properties
├── app/
│   ├── build.gradle
│   └── src/main/
│       ├── AndroidManifest.xml        无任何权限声明
│       ├── java/com/chord/helper/
│       │   └── MainActivity.java       只负责承载 WebView
│       ├── res/
│       │   ├── drawable/ic_launcher_foreground.xml   矢量图标（自适应）
│       │   ├── mipmap-anydpi-v26/                     Android 8+ 用矢量图标
│       │   ├── mipmap-*/ic_launcher.png               Android 5–7 用的 PNG（脚本生成）
│       │   └── values*/                              主题、颜色、字符串
│       └── assets/www/                ← 全部业务逻辑都在这里
│           ├── index.html
│           ├── css/style.css
│           └── js/
│               ├── music.js           乐理基础：音名、音阶、级数、罗马数字
│               ├── chord.js           和弦表 + 全把位指法穷举（核心算法）
│               ├── render.js          和弦图 / 全指板 SVG 渲染
│               ├── audio.js           WebAudio 拨弦合成
│               └── app.js             状态管理 + 交互
├── tools/
│   ├── run_tests.py          一条命令跑完全部自检（Windows 上最常用）
│   ├── install_to_phone.py   用数据线装到手机（自动找 adb）
│   ├── run_on_emulator.py    在电脑模拟器上跑并截图（自动找加速/建 AVD）
│   ├── build_apk.py          不用 Gradle 直接打 APK
│   ├── make_icons.py         生成 PNG 图标
│   ├── selftest.html         引擎自检（乐理 + 算法 + 渲染断言）
│   └── uitest.html           界面交互自检（模拟点击 + 布局体检）
├── build/emulator/           模拟器上的运行截图与日志（跑 run_on_emulator.py 生成）
└── dist/ChordHelper-1.0.0.apk
```

---

## 七、自检细节（可选）

两个测试页面都是纯 HTML，任何浏览器打开就能看结果，也可以用无头浏览器跑：

```bash
# 引擎自检：乐理计算、指法合法性（音高/跨度/低音/连续性逐条校验）、渲染坐标、性能
chrome --headless=new --dump-dom file:///<绝对路径>/tools/selftest.html

# 界面自检：模拟点击主调/级数/属性/卡片/开关，断言页面结果 + 布局体检
chrome --headless=new --allow-file-access-from-files        --dump-dom "file:///<绝对路径>/tools/uitest.html?w=390&h=844"
```

（`?w=360&h=640` 可以换视口尺寸，用来回归小屏布局。Windows 上 Chrome 通常在
`C:\Program Files\Google\Chrome\Application\chrome.exe`。）

## 八、常见问题

**Q：为什么某个和弦查不到指法？**
默认条件比较严格：至少 4 根弦发声、跨度不超过 4 品、低音必须是根音、发声弦必须连续。放宽其中任意一条都能查到更多，页面在查不到时也会提示。想看转位指法，关掉「低音必须是根音」。

**Q：指法是不是"标准指法"？**
不是。它是**按规则穷举出来的所有可行按法**，再按把位和发声弦数排序，所以既有你熟悉的 `x32010`，也会有一些不常见的变体。指法圆点里的数字是按品的先后顺序推断的（横按优先给食指），仅供参考。

**Q：为什么和弦图里有的和弦不带五音？**
因为查询不要求五音必须出现（`C` 只需要根音和三音）。这是吉他上的常规做法——去掉五音反而更容易按，听感上也不缺。

**Q：能改成其他调弦吗？**
可以，`js/chord.js` 顶部的 `TUNING` 数组就是 6 根弦的 MIDI 音高，改掉即可（例如 Drop D 把第一项改成 38）。

**Q：在很老的手机上界面为什么是简化样式？**
Android 5.x 出厂自带的 WebView 是 2014 年的 Chrome 37，不支持 CSS 变量，所以颜色/间距会降级成简化版
（功能完全正常，界面会多一条提示条）。到应用商店更新「Android System WebView」就恢复完整样式——
真机上 WebView 是独立更新的，绝大多数设备早已是新版本。本项目已在 Android 5.0 模拟器上实测过这条降级路径。

**Q：怎么确认我的手机能不能跑？**
装上去打开即可。如果是白屏或崩溃，用数据线连电脑跑 `adb logcat -s ChordHelper:I`，
App 会把页面标题、卡片数量、页面底色、脚本错误都打进日志（`dom={...}` 那一行），一眼能看出问题在哪。

**Q：为什么界面是网页做的？**
因为指板/和弦图本质是 2D 矢量绘制，用 SVG 表达最直接，改一行刷新就能看到效果，也方便在电脑浏览器里调试。详细取舍见 `process.md`。

---

## 九、许可与声明

这是一个 demo 项目，代码可自由使用与修改。和弦名称、指法推断仅为学习参考，弹奏请以你的耳朵和老师为准。
