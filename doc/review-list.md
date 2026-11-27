「音频批量处理」1.0.0 审核意见如下，请按「必须整改」修改后重新提交。

必须整改：
1. preload/index.js:29 与 338-344（getPath）：PATH_NAMES 里包含 home、documents、pictures、music、videos、userData、appData、exe，而 getPath 对每个 key 都调用 guard.grantDir，等于把该目录同时登记为可读目录与可写目录。页面只需调用一次 audioServices.getPath('home')，不经任何用户手势，assertReadDir 就会放行整个家目录（listMedia 还能递归枚举其中的媒体文件），assertWriteTarget 也会放行家目录直接子级的新文件写入。上一轮要求建立的「只认用户选择 / 拖入路径」的白名单，实际仍能由渲染层自行扩权。请把 getPath 拆成只读与可写两类：home、userData、appData、exe、documents、pictures、music、videos 这类不参与输出默认值的名字只返回路径或干脆不返回，不授予任何读写权限；只有确实作为输出位置的 desktop、downloads（以及用户经 chooseDir / showOpenDialog 选过的目录）才授予写权限，授权来源保持为用户手势。
2. preload/lib/config.js:258-266 与 preload/index.js:422-428（setConfig / outputDir）：setConfig 只把渲染层传入的 outputDir 从同步库剥离写进本机配置，既不校验路径也不校验是否经过用户选择；而 index.js:422-428 启动时对 cfg.outputDir 无条件调用 guard.grantDir。结果是渲染层调一次 audioServices.setConfig({outputDir:'/Users/xxx'})，下次启动该目录就成为可写白名单，等价于页面给自己发通行证。请在 setConfig 里要求 outputDir 必须已通过 guard.assertWriteDir（即本次会话由 chooseDir / showOpenDialog 选择或用户设置过）才允许写入，启动恢复白名单时对失效或未授权的目录直接跳过，不要静默授予。
3. preload/lib/fsx.js:119（makeTempText，经 preload/index.js:376 暴露）与 preload/lib/argswhitelist.js:302-310：makeTempText 接受渲染层给的任意文本（上限 4MB）写进插件临时目录，而 -f concat 的校验只看列表文件「位于临时目录且扩展名是 .txt」，不解析其中的条目。渲染层可以写一份列出 /Users/xxx 下任意音频路径的列表，再调 run 走 concat 流复制，让 ffmpeg 读取任何未经 assertReadFile 授权的文件，绕过 -i 的输入白名单。请把 concat 列表的生成收到 preload 内部：只暴露 makeConcatList(paths) 之类按已授权路径拼装列表的接口，不向渲染层开放任意文本写入；校验列表文件时逐条解析其中的路径并各自过 assertReadFile，遇到未授权条目直接拒绝。

建议整改：
1. preload/lib/config.js:258-275 的 setConfig 把渲染层传入的对象整份合并进 utools.dbStorage，键名、类型和体积都没有限制，页面可以写入非预期键或大对象，既会污染同步库也会让后续 getConfig 读到畸形值。建议在 preload 内按固定键表与类型做一次白名单校验后再写入。
2. preload/lib/binaries.js:556-561 在模块加载时立刻 setTimeout 触发 detect(true)，每次启动都会对 PATH 与常见安装目录里的候选逐个执行 -version。建议把探测结果按路径与 mtime 持久化缓存，只在首次运行或用户点「重新扫描」时才全量执行。
3. preload/index.js 的 probeManyGuarded 对传入文件逐个串行 probe，既没有数量上限也没有并发控制；一次拖入几百个文件时界面进度会长时间停住。建议限制并发（2-4 个）或分批处理，并提供可取消的入口。

提交前可安装官方自检 skill，让 AI 按审核标准先自查一遍：npx skills add uTools-Labs/utools-plugin-selfcheck-skill