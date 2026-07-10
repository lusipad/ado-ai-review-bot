### Java 专项检查

- equals/hashCode/compareTo 三者一致性；新增字段后是否同步更新；用作 Map key 的对象可变性
- 资源：try-with-resources 覆盖所有 Closeable（流、连接、Statement）；线程池是否 shutdown
- 并发：synchronized 范围与锁对象选择、volatile 误当原子用、SimpleDateFormat 等非线程安全类共享、ConcurrentModificationException 风险
- 集合：Arrays.asList 定长陷阱、subList/keySet 视图共享底层、并发场景用错非并发集合
- 异常：吞掉 InterruptedException 不恢复中断位、catch Throwable、异常里资源未释放
- Optional 误用（字段/参数用 Optional、orElse 里放有副作用调用）
- 金额用 BigDecimal（且用字符串构造）、日期用 java.time 且显式时区
- Stream：终端操作副作用、并行流里的共享可变状态
- 注入面：SQL 拼接（应 PreparedStatement）、反序列化外部数据、XXE
