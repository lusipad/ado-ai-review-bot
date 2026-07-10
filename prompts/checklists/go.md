### Go 专项检查

- goroutine 泄漏：启动的 goroutine 是否有明确退出路径；for-select 缺 done 分支；未消费的 channel 发送端阻塞
- channel：无缓冲 channel 的死锁场景、close 的所有权（谁关、会不会重复关、向已关 channel 发送）
- defer：循环体内 defer 堆积、defer 求值时机（参数立即求值）、defer 修改命名返回值
- 错误处理：err 被 := 遮蔽、错误被忽略（_ =）、errors.Is/As 与 %w 包装链
- slice/map：slice 截取共享底层数组导致的意外修改与内存滞留、map 并发读写（需要 sync.Map 或锁）、遍历 map 顺序假设
- 闭包捕获循环变量（Go 1.22 前）；time.After 在循环里泄漏
- context：是否透传、cancel 是否调用、用 context 传业务参数的滥用
- nil 陷阱：带类型的 nil 接口 != nil、nil map 写入 panic、nil slice 与空 slice 语义
- 结构体拷贝：含锁/大结构体按值传递
