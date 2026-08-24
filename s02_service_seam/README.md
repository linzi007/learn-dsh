# 02：Service seam——让 Consumer 依赖能力，而不是绑定实现

> 一句话目标：直接使用真实 Cordis `Service` 与 `inject`，用两个不同的 Provider class 证明“替换实现，不修改 Consumer”。

- 上一章：[01 Plugin、Fiber 与 Effect](../s01_lifecycle_microscope/)
- API Key：不需要
- 本章核心增量：从“一个 Plugin 管理自己的资源”走到“多个 Plugin 通过稳定能力边界协作”
- 下一章：[03 Append-only session](../s03_append_only_session/)

## 问题

Harness 的模型、工具、Session 和持久化能力不应该全部写死在一个大对象里。以模型调用为例，Consumer 真正需要的是“完成一次模型调用的能力”，不应该知道当前实现来自 DeepSeek、测试 fake，还是本地 replay。

如果 Consumer 直接 import 具体实现，会出现三个问题：

1. 测试时很难换成确定性的 fake。
2. Provider 尚未加载时，Consumer 只能自己轮询、判空或崩溃。
3. Provider 卸载后，Consumer 可能继续持有已经失效的实例。

本章把真实 DSH 使用的 capability seam 缩小成一个 `courseGreeter`：

```text
Service Definition（稳定接口）
        |
        +---- FriendlyGreeterProvider（实现 A）
        |
        +---- FormalGreeterProvider（实现 B）
        |
        v
Consumer 只依赖 Definition / service key
```

关键不在“问候语”，而在三者的依赖方向。

## 先认识七个基本概念

### 1. Service Definition：稳定的能力契约

[`GreeterDefinition`](src/service-lab.ts) 是抽象 class：

```ts
abstract class GreeterDefinition extends Service {
  constructor(ctx: Context) {
    super(ctx, 'courseGreeter')
  }

  abstract greet(who: string): string
}
```

它只回答“这项能力能做什么”，不携带 Friendly 或 Formal 的实现细节。真实 DSH 的 `SessionPersistence`、`ShellExecutor`、`SpillStore` 和 `JobRegistry` 也使用这种模式。

### 2. Provider：实现并注册 Definition

本章有两个真正不同的 Provider class：

```ts
class FriendlyGreeterProvider extends GreeterDefinition {}
class FormalGreeterProvider extends GreeterDefinition {}
```

二者都继承同一个 Definition，却可以返回完全不同的结果。构造时，Definition 内的 `super(ctx, 'courseGreeter')` 会把当前实例注册为同名 Service；这项注册由 Provider Fiber 的生命周期拥有。

一个作用域中同一时刻只应有一个 `courseGreeter` Provider。替换时先卸载旧 Provider，再挂载新 Provider。

### 3. Consumer：只使用能力，不认识实现

Consumer 只写：

```ts
ctx.courseGreeter.greet('learner')
```

它不 import、构造或判断 `FriendlyGreeterProvider` / `FormalGreeterProvider`。因此 Provider 换 class 时，Consumer 的业务代码不需要改。

### 4. declaration merging：只增强编译期类型

下面的声明让 TypeScript 知道 `ctx.courseGreeter` 的类型是稳定 Definition：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context {
    courseGreeter: GreeterDefinition
  }
}
```

它不会在运行时注册 Service，也不会替 Consumer 声明依赖。运行时注册来自 `super(...)`，运行时依赖来自 `inject`。本章负例会专门证明这一点。

### 5. `inject`：声明必需依赖

Consumer 的 Plugin metadata 中写着：

```ts
inject: ['courseGreeter']
```

它不是 TypeScript import，也不创建 Provider。它告诉 Cordis：“只有 `courseGreeter` 可用时，才运行我的 `apply`。”

### 6. PENDING 与依赖驱动重载

Consumer 先挂载而必需 Service 缺失时，它保持 PENDING，`apply` 不运行。Provider 出现后，Cordis 激活 Consumer；Provider 消失时，Cordis 清理 Consumer 的 Effects；替代 Provider 出现后，同一个 Consumer handle 会再次激活。

课程不读取 Fiber 的内部存储来证明这一点，而是观察公开证据：

- Consumer 的 start / stop 轨迹；
- `consumer.getEffects()` 返回的带标签 Effect；
- `root.get('courseGreeter')` 当前能否看到 Provider。

### 7. 属性访问与 `ctx.get()` 不是一回事

必需依赖在 Consumer 中使用 `ctx.courseGreeter`，并配套声明 `inject`。

`ctx.get('courseGreeter')` 是合法的 optional lookup：没有 Provider 时返回 `undefined`，但不会建立依赖关系，也不会让 Consumer 在 Provider 变化时自动重载。本章只在宿主观察点使用它，不把 optional dependency 当成错误写法。

## 你会交付什么

本章完成两个确定性实验：

1. 同一个 Consumer 依次等待 Friendly Provider、随其启动和停止，再使用 Formal Provider 重新启动。
2. 故意遗漏 `inject` 并直接读取 `ctx.courseGreeter`，捕获 `without inject` 错误。

代码与证据：

- [`src/service-lab.ts`](src/service-lab.ts)：Definition、两个 Provider、Consumer 和生命周期场景。
- [`src/demo.ts`](src/demo.ts)：带断言的可观察轨迹。
- [`tests/service.test.ts`](tests/service.test.ts)：seam 与失败边界测试。

## 机制图

```text
同一个 Consumer handle
        |
        | inject: courseGreeter（当前缺失）
        v
     PENDING                  effects=[]，apply 不运行
        |
        | Friendly Provider 注册 Service
        v
     ACTIVE                   start: 你好，learner！
        |
        | Friendly Provider dispose
        v
     PENDING                  stop: 你好，learner！；effects=[]
        |
        | Formal Provider 注册同名 Service
        v
     ACTIVE                   start: Welcome, learner.
        |
        | Formal Provider dispose
        v
     PENDING                  stop: Welcome, learner.；effects=[]
