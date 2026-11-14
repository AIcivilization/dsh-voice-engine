# 声音引擎验收题

> 状态：桌面版第 1 条通过；第 10 条第一次没通过，原因是说明里的两段命令要在同一个终端里连着运行，已改成一条命令。其余未测。
>
> 原状态：还没有在桌面版实测。不联网测试 139 项通过。命令行里真实合成过 Edge（中、英文）和本机 Ming，都成功。临时网页版（隔离环境，找不到你装好的 Edge 和 Ming）里确认过：三栏显示、折叠和记住折叠状态、不可用时的说明、对外接口的令牌和讯飞开关。

先**重启 DeepSeek Harness**。下面的操作都不扣讯飞额度。

## 音色展示

| # | 操作 | 通过标准 |
|---|---|---|
| 1 | 发 `/voice-list` | 右侧栏打开音色库，分讯飞、Edge、Ming 三栏；讯飞默认折叠 |
| 2 | 点讯飞的标题 | 展开和收起；关掉再打开音色库，折叠状态还在 |
| 3 | 在 Edge 一栏点晓晓的 ▶ | 有声音，标着「免费」 |
| 4 | 在 Ming 一栏点灵小雅的 ▶ | 第一次几秒后有声音（要加载模型），第二次很快 |
| 5 | Edge、Ming、讯飞各选一个点「对比」，写一句文案 | 按钮上只算讯飞的字数；连续试听三家轮流读 |
| 6 | 在 Ming 的一个音色上点「选用」 | 顶部默认音色变成它，后面标着 Ming |

## 对话

| # | 发送 | 通过标准 |
|---|---|---|
| 7 | `用免费的声音读：今天天气真好` | 用 Edge 或 Ming，没有扣讯飞字数，没有去运行 edge-tts 命令 |
| 8 | `用灵小雅读这句：欢迎收听` | 用 Ming |

## 给别的产品用

| # | 操作 | 通过标准 |
|---|---|---|
| 9 | 设置 → 声音引擎 → 声音引擎接口 | 显示「正在运行：http://127.0.0.1:18321」，三家状态都对 |
| 10 | 终端运行下面这一条命令 | 桌面上出现 hello.mp3，能播放 |
| 11 | 把命令里的 `edge:zh-CN-XiaoxiaoNeural` 换成 `聆飞瀚` 再跑一次 | 报错 HTTP 403（讯飞没有对外开放），没有扣字 |

```bash
python3 -c "import json,os,urllib.request as u;c=json.load(open(os.path.expanduser('~/.dsh/dsh-voice-engine/engine.json')));r=u.Request(c['url']+'/v1/speak',data=json.dumps({'text':'你好，欢迎收听。','voice':'edge:zh-CN-XiaoxiaoNeural'}).encode(),headers={'Authorization':'Bearer '+c['token'],'Content-Type':'application/json'});open(os.path.expanduser('~/Desktop/hello.mp3'),'wb').write(u.urlopen(r).read());print('已存到桌面 hello.mp3')"
```

## 把结果告诉我

第 1、3、4、10 条最关键。
