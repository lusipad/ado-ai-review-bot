### Python 专项检查

- 可变默认参数（def f(x=[]/{}）)；类属性与实例属性混淆导致的共享状态
- 异常：bare except / except Exception 吞错、异常链丢失（raise ... from e）、finally 里 return 覆盖异常
- 资源：文件/连接/锁是否用 with；生成器提前退出时的清理
- 并发：线程共享状态无锁、GIL 不保护复合操作、asyncio 里调用阻塞函数、事件循环内创建未 await 的 task
- 类型注解与运行时行为不符；Optional 未判 None
- 注入面：SQL 字符串拼接（应参数化）、subprocess shell=True、yaml.load（应 safe_load）、pickle 反序列化外部数据
- 浮点金额（应 Decimal）、时区 naive datetime 参与比较/存储
- 循环导入、`import *` 污染、包相对导入错误