```

Provider class 变了，Consumer 源码没有变。

缺少 `inject` 时则是：

```text
TypeScript declaration merging 通过
              |
              v
unsafe Consumer apply 直接读取 ctx.courseGreeter
              |
              v
Cordis 拒绝：cannot get property "courseGreeter" without inject
```

## 本章边界

本章只学习一个 service name、一份抽象 Definition、两个 Provider、一个 Consumer，以及 required `inject` 的生命周期语义。

暂不进入：

- YAML composition、Loader 与 HMR 文件监听；
- `ctx.isolate()` 的多作用域实现；
- optional dependency 的业务降级策略；
- Service intercept config；
- Session、Tool 或 LLM 的具体接口。

## 手把手实验

### 第 0 步：先预测

运行前回答：

1. Consumer 比 Provider 先挂载，会不会立即执行？
2. Friendly Provider 被 dispose 后，Consumer 的 Effect 会不会继续存在？
3. Formal Provider 出现后，需要重新创建 Consumer 吗？
4. declaration merging 已声明字段类型，是否意味着运行时可以省略 `inject`？

### 第 1 步：先找稳定 Definition

打开 [`src/service-lab.ts`](src/service-lab.ts)，先只读 `GreeterDefinition`。

确认它包含：

- 固定 service key：`courseGreeter`；
- 稳定方法：`greet(who)`；
- 不包含 Friendly / Formal 的文案和配置。

如果 Definition 已经写入具体供应商或实现细节，seam 就没有真正形成。

### 第 2 步：对比两个 Provider class

继续看 `FriendlyGreeterProvider` 和 `FormalGreeterProvider`。确认它们：

- 是两个不同 class；
- 都实现同一个 Definition；
- 可以返回不同结果；
- 不要求 Consumer 配合修改。

构造轨迹使用 `provider:constructed:*`，因为构造器执行完不等于整个 Fiber 已经完成激活；真正稳定的观察点在相应的 `await()` 之后。

### 第 3 步：检查 Consumer 的依赖方向

定位 `createGreeterConsumer()`：

```ts
inject: [GREETER_SERVICE_NAME]
```

再在这个函数范围内搜索 Provider class 名称。预期一个也找不到。Consumer 只读取 `ctx.courseGreeter`，等待、停止和重新激活都由 Cordis 根据 `inject` 管理。

### 第 4 步：运行完整轨迹

在仓库根目录执行：

```bash
corepack pnpm demo:s02
```

按顺序核对五个 checkpoint：

1. `waiting`：没有 Provider，没有 Consumer Effect。
2. `friendly`：Provider 是 Friendly，Consumer 有一个 Effect。
3. `missing`：Provider 消失，Consumer Effect 已清理。
4. `formal`：Provider 是 Formal，同一个 Consumer 再次拥有一个 Effect。
5. `complete`：第二个 Provider 消失，Effect 再次清空。

这里不靠 timer，也不读取 `Fiber.store` 或 `uid`。

### 第 5 步：运行自动测试

```bash
corepack pnpm test:s02
```

测试同时检查依赖拓扑、两个不同 Provider class、两轮 start / stop，以及缺少 `inject` 的确定性错误。

### 第 6 步：做自己的正向修改——加入第三个 Provider

不要修改 Consumer。新增一个自己的 Provider，例如：

```ts
class ExcitedGreeterProvider extends GreeterDefinition {
  greet(who: string): string {
    return `Let's go, ${who}!`
  }
}
```

在测试中用全新的 `Context` 挂载既有 Consumer 和这个 Provider，断言 activation 是 `Let's go, learner!`。使用 `try/finally` 清理 `root.fiber`。

