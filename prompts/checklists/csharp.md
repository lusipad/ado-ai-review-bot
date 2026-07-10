### C# / .NET 专项检查

- async 死锁与阻塞：`.Result` / `.Wait()` / `GetAwaiter().GetResult()` 混入异步链；async void（除事件处理器）
- IDisposable：新增的可释放资源是否有 using/await using；HttpClient 是否被反复 new（应复用/工厂）
- 事件与委托：订阅后是否有对应解绑，长生命周期对象订阅短生命周期事件导致泄漏
- LINQ 延迟执行：IEnumerable 被多次枚举、在锁外物化、查询捕获了会变化的变量
- EF/数据库：N+1 查询、遗漏 AsNoTracking、事务边界、并发更新冲突处理
- 并发：lock 对象选择（避免 lock(this)/字符串）、ConcurrentDictionary 的 GetOrAdd 工厂副作用、Interlocked 与 volatile 使用是否正确
- 字符串与文化：比较/排序/ToUpper 是否需要 Ordinal 或 InvariantCulture；金额用 decimal 而非 double
- 异常：catch 后吞掉不记录、catch (Exception) 过宽、异常里丢失原始堆栈（throw ex vs throw）
- 可空引用类型标注与实际判空逻辑是否一致
