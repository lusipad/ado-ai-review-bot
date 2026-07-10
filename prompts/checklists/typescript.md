### TypeScript / JavaScript 专项检查

- Promise：遗漏 await（fire-and-forget 是否故意）、未处理的 rejection、Promise.all 里一个失败导致其余结果丢失
- 类型逃逸：as 断言 / any / ! 非空断言是否掩盖了真实的类型错误；对外接口的运行时校验缺失（外部输入不能只靠类型）
- null/undefined 边界：可选链后的默认值语义、`??` 与 `||` 混用（0/'' 被误吞）
- 闭包与循环：循环里创建的回调捕获了循环变量或过期状态；定时器/监听器是否清理
- 相等与拷贝：对象浅拷贝导致共享可变状态；数组 sort 原地修改
- 日期与时区：new Date(string) 解析、跨时区序列化、只用本地时区的计算
- 注入面：模板拼 HTML（XSS）、动态 require/eval、正则来自用户输入（ReDoS）
- Node 特有：阻塞事件循环的同步 IO/大 JSON、流的错误事件未监听、子进程注入
- React/Vue（如适用）：hooks 依赖数组遗漏、副作用清理、大对象放 state 引发的重渲染