这个练习的验收点不是文案，而是：

- 第三个实现仍继承 Definition；
- Consumer 一行不改；
- 新测试能运行；
- 清理后没有残留资源。

它可以作为你的原创扩展保留，不会改变本章基线 demo 输出。

## 负向实验

内置负例没有用 `ctx.get()` 假装失败，而是省略 `inject` 后直接读取：

```ts
ctx.courseGreeter.greet('learner')
```

运行 `demo:s02` 时会被探针捕获为：

```text
cannot get property "courseGreeter" without inject
```

再亲手做一次更直接的故障注入：

1. 临时删除 `createGreeterConsumer()` 对象中的 `inject: [...]`。
2. 运行 `corepack pnpm test:s02`。
3. 预期正向场景在 Consumer 第一次 `apply` 时失败，并出现 `without inject`。
4. 恢复这一行，重新运行直到测试全绿。

“代码里会访问这个字段”和“TypeScript 知道字段类型”都不等于 Cordis 能自动推导运行时依赖。

## 预期观察

demo 的关键输出为：

```text
PASS 1/2：同一个 Consumer 跟随两个 Provider class 启停
  waiting: provider=none effects=0
  friendly: provider=FriendlyGreeterProvider effects=1
  missing: provider=none effects=0
  formal: provider=FormalGreeterProvider effects=1
  complete: provider=none effects=0
  provider:constructed:friendly
  consumer:start:你好，learner！
  consumer:stop:你好，learner！
  provider:constructed:formal
  consumer:start:Welcome, learner.
  consumer:stop:Welcome, learner.

PASS 2/2：负向探针捕获缺失 inject 的直接属性访问
  unsafe-consumer:apply
  unsafe-consumer:error:cannot get property "courseGreeter" without inject
```

第二个 `PASS` 表示课程成功捕获了错误，不表示省略 `inject` 是正确做法。

## 对照真实源码

本章直接运行 `@deepseek-ai/cordis@4.0.1`，以 DeepSeek Harness `0.1.1-rc.2`、commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` 为源码基线：

- [真实 `SessionPersistence` Service Definition](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/session/session-persistence/src/index.ts)
- [真实 `ShellExecutor` Service Definition](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/shell/shell/src/index.ts)
- [真实 `SpillStore` Service Definition](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/packages/spill/spill/src/index.ts)
- [`Service` 构造器如何注册能力](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/src/service.ts)
- [`inject` metadata 与 Plugin registry](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/src/registry.ts)
- [Fiber 根据依赖变化卸载和重载](https://github.com/deepseek-ai/deepseek-harness/blob/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e/vendor/cordis/src/fiber.ts)

课程没有复制这些实现，只调用公开 API 并用轨迹验证固定版本行为。

## 验收

运行：

```bash
corepack pnpm demo:s02
corepack pnpm test:s02
```

| 状态 | 判定 |
| --- | --- |
| Pass | 能画出 Definition → Provider / Consumer 依赖图；两个 Provider class 可替换；亲手加过第三个 Provider；负例按预期失败后恢复 |
| Fix | demo 能运行，但 Consumer 仍引用具体 Provider，或只能解释“换配置”而不能解释“换实现” |
| Not yet | 把 declaration merging / `inject` 当作 Provider 构造器，或只验证最后 greeting、没有验证清理 |

完成后，用自己的话回答：**为什么 Provider class 可以变化而 Consumer 不变？为什么 declaration merging 通过后仍然不能删除 `inject`？**

## 教学简化与生产差异

- `courseGreeter` 是原创最小领域；真实 DSH 的持久化、Shell、Jobs 等 Definition 方法更多、契约更严格。
- 本章直接用代码挂载 Plugin，没有进入 YAML composition；运行时依赖语义来自真实 Cordis。
- Provider config 中的 trace 只用于确定性观察，不属于 Definition，也不应成为生产业务接口。
- `ctx.get()` 适合真正可选的能力或宿主诊断；必需依赖仍应声明 `inject`。
- 本章只替换根作用域中的一个 Provider；多租户、agent preset 或测试隔离还需要 `ctx.isolate()` 等机制。

## 上游观察卡

完成实验后复制并填写：

```text
观察对象：@deepseek-ai/cordis / Service Definition + inject / b150a551b8...
预期行为：
实际行为：
复现命令：corepack pnpm test:s02
证据：
分类：学习误解 / 文档歧义 / 兼容性问题 / 可复现缺陷 / 插件机会
下一步：留在课程 / 写指南 / 发布插件 / 发 Discussion
```

如果只是自己遗漏 `inject`，它属于课程练习；如果固定版本中依赖存在却无法激活、依赖消失后 Consumer 仍使用旧 Service，才整理最小复现并考虑上游 Discussion。
